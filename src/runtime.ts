import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ArtifactStore } from "./artifacts.js";
import { AuditLog, type AuditContext } from "./audit.js";
import { CheckpointManager, type RestoreOptions } from "./checkpoints.js";
import type { RobloxConfig } from "./config.js";
import { loadRobloxConfig } from "./config.js";
import { parseConsoleResult } from "./console.js";
import {
  executeFileTransaction,
  type FileMutationOperation,
  type FileSyncEvidence,
  type FileTransactionResult
} from "./file-transaction.js";
import { OwnershipResolver, type OwnershipRecord } from "./ownership.js";
import { RojoIndex, type CommandRunner } from "./rojo-index.js";
import { readRojoProject, type RojoProjectMetadata } from "./rojo-project.js";
import { RojoProcessManager, type RojoServerStatus } from "./rojo-process.js";
import {
  ScenarioRunner,
  ScenarioStore,
  parseScenario,
  type RobloxScenario,
  type ScenarioRunResult
} from "./scenarios.js";
import { SourceIndex, type ProjectSnapshot, type SourceSearchResult } from "./source-index.js";
import {
  StudioClient,
  studioResultJson,
  studioResultText,
  type StudioCallOptions,
  type StudioToolDescriptor,
  type StudioToolResult
} from "./studio-client.js";
import {
  READ_ONLY_STUDIO_TOOLS,
  StudioSchemaValidator,
  addDataModelType,
  buildExecuteLuauArguments,
  buildPathArguments,
  inferArgumentKey,
  normalizeScriptReadText
} from "./studio-schema.js";
import {
  generateStudioRollbackLuau,
  generateStudioTransactionLuau,
  parseStudioTransactionResult,
  validateStudioOperations,
  type StudioMutationOperation,
  type StudioTransactionPayload,
  type StudioTransactionSnapshot
} from "./studio-transaction.js";
import { runValidation, type ValidationRun } from "./validation.js";
import { boundedJson, findStudioPaths, sha256, toPosixPath } from "./util.js";

export type ApprovalCallback = (title: string, detail: string) => Promise<boolean>;

export interface RuntimeStatus {
  cwd: string;
  configPath: string;
  configExists: boolean;
  configWarnings: string[];
  mode: RobloxConfig["mode"];
  projectFile: string;
  projectExists: boolean;
  project?: RojoProjectMetadata;
  sourcemapFile?: string;
  indexedInstances: number;
  mappedSourceFiles: number;
  ownershipConflicts: number;
  rojoServer?: RojoServerStatus;
  studioConnected: boolean;
  studioToolCount: number;
  missingStudioTools: string[];
  studioStderrTail?: string;
  rojoError?: string;
  studioError?: string;
}

export interface DoctorCheck {
  name: string;
  status: "pass" | "fail" | "warning" | "skipped";
  detail: string;
}

export interface DoctorResult {
  status: "pass" | "fail";
  checks: DoctorCheck[];
  runtime: RuntimeStatus;
}

export interface RuntimeSearchResult {
  query: string;
  source?: SourceSearchResult;
  mappings: Array<{ studioPath: string; className: string; sourcePath?: string }>;
  studio?: StudioToolResult;
}

export interface RuntimeInspection {
  ownership: OwnershipRecord;
  file?: {
    path: string;
    sha256: string;
    size: number;
    content: string;
    truncated: boolean;
  };
  dependencies?: Awaited<ReturnType<SourceIndex["dependencies"]>>;
  studio?: StudioToolResult;
}

export interface StudioMutationResult {
  status: "dry-run" | "applied";
  checkpointId?: string;
  operations: StudioMutationOperation[];
  payload?: StudioTransactionPayload;
  result?: StudioToolResult;
}

