import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AuditLog } from "../src/audit.js";
import { CheckpointManager } from "../src/checkpoints.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { executeFileTransaction, prepareFileOperations } from "../src/file-transaction.js";
import { OwnershipResolver } from "../src/ownership.js";
import { sha256 } from "../src/util.js";
import type { ValidationRun } from "../src/validation.js";

function makeDependencies(cwd: string, validation: ValidationRun) {
  const config = structuredClone(DEFAULT_CONFIG);
  config.mode = "studio-only";
  config.ownership.requireHashForMappedWrites = true;
  const resolver = new OwnershipResolver(cwd, config);
  const checkpoints = new CheckpointManager(cwd, config);
  const audit = new AuditLog(cwd, config);
  return {
    config,
    resolver,
    checkpoints,
    audit,
    dependencies: {
      cwd,
      config,
      resolver,
      checkpoints,
      audit,
      async refreshRojo() {},
      async verifySync(sourcePath: string, studioPath: string | undefined) {
        return { sourcePath, ...(studioPath ? { studioPath } : {}), status: "not-mapped" as const };
      },
      async validate() {
        return validation;
      }
    }
  };
}

const passingValidation: ValidationRun = {
  profile: "default",
  status: "pass",
  startedAt: new Date(0).toISOString(),
  durationMs: 0,
  results: []
};

test("file transaction supports dry-run, apply, checkpoint, and rollback", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-roblox-files-"));
  const target = join(cwd, "src", "Main.luau");
  await writeFile(target, "return 1\n", { recursive: undefined } as never).catch(async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(target, "return 1\n");
  });
  const setup = makeDependencies(cwd, passingValidation);
  const before = sha256(await readFile(target));

  const dry = await executeFileTransaction(
    setup.dependencies,
    [{ kind: "write", target: "src/Main.luau", content: "return 2\n", expectedSha256: before }],
    { dryRun: true }
  );
  assert.equal(dry.status, "dry-run");
  assert.equal(await readFile(target, "utf8"), "return 1\n");

  const applied = await executeFileTransaction(
    setup.dependencies,
    [{ kind: "write", target: "src/Main.luau", content: "return 2\n", expectedSha256: before }]
  );
  assert.equal(applied.status, "applied");
  assert.ok(applied.checkpointId);
  assert.equal(await readFile(target, "utf8"), "return 2\n");

  await setup.checkpoints.restore(applied.checkpointId!);
  assert.equal(await readFile(target, "utf8"), "return 1\n");
});

test("file transaction rejects stale hashes before changing source", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-roblox-files-stale-"));
  const target = join(cwd, "Main.luau");
  await writeFile(target, "return 1\n");
  const setup = makeDependencies(cwd, passingValidation);
  await assert.rejects(
    prepareFileOperations(
      { cwd, config: setup.config, resolver: setup.resolver },
      [{ kind: "write", target: "Main.luau", content: "return 2\n", expectedSha256: "bad-hash" }]
    ),
    /Stale mutation rejected/
  );
  assert.equal(await readFile(target, "utf8"), "return 1\n");
});

test("validation failure can automatically roll a transaction back", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-roblox-files-rollback-"));
  const target = join(cwd, "Main.luau");
  await writeFile(target, "return 1\n");
  const failing: ValidationRun = {
    profile: "default",
    status: "fail",
    startedAt: new Date(0).toISOString(),
    durationMs: 1,
    results: []
  };
  const setup = makeDependencies(cwd, failing);
  setup.config.checkpoints.autoRollbackOnValidationFailure = true;
  const result = await executeFileTransaction(
    setup.dependencies,
    [{
      kind: "write",
      target: "Main.luau",
      content: "return 2\n",
      expectedSha256: sha256(await readFile(target))
    }]
  );
  assert.equal(result.status, "rolled-back");
  assert.equal(await readFile(target, "utf8"), "return 1\n");
});

