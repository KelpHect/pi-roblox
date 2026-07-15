import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parse as parseJsonc, printParseErrorCode, type ParseError } from "jsonc-parser";
import type { ArtifactReference, ArtifactStore } from "./artifacts.js";
import type { RobloxConfig } from "./config.js";
import type { StudioToolDescriptor, StudioToolResult } from "./studio-client.js";
import { studioResultJson, studioResultText } from "./studio-client.js";
import {
  addDataModelType,
  buildExecuteLuauArguments,
  buildNavigationArguments,
  buildPlayArguments,
  buildScreenCaptureArguments
} from "./studio-schema.js";
import { boundedJson, isInside, safeFilename, truncateText } from "./util.js";

export type ScenarioDataModelType = "Edit" | "Client" | "Server";

export interface ScenarioExpectation {
  jsonPath?: string;
  equals?: unknown;
  truthy?: boolean;
  contains?: string;
  matches?: string;
  not?: boolean;
}

export interface ScenarioToolStep {
  kind: "tool";
  tool: string;
  arguments?: Record<string, unknown>;
  expect?: ScenarioExpectation;
  saveAs?: string;
  continueOnFailure?: boolean;
}

export interface ScenarioLuauStep {
  kind: "luau";
  code: string;
  dataModelType?: ScenarioDataModelType;
  expect?: ScenarioExpectation;
  saveAs?: string;
  continueOnFailure?: boolean;
}

export interface ScenarioWaitStep {
  kind: "wait";
  milliseconds: number;
  continueOnFailure?: boolean;
}

export interface ScenarioPlayStep {
  kind: "play";
  action: "start" | "stop";
  mode?: "play" | "run";
  continueOnFailure?: boolean;
}

export interface ScenarioCaptureStep {
  kind: "capture";
  name?: string;
  arguments?: Record<string, unknown>;
  continueOnFailure?: boolean;
}

export interface ScenarioConsoleStep {
  kind: "console";
  name?: string;
  dataModelType?: ScenarioDataModelType;
  expect?: ScenarioExpectation;
  continueOnFailure?: boolean;
}

export interface ScenarioNavigateStep {
  kind: "navigate";
  target: string;
  arguments?: Record<string, unknown>;
  continueOnFailure?: boolean;
}

export interface ScenarioAssertStep {
  kind: "assert";
  value?: unknown;
  from?: string;
  expect: ScenarioExpectation;
  continueOnFailure?: boolean;
}

export type ScenarioStep =
  | ScenarioToolStep
  | ScenarioLuauStep
  | ScenarioWaitStep
  | ScenarioPlayStep
  | ScenarioCaptureStep
  | ScenarioConsoleStep
  | ScenarioNavigateStep
  | ScenarioAssertStep;

export interface RobloxScenario {
  version: 1;
  name: string;
  description?: string;
  timeoutMs?: number;
  setup?: ScenarioStep[];
  steps: ScenarioStep[];
  teardown?: ScenarioStep[];
  failOnConsoleErrors?: boolean;
  failOnConsoleWarnings?: boolean;
  alwaysStopPlay?: boolean;
}

export interface ScenarioStepResult {
  phase: "setup" | "steps" | "teardown" | "finalize";
  index: number;
  kind: ScenarioStep["kind"] | "console-analysis" | "stop-play";
  status: "pass" | "fail" | "cancelled";
  startedAt: string;
  durationMs: number;
  summary: string;
  value?: unknown;
  artifacts?: ArtifactReference[];
  error?: string;
}

export interface ConsoleDiagnostic {
  severity: "error" | "warning";
  message: string;
  timestamp?: string;
  studioPath?: string;
  sourcePath?: string;
  line?: number;
}

export interface ScenarioRunResult {
  scenario: string;
  description?: string;
  status: "pass" | "fail" | "cancelled";
  startedAt: string;
  durationMs: number;
  artifactRunId: string;
  artifactDirectory: string;
  sourcePath?: string;
  steps: ScenarioStepResult[];
  diagnostics: ConsoleDiagnostic[];
  savedValues: Record<string, unknown>;
  reportArtifact: ArtifactReference;
}

