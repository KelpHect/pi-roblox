import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.js";
import { SourceIndex } from "../src/source-index.js";

test("source index searches Studio-only project text while excluding dependencies and pi-roblox artifacts", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-roblox-source-index-"));
  await mkdir(join(cwd, "src"), { recursive: true });
  await mkdir(join(cwd, "node_modules", "hidden"), { recursive: true });
  await mkdir(join(cwd, ".pi", "roblox", "artifacts"), { recursive: true });

  await writeFile(
    join(cwd, "src", "Main.luau"),
    "local Helper = require(script.Parent.Helper)\n-- searchable-needle\nreturn Helper\n"
  );
  await writeFile(join(cwd, "src", "Helper.luau"), "return {}\n");
  await writeFile(join(cwd, "node_modules", "hidden", "Package.luau"), "-- searchable-needle\n");
  await writeFile(join(cwd, ".pi", "roblox", "artifacts", "report.txt"), "searchable-needle\n");

  const config = structuredClone(DEFAULT_CONFIG);
  config.mode = "studio-only";
  const index = new SourceIndex(cwd, config);

  const search = await index.search("searchable-needle");
  assert.equal(search.matches.length, 1);
  assert.equal(search.matches[0]?.sourcePath, "src/Main.luau");

  const dependencies = await index.dependencies();
  assert.equal(dependencies.length, 1);
  assert.equal(dependencies[0]?.sourcePath, "src/Main.luau");
  assert.equal(dependencies[0]?.expression, "script.Parent.Helper");
});
