import { relative } from "node:path";
import type { RojoIndex } from "./rojo-index.js";
import { studioResultJson, studioResultText, type StudioToolResult } from "./studio-client.js";
import { normalizeNewlines, toPosixPath, truncateText } from "./util.js";

export type ConsoleSeverity = "error" | "warning" | "info" | "log" | "unknown";

export interface ConsoleEntry {
  severity: ConsoleSeverity;
  message: string;
  timestamp?: string;
  studioPath?: string;
  sourcePath?: string;
  line?: number;
  raw?: unknown;
}

export interface ConsoleSnapshot {
  entries: ConsoleEntry[];
  errors: ConsoleEntry[];
  warnings: ConsoleEntry[];
  text: string;
}

const PATH_LINE_PATTERNS = [
  /(?:^|\s)((?:game\.)?[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)+):(\d+)(?::\d+)?/,
  /(?:^|\s)([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)+):(\d+)(?::\d+)?/
];

function normalizeSeverity(value: unknown, message: string): ConsoleSeverity {
  const text = typeof value === "string" ? value.toLowerCase() : "";
  if (text.includes("error") || text === "3") return "error";
  if (text.includes("warn") || text === "2") return "warning";
  if (text.includes("info")) return "info";
  if (text.includes("log") || text.includes("output") || text === "1") return "log";

  const lowered = message.toLowerCase();
  if (/\b(error|exception|traceback|failed)\b/.test(lowered)) return "error";
  if (/\bwarn(?:ing)?\b/.test(lowered)) return "warning";
  return "unknown";
}

function firstString(record: Record<string, unknown>, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = record[name];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function firstNumber(record: Record<string, unknown>, names: readonly string[]): number | undefined {
  for (const name of names) {
    const value = record[name];
    if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
    if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  }
  return undefined;
}

function looksLikeEntry(record: Record<string, unknown>): boolean {
  return ["message", "text", "output", "content", "Message", "Text"].some(
    (name) => typeof record[name] === "string"
  );
}

function collectRecords(value: unknown, output: Record<string, unknown>[], depth = 0): void {
  if (depth > 10 || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const entry of value) collectRecords(entry, output, depth + 1);
    return;
  }
  const record = value as Record<string, unknown>;
  if (looksLikeEntry(record)) output.push(record);
  for (const child of Object.values(record)) collectRecords(child, output, depth + 1);
}

function normalizeStudioPath(candidate: string | undefined): string | undefined {
  if (!candidate) return undefined;
  const trimmed = candidate.trim().replace(/^DataModel\./, "game.");
  if (trimmed === "game" || trimmed.startsWith("game.")) return trimmed;
  const serviceNames = new Set([
    "Workspace",
    "ReplicatedStorage",
    "ReplicatedFirst",
    "ServerScriptService",
    "ServerStorage",
    "StarterGui",
    "StarterPack",
    "StarterPlayer",
    "Lighting",
    "SoundService",
    "Players"
  ]);
  const first = trimmed.split(".")[0];
  return first && serviceNames.has(first) ? `game.${trimmed}` : undefined;
}

function inferLocation(message: string): { studioPath?: string; line?: number } {
  for (const pattern of PATH_LINE_PATTERNS) {
    const match = pattern.exec(message);
    if (!match) continue;
    const studioPath = normalizeStudioPath(match[1]);
    if (studioPath) return { studioPath, line: Number(match[2]) };
  }
  return {};
}

function remapEntry(cwd: string, rojo: RojoIndex | undefined, entry: ConsoleEntry): ConsoleEntry {
  const inferred = inferLocation(entry.message);
  const studioPath = normalizeStudioPath(entry.studioPath) ?? inferred.studioPath;
  if (studioPath !== undefined) entry.studioPath = studioPath;
  if (entry.line === undefined && inferred.line !== undefined) entry.line = inferred.line;

  if (entry.studioPath) {
    const mapped = rojo?.findStudio(entry.studioPath) ?? rojo?.findNearestStudioAncestor(entry.studioPath);
    if (mapped?.sourcePath) entry.sourcePath = toPosixPath(relative(cwd, mapped.sourcePath));
  }
  return entry;
}

function parseTextLines(text: string): ConsoleEntry[] {
  return normalizeNewlines(text)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((message) => ({ severity: normalizeSeverity(undefined, message), message }));
}

export function parseConsoleResult(
  cwd: string,
  rojo: RojoIndex | undefined,
  result: StudioToolResult,
  maxMessageChars = 8_000
): ConsoleSnapshot {
  const text = studioResultText(result);
  const payload = studioResultJson<unknown>(result);
  const records: Record<string, unknown>[] = [];
  if (payload !== undefined) collectRecords(payload, records);

  const entries = records.length > 0
    ? records.map((record): ConsoleEntry => {
        const message = firstString(record, [
          "message",
          "Message",
          "text",
          "Text",
          "output",
          "content"
        ]) ?? JSON.stringify(record);
        const studioPath = firstString(record, [
          "studioPath",
          "scriptPath",
          "script",
          "path",
          "source"
        ]);
        const timestamp = firstString(record, ["timestamp", "time", "createdAt"]);
        const entry: ConsoleEntry = {
          severity: normalizeSeverity(
            record.severity ?? record.level ?? record.type ?? record.messageType,
            message
          ),
          message: truncateText(message, maxMessageChars),
          raw: record
        };
        if (studioPath) entry.studioPath = studioPath;
        const line = firstNumber(record, ["line", "lineNumber", "line_number"]);
        if (line !== undefined) entry.line = line;
        if (timestamp) entry.timestamp = timestamp;
        return entry;
      })
    : parseTextLines(text).map((entry) => ({ ...entry, message: truncateText(entry.message, maxMessageChars) }));

  const remapped = entries.map((entry) => remapEntry(cwd, rojo, entry));
  return {
    entries: remapped,
    errors: remapped.filter((entry) => entry.severity === "error"),
    warnings: remapped.filter((entry) => entry.severity === "warning"),
    text: truncateText(text, 50_000)
  };
}
