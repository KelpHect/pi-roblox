#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { arch, platform, release, version as osVersion } from "node:os";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { parseConsoleResult } from "../src/console.js";
import { nodeCommandRunner } from "../src/command-runner.js";
import { RobloxRuntime } from "../src/runtime.js";
import {
  studioResultJson,
  studioResultText,
  type StudioToolDescriptor
} from "../src/studio-client.js";
import {
  buildExecuteLuauArguments,
  buildPathArguments,
  buildSetActiveStudioArguments
} from "../src/studio-schema.js";
import type { StudioMutationOperation } from "../src/studio-transaction.js";

interface Options {
  cwd: string;
  output: string;
  studioVersion?: string;
}

interface CheckResult {
  name: string;
  status: "pass" | "fail";
  startedAt: string;
  durationMs: number;
  error?: string;
}

interface LiveReport {
  schemaVersion: 1;
  status: "running" | "pass" | "fail";
  startedAt: string;
  finishedAt?: string;
  environment: Record<string, unknown>;
  checks: CheckResult[];
  evidence: Record<string, unknown>;
  cleanup: Array<{ checkpointId: string; status: "restored" | "failed"; error?: string }>;
  error?: string;
}

function parseArgs(argv: string[]): Options {
  const cwdIndex = argv.indexOf("--cwd");
  const outputIndex = argv.indexOf("--output");
  if (cwdIndex < 0 || !argv[cwdIndex + 1]) throw new Error("--cwd is required.");
  if (outputIndex < 0 || !argv[outputIndex + 1]) throw new Error("--output is required.");
  const studioIndex = argv.indexOf("--studio-version");
  const result: Options = {
    cwd: resolve(argv[cwdIndex + 1]!),
    output: resolve(argv[outputIndex + 1]!)
  };
  const studioVersion = studioIndex >= 0 ? argv[studioIndex + 1] : undefined;
  if (studioVersion) result.studioVersion = studioVersion;
  return result;
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function commandVersion(command: string, args: string[]): string {
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true });
  return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
}