export interface ScenarioToolBridge {
  getTool(name: string): Promise<StudioToolDescriptor>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    options?: { signal?: AbortSignal | undefined; timeoutMs?: number | undefined }
  ): Promise<StudioToolResult>;
  /** Optional Roblox-aware console parser supplied by the runtime. */
  parseConsole?(result: StudioToolResult): ConsoleDiagnostic[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseScenarioText(source: string, path: string): unknown {
  const errors: ParseError[] = [];
  const parsed = parseJsonc(source, errors, {
    allowTrailingComma: true,
    disallowComments: false
  }) as unknown;
  if (errors.length > 0) {
    const message = errors
      .slice(0, 5)
      .map((error) => `${printParseErrorCode(error.error)} at offset ${error.offset}`)
      .join(", ");
    throw new Error(`Invalid scenario JSON/JSONC at ${path}: ${message}`);
  }
  return parsed;
}

function expectation(value: unknown, raw: unknown, label: string): ScenarioExpectation | undefined {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) throw new Error(`${label}.expect must be an object.`);
  const result: ScenarioExpectation = {};
  if (typeof raw.jsonPath === "string") result.jsonPath = raw.jsonPath;
  if ("equals" in raw) result.equals = raw.equals;
  if (typeof raw.truthy === "boolean") result.truthy = raw.truthy;
  if (typeof raw.contains === "string") result.contains = raw.contains;
  if (typeof raw.matches === "string") result.matches = raw.matches;
  if (typeof raw.not === "boolean") result.not = raw.not;
  const hasPredicate =
    "equals" in result ||
    result.truthy !== undefined ||
    result.contains !== undefined ||
    result.matches !== undefined;
  if (!hasPredicate) {
    throw new Error(
      `${label}.expect must define equals, truthy, contains, or matches; jsonPath may select the value.`
    );
  }
  return result;
}

function optionalArguments(raw: unknown, label: string): Record<string, unknown> | undefined {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) throw new Error(`${label}.arguments must be an object.`);
  return structuredClone(raw);
}

function optionalDataModelType(raw: unknown, label: string): ScenarioDataModelType | undefined {
  if (raw === undefined) return undefined;
  if (raw === "Edit" || raw === "Client" || raw === "Server") return raw;
  throw new Error(`${label}.dataModelType must be Edit, Client, or Server.`);
}

