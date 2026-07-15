import {
  CONFIG_DIR_NAME,
  isToolCallEventType,
  withFileMutationQueue,
  type ExtensionAPI,
  type ExtensionContext
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";
import { DEFAULT_CONFIG, writeRobloxConfig } from "../../src/config.js";
import type { FileMutationOperation } from "../../src/file-transaction.js";
import { RobloxRuntime, type RuntimeStatus } from "../../src/runtime.js";
import type { CommandRunner } from "../../src/rojo-index.js";
import { discoverRojoProjects, readRojoProject } from "../../src/rojo-project.js";
import type { StudioMutationOperation } from "../../src/studio-transaction.js";
import { nodeCommandRunner } from "../../src/command-runner.js";
import { buildSetActiveStudioArguments } from "../../src/studio-schema.js";
import type { StudioToolResult } from "../../src/studio-client.js";
import { boundedJson } from "../../src/util.js";

interface PiTextContent {
  type: "text";
  text: string;
}

interface PiImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

type PiToolContent = PiTextContent | PiImageContent;

function asToolResult<T>(value: T, maxChars = 30_000) {
  return {
    content: [{ type: "text" as const, text: boundedJson(value, maxChars) }],
    details: value
  };
}

function studioContent(result: StudioToolResult): PiToolContent[] {
  const output: PiToolContent[] = [];

  for (const block of result.content) {
    if (typeof block !== "object" || block === null) continue;
    const value = block as Record<string, unknown>;

    if (value.type === "text" && typeof value.text === "string") {
      output.push({ type: "text", text: value.text });
      continue;
    }

    if (
      value.type === "image" &&
      typeof value.data === "string" &&
      typeof value.mimeType === "string"
    ) {
      output.push({ type: "image", data: value.data, mimeType: value.mimeType });
    }
  }

  if (output.length === 0) {
    output.push({ type: "text", text: boundedJson(result) });
  }
  return output;
}

function statusSummary(status: RuntimeStatus): string {
  const studio = status.studioConnected
    ? `Studio connected (${status.studioToolCount} tools)`
    : "Studio disconnected";
  const source =
    status.mode === "rojo"
      ? `Rojo ${status.projectExists ? "project found" : "project missing"}; ${status.indexedInstances} indexed instances`
      : "Studio-only mode";
  const issues = [status.rojoError, status.studioError].filter(Boolean);
  return `${studio} · ${source}${issues.length > 0 ? ` · ${issues.length} issue(s)` : ""}`;
}

function commandRunner(_pi: ExtensionAPI): CommandRunner {
  return nodeCommandRunner;
}

export default function robloxExtension(pi: ExtensionAPI): void {
  let runtime: RobloxRuntime | undefined;
  const builtinCheckpoints = new Map<string, string>();

  async function closeRuntime(): Promise<void> {
    const current = runtime;
    runtime = undefined;
    if (current) await current.close();
  }

  async function createRuntime(
    ctx: ExtensionContext,
    signal?: AbortSignal
  ): Promise<RobloxRuntime> {
    await closeRuntime();
    const next = new RobloxRuntime(ctx.cwd, CONFIG_DIR_NAME, commandRunner(pi));
    await next.initialize(signal);
    runtime = next;
    return next;
  }

  async function getRuntime(
    ctx: ExtensionContext,
    signal?: AbortSignal
  ): Promise<RobloxRuntime> {
    if (!runtime || runtime.cwd !== ctx.cwd) return createRuntime(ctx, signal);
    return runtime;
  }

  async function updateStatus(ctx: ExtensionContext, current?: RobloxRuntime): Promise<void> {
    try {
      const active = current ?? (await getRuntime(ctx, ctx.signal));
      const status = await active.status();
      ctx.ui.setStatus("pi-roblox", `Roblox: ${status.studioConnected ? "Studio ✓" : "Studio –"} · ${status.mode === "rojo" ? `${status.indexedInstances} mapped` : "Studio-only"}`);
    } catch {
      ctx.ui.setStatus("pi-roblox", "Roblox: setup required");
    }
  }

  async function ask(
    ctx: ExtensionContext,
    title: string,
    detail: string,
    failClosed: boolean
  ): Promise<boolean> {
    if (!ctx.hasUI) return !failClosed;
    const options = ctx.signal ? { signal: ctx.signal } : undefined;
    return ctx.ui.confirm(title, detail, options);
  }

  async function approveFileMutation(
    ctx: ExtensionContext,
    active: RobloxRuntime,
    target: string,
    detail: string
  ): Promise<void> {
    const profile = active.config.permissions.profile;
    if (profile === "observe") {
      throw new Error(`File mutation is blocked by the observe profile: ${target}`);
    }
    if (profile === "autonomous-local") return;

    const accepted = await ask(
      ctx,
      `Allow Roblox source change?`,
      `${target}\n\n${detail}`,
      active.config.permissions.failClosedWithoutUi
    );
    if (!accepted) throw new Error(`The user rejected the source change to ${target}.`);
  }

  pi.registerTool({
    name: "roblox_status",
    label: "Roblox Status",
    description:
      "Inspect the Roblox integration state: selected source mode, Rojo project/sourcemap, Studio MCP connectivity, and current errors. This tool never calls an AI model.",
    promptSnippet: "Check Roblox Studio, Rojo, and source-ownership integration status",
    promptGuidelines: [
      "Call roblox_status before substantial Roblox work and after connection or synchronization failures."
    ],
    parameters: Type.Object({
      refresh: Type.Optional(
        Type.Boolean({ description: "Re-read config, regenerate the Rojo sourcemap, and reconnect." })
      )
    }),
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const active = params.refresh ? await createRuntime(ctx, signal) : await getRuntime(ctx, signal);
      const status = await active.status();
      await updateStatus(ctx, active);
      return asToolResult(status);
    }
  });

  pi.registerTool({
    name: "roblox_doctor",
    label: "Roblox Doctor",
    description: "Run deterministic diagnostics for configuration, Rojo, ownership, Studio MCP capabilities, and the open-place guard.",
    promptSnippet: "Diagnose the complete pi-roblox environment",
    promptGuidelines: ["Use roblox_doctor when setup, connection, ownership, or synchronization is uncertain."],
    parameters: Type.Object({
      connectStudio: Type.Optional(Type.Boolean({ description: "Attempt Studio MCP connection; default true." }))
    }),
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const active = await getRuntime(ctx, signal);
      const result = await active.doctor({ connectStudio: params.connectStudio ?? true, ...(signal ? { signal } : {}) });
      await updateStatus(ctx, active);
      return asToolResult(result, 50_000);
    }
  });

  pi.registerTool({
    name: "roblox_search",
    label: "Roblox Search",
    description:
      "Search the current Rojo sourcemap for Studio instance paths, class names, and source files. Use roblox_studio with search_game_tree for Studio-only objects that are not represented by Rojo.",
    promptSnippet: "Search Rojo mappings by Studio path, class, or source path",
    promptGuidelines: [
      "Use roblox_search before reading broad portions of a Roblox project; retrieve only the relevant mappings."
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Case-insensitive path, class, or file query." }),
      limit: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 200, description: "Maximum results; default 50." })
      ),
      source: Type.Optional(Type.Boolean({ description: "Search project source; default true." })),
      regex: Type.Optional(Type.Boolean({ description: "Treat query as a regular expression." })),
      caseSensitive: Type.Optional(Type.Boolean()),
      studio: Type.Optional(Type.Boolean({ description: "Also search the live Studio tree." }))
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const active = await getRuntime(ctx, signal);
      return asToolResult(await active.search(params.query, {
        limit: params.limit ?? 50,
        ...(params.source !== undefined ? { source: params.source } : {}),
        ...(params.regex !== undefined ? { regex: params.regex } : {}),
        ...(params.caseSensitive !== undefined ? { caseSensitive: params.caseSensitive } : {}),
        ...(params.studio !== undefined ? { studio: params.studio } : {})
      }));
    }
  });

  pi.registerTool({
    name: "roblox_inspect",
    label: "Roblox Inspect",
    description:
      "Resolve a filesystem or game.* target to its ownership record, read mapped source with a SHA-256 precondition hash, and inspect the corresponding live Studio instance when available.",
    promptSnippet: "Inspect a Roblox source file or Studio instance with ownership metadata",
    promptGuidelines: [
      "Use roblox_inspect before roblox_apply and pass its file.sha256 as expectedSha256 to prevent stale writes.",
      "Never send Studio multi_edit to a target reported as rojo-owned."
    ],
    parameters: Type.Object({
      target: Type.String({
        description:
          "A workspace-relative/absolute filesystem path or a Studio path such as game.ReplicatedStorage.Inventory."
      })
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const active = await getRuntime(ctx, signal);
      return asToolResult(await active.inspect(params.target, signal));
    }
  });

  pi.registerTool({
    name: "roblox_studio",
    label: "Roblox Studio",
    description:
      "A policy-enforced gateway to Roblox Studio's built-in MCP server. Use action=list_tools to discover the live Studio schemas, then action=call with an exact tool name and arguments. Roblox-hosted subagents and generation tools are denied by default; mutations require permission and Rojo-owned scripts cannot be edited through Studio.",
    promptSnippet: "Inspect, control, and playtest the live Roblox Studio through guarded MCP tools",
    promptGuidelines: [
      "Call roblox_studio with action=list_tools before using an unfamiliar Studio tool so its current input schema is known.",
      "Use Roblox Studio tools for the live data model, runtime, console, viewport, input, and Studio-owned instances—not for Rojo-owned source."
    ],
    parameters: Type.Object({
      action: Type.String({ description: "Either list_tools or call." }),
      tool: Type.Optional(Type.String({ description: "Studio MCP tool name when action is call." })),
      arguments: Type.Optional(
        Type.Record(Type.String(), Type.Unknown(), {
          description: "Arguments matching the discovered Studio MCP tool schema."
        })
      ),
      refresh: Type.Optional(
        Type.Boolean({ description: "Refresh Studio MCP's tool list before returning it." })
      )
    }),
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const active = await getRuntime(ctx, signal);

      if (params.action === "list_tools") {
        const tools = (await active.listStudioTools(params.refresh ?? false)).filter(
          (tool) => !active.isStudioToolDenied(tool.name)
        );
        await updateStatus(ctx, active);
        return asToolResult({ tools }, 50_000);
      }

      if (params.action !== "call") {
        throw new Error(`Unknown roblox_studio action: ${params.action}. Use list_tools or call.`);
      }
      if (!params.tool) throw new Error("roblox_studio action=call requires tool.");

      const result = await active.callStudioTool(
        params.tool,
        params.arguments ?? {},
        (title, detail) =>
          ask(ctx, title, detail, active.config.permissions.failClosedWithoutUi),
        signal
      );
      await updateStatus(ctx, active);
      return { content: studioContent(result), details: result };
    }
  });

  pi.registerTool({
    name: "roblox_files",
    label: "Roblox Files",
    description: "Apply an atomic batch of ownership-checked filesystem writes, deletes, and moves with hashes, checkpointing, Rojo refresh, sync evidence, validation, and rollback policy.",
    promptSnippet: "Apply a transactional Roblox source-file batch",
    promptGuidelines: [
      "Inspect existing mapped files first and pass their SHA-256 values.",
      "Prefer one roblox_files transaction for a logically atomic multi-file change."
    ],
    parameters: Type.Object({
      operations: Type.Array(Type.Union([
        Type.Object({
          kind: Type.Literal("write"),
          target: Type.String(),
          content: Type.String(),
          expectedSha256: Type.Optional(Type.Union([Type.String(), Type.Null()]))
        }),
        Type.Object({
          kind: Type.Literal("delete"),
          target: Type.String(),
          expectedSha256: Type.Optional(Type.String())
        }),
        Type.Object({
          kind: Type.Literal("move"),
          from: Type.String(),
          to: Type.String(),
          expectedSha256: Type.Optional(Type.String()),
          expectedDestinationSha256: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          overwrite: Type.Optional(Type.Boolean())
        })
      ]), { minItems: 1, maxItems: 200 }),
      dryRun: Type.Optional(Type.Boolean()),
      validate: Type.Optional(Type.Boolean()),
      validationProfile: Type.Optional(Type.String()),
      label: Type.Optional(Type.String())
    }),
    executionMode: "sequential",
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const active = await getRuntime(ctx, signal);
      const operations = params.operations as FileMutationOperation[];
      if (!params.dryRun) {
        if (active.config.permissions.profile === "observe") throw new Error("File mutation is blocked by the observe profile.");
        if (active.config.permissions.profile === "develop") {
          const accepted = await ask(
            ctx,
            "Allow Roblox file transaction?",
            boundedJson(operations.map((operation) => operation.kind === "move"
              ? { kind: operation.kind, from: operation.from, to: operation.to }
              : { kind: operation.kind, target: operation.target }), 12_000),
            active.config.permissions.failClosedWithoutUi
          );
          if (!accepted) throw new Error("The user rejected the Roblox file transaction.");
        }
      }
      pi.events.emit("pi-roblox/v1:before-mutation", { kind: "files", toolCallId, operations: operations.length });
      const result = await active.files(operations, {
        ...(params.dryRun !== undefined ? { dryRun: params.dryRun } : {}),
        ...(params.validate !== undefined ? { validate: params.validate } : {}),
        ...(params.validationProfile ? { validationProfile: params.validationProfile } : {}),
        ...(params.label ? { label: params.label } : {}),
        ...(signal ? { signal } : {}),
        auditContext: { toolCallId, source: "pi-tool" }
      });
      if (result.checkpointId) pi.appendEntry("pi-roblox-checkpoint", { id: result.checkpointId, kind: "files", status: result.status });
      pi.events.emit("pi-roblox/v1:after-mutation", { kind: "files", toolCallId, result });
      await updateStatus(ctx, active);
      return asToolResult(result, 50_000);
    }
  });

  pi.registerTool({
    name: "roblox_apply",
    label: "Roblox Apply",
    description:
      "Transactionally replace one filesystem source file after resolving Roblox ownership. The tool rejects Studio-owned, generated, dependency, outside-workspace, and stale targets; creates a rollback checkpoint; refreshes the Rojo sourcemap; verifies Studio synchronization when possible; and optionally runs configured validation commands.",
    promptSnippet: "Safely replace one Roblox source file with checkpoint and sync verification",
    promptGuidelines: [
      "Use roblox_apply for ownership-aware Roblox source replacement; include expectedSha256 from roblox_inspect.",
      "After roblox_apply, examine syncVerification and every validation result before declaring the task complete."
    ],
    parameters: Type.Object({
      target: Type.String({
        description: "A Rojo-owned Studio path or an editable filesystem path in the workspace."
      }),
      content: Type.String({ description: "Complete new UTF-8 file contents." }),
      expectedSha256: Type.Optional(
        Type.String({ description: "Hash returned by roblox_inspect; rejects stale writes." })
      ),
      validate: Type.Optional(
        Type.Boolean({ description: "Run configured validation commands after the write; default true." })
      )
    }),
    executionMode: "parallel",
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const active = await getRuntime(ctx, signal);
      const ownership = active.ownership(params.target);
      if (!ownership.sourcePath) {
        throw new Error(`${params.target} has no editable filesystem source: ${ownership.reason}`);
      }

      await approveFileMutation(
        ctx,
        active,
        relative(ctx.cwd, ownership.sourcePath) || ownership.sourcePath,
        `Ownership: ${ownership.ownership}\nMapped Studio path: ${ownership.studioPath ?? "none"}\nNew content: ${Buffer.byteLength(params.content, "utf8")} bytes`
      );

      pi.events.emit("pi-roblox/v1:before-mutation", { kind: "apply", toolCallId, target: params.target });
      const result = await withFileMutationQueue(ownership.sourcePath, () => {
        const request: {
          target: string;
          content: string;
          expectedSha256?: string;
          validate: boolean;
          signal?: AbortSignal;
        } = {
          target: params.target,
          content: params.content,
          validate: params.validate ?? true
        };
        if (params.expectedSha256 !== undefined) request.expectedSha256 = params.expectedSha256;
        if (signal) request.signal = signal;
        return active.replaceFile({
          ...request,
          auditContext: { toolCallId, source: "pi-tool" }
        });
      });

      if (result.checkpointId) pi.appendEntry("pi-roblox-checkpoint", { id: result.checkpointId, kind: "apply", status: result.status });
      pi.events.emit("pi-roblox/v1:after-mutation", { kind: "apply", toolCallId, result });
      await updateStatus(ctx, active);
      return asToolResult(result, 50_000);
    }
  });

  pi.registerTool({
    name: "roblox_mutate",
    label: "Roblox Mutate",
    description: "Apply a validated, reversible structured transaction to Studio-owned instances. Prefer this over arbitrary execute_luau.",
    promptSnippet: "Mutate Studio-owned instances with generated rollback evidence",
    promptGuidelines: [
      "Use only for targets classified studio-owned.",
      "Use roblox_files for Rojo-owned source and structure."
    ],
    parameters: Type.Object({
      operations: Type.Array(Type.Record(Type.String(), Type.Unknown()), { minItems: 1, maxItems: 100 }),
      dryRun: Type.Optional(Type.Boolean()),
      label: Type.Optional(Type.String())
    }),
    executionMode: "sequential",
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const active = await getRuntime(ctx, signal);
      const operations = params.operations as unknown as StudioMutationOperation[];
      pi.events.emit("pi-roblox/v1:before-mutation", { kind: "studio", toolCallId, operations: operations.length });
      const result = await active.mutateStudio(
        operations,
        (title, detail) => ask(ctx, title, detail, active.config.permissions.failClosedWithoutUi),
        {
          ...(params.dryRun !== undefined ? { dryRun: params.dryRun } : {}),
          ...(params.label ? { label: params.label } : {}),
          ...(signal ? { signal } : {}),
          auditContext: { toolCallId, source: "pi-tool" }
        }
      );
      if (result.checkpointId) pi.appendEntry("pi-roblox-checkpoint", { id: result.checkpointId, kind: "studio", status: result.status });
      pi.events.emit("pi-roblox/v1:after-mutation", { kind: "studio", toolCallId, result });
      return asToolResult(result, 50_000);
    }
  });

  pi.registerTool({
    name: "roblox_test",
    label: "Roblox Test",
    description:
      "Run the deterministic validation commands configured in .pi/roblox.json. The extension returns command evidence; Pi and its other extensions decide how to interpret or repair failures.",
    promptSnippet: "Run configured Roblox formatting, lint, build, type, or test checks",
    promptGuidelines: [
      "Use roblox_test after Roblox source changes; use roblox_studio for playtests and runtime console evidence."
    ],
    parameters: Type.Object({
      validationProfile: Type.Optional(Type.String()),
      scenario: Type.Optional(Type.Union([Type.String(), Type.Record(Type.String(), Type.Unknown())]))
    }),
    executionMode: "sequential",
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const active = await getRuntime(ctx, signal);
      const validation = await active.validate(params.validationProfile ?? signal, signal);
      const result: Record<string, unknown> = { validation };
      if (params.scenario !== undefined) {
        result.scenario = await active.runScenario(
          params.scenario,
          (title, detail) => ask(ctx, title, detail, active.config.permissions.failClosedWithoutUi),
          signal,
          { toolCallId, source: "pi-tool" }
        );
      }
      pi.appendEntry("pi-roblox-test-result", { validation: validation.status, scenario: (result.scenario as { status?: string } | undefined)?.status });
      pi.events.emit("pi-roblox/v1:test-result", result);
      return asToolResult(result, 50_000);
    }
  });

  pi.registerTool({
    name: "roblox_scenario",
    label: "Roblox Scenario",
    description: "List or run a deterministic JSON/JSONC Roblox playtest scenario with teardown, console assertions, and artifacts.",
    promptSnippet: "List or run a deterministic Roblox Studio scenario",
    promptGuidelines: ["Run a named scenario for repeatable playtest evidence; inspect its report and artifacts."],
    parameters: Type.Object({
      action: Type.Union([Type.Literal("list"), Type.Literal("run")]),
      scenario: Type.Optional(Type.Union([Type.String(), Type.Record(Type.String(), Type.Unknown())]))
    }),
    executionMode: "sequential",
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const active = await getRuntime(ctx, signal);
      if (params.action === "list") return asToolResult({ scenarios: await active.listScenarios() });
      if (params.scenario === undefined) throw new Error("roblox_scenario action=run requires scenario.");
      const result = await active.runScenario(
        params.scenario,
        (title, detail) => ask(ctx, title, detail, active.config.permissions.failClosedWithoutUi),
        signal,
        { toolCallId, source: "pi-tool" }
      );
      pi.appendEntry("pi-roblox-test-result", { scenario: result.scenario, status: result.status, artifactRunId: result.artifactRunId });
      pi.events.emit("pi-roblox/v1:test-result", { scenario: result });
      return asToolResult(result, 50_000);
    }
  });

  pi.registerTool({
    name: "roblox_checkpoint",
    label: "Roblox Checkpoint",
    description: "Create, list, inspect, restore, or remove pi-roblox checkpoints. Restore is conflict-aware unless force is explicitly set.",
    promptSnippet: "Manage reversible Roblox checkpoints",
    promptGuidelines: ["Inspect a checkpoint before restoring it; use force only after reviewing divergent work."],
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("create"), Type.Literal("list"), Type.Literal("inspect"),
        Type.Literal("restore"), Type.Literal("remove")
      ]),
      id: Type.Optional(Type.String()),
      paths: Type.Optional(Type.Array(Type.String(), { maxItems: 200 })),
      label: Type.Optional(Type.String()),
      force: Type.Optional(Type.Boolean()),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 }))
    }),
    executionMode: "sequential",
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const active = await getRuntime(ctx, signal);
      if (params.action === "list") return asToolResult({ checkpoints: await active.checkpoints.list(params.limit ?? 50) }, 50_000);
      if (params.action === "create") {
        const checkpoint = await active.createCheckpoint(params.paths ?? [], params.label ?? "manual checkpoint", { toolCallId });
        pi.appendEntry("pi-roblox-checkpoint", { id: checkpoint.id, kind: "manual" });
        return asToolResult(checkpoint);
      }
      if (!params.id) throw new Error(`roblox_checkpoint action=${params.action} requires id.`);
      if (params.action === "inspect") return asToolResult(await active.checkpoints.read(params.id), 50_000);
      if (params.action === "remove") {
        await active.checkpoints.remove(params.id);
        return asToolResult({ removed: params.id });
      }
      const accepted = await ask(ctx, "Restore Roblox checkpoint?", params.id, true);
      if (!accepted) throw new Error("The user rejected checkpoint restore.");
      const result = await active.rollback(params.id, {
        ...(params.force !== undefined ? { force: params.force } : {}),
        ...(params.paths ? { paths: params.paths } : {}),
        ...(signal ? { signal } : {}),
        approve: (title, detail) => ask(ctx, title, detail, true),
        auditContext: { toolCallId, source: "pi-tool" }
      });
      pi.events.emit("pi-roblox/v1:rollback", result);
      return asToolResult(result, 50_000);
    }
  });

  pi.registerTool({
    name: "roblox_rojo",
    label: "Roblox Rojo",
    description: "Start, stop, restart, inspect, or refresh the managed Rojo server and sourcemap indexes.",
    promptSnippet: "Control the project Rojo lifecycle",
    promptGuidelines: ["Use refresh after external project mapping changes; status distinguishes managed and external servers."],
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("status"), Type.Literal("start"), Type.Literal("stop"),
        Type.Literal("restart"), Type.Literal("refresh")
      ])
    }),
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const active = await getRuntime(ctx, signal);
      if (params.action === "refresh") {
        await active.refreshRojo(signal);
        return asToolResult({ refreshed: true, snapshot: await active.snapshot() }, 50_000);
      }
      const result = params.action === "start"
        ? await active.rojoStart(signal)
        : params.action === "stop"
          ? await active.rojoStop()
          : params.action === "restart"
            ? await active.rojoRestart(signal)
            : await active.rojoStatus();
      await updateStatus(ctx, active);
      return asToolResult(result);
    }
  });

  pi.registerCommand("roblox", {
    description: "Initialize, diagnose, connect, inspect, test, and manage pi-roblox",
    getArgumentCompletions(prefix) {
      const commands = [
        "init auto",
        "init rojo ",
        "init studio-only",
        "doctor",
        "status",
        "connect",
        "disconnect",
        "tools",
        "studios",
        "use ",
        "rojo status",
        "rojo start",
        "rojo stop",
        "rojo restart",
        "rojo refresh",
        "ownership ",
        "conflicts",
        "snapshot",
        "test ",
        "scenario list",
        "scenario run ",
        "checkpoints",
        "rollback ",
        "audit "
      ];
      const matches = commands.filter((entry) => entry.startsWith(prefix));
      return matches.length > 0
        ? matches.map((entry) => ({ value: entry, label: entry }))
        : null;
    },
    async handler(args, ctx) {
      const [subcommand = "status", ...rest] = args.trim().split(/\s+/);

      if (subcommand === "init") {
        try {
          const configPath = resolve(ctx.cwd, CONFIG_DIR_NAME, "roblox.json");
          if (existsSync(configPath)) throw Object.assign(new Error("config exists"), { code: "EEXIST" });
          const mode = rest[0] ?? "auto";
          if (!new Set(["auto", "rojo", "studio-only"]).has(mode)) {
            throw new Error("Usage: /roblox init [auto|rojo|studio-only] [project-file]");
          }
          const config = structuredClone(DEFAULT_CONFIG);
          let selectedProject: string | undefined;
          if (mode !== "studio-only") {
            selectedProject = rest[1]
              ? resolve(ctx.cwd, rest.slice(1).join(" "))
              : (await discoverRojoProjects(ctx.cwd))[0];
          }
          if (mode === "rojo" && !selectedProject) throw new Error("No .project.json file was found; pass its path explicitly.");
          if (selectedProject) {
            const project = await readRojoProject(ctx.cwd, selectedProject);
            config.mode = "rojo";
            config.projectFile = relative(ctx.cwd, project.path).replaceAll("\\", "/");
            config.expectedPlaceIds = [...new Set([
              ...project.servePlaceIds,
              ...(project.placeId ? [project.placeId] : [])
            ])];
            config.rojo.server.address = project.serveAddress;
            config.rojo.server.port = project.servePort;
          } else {
            config.mode = "studio-only";
          }
          const path = await writeRobloxConfig(ctx.cwd, config, CONFIG_DIR_NAME);
          const active = await createRuntime(ctx, ctx.signal);
          await active.writeExampleScenario().catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "EEXIST") throw error;
          });
          await updateStatus(ctx, active);
          ctx.ui.notify(`Created ${relative(ctx.cwd, path)} in ${config.mode} mode. Run /roblox doctor.`, "info");
        } catch (error) {
          const message = (error as NodeJS.ErrnoException).code === "EEXIST"
            ? `${CONFIG_DIR_NAME}/roblox.json already exists.`
            : (error as Error).message;
          ctx.ui.notify(message, "warning");
        }
        return;
      }

      const active = await getRuntime(ctx, ctx.signal);

      if (subcommand === "doctor") {
        const refreshed = await createRuntime(ctx, ctx.signal);
        const doctor = await refreshed.doctor({ connectStudio: true, ...(ctx.signal ? { signal: ctx.signal } : {}) });
        await updateStatus(ctx, refreshed);
        ctx.ui.notify(doctor.checks.map((check) => `${check.status.toUpperCase()} ${check.name}: ${check.detail}`).join("\n"), doctor.status === "pass" ? "info" : "warning");
        return;
      }

      if (subcommand === "status") {
        const status = await active.status();
        await updateStatus(ctx, active);
        ctx.ui.notify(boundedJson(status, 20_000), status.rojoError || status.studioError ? "warning" : "info");
        return;
      }

      if (subcommand === "connect") {
        await active.connectStudio();
        pi.events.emit("pi-roblox/v1:connected", { cwd: ctx.cwd });
        await updateStatus(ctx, active);
        ctx.ui.notify("Connected to Roblox Studio MCP.", "info");
        return;
      }

      if (subcommand === "disconnect") {
        await active.disconnectStudio();
        await updateStatus(ctx, active);
        ctx.ui.notify("Disconnected from Roblox Studio MCP.", "info");
        return;
      }

      if (subcommand === "tools") {
        const tools = (await active.listStudioTools(true)).filter(
          (tool) => !active.isStudioToolDenied(tool.name)
        );
        ctx.ui.notify(tools.map((tool) => tool.name).join("\n"), "info");
        return;
      }

      if (subcommand === "studios") {
        const result = await active.callStudioTool("list_roblox_studios", {}, async () => true, ctx.signal);
        ctx.ui.notify(boundedJson(result, 20_000), "info");
        return;
      }

      if (subcommand === "use") {
        const studioId = rest.join(" ").trim();
        if (!studioId) throw new Error("Usage: /roblox use <studio-id>");
        const tool = (await active.listStudioTools()).find((candidate) => candidate.name === "set_active_studio");
        if (!tool) throw new Error("Studio MCP does not expose set_active_studio.");
        const result = await active.callStudioTool(
          tool.name,
          buildSetActiveStudioArguments(tool, studioId),
          (title, detail) => ask(ctx, title, detail, true),
          ctx.signal
        );
        pi.events.emit("pi-roblox/v1:studio-selected", { studioId });
        ctx.ui.notify(boundedJson(result, 8_000), "info");
        return;
      }

      if (subcommand === "rojo") {
        const action = rest[0] ?? "status";
        const result = action === "refresh"
          ? (await active.refreshRojo(ctx.signal), await active.snapshot())
          : action === "start"
            ? await active.rojoStart(ctx.signal)
            : action === "stop"
              ? await active.rojoStop()
              : action === "restart"
                ? await active.rojoRestart(ctx.signal)
                : action === "status"
                  ? await active.rojoStatus()
                  : (() => { throw new Error("Usage: /roblox rojo status|start|stop|restart|refresh"); })();
        await updateStatus(ctx, active);
        ctx.ui.notify(boundedJson(result, 20_000), "info");
        return;
      }

      if (subcommand === "ownership") {
        const target = rest.join(" ").trim();
        if (!target) throw new Error("Usage: /roblox ownership <path-or-game.*>");
        ctx.ui.notify(boundedJson(active.ownership(target), 8_000), "info");
        return;
      }

      if (subcommand === "conflicts") {
        ctx.ui.notify(boundedJson(active.rojo?.conflicts ?? [], 20_000), "info");
        return;
      }

      if (subcommand === "snapshot") {
        ctx.ui.notify(boundedJson(await active.snapshot(), 30_000), "info");
        return;
      }

      if (subcommand === "test") {
        const validation = await active.validate(rest[0] ?? ctx.signal, ctx.signal);
        pi.appendEntry("pi-roblox-test-result", { validation: validation.status });
        pi.events.emit("pi-roblox/v1:test-result", { validation });
        ctx.ui.notify(boundedJson(validation, 30_000), validation.status === "pass" ? "info" : "warning");
        return;
      }

      if (subcommand === "scenario") {
        if (rest[0] === "list") {
          ctx.ui.notify(boundedJson(await active.listScenarios(), 20_000), "info");
          return;
        }
        if (rest[0] === "run" && rest[1]) {
          const result = await active.runScenario(rest.slice(1).join(" "), (title, detail) => ask(ctx, title, detail, true), ctx.signal);
          pi.appendEntry("pi-roblox-test-result", { scenario: result.scenario, status: result.status });
          pi.events.emit("pi-roblox/v1:test-result", { scenario: result });
          ctx.ui.notify(boundedJson(result, 30_000), result.status === "pass" ? "info" : "warning");
          return;
        }
        throw new Error("Usage: /roblox scenario list|run <name-or-path>");
      }

      if (subcommand === "checkpoints") {
        ctx.ui.notify(boundedJson(await active.checkpoints.list(100), 30_000), "info");
        return;
      }

      if (subcommand === "rollback") {
        const checkpointId = rest.join(" ").trim();
        if (!checkpointId) throw new Error("Usage: /roblox rollback <checkpoint-id>");
        const accepted = await ask(
          ctx,
          "Restore Roblox checkpoint?",
          checkpointId,
          true
        );
        if (!accepted) return;
        const result = await active.rollback(checkpointId, {
          approve: (title, detail) => ask(ctx, title, detail, true),
          ...(ctx.signal ? { signal: ctx.signal } : {})
        });
        pi.events.emit("pi-roblox/v1:rollback", result);
        await updateStatus(ctx, active);
        ctx.ui.notify(`Restored checkpoint ${checkpointId}.`, "info");
        return;
      }

      if (subcommand === "audit") {
        const limit = Number(rest[0] ?? 100);
        ctx.ui.notify(boundedJson(await active.audit.recent(Number.isSafeInteger(limit) ? limit : 100), 30_000), "info");
        return;
      }

      ctx.ui.notify(
        "Usage: /roblox init|doctor|status|connect|disconnect|tools|studios|use|rojo|ownership|conflicts|snapshot|test|scenario|checkpoints|rollback|audit",
        "info"
      );
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    try {
      const active = await createRuntime(ctx, ctx.signal);
      await updateStatus(ctx, active);
      if (active.studio.connected) pi.events.emit("pi-roblox/v1:connected", { cwd: ctx.cwd });
    } catch (error) {
      ctx.ui.setStatus("pi-roblox", "Roblox: setup required");
      if (ctx.hasUI) ctx.ui.notify(`pi-roblox: ${(error as Error).message}`, "warning");
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    ctx.ui.setStatus("pi-roblox", undefined);
    await closeRuntime();
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    try {
      const active = await getRuntime(ctx, ctx.signal);
      if (!active.config.context.injectStatus) return undefined;
      const status = await active.status();
      return {
        message: {
          customType: "pi-roblox-status",
          content: [
            `pi-roblox: ${status.mode}; Studio ${status.studioConnected ? "connected" : "disconnected"};`,
            `${status.mappedSourceFiles} mapped source file(s); ${status.ownershipConflicts} ownership conflict(s).`,
            status.missingStudioTools.length > 0 ? `Missing Studio tools: ${status.missingStudioTools.join(", ")}.` : "Required Studio tools are present.",
            "Honor ownership routing: Rojo-owned targets use filesystem transactions; Studio-owned targets use structured Studio transactions; ambiguous targets are blocked."
          ].join(" "),
          display: false,
          details: { mode: status.mode, studioConnected: status.studioConnected }
        }
      };
    } catch {
      return undefined;
    }
  });

  pi.on("tool_call", async (event, ctx) => {
    const isWrite = isToolCallEventType("write", event);
    const isEdit = isToolCallEventType("edit", event);
    if (!isWrite && !isEdit) return undefined;

    const path = event.input.path;
    if (typeof path !== "string") return undefined;

    const active = await getRuntime(ctx, ctx.signal);
    const ownership = active.ownership(path);
    if (
      ownership.ownership === "generated-output" ||
      ownership.ownership === "external-package" ||
      ownership.ownership === "binary-asset" ||
      ownership.ownership === "symbolic-link" ||
      ownership.ownership === "ambiguous-rojo-scope" ||
      ownership.ownership === "ownership-unresolved" ||
      ownership.ownership === "outside-workspace"
    ) {
      return { block: true, reason: ownership.reason };
    }

    if (active.config.permissions.profile === "observe") {
      return { block: true, reason: "Roblox source edits are blocked by the observe profile." };
    }

    if (isWrite && ownership.ownership === "rojo-owned" && ownership.sourcePath && existsSync(ownership.sourcePath)) {
      return {
        block: true,
        reason: "Pi's built-in full-file write cannot carry the required SHA-256 precondition for existing Rojo-owned source. Use roblox_files or roblox_apply after roblox_inspect."
      };
    }

    if (active.config.permissions.profile === "develop") {
      const accepted = await ask(
        ctx,
        `Allow Pi ${isWrite ? "write" : "edit"}?`,
        `${path}\n\nOwnership: ${ownership.ownership}\nStudio mapping: ${ownership.studioPath ?? "none"}`,
        active.config.permissions.failClosedWithoutUi
      );
      if (!accepted) return { block: true, reason: `The user rejected the change to ${path}.` };
    }

    if (ownership.sourcePath) {
      const checkpoint = await active.checkpoints.create(
        [ownership.sourcePath],
        `Pi built-in ${event.toolName}: ${relative(ctx.cwd, ownership.sourcePath)}`,
        { toolCallId: event.toolCallId, source: "builtin-tool" }
      );
      builtinCheckpoints.set(event.toolCallId, checkpoint.id);
      pi.appendEntry("pi-roblox-checkpoint", { id: checkpoint.id, kind: `builtin-${event.toolName}` });
      pi.events.emit("pi-roblox/v1:before-mutation", {
        kind: `builtin-${event.toolName}`,
        toolCallId: event.toolCallId,
        target: path,
        checkpointId: checkpoint.id
      });
    }

    return undefined;
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "write" && event.toolName !== "edit") return;
    try {
      const active = await getRuntime(ctx, ctx.signal);
      const checkpointId = builtinCheckpoints.get(event.toolCallId);
      builtinCheckpoints.delete(event.toolCallId);
      if (checkpointId) await active.checkpoints.finalize(checkpointId);
      if (!event.isError && active.config.mode === "rojo") {
        await active.refreshRojo(ctx.signal);
      }
      await active.audit.record(
        event.isError ? "builtin-mutation.failed" : "builtin-mutation.complete",
        { toolName: event.toolName, checkpointId },
        { toolCallId: event.toolCallId, source: "builtin-tool" }
      );
      pi.events.emit("pi-roblox/v1:after-mutation", {
        kind: `builtin-${event.toolName}`,
        toolCallId: event.toolCallId,
        checkpointId,
        isError: event.isError
      });
      await updateStatus(ctx, active);
    } catch {
      // A source write must not be retroactively changed into a failure just because
      // status refresh or sourcemap regeneration failed. /roblox doctor exposes it.
    }
  });
}
