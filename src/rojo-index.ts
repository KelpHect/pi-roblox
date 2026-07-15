import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import type { RobloxConfig } from "./config.js";
import { isInside, isStudioPathPrefix, toPosixPath } from "./util.js";

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}

export type CommandRunner = (
  command: string,
  args: string[],
  options: { cwd: string; signal?: AbortSignal; timeout?: number; env?: NodeJS.ProcessEnv }
) => Promise<CommandResult>;

export interface SourcemapNode {
  name: string;
  className: string;
  filePaths?: string[];
  children?: SourcemapNode[];
}

export interface RojoEntry {
  name: string;
  className: string;
  studioPath: string;
  filePaths: string[];
  sourcePath?: string;
}

export interface RojoConflict {
  kind: "studio-path" | "source-path";
  key: string;
  entries: RojoEntry[];
}

const SOURCE_EXTENSIONS = new Set([
  ".lua",
  ".luau",
  ".json",
  ".jsonc",
  ".toml",
  ".yaml",
  ".yml",
  ".csv",
  ".txt",
  ".rbxmx"
]);

function chooseSourcePath(paths: string[]): string | undefined {
  return paths.find((path) => {
    const lower = path.toLowerCase();
    if (lower.endsWith(".project.json") || lower.endsWith(".meta.json")) return false;
    return SOURCE_EXTENSIONS.has(extname(lower));
  });
}

