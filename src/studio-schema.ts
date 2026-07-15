import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import * as formatsNamespace from "ajv-formats";
import type { StudioToolDescriptor } from "./studio-client.js";
import { boundedJson, sha256 } from "./util.js";

export const READ_ONLY_STUDIO_TOOLS = new Set([
  "script_read",
  "script_search",
  "script_grep",
  "search_asset",
  "search_game_tree",
  "inspect_instance",
  "get_studio_state",
  "get_console_output",
  "screen_capture",
  "http_get",
  "skill",
  "list_roblox_studios"
]);

/**
 * Current Studio script_read responses prefix each source line with a
 * one-based line number and a right-arrow. Older/fake servers may return raw
 * source or JSON instead, so only remove the unambiguous numbered-line form.
 */
export function normalizeScriptReadText(value: string): string {
  return value
    .split(/\r?\n/u)
    .map((line) => line.replace(/^\s*\d+→/u, ""))
    .join("\n");
}

function properties(tool: StudioToolDescriptor): Record<string, unknown> {
  const value = tool.inputSchema.properties;
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function required(tool: StudioToolDescriptor): string[] {
  return Array.isArray(tool.inputSchema.required)
    ? tool.inputSchema.required.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function enumValues(schema: unknown): unknown[] {
  if (typeof schema !== "object" || schema === null) return [];
  const record = schema as Record<string, unknown>;
  if (Array.isArray(record.enum)) return record.enum;
  if (Array.isArray(record.anyOf)) return record.anyOf.flatMap(enumValues);
  if (Array.isArray(record.oneOf)) return record.oneOf.flatMap(enumValues);
  return [];
}

export function inferArgumentKey(
  tool: StudioToolDescriptor,
  candidates: readonly string[],
  label: string,
  optional = false
): string | undefined {
  const available = properties(tool);
  const exact = candidates.find((candidate) => candidate in available);
  if (exact) return exact;

  const normalizedCandidates = new Set(
    candidates.map((candidate) => candidate.replaceAll(/[_-]/g, "").toLowerCase())
  );
  const fuzzy = Object.keys(available).find((key) =>
    normalizedCandidates.has(key.replaceAll(/[_-]/g, "").toLowerCase())
  );
  if (fuzzy) return fuzzy;

  if (optional) return undefined;
  throw new Error(
    `Could not infer the ${label} argument for Studio tool ${tool.name}. ` +
      `Available fields: ${Object.keys(available).join(", ") || "none"}.`
  );
}

export function addDataModelType(
  tool: StudioToolDescriptor,
  args: Record<string, unknown>,
  dataModelType: "Edit" | "Client" | "Server"
): Record<string, unknown> {
  const available = properties(tool);
  const names = ["datamodel_type", "dataModelType", "datamodelType", "data_model_type"];
  const key = names.find((candidate) => candidate in available);
  if (key) args[key] = dataModelType;

  for (const requiredName of required(tool)) {
    if (names.includes(requiredName) && !(requiredName in args)) args[requiredName] = dataModelType;
  }
  return args;
}

export function buildPathArguments(
  tool: StudioToolDescriptor,
  path: string,
  dataModelType: "Edit" | "Client" | "Server" = "Edit"
): Record<string, unknown> {
  const pathKey = inferArgumentKey(
    tool,
    [
      "path",
      "file_path",
      "filePath",
      "target_file",
      "targetFile",
      "script_path",
      "scriptPath",
      "instance_path",
      "instancePath",
      "target",
      "target_path",
      "targetPath"
    ],
    "path"
  );
  return addDataModelType(tool, { [pathKey!]: path }, dataModelType);
}

export function buildExecuteLuauArguments(
  tool: StudioToolDescriptor,
  code: string,
  dataModelType: "Edit" | "Client" | "Server"
): Record<string, unknown> {
  const codeKey = inferArgumentKey(
    tool,
    ["code", "source", "script", "luau", "luau_code", "luauCode", "command"],
    "Luau source"
  );
  return addDataModelType(tool, { [codeKey!]: code }, dataModelType);
}

export function buildSetActiveStudioArguments(
  tool: StudioToolDescriptor,
  studioId: string
): Record<string, unknown> {
  const key = inferArgumentKey(
    tool,
    ["id", "studio_id", "studioId", "instance_id", "instanceId"],
    "Studio ID"
  );
  return { [key!]: studioId };
}

/**
 * Build arguments for start_stop_play without hard-coding the server's exact
 * casing. Unknown optional fields are intentionally omitted.
 */
export function buildPlayArguments(
  tool: StudioToolDescriptor,
  action: "start" | "stop",
  mode: "play" | "run" = "play"
): Record<string, unknown> {
  const actionKey = inferArgumentKey(
    tool,
    ["action", "command", "state", "play_action", "playAction", "is_start", "isStart", "start"],
    "play action"
  );
  const actionSchema = properties(tool)[actionKey!];
  const actionRecord =
    typeof actionSchema === "object" && actionSchema !== null
      ? actionSchema as Record<string, unknown>
      : undefined;
  const booleanAction = actionRecord?.type === "boolean" || actionKey === "is_start" || actionKey === "isStart";
  const values = enumValues(actionSchema).filter((entry): entry is string => typeof entry === "string");
  const wanted = action === "start"
    ? ["start", "play", "run", "resume"]
    : ["stop", "end", "terminate"];
  const selected = booleanAction
    ? action === "start"
    : values.find((value) => wanted.includes(value.toLowerCase())) ?? action;
  const args: Record<string, unknown> = { [actionKey!]: selected };

  if (action === "start") {
    const modeKey = inferArgumentKey(
      tool,
      ["mode", "play_mode", "playMode", "run_mode", "runMode"],
      "play mode",
      true
    );
    if (modeKey) {
      const modeValues = enumValues(properties(tool)[modeKey]).filter(
        (entry): entry is string => typeof entry === "string"
      );
      const selectedMode =
        modeValues.find((value) => value.toLowerCase() === mode) ??
        modeValues.find((value) => value.toLowerCase().includes(mode)) ??
        mode;
      args[modeKey] = selectedMode;
    }
  }

  return args;
}

export function buildNavigationArguments(
  tool: StudioToolDescriptor,
  target: string
): Record<string, unknown> {
  const key = inferArgumentKey(
    tool,
    ["target", "path", "target_path", "targetPath", "destination", "instance_path"],
    "navigation target"
  );
  return { [key!]: target };
}

/** Build a current Studio screen_capture call while retaining older no-arg servers. */
export function buildScreenCaptureArguments(
  tool: StudioToolDescriptor,
  captureId: string,
  provided: Record<string, unknown> = {}
): Record<string, unknown> {
  const args = { ...provided };
  const key = inferArgumentKey(
    tool,
    ["capture_id", "captureId", "id", "name"],
    "capture identifier",
    true
  );
  if (key && !(key in args)) args[key] = captureId;
  return args;
}

function formatErrors(errors: ErrorObject[] | null | undefined): string {
  if (!errors || errors.length === 0) return "unknown schema violation";
  return errors
    .slice(0, 10)
    .map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`)
    .join("; ");
}

/** Cached JSON-Schema validation for dynamically discovered Studio MCP tools. */
export class StudioSchemaValidator {
  readonly #ajv: Ajv;
  readonly #cache = new Map<string, ValidateFunction>();

  constructor() {
    this.#ajv = new Ajv({
      allErrors: true,
      strict: false,
      allowUnionTypes: true,
      validateFormats: true,
      messages: true
    });
    const addFormats = ((formatsNamespace as unknown as { default?: (ajv: Ajv) => unknown }).default ??
      (formatsNamespace as unknown as (ajv: Ajv) => unknown));
    addFormats(this.#ajv);
  }

  validate(tool: StudioToolDescriptor, args: Record<string, unknown>): void {
    const schemaKey = `${tool.name}:${sha256(JSON.stringify(tool.inputSchema))}`;
    let validator = this.#cache.get(schemaKey);
    if (!validator) {
      let compiled: ValidateFunction;
      try {
        compiled = this.#ajv.compile(tool.inputSchema);
      } catch (error) {
        throw new Error(
          `Studio MCP supplied an invalid input schema for ${tool.name}: ${(error as Error).message}`
        );
      }
      this.#cache.set(schemaKey, compiled);
      validator = compiled;
    }

    if (!validator(args)) {
      throw new Error(
        `Invalid arguments for Studio tool ${tool.name}: ${formatErrors(validator.errors)}. ` +
          `Arguments: ${boundedJson(args, 4_000)}`
      );
    }
  }

  clear(): void {
    this.#cache.clear();
  }
}

export function toolProperties(tool: StudioToolDescriptor): Record<string, unknown> {
  return properties(tool);
}

export function optionalArgumentKey(
  tool: StudioToolDescriptor,
  candidates: readonly string[]
): string | undefined {
  const available = properties(tool);
  const exact = candidates.find((candidate) => candidate in available);
  if (exact) return exact;
  const normalizedCandidates = new Set(
    candidates.map((candidate) => candidate.replaceAll(/[_-]/g, "").toLowerCase())
  );
  return Object.keys(available).find((key) =>
    normalizedCandidates.has(key.replaceAll(/[_-]/g, "").toLowerCase())
  );
}

export function buildPlaytestArguments(
  tool: StudioToolDescriptor,
  action: "start" | "stop",
  mode?: string
): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const actionKey = optionalArgumentKey(tool, [
    "action",
    "command",
    "operation",
    "state",
    "play_state",
    "playState"
  ]);
  if (actionKey) args[actionKey] = action;

  const boolKey = optionalArgumentKey(tool, [
    "play",
    "playing",
    "is_playing",
    "isPlaying",
    "start",
    "enabled"
  ]);
  if (boolKey && !(boolKey in args)) args[boolKey] = action === "start";

  const modeKey = optionalArgumentKey(tool, [
    "mode",
    "play_mode",
    "playMode",
    "run_mode",
    "runMode"
  ]);
  if (modeKey && action === "start") args[modeKey] = mode ?? "Play";

  if (Object.keys(args).length === 0) {
    const requiredFields = required(tool);
    if (requiredFields.length === 1) args[requiredFields[0]!] = action;
  }
  return args;
}