test("move operations preserve both sides for rollback", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-roblox-files-move-"));
  const source = join(cwd, "A.luau");
  const destination = join(cwd, "B.luau");
  await writeFile(source, "return 'a'\n");
  const setup = makeDependencies(cwd, passingValidation);
  const result = await executeFileTransaction(
    setup.dependencies,
    [{ kind: "move", from: "A.luau", to: "B.luau", expectedSha256: sha256(await readFile(source)) }],
    { validate: false }
  );
  assert.equal(await readFile(destination, "utf8"), "return 'a'\n");
  await setup.checkpoints.restore(result.checkpointId!);
  assert.equal(await readFile(source, "utf8"), "return 'a'\n");
  await assert.rejects(readFile(destination, "utf8"), /ENOENT/);
});

test("move overwrite requires and verifies the destination hash", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-roblox-files-move-overwrite-"));
  const source = join(cwd, "A.luau");
  const destination = join(cwd, "B.luau");
  await writeFile(source, "return 'a'\n");
  await writeFile(destination, "return 'b'\n");
  const setup = makeDependencies(cwd, passingValidation);

  await assert.rejects(
    executeFileTransaction(
      setup.dependencies,
      [{
        kind: "move",
        from: "A.luau",
        to: "B.luau",
        expectedSha256: sha256(await readFile(source)),
        overwrite: true
      }],
      { validate: false }
    ),
    /expectedDestinationSha256/
  );

  const result = await executeFileTransaction(
    setup.dependencies,
    [{
      kind: "move",
      from: "A.luau",
      to: "B.luau",
      expectedSha256: sha256(await readFile(source)),
      expectedDestinationSha256: sha256(await readFile(destination)),
      overwrite: true
    }],
    { validate: false }
  );
  assert.equal(await readFile(destination, "utf8"), "return 'a'\n");
  await setup.checkpoints.restore(result.checkpointId!);
  assert.equal(await readFile(source, "utf8"), "return 'a'\n");
  assert.equal(await readFile(destination, "utf8"), "return 'b'\n");
});

test("a concurrent change during checkpoint capture is preserved", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-roblox-files-race-"));
  const target = join(cwd, "Main.luau");
  await writeFile(target, "return 'before'\n");
  const setup = makeDependencies(cwd, passingValidation);

  class RacingCheckpointManager extends CheckpointManager {
    override async create(...args: Parameters<CheckpointManager["create"]>) {
      const manifest = await super.create(...args);
      await writeFile(target, "return 'collaborator'\n");
      return manifest;
    }
  }

  const racing = new RacingCheckpointManager(cwd, setup.config);
  const dependencies = { ...setup.dependencies, checkpoints: racing };
  await assert.rejects(
    executeFileTransaction(
      dependencies,
      [{
        kind: "write",
        target: "Main.luau",
        content: "return 'ours'\n",
        expectedSha256: sha256(Buffer.from("return 'before'\n"))
      }],
      { validate: false }
    ),
    /Concurrent change detected/
  );
  assert.equal(await readFile(target, "utf8"), "return 'collaborator'\n");
});

test("cancelled validation is not reported as a clean apply", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-roblox-files-cancelled-"));
  const target = join(cwd, "Main.luau");
  await writeFile(target, "return 1\n");
  const cancelled: ValidationRun = {
    profile: "default",
    status: "cancelled",
    startedAt: new Date(0).toISOString(),
    durationMs: 1,
    results: []
  };
  const setup = makeDependencies(cwd, cancelled);
  const result = await executeFileTransaction(
    setup.dependencies,
    [{
      kind: "write",
      target: "Main.luau",
      content: "return 2\n",
      expectedSha256: sha256(await readFile(target))
    }]
  );
  assert.equal(result.status, "applied-with-validation-cancelled");
});


test("file writes preserve the existing Unix permission mode", async (t) => {
  if (process.platform === "win32") {
    t.skip("Unix permission bits are not meaningful on Windows.");
    return;
  }

  const cwd = await mkdtemp(join(tmpdir(), "pi-roblox-files-mode-"));
  const target = join(cwd, "Executable.luau");
  await writeFile(target, "return 1\n");
  await chmod(target, 0o755);
  const setup = makeDependencies(cwd, passingValidation);

  await executeFileTransaction(
    setup.dependencies,
    [{
      kind: "write",
      target: "Executable.luau",
      content: "return 2\n",
      expectedSha256: sha256(await readFile(target))
    }],
    { validate: false }
  );

  assert.equal((await stat(target)).mode & 0o777, 0o755);
});
