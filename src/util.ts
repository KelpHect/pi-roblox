import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";

export function sha256(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function normalizeToolPath(value: string): string {
  return value.startsWith("@") ? value.slice(1) : value;
}

function canonicalPathForContainment(pathValue: string): string {
  let cursor = resolve(pathValue);
  const missingSegments: string[] = [];

  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) break;
    missingSegments.unshift(basename(cursor));
    cursor = parent;
  }

  const existingBase = realpathSync.native(cursor);
  return resolve(existingBase, ...missingSegments);
}

export function isInside(root: string, candidate: string): boolean {
  try {
    const canonicalRoot = canonicalPathForContainment(root);
    const canonicalCandidate = canonicalPathForContainment(candidate);
    const rel = relative(canonicalRoot, canonicalCandidate);
    return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..");
  } catch {
    return false;
  }
}

/**
 * Finds the first existing symbolic-link component below `root` on the
 * lexical path to `candidate`.
 *
 * `isInside()` intentionally follows existing links so it can reject links
 * that escape the workspace. That is not sufficient for links that point
 * somewhere else *inside* the workspace: such an alias could bypass
 * generated/dependency path policies or be swapped between inspection and a
 * mutation. Mutation and checkpoint code therefore rejects every symlink
 * component below the trusted workspace root.
 */
export function findSymbolicLinkComponent(
  root: string,
  candidate: string
): string | undefined {
  const absoluteRoot = resolve(root);
  const absoluteCandidate = resolve(candidate);
  const rel = relative(absoluteRoot, absoluteCandidate);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`)) return undefined;

  let cursor = absoluteRoot;
  for (const segment of rel.split(sep).filter(Boolean)) {
    cursor = resolve(cursor, segment);
    try {
      if (lstatSync(cursor).isSymbolicLink()) return cursor;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
  return undefined;
}

export function assertNoSymbolicLinkComponent(
  root: string,
  candidate: string,
  label = "path"
): void {
  const component = findSymbolicLinkComponent(root, candidate);
  if (component) {
    throw new Error(
      `Refusing to operate on ${label} through symbolic-link component ${component}.`
    );
  }
}

export function toPosixPath(value: string): string {
  return value.replaceAll("\\", "/");
}

export function normalizeNewlines(value: string): string {
  return value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

export function boundedJson(value: unknown, maxChars = 30_000): string {
  const serialized = JSON.stringify(value, null, 2);
  return truncateText(serialized, maxChars);
}

export function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars))}\n… [truncated ${value.length - maxChars} chars]`;
}

export function safeFilename(value: string, fallback = "artifact"): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  return normalized || fallback;
}

export async function atomicWriteFile(
  pathValue: string,
  data: string | Buffer,
  options?: { mode?: number }
): Promise<void> {
  await mkdir(dirname(pathValue), { recursive: true });
  const temporary = `${pathValue}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, data, options?.mode === undefined ? undefined : { mode: options.mode });
    await rename(temporary, pathValue);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function isStudioPath(value: string): boolean {
  return value === "game" || value.startsWith("game.");
}

export function studioPathDepth(value: string): number {
  if (!isStudioPath(value)) return 0;
  return value.split(".").length;
}

export function isStudioPathPrefix(prefix: string, target: string): boolean {
  return target === prefix || target.startsWith(`${prefix}.`);
}

/** Best-effort extraction used only as an ownership guardrail. */
export function findStudioPaths(value: unknown): string[] {
  const visited = new Set<object>();
  const results = new Set<string>();
  const explicitPathKeys = new Set([
    "path",
    "script_path",
    "scriptPath",
    "instance_path",
    "instancePath",
    "target",
    "target_path",
    "targetPath",
    "parent",
    "parent_path",
    "parentPath"
  ]);

  function addPath(node: unknown): void {
    if (typeof node === "string" && isStudioPath(node)) {
      results.add(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const entry of node) addPath(entry);
    }
  }

  function visit(node: unknown, depth: number): void {
    if (depth > 10 || typeof node !== "object" || node === null) return;
    if (visited.has(node)) return;
    visited.add(node);

    if (Array.isArray(node)) {
      for (const entry of node) visit(entry, depth + 1);
      return;
    }

    const record = node as Record<string, unknown>;
    for (const [key, child] of Object.entries(record)) {
      if (explicitPathKeys.has(key) || /(?:^|_)(?:path|target|parent)$/i.test(key)) {
        addPath(child);
      }
      if (typeof child === "object" && child !== null) visit(child, depth + 1);
    }
  }

  visit(value, 0);
  return [...results];
}

export function findStudioPath(value: unknown): string | undefined {
  return findStudioPaths(value)[0];
}

export function matchesGlob(pathValue: string, pattern: string): boolean {
  const path = toPosixPath(pathValue).replace(/^\.\//, "");
  const glob = toPosixPath(pattern).replace(/^\.\//, "");
  let source = "^";

  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]!;
    const next = glob[index + 1];
    if (char === "*" && next === "*") {
      source += ".*";
      index += 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[\\^$+?.()|{}\[\]]/g, "\\$&");
    }
  }

  source += "$";
  return new RegExp(source).test(path);
}

const SECRET_KEY = /(?:api[-_]?key|authorization|cookie|password|passwd|secret|token|credential|session)/i;
const CODE_PAYLOAD_KEY = /^(?:code|content|source|old_string|new_string|script_source|scriptsource)$/i;

export function redactSecrets(value: unknown, maxStringChars = 8_000): unknown {
  const ancestors = new WeakSet<object>();

  function visit(node: unknown, key?: string, depth = 0): unknown {
    if (key && SECRET_KEY.test(key)) return "[REDACTED]";
    // MCP/source payloads are strings. Preserve numeric process exit codes,
    // which commonly use the equally named `code` field in validation data.
    if (key && CODE_PAYLOAD_KEY.test(key) && typeof node === "string") {
      return "[REDACTED_CODE]";
    }
    if (typeof node === "string") return truncateText(node, maxStringChars);
    if (typeof node !== "object" || node === null) return node;
    if (depth > 15) return "[MAX_DEPTH]";

    if (ancestors.has(node)) return "[CIRCULAR]";
    ancestors.add(node);

    if (Array.isArray(node)) {
      const output: unknown[] = [];
      for (const entry of node) output.push(visit(entry, undefined, depth + 1));
      ancestors.delete(node);
      return output;
    }

    const output: Record<string, unknown> = {};
    for (const [childKey, child] of Object.entries(node as Record<string, unknown>)) {
      output[childKey] = visit(child, childKey, depth + 1);
    }
    ancestors.delete(node);
    return output;
  }

  return visit(value);
}

export function extractJsonValues(value: unknown): unknown[] {
  const values: unknown[] = [];
  const visited = new Set<object>();

  function visit(node: unknown, depth: number): void {
    if (depth > 12) return;
    if (typeof node === "string") {
      const trimmed = node.trim();
      if (
        (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
        (trimmed.startsWith("[") && trimmed.endsWith("]"))
      ) {
        try {
          const parsed = JSON.parse(trimmed) as unknown;
          values.push(parsed);
          visit(parsed, depth + 1);
        } catch {
          // Not JSON; keep searching other fields.
        }
      }
      return;
    }
    if (typeof node !== "object" || node === null || visited.has(node)) return;
    visited.add(node);
    if (Array.isArray(node)) {
      for (const entry of node) visit(entry, depth + 1);
      return;
    }
    for (const entry of Object.values(node as Record<string, unknown>)) visit(entry, depth + 1);
  }

  visit(value, 0);
  return values;
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized.startsWith("127.")
  );
}

export function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
