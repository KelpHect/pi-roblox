#!/usr/bin/env node
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod/v4";

const statePath = resolve(process.cwd(), ".pi/roblox/fake-studio-state.json");
const server = new McpServer({ name: "fake-roblox-studio", version: "1.0.0" });
let playing = false;
let activeStudio = "studio-main";

async function readState() {
  if (!existsSync(statePath)) return {};
  return JSON.parse(await readFile(statePath, "utf8"));
}

async function updateState(patch) {
  const state = await readState();
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, `${JSON.stringify({ ...state, ...patch }, null, 2)}\n`);
}

function text(value) {
  return {
    content: [
      {
        type: "text",
        text: typeof value === "string" ? value : JSON.stringify(value)
      }
    ]
  };
}

server.registerTool(
  "script_read",
  {
    description: "Read a script source",
    inputSchema: {
      path: z.string().startsWith("game."),
      datamodel_type: z.enum(["Edit", "Client", "Server"]).optional()
    }
  },
  async ({ path }) => {
    const state = await readState();
    const relativePath = state.pathMap?.[path];
    if (!relativePath) return { ...text({ error: `unknown script ${path}` }), isError: true };
    const source = await readFile(resolve(process.cwd(), relativePath), "utf8");
    return text({ path, source });
  }
);

server.registerTool(
  "script_search",
  {
    description: "Search scripts",
    inputSchema: { query: z.string(), limit: z.number().int().positive().optional() }
  },
  async ({ query }) => text({ query, matches: [] })
);

server.registerTool(
  "script_grep",
  {
    description: "Grep scripts",
    inputSchema: { query: z.string(), limit: z.number().int().positive().optional() }
  },
  async ({ query }) => text({ query, matches: [] })
);

server.registerTool(
  "search_game_tree",
  {
    description: "Search the game tree",
    inputSchema: { query: z.string(), limit: z.number().int().positive().optional() }
  },
  async ({ query, limit }) => {
    const state = await readState();
    const paths = Object.keys(state.pathMap ?? {})
      .filter((path) => path.toLowerCase().includes(query.toLowerCase()))
      .slice(0, limit ?? 50);
    return text({ query, paths });
  }
);

server.registerTool(
  "inspect_instance",
  {
    description: "Inspect an instance",
    inputSchema: {
      path: z.string().startsWith("game."),
      datamodel_type: z.enum(["Edit", "Client", "Server"]).optional()
    }
  },
  async ({ path }) => text({ path, className: path.endsWith("Main") ? "ModuleScript" : "Folder" })
);

server.registerTool(
  "get_studio_state",
  {
    description: "Get Studio state",
    inputSchema: { datamodel_type: z.enum(["Edit", "Client", "Server"]).optional() }
  },
  async ({ datamodel_type }) => {
    const state = await readState();
    if (playing && state.omitPlaceInStudioStateWhenPlaying) {
      return text({ playing, activeStudio, dataModelType: datamodel_type });
    }
    return text({
      placeId: state.placeId ?? 123456789,
      gameId: state.gameId ?? 987654321,
      playing,
      activeStudio
    });
  }
);

