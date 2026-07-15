import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.js";
import { OwnershipResolver } from "../src/ownership.js";
import { RojoIndex } from "../src/rojo-index.js";
import { findStudioPaths, matchesGlob } from "../src/util.js";

test("RojoIndex maps Studio paths to source files", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-roblox-"));
  await mkdir(join(cwd, "src", "shared"), { recursive: true });
  const source = join(cwd, "src", "shared", "Inventory.luau");
  await writeFile(source, "return {}\n");
  const project = join(cwd, "default.project.json");
  await writeFile(project, "{}\n");
  const sourcemap = join(cwd, "sourcemap.json");
  await writeFile(
    sourcemap,
    JSON.stringify({
      name: "Game",
      className: "DataModel",
      children: [
        {
          name: "ReplicatedStorage",
          className: "ReplicatedStorage",
          children: [
            {
              name: "Inventory",
              className: "ModuleScript",
              filePaths: ["src/shared/Inventory.luau"]
            }
          ]
        }
      ]
    })
  );

  const index = await RojoIndex.load(cwd, project, sourcemap);
  const entry = index.findStudio("game.ReplicatedStorage.Inventory");
  assert.equal(entry?.sourcePath, resolve(source));

  const resolver = new OwnershipResolver(cwd, structuredClone(DEFAULT_CONFIG), index);
  const record = resolver.resolve("game.ReplicatedStorage.Inventory");
  assert.equal(record.ownership, "rojo-owned");
  assert.equal(record.sourcePath, resolve(source));
});

test("ownership blocks dependencies, generated paths, and workspace escapes", () => {
  const cwd = resolve("/workspace/game");
  const resolver = new OwnershipResolver(cwd, structuredClone(DEFAULT_CONFIG));

  assert.equal(resolver.resolve("Packages/Foo.luau").ownership, "external-package");
  assert.equal(resolver.resolve("out/Foo.luau").ownership, "generated-output");
  assert.equal(resolver.resolve("models/Map.rbxm").ownership, "binary-asset");
  assert.equal(resolver.resolve("../secret.txt").ownership, "outside-workspace");
});

test("glob matching supports recursive and single-segment wildcards", () => {
  assert.equal(matchesGlob("Packages/Foo/init.luau", "Packages/**"), true);
  assert.equal(matchesGlob("src/server/Main.luau", "src/*/Main.luau"), true);
  assert.equal(matchesGlob("src/a/b/Main.luau", "src/*/Main.luau"), false);
});


test("ownership rejects a workspace symlink that escapes the project", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "pi-roblox-symlink-"));
  const cwd = join(parent, "project");
  const outside = join(parent, "outside");
  await mkdir(cwd);
  await mkdir(outside);
  try {
    await symlink(outside, join(cwd, "linked"), "dir");
  } catch (error) {
    t.skip(`Symlinks unavailable: ${(error as Error).message}`);
    return;
  }

  const resolver = new OwnershipResolver(cwd, structuredClone(DEFAULT_CONFIG));
  assert.equal(resolver.resolve("linked/secret.txt").ownership, "outside-workspace");
});



test("ownership rejects a direct symbolic-link source even when its target remains in the workspace", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-roblox-internal-symlink-"));
  const target = join(cwd, "Canonical.luau");
  const link = join(cwd, "Linked.luau");
  await writeFile(target, "return true\n");
  try {
    await symlink(target, link, "file");
  } catch (error) {
    t.skip(`Symlinks unavailable: ${(error as Error).message}`);
    return;
  }

  const resolver = new OwnershipResolver(cwd, structuredClone(DEFAULT_CONFIG));
  const record = resolver.resolve("Linked.luau");
  assert.equal(record.ownership, "symbolic-link");
  assert.equal(record.editable, false);
});

test("ownership rejects an internal symbolic-link directory alias", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-roblox-internal-dir-symlink-"));
  const canonical = join(cwd, "src", "canonical");
  const alias = join(cwd, "src", "alias");
  await mkdir(canonical, { recursive: true });
  await writeFile(join(canonical, "Main.luau"), "return true\n");
  try {
    await symlink(canonical, alias, "dir");
  } catch (error) {
    t.skip(`Symlinks unavailable: ${(error as Error).message}`);
    return;
  }

  const resolver = new OwnershipResolver(cwd, structuredClone(DEFAULT_CONFIG));
  const record = resolver.resolve("src/alias/Main.luau");
  assert.equal(record.ownership, "symbolic-link");
  assert.equal(record.editable, false);
  assert.match(record.reason, /src[\\/]alias/);
});

test("Studio path extraction finds multiple edit targets without scanning source text", () => {
  const paths = findStudioPaths({
    edits: [
      { scriptPath: "game.ServerScriptService.Main", source: "print('game.Workspace.Decoy')" },
      { instance_path: "game.ReplicatedStorage.Shared" }
    ]
  });
  assert.deepEqual(paths, [
    "game.ServerScriptService.Main",
    "game.ReplicatedStorage.Shared"
  ]);
});


test("Studio ownership fails closed when Rojo mode has no sourcemap", () => {
  const cwd = resolve("/workspace/game");
  const resolver = new OwnershipResolver(cwd, structuredClone(DEFAULT_CONFIG));
  const record = resolver.resolve("game.ServerScriptService.Main");
  assert.equal(record.ownership, "ownership-unresolved");
  assert.equal(record.editable, false);
});

test("Studio mappings to source outside the workspace are never editable", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-roblox-external-source-"));
  const cwd = join(parent, "project");
  const outside = join(parent, "outside");
  await mkdir(cwd);
  await mkdir(outside);
  const source = join(outside, "External.server.luau");
  await writeFile(source, "print('outside')\n");
  const project = join(cwd, "default.project.json");
  const sourcemap = join(cwd, "sourcemap.json");
  await writeFile(project, "{}\n");
  await writeFile(
    sourcemap,
    JSON.stringify({
      name: "Game",
      className: "DataModel",
      children: [
        {
          name: "ServerScriptService",
          className: "ServerScriptService",
          children: [
            {
              name: "External",
              className: "Script",
              filePaths: [source]
            }
          ]
        }
      ]
    })
  );

  const index = await RojoIndex.load(cwd, project, sourcemap);
  const resolver = new OwnershipResolver(cwd, structuredClone(DEFAULT_CONFIG), index);
  const record = resolver.resolve("game.ServerScriptService.External");
  assert.equal(record.ownership, "outside-workspace");
  assert.equal(record.editable, false);
  assert.equal(record.sourcePath, source);
});

test("Rojo index refuses project and sourcemap paths outside the workspace", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-roblox-index-boundary-"));
  const cwd = join(parent, "project");
  await mkdir(cwd);
  const outsideProject = join(parent, "outside.project.json");
  const outsideMap = join(parent, "outside.sourcemap.json");
  await writeFile(outsideProject, "{}\n");
  await writeFile(outsideMap, JSON.stringify({ name: "Game", className: "DataModel" }));

  await assert.rejects(
    RojoIndex.load(cwd, outsideProject, outsideMap),
    /project file must be inside the workspace/
  );
});