function parseStep(raw: unknown, label: string): ScenarioStep {
  if (!isObject(raw) || typeof raw.kind !== "string") {
    throw new Error(`${label} must be an object with a kind.`);
  }
  const continueOnFailure = raw.continueOnFailure === true ? true : undefined;

  switch (raw.kind) {
    case "tool": {
      if (typeof raw.tool !== "string" || raw.tool.length === 0) {
        throw new Error(`${label}.tool is required.`);
      }
      const step: ScenarioToolStep = { kind: "tool", tool: raw.tool };
      const args = optionalArguments(raw.arguments, label);
      if (args) step.arguments = args;
      const expect = expectation(raw, raw.expect, label);
      if (expect) step.expect = expect;
      if (typeof raw.saveAs === "string" && raw.saveAs.length > 0) step.saveAs = raw.saveAs;
      if (continueOnFailure) step.continueOnFailure = true;
      return step;
    }
    case "luau": {
      if (typeof raw.code !== "string" || raw.code.length === 0) {
        throw new Error(`${label}.code is required.`);
      }
      const step: ScenarioLuauStep = { kind: "luau", code: raw.code };
      const dataModelType = optionalDataModelType(raw.dataModelType, label);
      if (dataModelType) step.dataModelType = dataModelType;
      const expect = expectation(raw, raw.expect, label);
      if (expect) step.expect = expect;
      if (typeof raw.saveAs === "string" && raw.saveAs.length > 0) step.saveAs = raw.saveAs;
      if (continueOnFailure) step.continueOnFailure = true;
      return step;
    }
    case "wait": {
      if (
        typeof raw.milliseconds !== "number" ||
        !Number.isInteger(raw.milliseconds) ||
        raw.milliseconds < 0 ||
        raw.milliseconds > 300_000
      ) {
        throw new Error(`${label}.milliseconds must be an integer from 0 to 300000.`);
      }
      const step: ScenarioWaitStep = { kind: "wait", milliseconds: raw.milliseconds };
      if (continueOnFailure) step.continueOnFailure = true;
      return step;
    }
    case "play": {
      if (raw.action !== "start" && raw.action !== "stop") {
        throw new Error(`${label}.action must be start or stop.`);
      }
      const step: ScenarioPlayStep = { kind: "play", action: raw.action };
      if (raw.mode === "play" || raw.mode === "run") step.mode = raw.mode;
      if (continueOnFailure) step.continueOnFailure = true;
      return step;
    }
    case "capture": {
      const step: ScenarioCaptureStep = { kind: "capture" };
      if (typeof raw.name === "string" && raw.name.length > 0) step.name = raw.name;
      const args = optionalArguments(raw.arguments, label);
      if (args) step.arguments = args;
      if (continueOnFailure) step.continueOnFailure = true;
      return step;
    }
    case "console": {
      const step: ScenarioConsoleStep = { kind: "console" };
      if (typeof raw.name === "string" && raw.name.length > 0) step.name = raw.name;
      const dataModelType = optionalDataModelType(raw.dataModelType, label);
      if (dataModelType) step.dataModelType = dataModelType;
      const expect = expectation(raw, raw.expect, label);
      if (expect) step.expect = expect;
      if (continueOnFailure) step.continueOnFailure = true;
      return step;
    }
    case "navigate": {
      if (typeof raw.target !== "string" || !raw.target.startsWith("game.")) {
        throw new Error(`${label}.target must be a game.* path.`);
      }
      const step: ScenarioNavigateStep = { kind: "navigate", target: raw.target };
      const args = optionalArguments(raw.arguments, label);
      if (args) step.arguments = args;
      if (continueOnFailure) step.continueOnFailure = true;
      return step;
    }
    case "assert": {
      const expect = expectation(raw, raw.expect, label);
      if (!expect) throw new Error(`${label}.expect is required.`);
      if (raw.from !== undefined && (typeof raw.from !== "string" || raw.from.length === 0)) {
        throw new Error(`${label}.from must be a saved-value name.`);
      }
      const step: ScenarioAssertStep = { kind: "assert", expect };
      if ("value" in raw) step.value = raw.value;
      if (typeof raw.from === "string") step.from = raw.from;
      if (continueOnFailure) step.continueOnFailure = true;
      return step;
    }
    default:
      throw new Error(`${label}.kind is unsupported: ${raw.kind}`);
  }
}

function parseSteps(raw: unknown, label: string, required: boolean): ScenarioStep[] {
  if (raw === undefined && !required) return [];
  if (!Array.isArray(raw)) throw new Error(`${label} must be an array.`);
  if (raw.length > 500) throw new Error(`${label} may contain at most 500 steps.`);
  return raw.map((step, index) => parseStep(step, `${label}[${index}]`));
}