server.registerTool(
  "execute_luau",
  {
    description: "Execute Luau",
    inputSchema: {
      code: z.string(),
      datamodel_type: z.enum(["Edit", "Client", "Server"])
    }
  },
  async ({ code, datamodel_type }) => {
    if (code.includes("game.PlaceId") && code.includes("game.GameId")) {
      const state = await readState();
      if (playing && datamodel_type === "Edit") {
        return text({ ok: false, dataModelType: datamodel_type, reason: "Edit DataModel unavailable" });
      }
      return text({
        placeId: state.placeId ?? 123456789,
        gameId: state.gameId ?? 987654321,
        dataModelType: datamodel_type
      });
    }

    const checkpointMatch = code.match(/local checkpointId = (?:\[\[([^\]]+)\]\]|\"([^\"]+)\")/);
    const checkpointId = checkpointMatch?.[1] ?? checkpointMatch?.[2] ?? "fake-checkpoint";

    if (code.includes("pi-roblox-studio-rollback-v1")) {
      return text({
        marker: "pi-roblox-studio-rollback-v1",
        ok: true,
        checkpointId,
        results: [],
        failures: []
      });
    }

    if (code.includes("pi-roblox-studio-transaction-v1")) {
      return text({
        marker: "pi-roblox-studio-transaction-v1",
        ok: true,
        checkpointId,
        snapshot: {
          marker: "pi-roblox-studio-snapshot-v1",
          checkpointId,
          operations: []
        },
        results: [{ kind: "fake", ok: true }]
      });
    }

    if (code.includes("PI_ROBLOX_ADD_CONSOLE_ERROR")) {
      await updateState({
        console: [
          {
            severity: "Error",
            message: "ReplicatedStorage.Shared.Main:2: attempt to index nil"
          }
        ]
      });
    }

    return text({ ok: true, value: 42, dataModelType: datamodel_type, codeReceived: code.length > 0 });
  }
);

server.registerTool(
  "start_stop_play",
  {
    description: "Start or stop play",
    inputSchema: {
      action: z.enum(["start", "stop"]),
      mode: z.enum(["play", "run"]).optional()
    }
  },
  async ({ action, mode }) => {
    playing = action === "start";
    return text({ ok: true, playing, mode: mode ?? "play" });
  }
);

server.registerTool(
  "get_console_output",
  {
    description: "Get console output",
    inputSchema: { datamodel_type: z.enum(["Edit", "Client", "Server"]).optional() }
  },
  async () => {
    const state = await readState();
    return text({ entries: state.console ?? [] });
  }
);

server.registerTool(
  "screen_capture",
  {
    description: "Capture the Studio viewport",
    inputSchema: { capture_id: z.string() }
  },
  async () => ({
    content: [
      {
        type: "image",
        mimeType: "image/png",
        data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2fGQAAAAASUVORK5CYII="
      },
      { type: "text", text: JSON.stringify({ ok: true, width: 1, height: 1 }) }
    ]
  })
);

server.registerTool(
  "character_navigation",
  { description: "Navigate character", inputSchema: { target: z.string().startsWith("game.") } },
  async ({ target }) => text({ ok: true, target })
);

server.registerTool(
  "user_keyboard_input",
  { description: "Keyboard input", inputSchema: { key: z.string(), action: z.string().optional() } },
  async ({ key }) => text({ ok: true, key })
);

server.registerTool(
  "user_mouse_input",
  { description: "Mouse input", inputSchema: { x: z.number(), y: z.number(), action: z.string().optional() } },
  async ({ x, y }) => text({ ok: true, x, y })
);

server.registerTool(
  "list_roblox_studios",
  { description: "List Studio processes", inputSchema: {} },
  async () => text({ studios: [{ id: "studio-main", active: activeStudio === "studio-main" }] })
);

server.registerTool(
  "set_active_studio",
  { description: "Choose Studio", inputSchema: { studio_id: z.string() } },
  async ({ studio_id }) => {
    activeStudio = studio_id;
    await updateState({ activeStudio });
    return text({ ok: true, activeStudio });
  }
);

server.registerTool(
  "terminate_server",
  { description: "Terminate the fake MCP process", inputSchema: {} },
  async () => {
    setTimeout(() => process.exit(0), 10).unref?.();
    return text({ ok: true, terminating: true });
  }
);

server.registerTool(
  "subagent",
  { description: "Opaque built-in agent", inputSchema: { task: z.string() } },
  async ({ task }) => text({ task, forbidden: true })
);

server.registerTool(
  "explore_subagent",
  { description: "Renamed opaque built-in agent", inputSchema: { task: z.string() } },
  async ({ task }) => text({ task, forbidden: true })
);

const transport = new StdioServerTransport();
await server.connect(transport);
