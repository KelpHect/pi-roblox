import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.js";
import { StudioClient } from "../src/studio-client.js";

const fixtureDirectory = dirname(fileURLToPath(import.meta.url));
const fakeStudio = resolve(fixtureDirectory, "fixtures/fake-studio-server.mjs");
const fakeHangingStudio = resolve(fixtureDirectory, "fixtures/fake-hanging-studio.mjs");

async function workspace(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-roblox-studio-client-"));
  const statePath = resolve(cwd, ".pi/roblox/fake-studio-state.json");
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify({ placeId: 123456789, pathMap: {} }));
  return cwd;
}

function config() {
  const value = structuredClone(DEFAULT_CONFIG);
  value.studio.command = process.execPath;
  value.studio.args = [fakeStudio];
  return value;
}

test("Studio client shares concurrent connection attempts", async (t) => {
  const cwd = await workspace();
  const client = new StudioClient();
  t.after(async () => client.close());

  await Promise.all([client.connect(cwd, config()), client.connect(cwd, config())]);
  assert.equal(client.connected, true);
  assert.ok((await client.listTools()).some((tool) => tool.name === "get_studio_state"));
});

test("Studio transport failure rejects without deadlocking the call queue", async (t) => {
  const cwd = await workspace();
  const client = new StudioClient();
  t.after(async () => client.close());

  await client.connect(cwd, config());
  await client.callTool("terminate_server", {}, { timeoutMs: 2_000 });
  await delay(100);

  const attempted = client.callTool("get_studio_state", {}, { timeoutMs: 1_000 });
  let failure: unknown;
  try {
    await Promise.race([
      attempted,
      delay(3_000).then(() => {
        throw new Error("Studio client call queue deadlocked after transport closure.");
      })
    ]);
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof Error);
  assert.match(failure.message, /closed|disconnect|transport|not connected/i);
  assert.equal(client.connected, false, failure.message);
});


test("Studio client bounds a server that never completes MCP initialization", async (t) => {
  const cwd = await workspace();
  const client = new StudioClient();
  t.after(async () => client.close());

  const value = config();
  value.studio.args = [fakeHangingStudio];
  value.studio.connectTimeoutMs = 250;
  await assert.rejects(client.connect(cwd, value), /timed out after 250ms/);
  assert.equal(client.connected, false);
});