export function parseScenario(raw: unknown, sourceLabel = "scenario"): RobloxScenario {
  if (!isObject(raw)) throw new Error(`${sourceLabel} must contain an object.`);
  if (raw.version !== undefined && raw.version !== 1) {
    throw new Error(`${sourceLabel}.version must be 1.`);
  }
  if (typeof raw.name !== "string" || raw.name.trim().length === 0 || raw.name.length > 200) {
    throw new Error(`${sourceLabel}.name must be 1-200 characters.`);
  }

  const scenario: RobloxScenario = {
    version: 1,
    name: raw.name.trim(),
    steps: parseSteps(raw.steps, `${sourceLabel}.steps`, true)
  };
  if (typeof raw.description === "string") scenario.description = raw.description.slice(0, 2_000);
  if (raw.timeoutMs !== undefined) {
    if (
      typeof raw.timeoutMs !== "number" ||
      !Number.isInteger(raw.timeoutMs) ||
      raw.timeoutMs < 1_000 ||
      raw.timeoutMs > 30 * 60_000
    ) {
      throw new Error(`${sourceLabel}.timeoutMs must be an integer from 1000 to 1800000.`);
    }
    scenario.timeoutMs = raw.timeoutMs;
  }
  const setup = parseSteps(raw.setup, `${sourceLabel}.setup`, false);
  if (setup.length > 0) scenario.setup = setup;
  const teardown = parseSteps(raw.teardown, `${sourceLabel}.teardown`, false);
  if (teardown.length > 0) scenario.teardown = teardown;
  if (typeof raw.failOnConsoleErrors === "boolean") {
    scenario.failOnConsoleErrors = raw.failOnConsoleErrors;
  }
  if (typeof raw.failOnConsoleWarnings === "boolean") {
    scenario.failOnConsoleWarnings = raw.failOnConsoleWarnings;
  }
  if (typeof raw.alwaysStopPlay === "boolean") scenario.alwaysStopPlay = raw.alwaysStopPlay;
  return scenario;
}

function getJsonPath(value: unknown, path: string): unknown {
  if (!path || path === "$" || path === ".") return value;
  const normalized = path.replace(/^\$\.?/, "");
  if (!normalized) return value;
  const segments = normalized
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter(Boolean);
  let cursor = value;
  for (const segment of segments) {
    if (Array.isArray(cursor) && /^\d+$/.test(segment)) {
      cursor = cursor[Number(segment)];
    } else if (isObject(cursor)) {
      cursor = cursor[segment];
    } else {
      return undefined;
    }
  }
  return cursor;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function evaluateExpectation(
  sourceValue: unknown,
  expectationValue: ScenarioExpectation
): { pass: boolean; actual: unknown; message: string } {
  const actual = expectationValue.jsonPath
    ? getJsonPath(sourceValue, expectationValue.jsonPath)
    : sourceValue;
  const checks: boolean[] = [];
  const descriptions: string[] = [];

  if ("equals" in expectationValue) {
    checks.push(deepEqual(actual, expectationValue.equals));
    descriptions.push(`equals ${boundedJson(expectationValue.equals, 1_000)}`);
  }
  if (expectationValue.truthy !== undefined) {
    checks.push(Boolean(actual) === expectationValue.truthy);
    descriptions.push(expectationValue.truthy ? "is truthy" : "is falsy");
  }
  if (expectationValue.contains !== undefined) {
    const container = typeof actual === "string" ? actual : boundedJson(actual, 20_000);
    checks.push(container.includes(expectationValue.contains));
    descriptions.push(`contains ${JSON.stringify(expectationValue.contains)}`);
  }
  if (expectationValue.matches !== undefined) {
    let regex: RegExp;
    try {
      regex = new RegExp(expectationValue.matches);
    } catch (error) {
      throw new Error(`Invalid scenario expectation regex: ${(error as Error).message}`);
    }
    const text = typeof actual === "string" ? actual : boundedJson(actual, 20_000);
    checks.push(regex.test(text));
    descriptions.push(`matches /${expectationValue.matches}/`);
  }

  let pass = checks.length > 0 && checks.every(Boolean);
  if (expectationValue.not) pass = !pass;
  return {
    pass,
    actual,
    message: `${expectationValue.not ? "not " : ""}${descriptions.join(" and ")}`
  };
}

function resultValue(result: StudioToolResult): unknown {
  return studioResultJson(result) ?? studioResultText(result);
}

function diagnosticsFromValue(value: unknown): ConsoleDiagnostic[] {
  const diagnostics: ConsoleDiagnostic[] = [];
  const seen = new Set<string>();

  const push = (severity: "error" | "warning", message: string): void => {
    const normalized = message.trim();
    if (!normalized) return;
    const key = `${severity}:${normalized}`;
    if (seen.has(key)) return;
    seen.add(key);
    diagnostics.push({ severity, message: truncateText(normalized, 4_000) });
  };

  const visited = new Set<object>();
  const visit = (node: unknown, depth = 0): void => {
    if (depth > 12) return;
    if (typeof node === "string") {
      for (const line of node.split(/\r?\n/)) {
        if (/\b(error|exception|traceback|attempt to|stack begin)\b/i.test(line)) push("error", line);
        else if (/\bwarn(?:ing)?\b/i.test(line)) push("warning", line);
      }
      return;
    }
    if (typeof node !== "object" || node === null || visited.has(node)) return;
    visited.add(node);
    if (Array.isArray(node)) {
      for (const entry of node) visit(entry, depth + 1);
      return;
    }
    const record = node as Record<string, unknown>;
    const severityRaw = [record.severity, record.level, record.type, record.messageType]
      .find((entry) => typeof entry === "string") as string | undefined;
    const messageRaw = [record.message, record.text, record.output, record.content]
      .find((entry) => typeof entry === "string") as string | undefined;
    if (severityRaw && messageRaw) {
      if (/error|exception/i.test(severityRaw)) push("error", messageRaw);
      else if (/warn/i.test(severityRaw)) push("warning", messageRaw);
    }
    for (const entry of Object.values(record)) visit(entry, depth + 1);
  };

  visit(value);
  return diagnostics;
}

function newDiagnostics(
  baseline: ConsoleDiagnostic[],
  final: ConsoleDiagnostic[]
): ConsoleDiagnostic[] {
  const existing = new Set(baseline.map((entry) => `${entry.severity}:${entry.message}`));
  return final.filter((entry) => !existing.has(`${entry.severity}:${entry.message}`));
}

function combineSignal(external: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`Scenario timed out after ${timeoutMs}ms.`)), timeoutMs);
  timeout.unref?.();
  const onAbort = (): void => controller.abort(external?.reason);
  if (external) {
    if (external.aborted) onAbort();
    else external.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout);
      external?.removeEventListener("abort", onAbort);
    }
  };
}

