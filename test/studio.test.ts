import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPathArguments,
  buildPlayArguments,
  buildScreenCaptureArguments,
  normalizeScriptReadText,
  StudioSchemaValidator
} from "../src/studio-schema.js";
import {
  generateStudioRollbackLuau,
  generateStudioTransactionLuau,
  parseStudioTransactionResult,
  studioValueToLuau,
  validateStudioOperations,
  type StudioTransactionSnapshot
} from "../src/studio-transaction.js";
import type { StudioToolDescriptor } from "../src/studio-client.js";

test("Studio schema validator enforces dynamically discovered MCP schemas", () => {
  const tool: StudioToolDescriptor = {
    name: "script_read",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["script_path"],
      properties: { script_path: { type: "string", minLength: 1 } }
    }
  };
  const validator = new StudioSchemaValidator();
  const args = buildPathArguments(tool, "game.ServerScriptService.Main");
  validator.validate(tool, args);
  assert.throws(() => validator.validate(tool, {}), /Invalid arguments/);
});

test("path arguments adapt to Studio's target_file schema", () => {
  const tool: StudioToolDescriptor = {
    name: "script_read",
    inputSchema: {
      type: "object",
      required: ["target_file"],
      properties: {
        target_file: { type: "string" },
        should_read_entire_file: { type: "boolean" }
      }
    }
  };
  assert.deepEqual(
    buildPathArguments(tool, "game.ReplicatedStorage.LiveSmoke"),
    { target_file: "game.ReplicatedStorage.LiveSmoke" }
  );
});

test("Studio numbered script reads normalize to raw source", () => {
  assert.equal(
    normalizeScriptReadText('     1→local value = 1\n     2→\n     3→return value\n    4→'),
    "local value = 1\n\nreturn value\n"
  );
  assert.equal(normalizeScriptReadText('{"source":"return true"}'), '{"source":"return true"}');
});

test("play arguments adapt to a Studio tool's enum casing", () => {
  const tool: StudioToolDescriptor = {
    name: "start_stop_play",
    inputSchema: {
      type: "object",
      required: ["command"],
      properties: {
        command: { enum: ["Play", "Stop"] },
        playMode: { enum: ["Play", "Run"] }
      }
    }
  };
  assert.deepEqual(buildPlayArguments(tool, "start", "run"), { command: "Play", playMode: "Run" });
  assert.deepEqual(buildPlayArguments(tool, "stop"), { command: "Stop" });
});

test("play arguments adapt to Studio's current is_start boolean schema", () => {
  const tool: StudioToolDescriptor = {
    name: "start_stop_play",
    inputSchema: {
      type: "object",
      required: ["is_start"],
      properties: { is_start: { type: "boolean" } }
    }
  };
  assert.deepEqual(buildPlayArguments(tool, "start"), { is_start: true });
  assert.deepEqual(buildPlayArguments(tool, "stop"), { is_start: false });
});

test("screen captures provide Studio's required capture_id while preserving overrides", () => {
  const tool: StudioToolDescriptor = {
    name: "screen_capture",
    inputSchema: {
      type: "object",
      required: ["capture_id"],
      properties: { capture_id: { type: "string" } }
    }
  };
  assert.deepEqual(buildScreenCaptureArguments(tool, "smoke-viewport"), {
    capture_id: "smoke-viewport"
  });
  assert.deepEqual(buildScreenCaptureArguments(tool, "generated", { capture_id: "explicit" }), {
    capture_id: "explicit"
  });
});

test("Studio transaction generation validates operations and emits rollback snapshots", () => {
  const operations = [
    {
      kind: "create" as const,
      parent: "game.Workspace",
      className: "Part",
      name: "PiPart",
      properties: {
        Anchored: true,
        Position: { $type: "Vector3" as const, value: [1, 2, 3] }
      },
      attributes: { ManagedByPi: true },
      tags: ["PiGenerated"]
    },
    {
      kind: "set-properties" as const,
      target: "game.Workspace.PiPart",
      properties: { Transparency: 0.5 }
    }
  ];
  validateStudioOperations(operations);
  const code = generateStudioTransactionLuau("cp-test", operations);
  assert.match(code, /pi-roblox-studio-transaction-v1/);
  assert.match(code, /Instance\.new\("Part"\)/);
  assert.match(code, /Vector3\.new\(1,2,3\)/);
  assert.throws(
    () => validateStudioOperations([{ kind: "delete", target: "game.Workspace" }]),
    /top-level service/
  );
  assert.equal(studioValueToLuau({ $type: "Enum", value: "Enum.Material.Neon" }), "Enum.Material.Neon");
});

test("Studio transaction results and rollback code are parseable", () => {
  const payload = {
    marker: "pi-roblox-studio-transaction-v1" as const,
    ok: true,
    checkpointId: "cp-test",
    snapshot: {
      marker: "pi-roblox-studio-snapshot-v1" as const,
      checkpointId: "cp-test",
      operations: [{ kind: "create", pathAfter: "game.Workspace.PiPart" }]
    },
    results: [{ kind: "create", path: "game.Workspace.PiPart" }]
  };
  const parsed = parseStudioTransactionResult({
    content: [{ type: "text", text: JSON.stringify(payload) }]
  });
  assert.equal(parsed.checkpointId, "cp-test");
  const rollback = generateStudioRollbackLuau(payload.snapshot as StudioTransactionSnapshot);
  assert.match(rollback, /pi-roblox-studio-rollback-v1/);
  assert.match(rollback, /game\.Workspace\.PiPart/);
});
