import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import type { RobloxConfig } from "./config.js";
import type { RojoIndex } from "./rojo-index.js";
import {
  isInside,
  matchesGlob,
  normalizeNewlines,
  toPosixPath,
  truncateText
} from "./util.js";

export interface SourceSearchMatch {
  sourcePath: string;
  studioPath?: string;
  line: number;
  column: number;
  excerpt: string;
}

export interface SourceSearchResult {
  query: string;
  regex: boolean;
  matches: SourceSearchMatch[];
  filesSearched: number;
  truncated: boolean;
}

export interface DependencyEdge {
  sourcePath: string;
  studioPath?: string;
  expression: string;
  line: number;
}

export interface ProjectSnapshot {
  mode: RobloxConfig["mode"];
  projectFile: string;
  indexedInstances: number;
  mappedSourceFiles: number;
  classes: Record<string, number>;
  topLevel: Array<{ studioPath: string; className: string; descendants: number }>;
  conflicts: Array<{ kind: string; key: string }>;
  dependencyEdges: DependencyEdge[];
}

interface IndexedSource {
  sourcePath: string;
  studioPath?: string;
}

const TEXT_EXTENSIONS = new Set([
  ".lua",
  ".luau",
  ".json",
  ".jsonc",
  ".toml",
  ".yaml",
  ".yml",
  ".csv",
  ".txt",
  ".md"
]);

const IGNORED_DIRECTORY_NAMES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".idea",
  ".vscode",
  "node_modules",
  "Packages",
  "ServerPackages"
]);

function sourceLabel(cwd: string, path: string): string {
  return toPosixPath(relative(cwd, path));
}

function directoryMatchesPattern(relativeDirectory: string, patterns: readonly string[]): boolean {
  if (!relativeDirectory) return false;
  const probe = `${relativeDirectory}/__pi_roblox_probe__`;
  return patterns.some(
    (pattern) => matchesGlob(relativeDirectory, pattern) || matchesGlob(probe, pattern)
  );
}

export class SourceIndex {
  #dependencyCache: DependencyEdge[] | undefined;

  constructor(
    private readonly cwd: string,
    private readonly config: RobloxConfig,
    private readonly rojo?: RojoIndex
  ) {}

  async search(
    query: string,
    options: {
      regex?: boolean | undefined;
      caseSensitive?: boolean | undefined;
      limit?: number | undefined;
    } = {}
  ): Promise<SourceSearchResult> {
    const limit = Math.max(
      1,
      Math.min(options.limit ?? this.config.context.maxSearchResults, 1_000)
    );
    const regex = options.regex ?? false;
    const flags = options.caseSensitive ? "g" : "gi";
    let expression: RegExp;
    try {
      expression = regex
        ? new RegExp(query, flags)
        : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
    } catch (error) {
      throw new Error(`Invalid source search pattern: ${(error as Error).message}`);
    }

    const matches: SourceSearchMatch[] = [];
    let filesSearched = 0;
    let truncated = false;

    for (const entry of await this.sourceEntries()) {
      if (!existsSync(entry.sourcePath)) continue;
      if (!TEXT_EXTENSIONS.has(extname(entry.sourcePath).toLowerCase())) continue;
      const info = await stat(entry.sourcePath);
      if (!info.isFile() || info.size > 5_000_000) continue;
      filesSearched += 1;

      const content = normalizeNewlines(await readFile(entry.sourcePath, "utf8"));
      const lines = content.split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        expression.lastIndex = 0;
        const line = lines[index]!;
        let match: RegExpExecArray | null;
        while ((match = expression.exec(line)) !== null) {
          const result: SourceSearchMatch = {
            sourcePath: sourceLabel(this.cwd, entry.sourcePath),
            line: index + 1,
            column: match.index + 1,
            excerpt: truncateText(line.trim(), 500)
          };
          if (entry.studioPath) result.studioPath = entry.studioPath;
          matches.push(result);
          if (matches.length >= limit) {
            truncated = true;
            return { query, regex, matches, filesSearched, truncated };
          }
          if (match[0].length === 0) expression.lastIndex += 1;
        }
      }
    }