export class ScenarioStore {
  readonly directory: string;

  constructor(
    cwd: string,
    private readonly config: RobloxConfig
  ) {
    this.directory = resolve(cwd, config.scenarios.directory);
    if (!isInside(cwd, this.directory)) {
      throw new Error(`Scenario directory must be inside the workspace: ${this.directory}`);
    }
  }

  async list(): Promise<Array<{ name: string; path: string; description?: string }>> {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }

    const output: Array<{ name: string; path: string; description?: string }> = [];
    for (const name of names.sort()) {
      if (!/\.(?:json|jsonc)$/i.test(name)) continue;
      try {
        const loaded = await this.load(resolve(this.directory, name));
        const item: { name: string; path: string; description?: string } = {
          name: loaded.scenario.name,
          path: loaded.path
        };
        if (loaded.scenario.description) item.description = loaded.scenario.description;
        output.push(item);
      } catch {
        output.push({ name: basename(name, extname(name)), path: resolve(this.directory, name) });
      }
    }
    return output;
  }

  async load(nameOrPath: string): Promise<{ path: string; scenario: RobloxScenario }> {
    const direct = resolve(this.directory, nameOrPath);
    const candidates = [
      direct,
      resolve(this.directory, `${nameOrPath}.json`),
      resolve(this.directory, `${nameOrPath}.jsonc`)
    ];
    const path = candidates.find((candidate) => isInside(this.directory, candidate) && existsSync(candidate));
    if (!path) throw new Error(`Scenario not found in ${this.directory}: ${nameOrPath}`);
    if (!isInside(this.directory, path)) throw new Error(`Scenario path escapes its directory: ${path}`);
    const source = await readFile(path, "utf8");
    return { path, scenario: parseScenario(parseScenarioText(source, path), path) };
  }

  async ensureDirectory(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
  }

  async writeExample(name = "smoke.json"): Promise<string> {
    await this.ensureDirectory();
    const path = resolve(this.directory, safeFilename(name, "smoke.json"));
    if (!isInside(this.directory, path)) throw new Error("Invalid scenario example path.");
    const example: RobloxScenario = {
      version: 1,
      name: "Studio smoke test",
      description: "Starts a playtest, executes a simple server assertion, captures the viewport, and stops.",
      timeoutMs: 60_000,
      steps: [
        { kind: "play", action: "start", mode: "play" },
        {
          kind: "luau",
          dataModelType: "Server",
          code: "return game ~= nil and game:GetService('Workspace') ~= nil",
          expect: { truthy: true },
          saveAs: "workspace-available"
        },
        { kind: "capture", name: "smoke-viewport" },
        { kind: "play", action: "stop" }
      ],
      alwaysStopPlay: true
    };
    await writeFile(path, `${JSON.stringify(example, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    return path;
  }
}

export class ScenarioRunner {
  constructor(
    private readonly config: RobloxConfig,
    private readonly artifacts: ArtifactStore,
    private readonly bridge: ScenarioToolBridge
  ) {}

  async run(
    scenario: RobloxScenario,
    options: { sourcePath?: string | undefined; signal?: AbortSignal | undefined } = {}
  ): Promise<ScenarioRunResult> {
    const started = Date.now();
    const startedAt = new Date(started).toISOString();
    const artifactRun = this.artifacts.run(`scenario-${safeFilename(scenario.name)}`);
    await artifactRun.initialize();
    const timeoutMs = scenario.timeoutMs ?? this.config.scenarios.defaultTimeoutMs;
    const combined = combineSignal(options.signal, timeoutMs);
    const savedValues: Record<string, unknown> = {};
    const stepResults: ScenarioStepResult[] = [];
    let playStarted = false;
    let baselineDiagnostics: ConsoleDiagnostic[] = [];
    let finalDiagnostics: ConsoleDiagnostic[] = [];

    const consoleResult = async (dataModelType: ScenarioDataModelType): Promise<StudioToolResult> => {
      const tool = await this.bridge.getTool("get_console_output");
      return this.bridge.callTool(
        tool.name,
        addDataModelType(tool, {}, dataModelType),
        { signal: combined.signal, timeoutMs: Math.min(timeoutMs, 120_000) }
      );
    };
    const parseDiagnostics = (result: StudioToolResult): ConsoleDiagnostic[] =>
      this.bridge.parseConsole?.(result) ?? diagnosticsFromValue(result);

    try {
      try {
        baselineDiagnostics = parseDiagnostics(await consoleResult("Edit"));
      } catch {
        baselineDiagnostics = [];
      }

      const phases: Array<{ name: "setup" | "steps"; steps: ScenarioStep[] }> = [
        { name: "setup", steps: scenario.setup ?? [] },
        { name: "steps", steps: scenario.steps }
      ];

      let failed = false;
      for (const phase of phases) {
        for (let index = 0; index < phase.steps.length; index += 1) {
          const step = phase.steps[index]!;
          const result = await this.executeStep(
            phase.name,
            index,
            step,
            savedValues,
            artifactRun,
            combined.signal,
            (startedValue) => {
              playStarted = startedValue;
            }
          );
          stepResults.push(result);
          if (result.status !== "pass" && !("continueOnFailure" in step && step.continueOnFailure)) {
            failed = true;
            break;
          }
        }
        if (failed) break;
      }

      // Teardown runs even after a failed main step and does not hide the primary failure.
      for (let index = 0; index < (scenario.teardown ?? []).length; index += 1) {
        const step = scenario.teardown![index]!;
        const result = await this.executeStep(
          "teardown",
          index,
          step,
          savedValues,
          artifactRun,
          combined.signal,
          (startedValue) => {
            playStarted = startedValue;
          }
        ).catch((error) => ({
          phase: "teardown" as const,
          index,
          kind: step.kind,
          status: combined.signal.aborted ? "cancelled" as const : "fail" as const,
          startedAt: new Date().toISOString(),
          durationMs: 0,
          summary: "Teardown step failed.",
          error: (error as Error).message
        }));
        stepResults.push(result);
      }

      try {
        const finalConsole = await consoleResult(playStarted ? "Server" : "Edit");
        await artifactRun.writeStudioResult("final-console", finalConsole);
        finalDiagnostics = parseDiagnostics(finalConsole);
      } catch (error) {
        stepResults.push({
          phase: "finalize",
          index: 0,
          kind: "console-analysis",
          status: "fail",
          startedAt: new Date().toISOString(),
          durationMs: 0,
          summary: "Could not retrieve final console output.",
          error: (error as Error).message
        });
      }
    } finally {
      if ((scenario.alwaysStopPlay ?? true) && playStarted) {
        const stopStarted = Date.now();
        try {
          const tool = await this.bridge.getTool("start_stop_play");
          await this.bridge.callTool(tool.name, buildPlayArguments(tool, "stop"), {
            timeoutMs: 30_000
          });
          stepResults.push({
            phase: "finalize",
            index: 1,
            kind: "stop-play",
            status: "pass",
            startedAt: new Date(stopStarted).toISOString(),
            durationMs: Date.now() - stopStarted,
            summary: "Stopped playtest."
          });
        } catch (error) {
          stepResults.push({
            phase: "finalize",
            index: 1,
            kind: "stop-play",
            status: "fail",
            startedAt: new Date(stopStarted).toISOString(),
            durationMs: Date.now() - stopStarted,
            summary: "Could not stop playtest.",
            error: (error as Error).message
          });
        }
      }
      combined.cleanup();
    }

    const diagnostics = newDiagnostics(baselineDiagnostics, finalDiagnostics);
    const failOnErrors = scenario.failOnConsoleErrors ?? this.config.scenarios.failOnConsoleErrors;
    const failOnWarnings =
      scenario.failOnConsoleWarnings ?? this.config.scenarios.failOnConsoleWarnings;
    const consoleFailed = diagnostics.some(
      (entry) =>
        (entry.severity === "error" && failOnErrors) ||
        (entry.severity === "warning" && failOnWarnings)
    );

    if (diagnostics.length > 0) {
      stepResults.push({
        phase: "finalize",
        index: 2,
        kind: "console-analysis",
        status: consoleFailed ? "fail" : "pass",
        startedAt: new Date().toISOString(),
        durationMs: 0,
        summary: `${diagnostics.length} new console diagnostic(s).`,
        value: diagnostics
      });
    }

    const cancelled = options.signal?.aborted || stepResults.some((result) => result.status === "cancelled");
    const status: ScenarioRunResult["status"] = cancelled
      ? "cancelled"
      : consoleFailed || stepResults.some((result) => result.status === "fail")
        ? "fail"
        : "pass";

    const reportWithoutArtifact = {
      scenario: scenario.name,
      ...(scenario.description ? { description: scenario.description } : {}),
      status,
      startedAt,
      durationMs: Date.now() - started,
      artifactRunId: artifactRun.id,
      artifactDirectory: artifactRun.directory,
      ...(options.sourcePath ? { sourcePath: options.sourcePath } : {}),
      steps: stepResults,
      diagnostics,
      savedValues
    };
    const reportArtifact = await artifactRun.writeJson("report", reportWithoutArtifact);
    return { ...reportWithoutArtifact, reportArtifact };
  }

  private async executeStep(
    phase: "setup" | "steps" | "teardown",
    index: number,
    step: ScenarioStep,
    savedValues: Record<string, unknown>,
    artifacts: ReturnType<ArtifactStore["run"]>,
    signal: AbortSignal,
    setPlayStarted: (value: boolean) => void
  ): Promise<ScenarioStepResult> {
    const started = Date.now();
    const startedAt = new Date(started).toISOString();
    const base = {
      phase,
      index,
      kind: step.kind,
      startedAt
    } as const;

    if (signal.aborted) {
      return {
        ...base,
        status: "cancelled",
        durationMs: 0,
        summary: "Scenario was cancelled before this step."
      };
    }

    try {
      if (step.kind === "wait") {
        await delay(step.milliseconds, undefined, { signal });
        return {
          ...base,
          status: "pass",
          durationMs: Date.now() - started,
          summary: `Waited ${step.milliseconds}ms.`
        };
      }

      if (step.kind === "assert") {
        const source = step.from ? savedValues[step.from] : step.value;
        const checked = evaluateExpectation(source, step.expect);
        return {
          ...base,
          status: checked.pass ? "pass" : "fail",
          durationMs: Date.now() - started,
          summary: `${checked.pass ? "Assertion passed" : "Assertion failed"}: ${checked.message}.`,
          value: checked.actual
        };
      }

      let toolName: string;
      let args: Record<string, unknown>;
      let artifactName: string | undefined;
      let expected: ScenarioExpectation | undefined;
      let saveAs: string | undefined;

      switch (step.kind) {
        case "tool":
          toolName = step.tool;
          args = step.arguments ?? {};
          expected = step.expect;
          saveAs = step.saveAs;
          artifactName = step.saveAs ?? `${phase}-${index + 1}-${step.tool}`;
          break;
        case "luau": {
          const tool = await this.bridge.getTool("execute_luau");
          toolName = tool.name;
          args = buildExecuteLuauArguments(tool, step.code, step.dataModelType ?? "Server");
          expected = step.expect;
          saveAs = step.saveAs;
          artifactName = step.saveAs ?? `${phase}-${index + 1}-luau`;
          break;
        }
        case "play": {
          const tool = await this.bridge.getTool("start_stop_play");
          toolName = tool.name;
          args = buildPlayArguments(tool, step.action, step.mode ?? "play");
          artifactName = `${phase}-${index + 1}-play-${step.action}`;
          break;
        }
        case "capture": {
          const tool = await this.bridge.getTool("screen_capture");
          toolName = tool.name;
          artifactName = step.name ?? `${phase}-${index + 1}-capture`;
          args = buildScreenCaptureArguments(tool, artifactName, step.arguments ?? {});
          break;
        }
        case "console": {
          const tool = await this.bridge.getTool("get_console_output");
          toolName = tool.name;
          args = addDataModelType(tool, {}, step.dataModelType ?? "Server");
          expected = step.expect;
          artifactName = step.name ?? `${phase}-${index + 1}-console`;
          break;
        }
        case "navigate": {
          const tool = await this.bridge.getTool("character_navigation");
          toolName = tool.name;
          args = { ...buildNavigationArguments(tool, step.target), ...(step.arguments ?? {}) };
          artifactName = `${phase}-${index + 1}-navigate`;
          break;
        }
      }

      const result = await this.bridge.callTool(toolName!, args!, { signal, timeoutMs: 120_000 });
      const value = resultValue(result);
      const artifactReferences = await artifacts.writeStudioResult(artifactName!, result);
      if (saveAs) savedValues[saveAs] = value;
      if (step.kind === "play") setPlayStarted(step.action === "start");

      if (result.isError) {
        return {
          ...base,
          status: "fail",
          durationMs: Date.now() - started,
          summary: `${toolName!} returned an MCP error.`,
          value,
          artifacts: artifactReferences
        };
      }

      if (expected) {
        const checked = evaluateExpectation(value, expected);
        return {
          ...base,
          status: checked.pass ? "pass" : "fail",
          durationMs: Date.now() - started,
          summary: `${checked.pass ? "Expectation passed" : "Expectation failed"}: ${checked.message}.`,
          value: checked.actual,
          artifacts: artifactReferences
        };
      }

      return {
        ...base,
        status: "pass",
        durationMs: Date.now() - started,
        summary: `${toolName!} completed.`,
        value,
        artifacts: artifactReferences
      };
    } catch (error) {
      return {
        ...base,
        status: signal.aborted ? "cancelled" : "fail",
        durationMs: Date.now() - started,
        summary: `${step.kind} step failed.`,
        error: truncateText((error as Error).message, 8_000)
      };
    }
  }
}
