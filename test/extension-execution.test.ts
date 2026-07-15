import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import robloxExtension from "../extensions/roblox/index.js";

interface RegisteredTool {
  name: string;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: (value: unknown) => void,
    ctx: ExtensionContext
  ): Promise<{ content: unknown[]; details?: unknown }>;
}

interface RegisteredCommand {
  handler(args: string, ctx: ExtensionContext): Promise<void>;
  getArgumentCompletions?(prefix: string): Array<{ value: string; label: string }> | null;
}

type EventHandler = (event: Record<string, unknown>, ctx: ExtensionContext) => Promise<unknown>;

const fixtureDirectory = dirname(fileURLToPath(import.meta.url));
const fakeStudio = resolve(fixtureDirectory, "fixtures/fake-studio-server.mjs");

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function createWorkspace(): Promise<{ cwd: string; sourcePath: string }> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-roblox-extension-"));
  const sourcePath = resolve(cwd, "src/Existing.luau");
  await mkdir(dirname(sourcePath), { recursive: true });
  await writeFile(sourcePath, "return 1\n");
  await writeJson(resolve(cwd, ".pi/roblox/fake-studio-state.json"), {
    placeId: 123456789,
    gameId: 987654321,
    pathMap: {},
    console: []
  });
  await writeJson(resolve(cwd, ".pi/roblox.json"), {
    version: 1,
    mode: "studio-only",
    expectedPlaceIds: [123456789],
    studio: {
      autoConnect: true,
      command: process.execPath,
      args: [fakeStudio]
    },
    permissions: {
      profile: "autonomous-local",
      failClosedWithoutUi: true
    },
    validation: {
      commands: [
        {
          name: "node-check",
          command: process.execPath,
          args: ["-e", "process.stdout.write('wrapper-ok')"],
          timeoutMs: 5000,
          continueOnFailure: false,
          env: {}
        }
      ],
      profiles: { default: ["node-check"] },
      defaultProfile: "default"
    }
  });
  return { cwd, sourcePath };
}

test("registered Pi tools, commands, and lifecycle handlers execute through the real runtime", async (t) => {
  const { cwd, sourcePath } = await createWorkspace();

  const tools = new Map<string, RegisteredTool>();
  const commands = new Map<string, RegisteredCommand>();
  const handlers = new Map<string, EventHandler>();
  const emitted: Array<{ name: string; value: unknown }> = [];
  const entries: Array<{ type: string; value: unknown }> = [];
  const notifications: Array<{ message: string; level: string }> = [];
  const statuses: Array<string | undefined> = [];
  t.after(async () => {
    await handlers.get("session_shutdown")?.({}, ctx).catch(() => undefined);
    await rm(cwd, { recursive: true, force: true });
  });

  const pi = {
    registerTool(tool: RegisteredTool) {
      tools.set(tool.name, tool);
    },
    registerCommand(name: string, command: RegisteredCommand) {
      commands.set(name, command);
    },
    on(event: string, handler: EventHandler) {
      handlers.set(event, handler);
    },
    events: {
      emit(name: string, value: unknown) {
        emitted.push({ name, value });
      }
    },
    appendEntry(type: string, value: unknown) {
      entries.push({ type, value });
    }
  } as unknown as ExtensionAPI;

  const ctx = {
    cwd,
    hasUI: true,
    ui: {
      setStatus(_key: string, value: string | undefined) {
        statuses.push(value);
      },
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
      async confirm() {
        return true;
      }
    }
  } as unknown as ExtensionContext;

  robloxExtension(pi);
  assert.equal(tools.size, 12);
  const command = commands.get("roblox");
  assert.ok(command);
  const completions = command.getArgumentCompletions?.("rojo");
  assert.ok(completions?.some((entry) => entry.value === "rojo refresh"));

  await handlers.get("session_start")?.({}, ctx);
  assert.ok(statuses.some((value) => value?.includes("Studio ✓")));

  const execute = async (name: string, params: Record<string, unknown>) => {
    const tool = tools.get(name);
    assert.ok(tool, `Missing registered tool ${name}`);
    const result = await tool.execute(`call-${name}`, params, undefined, () => undefined, ctx);
    assert.ok(Array.isArray(result.content));
    return result;
  };

  await execute("roblox_status", {});
  await execute("roblox_doctor", { connectStudio: false });
  await execute("roblox_search", { query: "Existing", source: true, studio: true });
  const inspection = await execute("roblox_inspect", { target: "src/Existing.luau" });
  const studioTools = await execute("roblox_studio", { action: "list_tools" });
  assert.ok(JSON.stringify(studioTools.details).includes("get_studio_state"));
  await execute("roblox_studio", { action: "call", tool: "get_studio_state", arguments: {} });
  await execute("roblox_files", {
    operations: [{ kind: "write", target: "src/DryRun.luau", content: "return true\n" }],
    dryRun: true,
    validate: false
  });

  const expectedSha256 = (inspection.details as { file: { sha256: string } }).file.sha256;
  await execute("roblox_apply", {
    target: "src/Existing.luau",
    content: "return 2\n",
    expectedSha256,
    validate: false
  });
  assert.equal(await readFile(sourcePath, "utf8"), "return 2\n");

  await execute("roblox_mutate", {
    operations: [{ kind: "create", parent: "game.Workspace.Runtime", className: "Folder", name: "Generated" }],
    dryRun: true
  });
  await execute("roblox_test", { validationProfile: "default" });
  await execute("roblox_scenario", { action: "list" });
  await execute("roblox_scenario", {
    action: "run",
    scenario: {
      version: 1,
      name: "Wrapper scenario",
      steps: [{ kind: "tool", tool: "get_studio_state", arguments: {}, saveAs: "state" }],
      alwaysStopPlay: true
    }
  });
  const checkpoint = await execute("roblox_checkpoint", {
    action: "create",
    paths: ["src/Existing.luau"],
    label: "wrapper checkpoint"
  });
  const checkpointId = (checkpoint.details as { id: string }).id;
  assert.ok(checkpointId);
  await execute("roblox_checkpoint", { action: "inspect", id: checkpointId });
  await execute("roblox_rojo", { action: "refresh" });

  for (const args of [
    "status",
    "tools",
    "studios",
    "use studio-main",
    "rojo refresh",
    "ownership src/Existing.luau",
    "conflicts",
    "snapshot",
    "test default",
    "scenario list",
    "checkpoints",
    "audit 5"
  ]) {
    await command.handler(args, ctx);
  }
  await command.handler(`rollback ${checkpointId}`, ctx);
  await command.handler("disconnect", ctx);
  await command.handler("connect", ctx);

  const contextInjection = await handlers.get("before_agent_start")?.({}, ctx);
  assert.ok(JSON.stringify(contextInjection).includes("pi-roblox"));
  await handlers.get("tool_call")?.({
    toolName: "edit",
    toolCallId: "builtin-edit",
    input: { path: "src/Existing.luau" }
  }, ctx);
  await handlers.get("tool_result")?.({
    toolName: "edit",
    toolCallId: "builtin-edit",
    isError: false
  }, ctx);

  assert.ok(entries.some((entry) => entry.type === "pi-roblox-checkpoint"));
  assert.ok(entries.some((entry) => entry.type === "pi-roblox-test-result"));
  assert.ok(emitted.some((entry) => entry.name === "pi-roblox/v1:before-mutation"));
  assert.ok(emitted.some((entry) => entry.name === "pi-roblox/v1:test-result"));
  assert.ok(notifications.length >= 12);

  await handlers.get("session_shutdown")?.({}, ctx);
  assert.equal(statuses.at(-1), undefined);
});
