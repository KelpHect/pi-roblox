import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEFAULT_CONFIG,
  loadRobloxConfig,
  writeDefaultRobloxConfig,
  writeRobloxConfig
} from "../src/config.js";

test("config loader accepts JSONC and merges secure defaults", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-roblox-config-"));
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await writeFile(
    join(cwd, ".pi", "roblox.json"),
    `{
      // User settings may be partial.
      "version": 1,
      "mode": "studio-only",
      "expectedPlaceIds": [123, 123, 456],
      "studio": { "autoConnect": false, },
      "validation": {
        "defaultProfile": "changed",
        "profiles": { "changed": ["missing-check"] }
      }
    }`
  );

  const loaded = await loadRobloxConfig(cwd);
  assert.equal(loaded.exists, true);
  assert.equal(loaded.config.mode, "studio-only");
  assert.equal(loaded.config.studio.autoConnect, false);
  assert.deepEqual(loaded.config.expectedPlaceIds, [123, 456]);
  assert.deepEqual(loaded.config.studio.deniedTools, DEFAULT_CONFIG.studio.deniedTools);
  assert.equal(loaded.config.audit.enabled, true);
  assert.match(loaded.warnings.join("\n"), /missing-check/);
});

test("config loader rejects malformed JSONC", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-roblox-config-bad-"));
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await writeFile(join(cwd, ".pi", "roblox.json"), `{ "version": 1, nope }`);
  await assert.rejects(loadRobloxConfig(cwd), /Invalid JSON\/JSONC/);
});

test("config loader rejects unsupported explicit versions", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-roblox-config-version-"));
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await writeFile(join(cwd, ".pi", "roblox.json"), `{ "version": 2 }\n`);
  await assert.rejects(loadRobloxConfig(cwd), /Unsupported Roblox config version 2/);
});

test("writeDefaultRobloxConfig creates a usable project-local config without overwriting", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-roblox-config-write-"));
  const path = await writeDefaultRobloxConfig(cwd);
  const parsed = JSON.parse(await readFile(path, "utf8")) as { version: number; studio: { deniedTools: string[] } };
  assert.equal(parsed.version, 1);
  assert.ok(parsed.studio.deniedTools.includes("subagent"));
  await assert.rejects(writeDefaultRobloxConfig(cwd), /already exists/i);
});


test("writeRobloxConfig persists an explicitly discovered setup without weakening defaults", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-roblox-config-custom-"));
  const config = structuredClone(DEFAULT_CONFIG);
  config.mode = "studio-only";
  config.expectedPlaceIds = [123456789];
  const path = await writeRobloxConfig(cwd, config);
  const loaded = await loadRobloxConfig(cwd);
  assert.equal(path, join(cwd, ".pi", "roblox.json"));
  assert.equal(loaded.config.mode, "studio-only");
  assert.deepEqual(loaded.config.expectedPlaceIds, [123456789]);
  assert.ok(loaded.config.studio.deniedTools.includes("subagent"));
});
