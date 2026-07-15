import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import robloxExtension from "../extensions/roblox/index.js";

test("extension registers the complete Pi surface", () => {
  const tools: string[] = [];
  const commands: string[] = [];
  const events: string[] = [];

  const api = {
    registerTool(tool: { name: string }) {
      tools.push(tool.name);
    },
    registerCommand(name: string) {
      commands.push(name);
    },
    on(event: string) {
      events.push(event);
    }
  } as unknown as ExtensionAPI;

  robloxExtension(api);

  assert.deepEqual(tools, [
    "roblox_status",
    "roblox_doctor",
    "roblox_search",
    "roblox_inspect",
    "roblox_studio",
    "roblox_files",
    "roblox_apply",
    "roblox_mutate",
    "roblox_test",
    "roblox_scenario",
    "roblox_checkpoint",
    "roblox_rojo"
  ]);
  assert.deepEqual(commands, ["roblox"]);
  assert.deepEqual(events, [
    "session_start",
    "session_shutdown",
    "before_agent_start",
    "tool_call",
    "tool_result"
  ]);
});