function resolveSourcemapPath(
  rawPath: string,
  cwd: string,
  projectDir: string,
  outputDir: string
): string {
  if (isAbsolute(rawPath)) return resolve(rawPath);

  const candidates = [
    resolve(cwd, rawPath),
    resolve(projectDir, rawPath),
    resolve(outputDir, rawPath)
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

export class RojoIndex {
  readonly projectFile: string;
  readonly sourcemapFile: string;
  readonly entries: RojoEntry[];
  readonly byStudioPath: ReadonlyMap<string, RojoEntry>;
  readonly bySourcePath: ReadonlyMap<string, RojoEntry>;
  readonly conflicts: RojoConflict[];

  private constructor(
    projectFile: string,
    sourcemapFile: string,
    entries: RojoEntry[]
  ) {
    this.projectFile = projectFile;
    this.sourcemapFile = sourcemapFile;
    this.entries = entries;
    const studioGroups = new Map<string, RojoEntry[]>();
    const sourceGroups = new Map<string, RojoEntry[]>();
    for (const entry of entries) {
      const studio = studioGroups.get(entry.studioPath) ?? [];
      studio.push(entry);
      studioGroups.set(entry.studioPath, studio);
      if (entry.sourcePath) {
        const key = resolve(entry.sourcePath);
        const source = sourceGroups.get(key) ?? [];
        source.push(entry);
        sourceGroups.set(key, source);
      }
    }
    this.byStudioPath = new Map(
      [...studioGroups].filter(([, group]) => group.length === 1).map(([key, group]) => [key, group[0]!])
    );
    this.bySourcePath = new Map(
      [...sourceGroups].filter(([, group]) => group.length === 1).map(([key, group]) => [key, group[0]!])
    );
    this.conflicts = [
      ...[...studioGroups].filter(([, group]) => group.length > 1).map(([key, group]) => ({
        kind: "studio-path" as const,
        key,
        entries: group
      })),
      ...[...sourceGroups].filter(([, group]) => group.length > 1).map(([key, group]) => ({
        kind: "source-path" as const,
        key,
        entries: group
      }))
    ];
  }

  static async refresh(
    cwd: string,
    config: RobloxConfig,
    run: CommandRunner,
    signal?: AbortSignal
  ): Promise<RojoIndex> {
    const projectFile = resolve(cwd, config.projectFile);
    if (!isInside(cwd, projectFile)) {
      throw new Error(`Rojo project file must be inside the workspace: ${projectFile}`);
    }
    if (!existsSync(projectFile)) {
      throw new Error(`Rojo project file not found: ${projectFile}`);
    }

    const sourcemapFile = resolve(cwd, config.rojo.sourcemapFile);
    if (!isInside(cwd, sourcemapFile)) {
      throw new Error(`Rojo sourcemap file must be inside the workspace: ${sourcemapFile}`);
    }
    const temporaryFile = `${sourcemapFile}.tmp-${process.pid}-${Date.now()}`;
    await mkdir(dirname(sourcemapFile), { recursive: true });

    const args = ["sourcemap"];
    if (config.rojo.includeNonScripts) args.push("--include-non-scripts");
    args.push(projectFile, "--output", temporaryFile);

    const runOptions: { cwd: string; signal?: AbortSignal; timeout?: number; env?: NodeJS.ProcessEnv } = {
      cwd,
      timeout: 60_000
    };
    if (signal) runOptions.signal = signal;
    const result = await run(config.rojo.binary, args, runOptions);
    if (result.code !== 0) {
      await rm(temporaryFile, { force: true }).catch(() => undefined);
      throw new Error(
        `rojo sourcemap failed with exit code ${result.code}:\n${result.stderr || result.stdout}`
      );
    }

    await rm(sourcemapFile, { force: true });
    await rename(temporaryFile, sourcemapFile);
    return RojoIndex.load(cwd, projectFile, sourcemapFile);
  }

  static async load(
    cwd: string,
    projectFile: string,
    sourcemapFile: string
  ): Promise<RojoIndex> {
    const resolvedProject = resolve(projectFile);
    const resolvedSourcemap = resolve(sourcemapFile);
    if (!isInside(cwd, resolvedProject)) {
      throw new Error(`Rojo project file must be inside the workspace: ${resolvedProject}`);
    }
    if (!isInside(cwd, resolvedSourcemap)) {
      throw new Error(`Rojo sourcemap file must be inside the workspace: ${resolvedSourcemap}`);
    }
    const root = JSON.parse(await readFile(resolvedSourcemap, "utf8")) as SourcemapNode;
    const entries: RojoEntry[] = [];
    const projectDir = dirname(resolvedProject);
    const outputDir = dirname(resolvedSourcemap);

    function visit(node: SourcemapNode, parentPath: string | undefined, isRoot: boolean): void {
      const studioPath =
        isRoot && node.className === "DataModel"
          ? "game"
          : parentPath
            ? `${parentPath}.${node.name}`
            : node.name;

      const filePaths = (node.filePaths ?? []).map((path) =>
        resolveSourcemapPath(path, cwd, projectDir, outputDir)
      );
      const sourcePath = chooseSourcePath(filePaths);
      const entry: RojoEntry = {
        name: node.name,
        className: node.className,
        studioPath,
        filePaths
      };
      if (sourcePath) entry.sourcePath = sourcePath;
      entries.push(entry);

      for (const child of node.children ?? []) {
        visit(child, studioPath, false);
      }
    }

    visit(root, undefined, true);
    return new RojoIndex(resolvedProject, resolvedSourcemap, entries);
  }

  findStudio(target: string): RojoEntry | undefined {
    return this.byStudioPath.get(target);
  }

  findSource(target: string): RojoEntry | undefined {
    return this.bySourcePath.get(resolve(target));
  }

  findNearestStudioAncestor(target: string): RojoEntry | undefined {
    let cursor = target;
    while (cursor.startsWith("game.")) {
      cursor = cursor.slice(0, cursor.lastIndexOf("."));
      const entry = this.findStudio(cursor);
      if (entry) return entry;
    }
    return this.findStudio("game");
  }

  descendants(prefix: string, limit = 200): RojoEntry[] {
    const bounded = Math.max(1, Math.min(limit, 100_000));
    return this.entries
      .filter((entry) => entry.studioPath !== prefix && isStudioPathPrefix(prefix, entry.studioPath))
      .slice(0, bounded);
  }

  sourceFiles(): string[] {
    return [...new Set(this.entries.flatMap((entry) => entry.sourcePath ? [resolve(entry.sourcePath)] : []))];
  }

  classCounts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const entry of this.entries) counts[entry.className] = (counts[entry.className] ?? 0) + 1;
    return counts;
  }

  search(query: string, cwd: string, limit = 50): RojoEntry[] {
    const needle = query.toLowerCase();
    return this.entries
      .filter((entry) => {
        const source = entry.sourcePath ? toPosixPath(relative(cwd, entry.sourcePath)) : "";
        return (
          entry.studioPath.toLowerCase().includes(needle) ||
          entry.className.toLowerCase().includes(needle) ||
          source.toLowerCase().includes(needle)
        );
      })
      .slice(0, Math.max(1, Math.min(limit, 200)));
  }
}
