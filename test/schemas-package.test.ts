import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import { parse as parseJsonc } from "jsonc-parser";
import { DEFAULT_CONFIG } from "../src/config.js";
import { parseScenario } from "../src/scenarios.js";
import { PI_ROBLOX_VERSION } from "../src/version.js";

const cwd = process.cwd();

async function json(path: string): Promise<unknown> {
  return JSON.parse(await readFile(resolve(cwd, path), "utf8")) as unknown;
}

async function jsonc(path: string): Promise<unknown> {
  return parseJsonc(await readFile(resolve(cwd, path), "utf8")) as unknown;
}

function validator(schema: object) {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  return ajv.compile(schema);
}

test("configuration schema validates defaults and shipped examples", async () => {
  const validate = validator((await json("schemas/roblox.schema.json")) as object);
  const examples = [
    DEFAULT_CONFIG,
    await json("examples/roblox.json"),
    await json("examples/studio-only.json")
  ];

  for (const example of examples) {
    assert.equal(validate(example), true, JSON.stringify(validate.errors, null, 2));
  }

  assert.equal(validate({ version: 1, unexpected: true }), false);
});

test("scenario schema and runtime parser accept shipped examples", async () => {
  const validate = validator((await json("schemas/scenario.schema.json")) as object);
  for (const path of [
    "examples/scenarios/smoke.jsonc",
    "examples/scenarios/saved-values.jsonc"
  ]) {
    const example = await jsonc(path);
    assert.equal(validate(example), true, `${path}: ${JSON.stringify(validate.errors, null, 2)}`);
    assert.equal(parseScenario(example, path).version, 1);
  }

  assert.equal(
    validate({
      version: 1,
      name: "invalid",
      steps: [{ kind: "assert", expect: { jsonPath: "$.ready" } }]
    }),
    false
  );
});

test("package version and runtime version stay aligned", async () => {
  const packageJson = (await json("package.json")) as { version?: string };
  assert.equal(packageJson.version, PI_ROBLOX_VERSION);
});