export interface RollbackResult {
  checkpointId: string;
  filesRestored: number;
  studio?: StudioToolResult;
  studioPayload?: unknown;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeSource(value: string): string {
  return value.replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim();
}

function valueContainsSource(value: unknown, expected: string, depth = 0): boolean {
  if (depth > 12) return false;
  if (typeof value === "string") {
    if (normalizeSource(value).includes(expected)) return true;
    try {
      return valueContainsSource(JSON.parse(value) as unknown, expected, depth + 1);
    } catch {
      return false;
    }
  }
  if (typeof value !== "object" || value === null) return false;
  if (Array.isArray(value)) return value.some((entry) => valueContainsSource(entry, expected, depth + 1));
  return Object.values(value as Record<string, unknown>).some((entry) =>
    valueContainsSource(entry, expected, depth + 1)
  );
}

function findNumericField(value: unknown, names: ReadonlySet<string>, depth = 0): number | undefined {
  if (depth > 10 || typeof value !== "object" || value === null) return undefined;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findNumericField(entry, names, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (names.has(key.toLowerCase())) {
      const number = typeof child === "number" ? child : typeof child === "string" ? Number(child) : NaN;
      if (Number.isSafeInteger(number) && number > 0) return number;
    }
    const found = findNumericField(child, names, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

export class RobloxRuntime {
  readonly studio = new StudioClient();

  #config: RobloxConfig | undefined;
  #configPath = "";
  #configExists = false;
  #configWarnings: string[] = [];
  #project: RojoProjectMetadata | undefined;
  #rojo: RojoIndex | undefined;
  #resolver: OwnershipResolver | undefined;
  #sourceIndex: SourceIndex | undefined;
  #rojoProcess: RojoProcessManager | undefined;
  #checkpoints: CheckpointManager | undefined;
  #audit: AuditLog | undefined;
  #artifacts: ArtifactStore | undefined;
  #scenarioStore: ScenarioStore | undefined;
  #schemaValidator = new StudioSchemaValidator();
  #rojoError: string | undefined;
  #studioError: string | undefined;

  constructor(
    readonly cwd: string,
    readonly configDirName: string,
    private readonly run: CommandRunner
  ) {}

  get config(): RobloxConfig {
    if (!this.#config) throw new Error("Roblox runtime has not been initialized.");
    return this.#config;
  }

  get rojo(): RojoIndex | undefined {
    return this.#rojo;
  }

  get project(): RojoProjectMetadata | undefined {
    return this.#project;
  }

  get checkpoints(): CheckpointManager {
    if (!this.#checkpoints) throw new Error("Roblox runtime has not been initialized.");
    return this.#checkpoints;
  }

  get audit(): AuditLog {
    if (!this.#audit) throw new Error("Roblox runtime has not been initialized.");
    return this.#audit;
  }

  async initialize(
    signal?: AbortSignal,
    options: { connectStudio?: boolean } = {}
  ): Promise<RuntimeStatus> {
    const loaded = await loadRobloxConfig(this.cwd, this.configDirName);
    this.#config = loaded.config;
    this.#configPath = loaded.path;
    this.#configExists = loaded.exists;
    this.#configWarnings = loaded.warnings;
    this.#rojo = undefined;
    this.#project = undefined;
    this.#rojoError = undefined;
    this.#studioError = undefined;
    this.#schemaValidator.clear();

    this.#checkpoints = new CheckpointManager(this.cwd, this.config);
    this.#audit = new AuditLog(this.cwd, this.config);
    this.#artifacts = new ArtifactStore(this.cwd, this.config);
    this.#scenarioStore = new ScenarioStore(this.cwd, this.config);
    this.#rojoProcess = new RojoProcessManager(this.cwd, this.config, this.run);

    if (this.config.mode === "rojo") {
      try {
        this.#project = await readRojoProject(this.cwd, this.config.projectFile);
        this.#rojoProcess.configure(this.#project);
        if (this.config.rojo.server.autoStart) await this.#rojoProcess.start(this.#project, signal);
        await this.refreshRojo(signal);
      } catch (error) {
        this.#rojoError = errorMessage(error);
      }
    }
    this.rebuildIndexes();

    if (options.connectStudio ?? this.config.studio.autoConnect) {
      try {
        await this.connectStudio();
      } catch (error) {
        this.#studioError = errorMessage(error);
      }
    }

    await this.audit.record("runtime.initialized", {
      mode: this.config.mode,
      configExists: this.#configExists,
      rojoError: this.#rojoError,
      studioError: this.#studioError
    }, { source: "system" });
    return this.status();
  }

  private rebuildIndexes(): void {
    this.#resolver = new OwnershipResolver(this.cwd, this.config, this.#rojo);
    this.#sourceIndex = new SourceIndex(this.cwd, this.config, this.#rojo);
  }

  async refreshRojo(signal?: AbortSignal): Promise<void> {
    if (this.config.mode !== "rojo") return;
    this.#rojo = await RojoIndex.refresh(this.cwd, this.config, this.run, signal);
    this.#rojoError = undefined;
    this.rebuildIndexes();
  }

  async connectStudio(): Promise<void> {
    await this.studio.connect(this.cwd, this.config);
    this.#studioError = undefined;
    this.#schemaValidator.clear();
    await this.audit.record("studio.connected", {}, { source: "runtime" });
  }

  async disconnectStudio(): Promise<void> {
    await this.studio.close();
    await this.audit.record("studio.disconnected", {}, { source: "runtime" });
  }

  async status(): Promise<RuntimeStatus> {
    let tools: StudioToolDescriptor[] = [];
    if (this.studio.connected) {
      try {
        tools = await this.studio.listTools();
        this.#studioError = undefined;
      } catch (error) {
        this.#studioError = errorMessage(error);
      }
    }
    const toolNames = new Set(tools.map((tool) => tool.name));
    const result: RuntimeStatus = {
      cwd: this.cwd,
      configPath: this.#configPath,
      configExists: this.#configExists,
      configWarnings: [...this.#configWarnings],
      mode: this.config.mode,
      projectFile: resolve(this.cwd, this.config.projectFile),
      projectExists: existsSync(resolve(this.cwd, this.config.projectFile)),
      indexedInstances: this.#rojo?.entries.length ?? 0,
      mappedSourceFiles: this.#rojo?.sourceFiles().length ?? 0,
      ownershipConflicts: this.#rojo?.conflicts.length ?? 0,
      studioConnected: this.studio.connected,
      studioToolCount: tools.length,
      missingStudioTools: this.config.studio.requiredTools.filter((name) => !toolNames.has(name))
    };
    if (this.#project) result.project = structuredClone(this.#project);
    if (this.#rojo) result.sourcemapFile = this.#rojo.sourcemapFile;
    if (this.#rojoProcess && this.#project) result.rojoServer = await this.#rojoProcess.status();
    if (this.studio.stderrTail) result.studioStderrTail = this.studio.stderrTail;
    if (this.#rojoError) result.rojoError = this.#rojoError;
    if (this.#studioError) result.studioError = this.#studioError;
    return result;
  }

  async doctor(options: { connectStudio?: boolean; signal?: AbortSignal } = {}): Promise<DoctorResult> {
    if (options.connectStudio && !this.studio.connected) {
      try {
        await this.connectStudio();
      } catch (error) {
        this.#studioError = errorMessage(error);
      }
    }
    const runtime = await this.status();
    const checks: DoctorCheck[] = [];
    checks.push({
      name: "configuration",
      status: runtime.configExists ? "pass" : "warning",
      detail: runtime.configExists ? runtime.configPath : `No config at ${runtime.configPath}; secure defaults are active.`
    });
    if (runtime.mode === "rojo") {
      checks.push({
        name: "rojo-project",
        status: runtime.projectExists ? "pass" : "fail",
        detail: runtime.projectExists ? runtime.projectFile : `Missing ${runtime.projectFile}`
      });
      checks.push({
        name: "rojo-sourcemap",
        status: runtime.rojoError || !runtime.sourcemapFile ? "fail" : "pass",
        detail: runtime.rojoError ?? `${runtime.indexedInstances} instances and ${runtime.mappedSourceFiles} source files indexed.`
      });
      checks.push({
        name: "rojo-server",
        status: runtime.rojoServer?.ready ? "pass" : "fail",
        detail: runtime.rojoServer?.ready
          ? `Ready at ${runtime.rojoServer.url}${runtime.rojoServer.ownedByExtension ? " (managed)" : " (external)"}.`
          : runtime.rojoServer?.error ?? "Rojo serve is not ready."
      });
    }
    checks.push({
      name: "ownership-conflicts",
      status: runtime.ownershipConflicts === 0 ? "pass" : "fail",
      detail: runtime.ownershipConflicts === 0 ? "No duplicate Studio/source mappings." : `${runtime.ownershipConflicts} conflicting mappings.`
    });
    if (options.connectStudio === false) {
      checks.push({ name: "studio", status: "skipped", detail: "Studio connection check disabled." });
    } else {
      checks.push({
        name: "studio",
        status: runtime.studioConnected ? "pass" : "fail",
        detail: runtime.studioConnected ? `${runtime.studioToolCount} MCP tools discovered.` : runtime.studioError ?? "Studio MCP is disconnected."
      });
      checks.push({
        name: "studio-required-tools",
        status: runtime.missingStudioTools.length === 0 ? "pass" : "fail",
        detail: runtime.missingStudioTools.length === 0 ? "All required tools are present." : `Missing: ${runtime.missingStudioTools.join(", ")}`
      });
      if (runtime.studioConnected) {
        try {
          const place = await this.currentPlaceId(options.signal);
          const expected = this.expectedPlaceIds();
          checks.push({
            name: "place-guard",
            status: expected.length > 0 && place !== undefined && expected.includes(place) ? "pass" : "fail",
            detail: expected.length === 0
              ? "No expected place IDs are configured."
              : place === undefined
                ? "Studio did not report a place ID."
                : expected.includes(place)
                  ? `Studio place ${place} is allowed.`
                  : `Studio place ${place} is not one of ${expected.join(", ")}.`
          });
        } catch (error) {
          checks.push({ name: "place-guard", status: "fail", detail: errorMessage(error) });
        }
      }
    }
    const status = checks.some((check) => check.status === "fail") ? "fail" : "pass";
    const result: DoctorResult = { status, checks, runtime };
    await this.audit.record("doctor.complete", result, { source: "runtime" });
    return result;
  }

  ownership(target: string): OwnershipRecord {
    if (!this.#resolver) throw new Error("Roblox runtime has not been initialized.");
    return this.#resolver.resolve(target);
  }

  async snapshot(): Promise<ProjectSnapshot> {
    if (!this.#sourceIndex) throw new Error("Roblox runtime has not been initialized.");
    return this.#sourceIndex.snapshot();
  }

  async search(
    query: string,
    options: number | { limit?: number; source?: boolean; regex?: boolean; caseSensitive?: boolean; studio?: boolean } = {}
  ): Promise<RuntimeSearchResult> {
    const normalized = typeof options === "number" ? { limit: options } : options;
    const limit = Math.max(1, Math.min(normalized.limit ?? this.config.context.maxSearchResults, 1_000));
    const mappings = (this.#rojo?.search(query, this.cwd, limit) ?? []).map((entry) => ({
      studioPath: entry.studioPath,
      className: entry.className,
      ...(entry.sourcePath ? { sourcePath: toPosixPath(relative(this.cwd, entry.sourcePath)) } : {})
    }));
    const result: RuntimeSearchResult = { query, mappings };
    if (normalized.source ?? true) {
      if (!this.#sourceIndex) throw new Error("Roblox runtime has not been initialized.");
      result.source = await this.#sourceIndex.search(query, {
        limit,
        regex: normalized.regex,
        caseSensitive: normalized.caseSensitive
      });
    }
    if (normalized.studio && this.studio.connected) {
      const tool = await this.getStudioTool("search_game_tree");
      const queryKey = inferArgumentKey(tool, ["query", "keywords", "search", "text", "pattern"], "search query");
      const args: Record<string, unknown> = { [queryKey!]: query };
      const properties = tool.inputSchema.properties as Record<string, unknown> | undefined;
      if (properties && "limit" in properties) args.limit = limit;
      result.studio = await this.callStudioTool(tool.name, args, async () => true);
    }
    return result;
  }

  async inspect(target: string, signal?: AbortSignal): Promise<RuntimeInspection> {
    const ownership = this.ownership(target);
    const inspection: RuntimeInspection = { ownership };
    if (ownership.sourcePath && existsSync(ownership.sourcePath)) {
      const data = await readFile(ownership.sourcePath);
      const content = data.toString("utf8");
      inspection.file = {
        path: ownership.sourcePath,
        sha256: sha256(data),
        size: data.byteLength,
        content: content.slice(0, this.config.context.maxFileChars),
        truncated: content.length > this.config.context.maxFileChars
      };
      const dependencies = await this.#sourceIndex?.dependencies();
      if (dependencies) inspection.dependencies = dependencies.filter(
        (edge) => resolve(this.cwd, edge.sourcePath) === resolve(ownership.sourcePath!)
      );
    }
    if (ownership.studioPath && this.studio.connected) {
      const tool = await this.getStudioTool("inspect_instance");
      inspection.studio = await this.studio.callTool(
        tool.name,
        buildPathArguments(tool, ownership.studioPath),
        signal ? { signal } : {}
      );
    }
    return inspection;
  }

  async listStudioTools(refresh = false): Promise<StudioToolDescriptor[]> {
    if (!this.studio.connected) await this.connectStudio();
    return this.studio.listTools(refresh);
  }

  private async getStudioTool(name: string): Promise<StudioToolDescriptor> {
    const tool = (await this.listStudioTools()).find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`Roblox Studio MCP does not expose required tool ${name}.`);
    return tool;
  }

  async callStudioTool(
    name: string,
    args: Record<string, unknown>,
    approve: ApprovalCallback,
    signalOrOptions?: AbortSignal | StudioCallOptions,
    auditContext?: AuditContext
  ): Promise<StudioToolResult> {
    if (!this.studio.connected) await this.connectStudio();
    if (this.isStudioToolDenied(name)) {
      throw new Error(`Studio tool ${name} is denied by the strict Pi-only policy.`);
    }
    const tool = await this.getStudioTool(name);
    this.#schemaValidator.validate(tool, args);
    const readOnly = READ_ONLY_STUDIO_TOOLS.has(name);
    const targets = findStudioPaths(args);
    if (!readOnly) {
      if (this.config.permissions.profile === "observe") {
        throw new Error(`Studio mutation ${name} is blocked by the observe permission profile.`);
      }
      for (const target of targets) {
        const ownership = this.ownership(target);
        if (ownership.ownership !== "studio-owned") {
          throw new Error(`Refusing Studio mutation for ${target}: ${ownership.reason}`);
        }
      }
      if (name !== "set_active_studio" && name !== "terminate_server") await this.assertExpectedPlace(signalOrOptions instanceof AbortSignal ? signalOrOptions : signalOrOptions?.signal);
      const mustAsk = this.config.permissions.profile !== "autonomous-local" || this.config.studio.alwaysAskTools.includes(name);
      if (mustAsk) {
        const accepted = await approve(`Allow Roblox Studio tool: ${name}`, boundedJson({ targets, arguments: args }, 12_000));
        if (!accepted) throw new Error(`The user rejected Studio tool ${name}.`);
      }
      await this.audit.record("studio-tool.before-mutation", { name, targets, arguments: args }, auditContext);
    }
    const options: StudioCallOptions = signalOrOptions instanceof AbortSignal
      ? { signal: signalOrOptions }
      : signalOrOptions ?? {};
    const result = await this.studio.callTool(name, args, options);
    await this.audit.record(readOnly ? "studio-tool.read" : "studio-tool.after-mutation", { name, targets, isError: result.isError === true }, auditContext);
    return result;
  }

  isStudioToolDenied(name: string): boolean {
    return this.config.studio.deniedTools.includes(name) || name.toLowerCase().includes("subagent");
  }

  async files(
    operations: FileMutationOperation[],
    options: {
      dryRun?: boolean;
      validationProfile?: string;
      validate?: boolean;
      signal?: AbortSignal;
      auditContext?: AuditContext;
      label?: string;
    } = {}
  ): Promise<FileTransactionResult> {
    if (!this.#resolver) throw new Error("Roblox runtime has not been initialized.");
    return executeFileTransaction({
      cwd: this.cwd,
      config: this.config,
      resolver: this.#resolver,
      checkpoints: this.checkpoints,
      audit: this.audit,
      refreshRojo: (signal) => this.refreshRojo(signal),
      verifySync: (sourcePath, studioPath, signal) => this.verifyStudioSource(sourcePath, studioPath, signal),
      validate: (profile, signal) => this.validate(profile, signal)
    }, operations, options);
  }

  async replaceFile(params: {
    target: string;
    content: string;
    expectedSha256?: string;
    validate?: boolean;
    validationProfile?: string;
    signal?: AbortSignal;
    auditContext?: AuditContext;
    label?: string;
  }): Promise<FileTransactionResult> {
    return this.files([{
      kind: "write",
      target: params.target,
      content: params.content,
      ...(params.expectedSha256 !== undefined ? { expectedSha256: params.expectedSha256 } : {})
    }], {
      validate: params.validate ?? true,
      ...(params.validationProfile !== undefined ? { validationProfile: params.validationProfile } : {}),
      ...(params.signal ? { signal: params.signal } : {}),
      ...(params.auditContext ? { auditContext: params.auditContext } : {}),
      label: params.label ?? `replace ${params.target}`
    });
  }

  async mutateStudio(
    operations: StudioMutationOperation[],
    approve: ApprovalCallback,
    options: { dryRun?: boolean; label?: string; signal?: AbortSignal; auditContext?: AuditContext } = {}
  ): Promise<StudioMutationResult> {
    validateStudioOperations(operations);
    for (const operation of operations) {
      const paths = operation.kind === "create"
        ? [operation.parent]
        : operation.kind === "reparent"
          ? [operation.target, operation.parent]
          : [operation.target];
      for (const path of paths) {
        const ownership = this.ownership(path);
        if (ownership.ownership !== "studio-owned") {
          throw new Error(`Refusing structured Studio mutation for ${path}: ${ownership.reason}`);
        }
      }
    }
    if (options.dryRun) {
      await this.audit.record("studio-transaction.dry-run", { operations }, options.auditContext);
      return { status: "dry-run", operations: structuredClone(operations) };
    }
    const checkpoint = await this.checkpoints.create([], options.label ?? "Studio transaction", {
      operationCount: operations.length
    });
    const tool = await this.getStudioTool("execute_luau");
    const code = generateStudioTransactionLuau(checkpoint.id, operations);
    try {
      await this.audit.record("studio-transaction.begin", { checkpointId: checkpoint.id, operations }, options.auditContext);
      const result = await this.callStudioTool(
        tool.name,
        buildExecuteLuauArguments(tool, code, "Edit"),
        approve,
        options.signal,
        options.auditContext
      );
      const payload = parseStudioTransactionResult(result);
      await this.checkpoints.attachStudioSnapshot(checkpoint.id, payload.snapshot, {
        rollbackSupported: true,
        summary: `${operations.length} structured Studio operation(s)`
      });
      await this.checkpoints.finalize(checkpoint.id);
      await this.audit.record("studio-transaction.complete", { checkpointId: checkpoint.id, payload }, options.auditContext);
      return { status: "applied", checkpointId: checkpoint.id, operations: structuredClone(operations), payload, result };
    } catch (error) {
      await this.audit.record("studio-transaction.failed", { checkpointId: checkpoint.id, error: errorMessage(error) }, options.auditContext);
      throw error;
    }
  }

  async validate(profileOrSignal?: string | AbortSignal, signal?: AbortSignal): Promise<ValidationRun> {
    const profile = typeof profileOrSignal === "string" ? profileOrSignal : undefined;
    const actualSignal = profileOrSignal instanceof AbortSignal ? profileOrSignal : signal;
    return runValidation(this.cwd, this.config, this.run, {
      ...(profile !== undefined ? { profile } : {}),
      ...(actualSignal ? { signal: actualSignal } : {})
    });
  }

  async listScenarios(): ReturnType<ScenarioStore["list"]> {
    if (!this.#scenarioStore) throw new Error("Roblox runtime has not been initialized.");
    return this.#scenarioStore.list();
  }

  async writeExampleScenario(name?: string): Promise<string> {
    if (!this.#scenarioStore) throw new Error("Roblox runtime has not been initialized.");
    return this.#scenarioStore.writeExample(name);
  }

  async runScenario(
    nameOrScenario: string | RobloxScenario | unknown,
    approve: ApprovalCallback,
    signal?: AbortSignal,
    auditContext?: AuditContext
  ): Promise<ScenarioRunResult> {
    if (!this.#scenarioStore || !this.#artifacts) throw new Error("Roblox runtime has not been initialized.");
    let scenario: RobloxScenario;
    let sourcePath: string | undefined;
    if (typeof nameOrScenario === "string") {
      const loaded = await this.#scenarioStore.load(nameOrScenario);
      scenario = loaded.scenario;
      sourcePath = loaded.path;
    } else {
      scenario = parseScenario(nameOrScenario, "inline scenario");
    }
    const runner = new ScenarioRunner(this.config, this.#artifacts, {
      getTool: (name) => this.getStudioTool(name),
      callTool: (name, args, options) => this.callStudioTool(name, args, approve, options ? {
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {})
      } : undefined, auditContext),
      parseConsole: (result) => parseConsoleResult(this.cwd, this.#rojo, result).entries
        .filter((entry): entry is typeof entry & { severity: "error" | "warning" } =>
          entry.severity === "error" || entry.severity === "warning"
        )
        .map((entry) => ({
          severity: entry.severity,
          message: entry.message,
          ...(entry.timestamp ? { timestamp: entry.timestamp } : {}),
          ...(entry.studioPath ? { studioPath: entry.studioPath } : {}),
          ...(entry.sourcePath ? { sourcePath: entry.sourcePath } : {}),
          ...(entry.line !== undefined ? { line: entry.line } : {})
        }))
    });
    await this.audit.record("scenario.begin", { name: scenario.name, sourcePath }, auditContext);
    const result = await runner.run(scenario, {
      ...(sourcePath ? { sourcePath } : {}),
      ...(signal ? { signal } : {})
    });
    await this.audit.record("scenario.complete", result, auditContext);
    return result;
  }

  async createCheckpoint(paths: string[], label: string, metadata?: Record<string, unknown>) {
    const checkpoint = await this.checkpoints.create(
      paths.map((path) => resolve(this.cwd, path)),
      label,
      metadata
    );
    // A user-created checkpoint is a completed snapshot, not the beginning of
    // a pending mutation. Finalizing records the current post-state so its
    // conflict checks can distinguish later edits from the captured snapshot.
    return this.checkpoints.finalize(checkpoint.id);
  }

  async rollback(
    id: string,
    options: RestoreOptions & { approve?: ApprovalCallback; signal?: AbortSignal; auditContext?: AuditContext } = {}
  ): Promise<RollbackResult> {
    const manifest = await this.checkpoints.read(id);
    let studio: StudioToolResult | undefined;
    let studioPayload: unknown;
    if (manifest.studio?.rollbackSupported) {
      const snapshot = await this.checkpoints.readStudioSnapshot(id) as StudioTransactionSnapshot | undefined;
      if (snapshot) {
        const tool = await this.getStudioTool("execute_luau");
        const approve = options.approve ?? (async () => this.config.permissions.profile === "autonomous-local");
        studio = await this.callStudioTool(
          tool.name,
          buildExecuteLuauArguments(tool, generateStudioRollbackLuau(snapshot), "Edit"),
          approve,
          options.signal,
          options.auditContext
        );
        studioPayload = studioResultJson(studio);
      }
    }
    const restored = await this.checkpoints.restore(id, { force: options.force, paths: options.paths });
    if (this.config.mode === "rojo" && restored.files.length > 0) await this.refreshRojo(options.signal);
    const result: RollbackResult = { checkpointId: id, filesRestored: restored.files.length };
    if (studio) result.studio = studio;
    if (studioPayload !== undefined) result.studioPayload = studioPayload;
    await this.audit.record("rollback.complete", result, options.auditContext);
    return result;
  }

  async rojoStatus(): Promise<RojoServerStatus | undefined> {
    return this.#rojoProcess && this.#project ? this.#rojoProcess.status() : undefined;
  }

  async rojoStart(signal?: AbortSignal): Promise<RojoServerStatus> {
    if (!this.#rojoProcess || !this.#project) throw new Error("No valid Rojo project is configured.");
    return this.#rojoProcess.start(this.#project, signal);
  }

  async rojoStop(): Promise<RojoServerStatus> {
    if (!this.#rojoProcess) throw new Error("Rojo process manager is not initialized.");
    return this.#rojoProcess.stop();
  }

  async rojoRestart(signal?: AbortSignal): Promise<RojoServerStatus> {
    if (!this.#rojoProcess || !this.#project) throw new Error("No valid Rojo project is configured.");
    const result = await this.#rojoProcess.restart(this.#project, signal);
    await this.refreshRojo(signal);
    return result;
  }

  async close(): Promise<void> {
    await Promise.allSettled([
      this.#audit?.close() ?? Promise.resolve(),
      this.#rojoProcess?.close() ?? Promise.resolve(),
      this.studio.close()
    ]);
  }

  private expectedPlaceIds(): number[] {
    return [...new Set([
      ...this.config.expectedPlaceIds,
      ...(this.#project?.servePlaceIds ?? []),
      ...(this.#project?.placeId ? [this.#project.placeId] : [])
    ])];
  }

  private async currentPlaceId(signal?: AbortSignal): Promise<number | undefined> {
    const tool = await this.getStudioTool("get_studio_state");
    const dataModels = ["Edit", "Server", "Client"] as const;
    for (const dataModelType of dataModels) {
      try {
        const result = await this.studio.callTool(
          tool.name,
          addDataModelType(tool, {}, dataModelType),
          signal ? { signal } : {}
        );
        const payload = studioResultJson(result);
        const reported = findNumericField(payload ?? result, new Set(["placeid", "place_id"]));
        if (reported !== undefined) return reported;
      } catch (error) {
        if (signal?.aborted) throw error;
        // A DataModel is absent during transitions or when Studio is in the
        // opposite Edit/Play state. Try the remaining active contexts.
      }
    }

    // Current Studio releases do not uniformly include PlaceId in
    // get_studio_state. A fixed, extension-authored read is safe to run before
    // the mutation guard; arbitrary user/model Luau still goes through normal
    // permission and approval handling.
    const execute = await this.getStudioTool("execute_luau");
    for (const dataModelType of dataModels) {
      try {
        const argumentsValue = buildExecuteLuauArguments(
          execute,
          "return { placeId = game.PlaceId, gameId = game.GameId }",
          dataModelType
        );
        this.#schemaValidator.validate(execute, argumentsValue);
        const fallback = await this.studio.callTool(
          execute.name,
          argumentsValue,
          signal ? { signal } : {}
        );
        const reported = findNumericField(
          studioResultJson(fallback) ?? fallback,
          new Set(["placeid", "place_id"])
        );
        if (reported !== undefined) return reported;
      } catch (error) {
        if (signal?.aborted) throw error;
      }
    }
    return undefined;
  }

  private async assertExpectedPlace(signal?: AbortSignal): Promise<void> {
    const expected = this.expectedPlaceIds();
    if (expected.length === 0) {
      throw new Error("Studio mutation is blocked because no expected place IDs are configured.");
    }
    const current = await this.currentPlaceId(signal);
    if (current === undefined) throw new Error("Studio mutation is blocked because Studio did not report a place ID.");
    if (!expected.includes(current)) {
      throw new Error(`Studio place ${current} is not allowed; expected one of ${expected.join(", ")}.`);
    }
  }

  private async verifyStudioSource(
    sourcePath: string,
    studioPath: string | undefined,
    signal?: AbortSignal
  ): Promise<FileSyncEvidence> {
    if (!studioPath) return { sourcePath, status: "not-mapped" };
    if (!this.studio.connected) return { sourcePath, studioPath, status: "not-connected" };
    let tool: StudioToolDescriptor;
    try {
      tool = await this.getStudioTool("script_read");
    } catch (error) {
      return { sourcePath, studioPath, status: "unverified", detail: errorMessage(error) };
    }
    const expected = normalizeSource(await readFile(sourcePath, "utf8"));
    const deadline = Date.now() + this.config.studio.syncTimeoutMs;
    let detail: string | undefined;
    while (!signal?.aborted && Date.now() <= deadline) {
      try {
        const result = await this.studio.callTool(tool.name, buildPathArguments(tool, studioPath), signal ? { signal } : {});
        const readback = normalizeSource(normalizeScriptReadText(studioResultText(result)));
        if (valueContainsSource(result, expected) || readback.includes(expected)) {
          return { sourcePath, studioPath, status: "verified" };
        }
        detail = "Studio returned source that did not match the filesystem content.";
      } catch (error) {
        detail = errorMessage(error);
      }
      await delay(150, undefined, signal ? { signal } : undefined).catch(() => undefined);
    }
    return { sourcePath, studioPath, status: "unverified", ...(detail ? { detail } : {}) };
  }
}
