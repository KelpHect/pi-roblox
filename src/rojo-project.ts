import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { parse as parseJsonc, printParseErrorCode, type ParseError } from "jsonc-parser";
import { isInside, toPosixPath } from "./util.js";

export interface RojoProjectMetadata {
  path: string;
  directory: string;
  name?: string;
  serveAddress: string;
  servePort: number;
  servePlaceIds: number[];
  placeId?: number;
  gameId?: number;
  hasTree: boolean;
  raw: Record<string, unknown>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

export async function readRojoProject(
  cwd: string,
  projectFile: string
): Promise<RojoProjectMetadata> {
  const path = resolve(cwd, projectFile);
  if (!isInside(cwd, path)) {
    throw new Error(`Rojo project file must be inside the workspace: ${path}`);
  }

  const source = await readFile(path, "utf8");
  const errors: ParseError[] = [];
  const parsed = parseJsonc(source, errors, {
    allowTrailingComma: true,
    disallowComments: false
  }) as unknown;

  if (errors.length > 0) {
    const details = errors
      .slice(0, 5)
      .map((error) => `${printParseErrorCode(error.error)} at offset ${error.offset}`)
      .join(", ");
    throw new Error(`Invalid Rojo project JSON/JSONC at ${path}: ${details}`);
  }
  if (!isObject(parsed)) throw new Error(`Rojo project must contain an object: ${path}`);

  const servePort = positiveInteger(parsed.servePort) ?? 34_872;
  if (servePort > 65_535) throw new Error(`Invalid servePort in ${path}: ${servePort}`);

  const servePlaceIds = Array.isArray(parsed.servePlaceIds)
    ? parsed.servePlaceIds
        .map(positiveInteger)
        .filter((value): value is number => value !== undefined)
    : [];

  const metadata: RojoProjectMetadata = {
    path,
    directory: dirname(path),
    serveAddress:
      typeof parsed.serveAddress === "string" && parsed.serveAddress.length > 0
        ? parsed.serveAddress
        : "localhost",
    servePort,
    servePlaceIds: [...new Set(servePlaceIds)],
    hasTree: isObject(parsed.tree),
    raw: parsed
  };

  if (typeof parsed.name === "string" && parsed.name.length > 0) metadata.name = parsed.name;
  const placeId = positiveInteger(parsed.placeId);
  if (placeId) metadata.placeId = placeId;
  const gameId = positiveInteger(parsed.gameId);
  if (gameId) metadata.gameId = gameId;

  return metadata;
}


export async function discoverRojoProjects(
  cwd: string,
  options: { maxDepth?: number; limit?: number } = {}
): Promise<string[]> {
  const root = resolve(cwd);
  const maxDepth = Math.max(0, Math.min(options.maxDepth ?? 4, 10));
  const limit = Math.max(1, Math.min(options.limit ?? 100, 1_000));
  const results: string[] = [];
  const ignored = new Set([".git", ".hg", ".svn", "node_modules", "Packages", "ServerPackages"]);

  async function visit(directory: string, depth: number): Promise<void> {
    if (results.length >= limit || depth > maxDepth) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (results.length >= limit) return;
      const path = join(directory, entry.name);
      if (!isInside(root, path)) continue;
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".project.json")) {
        results.push(resolve(path));
      }
    }
    for (const entry of entries) {
      if (results.length >= limit || !entry.isDirectory() || ignored.has(entry.name)) continue;
      await visit(join(directory, entry.name), depth + 1);
    }
  }

  await visit(root, 0);
  return results.sort((left, right) => {
    const leftRelative = toPosixPath(relative(root, left));
    const rightRelative = toPosixPath(relative(root, right));
    if (leftRelative === "default.project.json") return -1;
    if (rightRelative === "default.project.json") return 1;
    return leftRelative.localeCompare(rightRelative);
  });
}

export function projectPathExists(cwd: string, projectFile: string): boolean {
  const path = resolve(cwd, projectFile);
  return isInside(cwd, path) && existsSync(path);
}
