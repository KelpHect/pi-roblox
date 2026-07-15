import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AuditLog } from "../src/audit.js";
import { CheckpointManager } from "../src/checkpoints.js";
import { DEFAULT_CONFIG } from "../src/config.js";

function config() {
  const value = structuredClone(DEFAULT_CONFIG);
  value.mode = "studio-only";
  return value;
}

test("audit log redacts secrets and source payloads while returning newest records first", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-roblox-audit-"));
  const audit = new AuditLog(cwd, config());
  await audit.record("first", {
    apiKey: "secret-one",
    nested: {
      authorization: "Bearer hidden",
      arguments: { code: "return game.PlaceId", content: "source text" }
    },
    validation: { code: 0 },
    sourcePath: "src/Main.luau"
  });
  await audit.record("second", { safe: "visible" });
  await audit.close();

  const recent = await audit.recent(10);
  assert.deepEqual(recent.map((entry) => entry.event), ["second", "first"]);
  const first = recent.find((entry) => entry.event === "first")!;
  assert.deepEqual(first.data, {
    apiKey: "[REDACTED]",
    nested: {
      authorization: "[REDACTED]",
      arguments: { code: "[REDACTED_CODE]", content: "[REDACTED_CODE]" }
    },
    validation: { code: 0 },
    sourcePath: "src/Main.luau"
  });
});

test("audit log safely serializes cyclic values", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-roblox-audit-cycle-"));
  const audit = new AuditLog(cwd, config());
  const cyclic: { name: string; self?: unknown } = { name: "root" };
  cyclic.self = cyclic;
  await audit.record("cycle", cyclic);
  await audit.close();

  const [record] = await audit.recent(1);
  assert.deepEqual(record?.data, { name: "root", self: "[CIRCULAR]" });
});

test("checkpoint restore is byte-exact and rejects overwriting divergent work", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-roblox-checkpoint-"));
  const target = join(cwd, "Main.luau");
  await writeFile(target, "return 'before'\n");
  const manager = new CheckpointManager(cwd, config());

  const checkpoint = await manager.create([target], "test checkpoint");
  await writeFile(target, "return 'after'\n");
  await manager.finalize(checkpoint.id);

  await writeFile(target, "return 'newer collaborator work'\n");
  await assert.rejects(manager.restore(checkpoint.id), /Rollback conflict/);

  await manager.restore(checkpoint.id, { force: true });
  assert.equal(await readFile(target, "utf8"), "return 'before'\n");
});

test("checkpoint restore removes a file created after the checkpoint", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-roblox-checkpoint-new-"));
  const target = join(cwd, "Created.luau");
  const manager = new CheckpointManager(cwd, config());
  const checkpoint = await manager.create([target], "new file");
  await writeFile(target, "return true\n");
  await manager.finalize(checkpoint.id);
  await manager.restore(checkpoint.id);
  await assert.rejects(readFile(target, "utf8"), /ENOENT/);
});

test("checkpoint restore refuses a symbolic-link parent inserted after capture", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-roblox-checkpoint-link-"));
  const directory = join(cwd, "src");
  const target = join(directory, "Main.luau");
  const replacement = join(cwd, "replacement");
  await mkdir(directory);
  await mkdir(replacement);
  await writeFile(target, "return 'before'\n");
  const manager = new CheckpointManager(cwd, config());
  const checkpoint = await manager.create([target], "symlink protection");
  await writeFile(target, "return 'after'\n");
  await manager.finalize(checkpoint.id);

  await rm(directory, { recursive: true, force: true });
  try {
    await symlink(replacement, directory, "dir");
  } catch (error) {
    t.skip(`Symlinks unavailable: ${(error as Error).message}`);
    return;
  }

  await assert.rejects(
    manager.restore(checkpoint.id, { force: true }),
    /symbolic-link component/
  );
});
