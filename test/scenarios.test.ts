import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ArtifactStore } from "../src/artifacts.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import {
  evaluateExpectation,
  parseScenario,
  ScenarioRunner,
  ScenarioStore,
  type ScenarioToolBridge
} from "../src/scenarios.js";
import type { StudioToolDescriptor, StudioToolResult } from "../src/studio-client.js";

const objectSchema = { type: "object", properties: {}, additionalProperties: true };

function descriptor(name: string): StudioToolDescriptor {
  return { name, inputSchema: objectSchema };
}

function result(value: unknown): StudioToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

test("scenario parser validates steps and expectation evaluation supports JSON paths", () => {
  const parsed = parseScenario({
    version: 1,
    name: "inventory smoke",
    steps: [
      { kind: "tool", tool: "echo", arguments: { value: 42 }, saveAs: "echo" },
      { kind: "assert", from: "echo", expect: { jsonPath: "$.answer", equals: 42 } }
    ]
  });
  assert.equal(parsed.steps.length, 2);
  assert.equal(evaluateExpectation({ answer: 42 }, { jsonPath: "$.answer", equals: 42 }).pass, true);
  assert.equal(evaluateExpectation("hello", { contains: "ell", not: true }).pass, false);
  assert.throws(
    () => parseScenario({ name: "bad", steps: [{ kind: "navigate", target: "Workspace.Part" }] }),
    /game\.\* path/
  );
});

test("scenario store writes and reloads a smoke scenario", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-roblox-scenario-store-"));
  const config = structuredClone(DEFAULT_CONFIG);
  const store = new ScenarioStore(cwd, config);
  const path = await store.writeExample();
  const loaded = await store.load("smoke");
  assert.equal(loaded.path, path);
  assert.equal(loaded.scenario.name, "Studio smoke test");
  assert.match(await readFile(path, "utf8"), /smoke-viewport/);
});

test("scenario runner executes saved-value assertions and writes a report", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-roblox-scenario-run-"));
  const config = structuredClone(DEFAULT_CONFIG);
  let consoleCalls = 0;
  const bridge: ScenarioToolBridge = {
    async getTool(name: string) {
      return descriptor(name);
    },
    async callTool(name: string, args: Record<string, unknown>) {
      if (name === "get_console_output") {
        consoleCalls += 1;
        return result({ entries: [] });
      }
      if (name === "echo") return result({ answer: args.value });
      throw new Error(`Unexpected tool ${name}`);
    }
  };
  const runner = new ScenarioRunner(config, new ArtifactStore(cwd, config), bridge);
  const scenario = parseScenario({
    name: "fake bridge",
    steps: [
      { kind: "tool", tool: "echo", arguments: { value: 42 }, saveAs: "echo" },
      { kind: "assert", from: "echo", expect: { jsonPath: "$.answer", equals: 42 } }
    ]
  });
  const run = await runner.run(scenario);
  assert.equal(run.status, "pass");
  assert.equal(consoleCalls, 2);
  assert.equal((run.savedValues.echo as { answer: number }).answer, 42);
  assert.match(await readFile(run.reportArtifact.path, "utf8"), /"status": "pass"/);
});

test("artifact storage extracts valid images and omits inline base64 from JSON", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-roblox-artifacts-image-"));
  const config = structuredClone(DEFAULT_CONFIG);
  const run = new ArtifactStore(cwd, config).run("image");
  const png = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");
  const references = await run.writeStudioResult("capture", {
    content: [{ type: "image", mimeType: "image/png", data: png }]
  });
  const json = references.find((reference) => reference.kind === "json");
  const image = references.find((reference) => reference.kind === "image");
  assert.ok(json);
  assert.ok(image);
  assert.doesNotMatch(await readFile(json.path, "utf8"), new RegExp(png));
  assert.equal((await readFile(image.path)).toString("hex"), "89504e470d0a1a0a");
});

test("artifact storage rejects invalid image payloads", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-roblox-artifacts-invalid-"));
  const config = structuredClone(DEFAULT_CONFIG);
  const run = new ArtifactStore(cwd, config).run("invalid-image");
  await assert.rejects(
    run.writeStudioResult("capture", {
      content: [{ type: "image", mimeType: "image/png", data: "not base64" }]
    }),
    /invalid base64/
  );
});


test("scenario parser rejects jsonPath without a predicate", () => {
  assert.throws(
    () =>
      parseScenario({
        version: 1,
        name: "invalid expectation",
        steps: [
          {
            kind: "assert",
            value: { ready: true },
            expect: { jsonPath: "$.ready" }
          }
        ]
      }),
    /must define equals, truthy, contains, or matches/
  );
});