    return { query, regex, matches, filesSearched, truncated };
  }

  async dependencies(limit = 500): Promise<DependencyEdge[]> {
    if (this.#dependencyCache) return this.#dependencyCache.slice(0, limit);
    const edges: DependencyEdge[] = [];
    const requirePattern = /\brequire\s*\(\s*([^\n)]+)\s*\)/g;

    for (const entry of await this.sourceEntries()) {
      if (!/\.lua[u]?$/i.test(entry.sourcePath) || !existsSync(entry.sourcePath)) continue;
      const info = await stat(entry.sourcePath);
      if (!info.isFile() || info.size > 5_000_000) continue;
      const content = normalizeNewlines(await readFile(entry.sourcePath, "utf8"));
      const lines = content.split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]!;
        requirePattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = requirePattern.exec(line)) !== null) {
          const edge: DependencyEdge = {
            sourcePath: sourceLabel(this.cwd, entry.sourcePath),
            expression: match[1]!.trim(),
            line: index + 1
          };
          if (entry.studioPath) edge.studioPath = entry.studioPath;
          edges.push(edge);
          if (edges.length >= 5_000) break;
        }
      }
      if (edges.length >= 5_000) break;
    }

    this.#dependencyCache = edges;
    return edges.slice(0, Math.max(1, Math.min(limit, 5_000)));
  }

  async snapshot(): Promise<ProjectSnapshot> {
    const entries = this.rojo?.entries ?? [];
    const topLevel = entries
      .filter((entry) => entry.studioPath.split(".").length === 2)
      .map((entry) => ({
        studioPath: entry.studioPath,
        className: entry.className,
        descendants: this.rojo?.descendants(entry.studioPath, 100_000).length ?? 0
      }));

    return {
      mode: this.config.mode,
      projectFile: this.config.projectFile,
      indexedInstances: entries.length,
      mappedSourceFiles: this.rojo?.sourceFiles().length ?? 0,
      classes: this.rojo?.classCounts() ?? {},
      topLevel,
      conflicts: (this.rojo?.conflicts ?? []).map((conflict) => ({
        kind: conflict.kind,
        key: conflict.key
      })),
      dependencyEdges: await this.dependencies(250)
    };
  }

  invalidate(): void {
    this.#dependencyCache = undefined;
  }

  /**
   * Discover project text files even in Studio-only mode. Rojo mappings are
   * attached when available, while generated output, package caches, audit,
   * checkpoints, and artifact directories are excluded.
   */
  private async sourceEntries(): Promise<IndexedSource[]> {
    const output = new Map<string, IndexedSource>();
    for (const entry of this.rojo?.entries ?? []) {
      if (!entry.sourcePath || !TEXT_EXTENSIONS.has(extname(entry.sourcePath).toLowerCase())) continue;
      if (!isInside(this.cwd, entry.sourcePath)) continue;
      output.set(resolve(entry.sourcePath), {
        sourcePath: resolve(entry.sourcePath),
        studioPath: entry.studioPath
      });
    }

    const excludedPatterns = [
      ...this.config.rojo.generatedPatterns,
      ...this.config.rojo.dependencyPatterns,
      `${toPosixPath(this.config.audit.directory)}/**`,
      `${toPosixPath(this.config.checkpoints.directory)}/**`,
      `${toPosixPath(this.config.scenarios.artifactsDirectory)}/**`,
      toPosixPath(this.config.rojo.sourcemapFile)
    ];
    const maxFiles = 10_000;

    const visit = async (directory: string, depth: number): Promise<void> => {
      if (depth > 30 || output.size >= maxFiles) return;
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch {
        return;
      }

      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        if (output.size >= maxFiles) break;
        if (entry.isSymbolicLink()) continue;
        const path = join(directory, entry.name);
        if (!isInside(this.cwd, path)) continue;
        const relativePath = toPosixPath(relative(this.cwd, path));

        if (entry.isDirectory()) {
          if (
            IGNORED_DIRECTORY_NAMES.has(entry.name) ||
            directoryMatchesPattern(relativePath, excludedPatterns)
          ) {
            continue;
          }
          await visit(path, depth + 1);
          continue;
        }

        if (!entry.isFile()) continue;
        if (!TEXT_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
        if (excludedPatterns.some((pattern) => matchesGlob(relativePath, pattern))) continue;

        const absolute = resolve(path);
        if (!output.has(absolute)) {
          const mapped = this.rojo?.findSource(absolute);
          const source: IndexedSource = { sourcePath: absolute };
          if (mapped) source.studioPath = mapped.studioPath;
          output.set(absolute, source);
        }
      }
    };

    await visit(this.cwd, 0);
    return [...output.values()].sort((left, right) =>
      left.sourcePath.localeCompare(right.sourcePath)
    );
  }
}