function findPayloadLeaks(value: unknown): string[] {
  const leaks: string[] = [];
  const payloadKey = /^(?:code|content|source|old_string|new_string|script_source|scriptsource)$/i;
  const secretKey = /(?:api[-_]?key|authorization|cookie|password|passwd|secret|token|credential|session)/i;

  function visit(node: unknown, path: string, depth: number): void {
    if (depth > 20 || typeof node !== "object" || node === null) return;
    if (Array.isArray(node)) {
      node.forEach((entry, index) => visit(entry, `${path}[${index}]`, depth + 1));
      return;
    }
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      const childPath = path ? `${path}.${key}` : key;
      if (payloadKey.test(key) && typeof child === "string" && child !== "[REDACTED_CODE]") {
        leaks.push(childPath);
      }
      if (secretKey.test(key) && child !== "[REDACTED]") leaks.push(childPath);
      visit(child, childPath, depth + 1);
    }
  }

  visit(value, "", 0);
  return leaks;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const report: LiveReport = {
    schemaVersion: 1,
    status: "running",
    startedAt: new Date().toISOString(),
    environment: {
      platform: platform(),
      arch: arch(),
      osRelease: release(),
      osVersion: osVersion(),
      node: process.version,
      rojo: commandVersion("rojo", ["--version"]),
      ...(options.studioVersion ? { studioVersion: options.studioVersion } : {}),
      cwd: options.cwd
    },
    checks: [],
    evidence: {},
    cleanup: []
  };
  const runtime = new RobloxRuntime(options.cwd, ".pi", nodeCommandRunner);
  const pendingCheckpoints: string[] = [];
  const sourcePath = resolve(options.cwd, "src/shared/LiveSmoke.luau");
  const errorSourcePath = resolve(options.cwd, "src/server/LiveError.server.luau");
  const originalSource = await readFile(sourcePath, "utf8");
  const originalErrorSource = await readFile(errorSourcePath, "utf8");
  const approve = async (): Promise<boolean> => true;

  const check = async <T>(name: string, work: () => Promise<T>): Promise<T> => {
    const started = Date.now();
    const startedAt = new Date(started).toISOString();
    try {
      const value = await work();
      report.checks.push({ name, status: "pass", startedAt, durationMs: Date.now() - started });
      return value;
    } catch (error) {
      report.checks.push({
        name,
        status: "fail",
        startedAt,
        durationMs: Date.now() - started,
        error: errorMessage(error)
      });
      throw error;
    }
  };

  const getTool = async (name: string): Promise<StudioToolDescriptor> => {
    const tool = (await runtime.listStudioTools()).find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`Studio did not expose ${name}.`);
    return tool;
  };

  const readStudioScript = async (studioPath: string): Promise<string> => {
    const tool = await getTool("script_read");
    const result = await runtime.callStudioTool(tool.name, buildPathArguments(tool, studioPath), approve);
    if (result.isError) throw new Error(studioResultText(result));
    return studioResultText(result);
  };

  const waitForStudioScript = async (studioPath: string, expected: string): Promise<string> => {
    const deadline = Date.now() + runtime.config.studio.syncTimeoutMs;
    let latest = "";
    while (Date.now() <= deadline) {
      try {
        latest = await readStudioScript(studioPath);
        if (latest.includes(expected)) return latest;
      } catch {
        // Rojo and Studio can briefly disagree while the plugin applies a patch.
      }
      await delay(250);
    }
    throw new Error(`Studio source did not contain ${JSON.stringify(expected)} before the synchronization timeout. Last read: ${latest.slice(0, 500)}`);
  };

  try {
    await check("runtime-initialize", async () => {
      await runtime.initialize();
      return true;
    });

    const doctor = await check("doctor", async () => {
      const value = await runtime.doctor({ connectStudio: true });
      assertCondition(value.status === "pass", "Live doctor did not pass.");
      return value;
    });
    report.evidence.doctor = doctor;

    const tools = await check("studio-tool-discovery", async () => {
      const value = await runtime.listStudioTools(true);
      assertCondition(value.length >= 8, `Expected a live Studio tool surface; received ${value.length}.`);
      for (const required of runtime.config.studio.requiredTools) {
        assertCondition(value.some((tool) => tool.name === required), `Missing required Studio tool ${required}.`);
      }
      return value;
    });
    report.evidence.studioTools = tools.map((tool) => tool.name);

    const studiosEvidence = await check("studio-selection", async () => {
      const listed = await runtime.callStudioTool("list_roblox_studios", {}, approve);
      const payload = studioResultJson(listed) as {
        studios?: Array<{ id?: string; name?: string; active?: boolean }>;
      } | undefined;
      const studio = payload?.studios?.[0];
      assertCondition(typeof studio?.id === "string", "Studio list did not return a selectable Studio ID.");
      const selectTool = tools.find((tool) => tool.name === "set_active_studio");
      assertCondition(selectTool, "set_active_studio was not exposed.");
      await runtime.callStudioTool(
        selectTool.name,
        buildSetActiveStudioArguments(selectTool, studio.id),
        approve
      );
      return { listed: payload, selectedStudioId: studio.id, selectedStudioName: studio.name };
    });
    report.evidence.studios = studiosEvidence;

    const placeEvidence = await check("place-identity", async () => {
      const execute = await getTool("execute_luau");
      const result = await runtime.callStudioTool(
        execute.name,
        buildExecuteLuauArguments(
          execute,
          "return { placeId = game.PlaceId, gameId = game.GameId, placeVersion = game.PlaceVersion }",
          "Edit"
        ),
        approve
      );
      const payload = studioResultJson(result) as {
        placeId?: number;
        gameId?: number;
        placeVersion?: number;
      } | undefined;
      assertCondition(payload?.placeId === 118023848497907, `Unexpected place ID ${String(payload?.placeId)}.`);
      return payload;
    });
    report.evidence.place = placeEvidence;

    const validation = await check("validation-profile", async () => {
      const value = await runtime.validate("default");
      assertCondition(value.status === "pass", "The live validation profile failed.");
      return value;
    });
    report.evidence.validation = validation;

    const initialInspection = await check("mapped-source-inspection", async () => {
      for (let attempt = 0; attempt < 30; attempt += 1) {
        try {
          const value = await runtime.inspect("src/shared/LiveSmoke.luau");
          if (
            value.ownership.ownership === "rojo-owned" &&
            value.file &&
            value.studio &&
            !value.studio.isError &&
            studioResultText(value.studio).includes("ORIGINAL")
          ) {
            return value;
          }
        } catch {
          // The Studio plugin can take a moment to reconnect after the server starts.
        }
        await delay(500);
      }
      throw new Error("Mapped source was not visible through live Studio after 15 seconds.");
    });
    assertCondition(initialInspection.file, "Mapped source inspection did not return a file hash.");
    report.evidence.initialInspection = {
      ownership: initialInspection.ownership,
      sha256: initialInspection.file.sha256,
      size: initialInspection.file.size,
      studioReadback: true
    };

    const changedSource = originalSource
      .replace('LiveSmoke.marker = "ORIGINAL"', 'LiveSmoke.marker = "WINDOWS_LIVE_CHANGED"')
      .replace("\treturn 1", "\treturn 2");
    const fileTransaction = await check("filesystem-transaction-and-sync", async () => {
      const value = await runtime.replaceFile({
        target: "src/shared/LiveSmoke.luau",
        content: changedSource,
        expectedSha256: initialInspection.file!.sha256,
        validate: true,
        validationProfile: "changed",
        label: "Windows live mapped-source mutation"
      });
      assertCondition(value.status === "applied", `Unexpected file transaction status ${value.status}.`);
      assertCondition(value.checkpointId, "File transaction did not return a checkpoint.");
      pendingCheckpoints.push(value.checkpointId);
      assertCondition(value.sync.some((entry) => entry.status === "verified"), "Studio synchronization was not verified.");
      return value;
    });
    report.evidence.fileTransaction = fileTransaction;

    const staleRejection = await check("stale-hash-rejection", async () => {
      try {
        await runtime.replaceFile({
          target: "src/shared/LiveSmoke.luau",
          content: `${changedSource}\n-- stale retry\n`,
          expectedSha256: initialInspection.file!.sha256,
          validate: false
        });
      } catch (error) {
        const message = errorMessage(error);
        assertCondition(/stale mutation rejected/i.test(message), `Unexpected stale-write error: ${message}`);
        assertCondition(await readFile(sourcePath, "utf8") === changedSource, "Stale retry changed the filesystem source.");
        return { rejected: true, message };
      }
      throw new Error("A stale SHA-256 mutation was unexpectedly accepted.");
    });
    report.evidence.staleHash = staleRejection;

    await check("filesystem-checkpoint-rollback", async () => {
      const checkpointId = fileTransaction.checkpointId!;
      const value = await runtime.rollback(checkpointId, { approve });
      pendingCheckpoints.splice(pendingCheckpoints.indexOf(checkpointId), 1);
      assertCondition(await readFile(sourcePath, "utf8") === originalSource, "Filesystem rollback did not restore original bytes.");
      const studioSource = await waitForStudioScript("game.ReplicatedStorage.PiRobloxLive.LiveSmoke", "ORIGINAL");
      assertCondition(studioSource.includes("ORIGINAL"), "Studio rollback readback did not restore original source.");
      return value;
    });
    report.evidence.fileRollback = { restored: true, originalBytes: Buffer.byteLength(originalSource) };

    const createOperations: StudioMutationOperation[] = [
      {
        kind: "create",
        parent: "game.Workspace",
        className: "Folder",
        name: "PiRobloxStudioOwned",
        attributes: { Phase: "created" },
        tags: ["PiRobloxLive"]
      },
      {
        kind: "set-attributes",
        target: "game.Workspace.PiRobloxStudioOwned",
        attributes: { Phase: "updated", Enabled: true }
      },
      {
        kind: "create",
        parent: "game.Workspace.PiRobloxStudioOwned",
        className: "Part",
        name: "CheckpointPart",
        properties: {
          Anchored: true,
          Position: { $type: "Vector3", value: [0, 5, 0] },
          Color: { $type: "Color3RGB", value: [0, 170, 255] }
        },
        tags: ["PiRobloxLive"]
      }
    ];
    const studioDryRun = await check("studio-transaction-dry-run", async () => {
      const value = await runtime.mutateStudio(createOperations, approve, { dryRun: true });
      assertCondition(value.status === "dry-run", "Structured Studio dry-run did not stay non-mutating.");
      return value;
    });
    report.evidence.studioDryRun = studioDryRun;

    const studioCreate = await check("studio-create-and-set-transaction", async () => {
      const value = await runtime.mutateStudio(createOperations, approve, {
        label: "Windows live Studio create/set transaction"
      });
      assertCondition(value.status === "applied" && value.checkpointId, "Studio create transaction was not checkpointed.");
      pendingCheckpoints.push(value.checkpointId);
      const inspectTool = await getTool("inspect_instance");
      const inspected = await runtime.callStudioTool(
        inspectTool.name,
        buildPathArguments(inspectTool, "game.Workspace.PiRobloxStudioOwned.CheckpointPart"),
        approve
      );
      assertCondition(!inspected.isError, "Created Studio part was not inspectable.");
      return value;
    });
    report.evidence.studioCreate = {
      status: studioCreate.status,
      checkpointId: studioCreate.checkpointId,
      operationCount: studioCreate.operations.length,
      payloadOk: studioCreate.payload?.ok
    };

    const studioDelete = await check("studio-delete-transaction", async () => {
      const value = await runtime.mutateStudio(
        [{ kind: "delete", target: "game.Workspace.PiRobloxStudioOwned.CheckpointPart" }],
        approve,
        { label: "Windows live Studio delete transaction" }
      );
      assertCondition(value.status === "applied" && value.checkpointId, "Studio delete transaction was not checkpointed.");
      pendingCheckpoints.push(value.checkpointId);
      return value;
    });
    report.evidence.studioDelete = {
      status: studioDelete.status,
      checkpointId: studioDelete.checkpointId,
      payloadOk: studioDelete.payload?.ok
    };

    await check("studio-delete-rollback", async () => {
      await runtime.rollback(studioDelete.checkpointId!, { approve });
      pendingCheckpoints.splice(pendingCheckpoints.indexOf(studioDelete.checkpointId!), 1);
      const inspectTool = await getTool("inspect_instance");
      const inspected = await runtime.callStudioTool(
        inspectTool.name,
        buildPathArguments(inspectTool, "game.Workspace.PiRobloxStudioOwned.CheckpointPart"),
        approve
      );
      assertCondition(!inspected.isError, "Delete rollback did not restore the Studio part.");
      return true;
    });

    await check("studio-create-rollback", async () => {
      await runtime.rollback(studioCreate.checkpointId!, { approve });
      pendingCheckpoints.splice(pendingCheckpoints.indexOf(studioCreate.checkpointId!), 1);
      const search = await runtime.search("PiRobloxStudioOwned", { source: false, studio: true });
      const text = search.studio ? studioResultText(search.studio) : "";
      assertCondition(!text.includes("Workspace.PiRobloxStudioOwned"), "Create rollback left the Studio-owned root behind.");
      return true;
    });
    report.evidence.studioRollback = { deleteRestored: true, createRemoved: true };

    const smokeScenario = await check("playtest-screenshot-console-teardown", async () => {
      const value = await runtime.runScenario("smoke", approve, undefined, { source: "runtime" });
      assertCondition(value.status === "pass", `Smoke scenario status was ${value.status}.`);
      const artifacts = value.steps.flatMap((step) => step.artifacts ?? []);
      const image = artifacts.find((artifact) => artifact.kind === "image");
      assertCondition(image, "Smoke scenario did not create an image artifact.");
      assertCondition((await stat(image.path)).size > 0, "Screenshot artifact is empty.");
      assertCondition(value.steps.some((step) => step.kind === "console" && step.status === "pass"), "Console capture did not pass.");
      assertCondition(value.steps.some((step) => step.kind === "play" && step.summary.includes("stop")), "Play stop was not recorded.");
      return value;
    });
    report.evidence.smokeScenario = smokeScenario;

    const errorInspection = await runtime.inspect("src/server/LiveError.server.luau");
    assertCondition(errorInspection.file, "Mapped error script inspection did not return a hash.");
    const errorTransaction = await check("controlled-runtime-error-sync", async () => {
      const value = await runtime.replaceFile({
        target: "src/server/LiveError.server.luau",
        content: 'error("PI_ROBLOX_LIVE_CONTROLLED_ERROR")\n',
        expectedSha256: errorInspection.file!.sha256,
        validate: false,
        label: "Windows live controlled runtime error"
      });
      assertCondition(value.status === "applied" && value.checkpointId, "Controlled error source was not checkpointed.");
      pendingCheckpoints.push(value.checkpointId);
      assertCondition(value.sync.some((entry) => entry.status === "verified"), "Controlled error source did not synchronize.");
      return value;
    });

    const errorScenario = await check("console-source-remapping", async () => {
      const value = await runtime.runScenario({
        version: 1,
        name: "Controlled mapped runtime error",
        steps: [
          { kind: "play", action: "start", mode: "play" },
          { kind: "wait", milliseconds: 2000 },
          { kind: "console", dataModelType: "Server", name: "controlled-error-console" },
          { kind: "play", action: "stop" }
        ],
        failOnConsoleErrors: false,
        failOnConsoleWarnings: false,
        alwaysStopPlay: true
      }, approve, undefined, { source: "runtime" });
      const consoleTool = await getTool("get_console_output");
      const consoleResult = await runtime.callStudioTool(consoleTool.name, {}, approve);
      const parsed = parseConsoleResult(options.cwd, runtime.rojo, consoleResult);
      const mapped = parsed.entries.find((entry) =>
        entry.message.includes("PI_ROBLOX_LIVE_CONTROLLED_ERROR") &&
        entry.sourcePath?.replaceAll("\\", "/").endsWith("src/server/LiveError.server.luau")
      );
      assertCondition(mapped, "Controlled Studio error was not remapped to the filesystem source path.");
      return { scenario: value, mappedDiagnostic: mapped };
    });
    report.evidence.controlledError = errorScenario;

    await check("controlled-error-rollback", async () => {
      await runtime.rollback(errorTransaction.checkpointId!, { approve });
      pendingCheckpoints.splice(pendingCheckpoints.indexOf(errorTransaction.checkpointId!), 1);
      assertCondition(await readFile(errorSourcePath, "utf8") === originalErrorSource, "Controlled error rollback did not restore source bytes.");
      const studioSource = await waitForStudioScript("game.ServerScriptService.PiRobloxLiveError", "PI_ROBLOX_LIVE_READY");
      assertCondition(studioSource.includes("PI_ROBLOX_LIVE_READY"), "Studio did not receive the controlled-error rollback.");
      return true;
    });

    const wrongPlace = await check("wrong-place-guard", async () => {
      const originalConfigIds = [...runtime.config.expectedPlaceIds];
      const project = runtime.project;
      assertCondition(project, "Runtime project metadata is unavailable.");
      const originalProjectIds = [...project.servePlaceIds];
      try {
        runtime.config.expectedPlaceIds = [1];
        project.servePlaceIds = [1];
        try {
          await runtime.mutateStudio(
            [{ kind: "create", parent: "game.Workspace", className: "Folder", name: "MustNotExist" }],
            approve
          );
        } catch (error) {
          const message = errorMessage(error);
          assertCondition(/not allowed; expected one of 1/i.test(message), `Unexpected wrong-place error: ${message}`);
          return { rejected: true, currentPlaceId: 118023848497907, configuredExpectedPlaceId: 1, message };
        }
        throw new Error("Studio mutation was accepted with a deliberately mismatched place guard.");
      } finally {
        runtime.config.expectedPlaceIds = originalConfigIds;
        project.servePlaceIds = originalProjectIds;
      }
    });
    report.evidence.wrongPlace = wrongPlace;

    const deniedTool = await check("roblox-hosted-subagent-denial", async () => {
      assertCondition(runtime.isStudioToolDenied("subagent"), "subagent was not classified as denied.");
      try {
        await runtime.callStudioTool("subagent", {
          task: "This must not run",
          description: "Testing denial",
          subagent_type: "explore"
        }, approve);
      } catch (error) {
        const message = errorMessage(error);
        assertCondition(/denied by the strict Pi-only policy/i.test(message), `Unexpected denial error: ${message}`);
        return { rejected: true, message };
      }
      throw new Error("Roblox-hosted subagent was unexpectedly callable.");
    });
    report.evidence.deniedTool = deniedTool;

    const auditEvidence = await check("audit-redaction", async () => {
      const records = await runtime.audit.recent(2_000);
      // Audit context has typed metadata such as context.source="runtime";
      // source-code and secret redaction applies to the recursively recorded data payload.
      const leaks = findPayloadLeaks(records.map((record) => record.data));
      assertCondition(leaks.length === 0, `Audit payload leak(s): ${leaks.join(", ")}`);
      assertCondition(records.length > 0, "No audit records were written.");
      return {
        recordCount: records.length,
        events: [...new Set(records.map((record) => record.event))].sort(),
        payloadLeaks: leaks
      };
    });
    report.evidence.audit = auditEvidence;

    report.status = "pass";
  } catch (error) {
    report.status = "fail";
    report.error = errorMessage(error);
  } finally {
    for (const checkpointId of [...pendingCheckpoints].reverse()) {
      try {
        await runtime.rollback(checkpointId, { approve, force: false });
        report.cleanup.push({ checkpointId, status: "restored" });
      } catch (error) {
        report.cleanup.push({ checkpointId, status: "failed", error: errorMessage(error) });
      }
    }
    await runtime.close();
    report.finishedAt = new Date().toISOString();
    await mkdir(dirname(options.output), { recursive: true });
    await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`);
  }

  process.stdout.write(`${JSON.stringify({ status: report.status, output: options.output, checks: report.checks }, null, 2)}\n`);
  if (report.status !== "pass") process.exitCode = 1;
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
