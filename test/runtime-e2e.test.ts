import assert from "node:assert/strict";
import { createServer } from "node:net";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { nodeCommandRunner } from "../src/command-runner.js";
import { RobloxRuntime } from "../src/runtime.js";

const fixtureDirectory = dirname(fileURLToPath(import.meta.url));
const fakeStudio = resolve(fixtureDirectory, "fixtures/fake-studio-server.mjs");
const fakeRojo = resolve(fixtureDirectory, "fixtures/fake-rojo.mjs");

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolvePromise());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve a test port.");
  const port = address.port;
  await new Promise<void>((resolvePromise, reject) => {
    server.close((error) => (error ? reject(error) : resolvePromise()));
  });
  return port;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function createWorkspace(): Promise<{ cwd: string; sourcePath: string; statePath: string }> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-roblox-e2e-"));
  const port = await freePort();
  const sourcePath = resolve(cwd, "src/shared/Main.luau");
  const statePath = resolve(cwd, ".pi/roblox/fake-studio-state.json");
  await mkdir(dirname(sourcePath), { recursive: true });
  await writeFile(sourcePath, "local value = 1\nreturn value\n");

  await writeJson(resolve(cwd, "default.project.json"), {
    name: "IntegrationGame",
    serveAddress: "127.0.0.1",
    servePort: port,
    servePlaceIds: [123456789],
    tree: {
      $className: "DataModel",
      ReplicatedStorage: { $className: "ReplicatedStorage" },
      Workspace: { $className: "Workspace" }
    }
  });

  await writeJson(resolve(cwd, ".fake-rojo-sourcemap.json"), {
    name: "IntegrationGame",
    className: "DataModel",
    children: [
      {
        name: "ReplicatedStorage",
        className: "ReplicatedStorage",
        children: [
          {
            name: "Shared",
            className: "Folder",
            children: [
              {
                name: "Main",
                className: "ModuleScript",
                filePaths: ["src/shared/Main.luau"]
              }
            ]
          }
        ]
      },
      { name: "Workspace", className: "Workspace" }
    ]
  });

  await writeJson(statePath, {
    placeId: 123456789,
    gameId: 987654321,
    omitPlaceInStudioStateWhenPlaying: true,
    pathMap: {
      "game.ReplicatedStorage.Shared.Main": "src/shared/Main.luau"
    },
    console: []
  });

  await writeJson(resolve(cwd, ".pi/roblox.json"), {
    version: 1,
    mode: "rojo",
    projectFile: "default.project.json",
    expectedPlaceIds: [123456789],
    studio: {
      autoConnect: true,
      command: process.execPath,
      args: [fakeStudio],
      syncTimeoutMs: 3000
    },
    rojo: {
      binary: fakeRojo,
      sourcemapFile: ".pi/roblox/sourcemap.json",
      includeNonScripts: true,
      generatedPatterns: ["out/**", "dist/**"],
      dependencyPatterns: ["Packages/**", "node_modules/**"],
      server: {
        autoStart: true,
        shutdownOnExit: true,
        address: "127.0.0.1",
        port,
        readinessTimeoutMs: 5000,
        extraArgs: []
      }
    },
    ownership: {
      studioOwnedRoots: ["game.Workspace.Runtime"],
      blockAmbiguousWrites: true,
      requireHashForMappedWrites: true
    },
    permissions: {
      profile: "autonomous-local",
      failClosedWithoutUi: true
    },
    validation: {
      commands: [
        {
          name: "node-check",
          command: process.execPath,
          args: ["-e", "process.stdout.write('validation-ok')"],
          timeoutMs: 5000,
          continueOnFailure: false,
          env: { PI_ROBLOX_TEST: "1" }
        }
      ],
      profiles: { default: ["node-check"] },
      defaultProfile: "default",
      maxOutputChars: 10000
    },
    scenarios: {
      directory: ".pi/roblox/scenarios",
      artifactsDirectory: ".pi/roblox/artifacts",
      defaultTimeoutMs: 10000,
      failOnConsoleErrors: true,
      failOnConsoleWarnings: false
    },
    checkpoints: {
      directory: ".pi/roblox/checkpoints",
      keep: 20,
      autoRollbackOnApplyFailure: true,
      autoRollbackOnValidationFailure: false
    },
    audit: {
      enabled: true,
      directory: ".pi/roblox/audit",
      maxValueChars: 8000
    },
    context: {
      maxFileChars: 40000,
      maxSearchResults: 100,
      injectStatus: true
    }
  });

  await chmod(fakeRojo, 0o755);
  return { cwd, sourcePath, statePath };
}

test("runtime completes the Rojo + Studio MCP workflow end to end", async (t) => {
  const { cwd, sourcePath, statePath } = await createWorkspace();
  const runtime = new RobloxRuntime(cwd, ".pi", nodeCommandRunner);
  t.after(async () => runtime.close());

  const initialized = await runtime.initialize();
  assert.equal(initialized.studioConnected, true);
  assert.equal(initialized.rojoServer?.ready, true);
  assert.equal(initialized.mappedSourceFiles, 1);
  assert.deepEqual(initialized.missingStudioTools, []);

  const scenarioPath = await runtime.writeExampleScenario("smoke.json");
  assert.equal((await runtime.listScenarios()).length, 1);
  assert.match(scenarioPath, /smoke\.json$/);

  const doctor = await runtime.doctor({ connectStudio: true });
  assert.equal(doctor.status, "pass", JSON.stringify(doctor, null, 2));

  const inspection = await runtime.inspect("game.ReplicatedStorage.Shared.Main");
  assert.equal(inspection.ownership.ownership, "rojo-owned");
  assert.equal(inspection.file?.content, "local value = 1\nreturn value\n");
  assert.ok(inspection.file?.sha256);
  assert.ok(inspection.studio);

  const search = await runtime.search("value", { studio: true });
  const mainMatches = search.source?.matches.filter(
    (match) => match.sourcePath === "src/shared/Main.luau"
  );
  assert.equal(mainMatches?.length, 2);
  assert.deepEqual(mainMatches?.map((match) => match.line), [1, 2]);
  assert.ok(search.studio);

  const changed = "local value = 2\nreturn value\n";
  const applied = await runtime.replaceFile({
    target: "game.ReplicatedStorage.Shared.Main",
    content: changed,
    expectedSha256: inspection.file!.sha256,
    validate: true
  });
  assert.equal(applied.status, "applied");
  assert.equal(applied.sync[0]?.status, "verified");
  assert.equal(applied.validation?.status, "pass");
  assert.equal(await readFile(sourcePath, "utf8"), changed);
  assert.ok(applied.checkpointId);

  await assert.rejects(
    runtime.replaceFile({
      target: "game.ReplicatedStorage.Shared.Main",
      content: "return 3\n",
      expectedSha256: inspection.file!.sha256,
      validate: false
    }),
    /Stale mutation rejected/
  );

  const rollback = await runtime.rollback(applied.checkpointId!);
  assert.equal(rollback.filesRestored, 1);
  assert.equal(await readFile(sourcePath, "utf8"), "local value = 1\nreturn value\n");

  const studioMutation = await runtime.mutateStudio(
    [
      {
        kind: "create",
        parent: "game.Workspace.Runtime",
        className: "Folder",
        name: "Generated"
      }
    ],
    async () => true
  );
  assert.equal(studioMutation.status, "applied");
  assert.equal(studioMutation.payload?.ok, true);
  assert.ok(studioMutation.checkpointId);

  const studioRollback = await runtime.rollback(studioMutation.checkpointId!);
  assert.ok(studioRollback.studio);

  await assert.rejects(
    runtime.callStudioTool("subagent", { task: "do hidden AI work" }, async () => true),
    /denied by the strict Pi-only policy/
  );
  await assert.rejects(
    runtime.callStudioTool("explore_subagent", { task: "do hidden AI work" }, async () => true),
    /denied by the strict Pi-only policy/
  );

  const scenario = await runtime.runScenario("smoke", async () => true);
  assert.equal(scenario.status, "pass", JSON.stringify(scenario, null, 2));
  assert.equal(scenario.steps.filter((step) => step.kind === "play").length, 2);
  assert.equal(scenario.diagnostics.length, 0);
  assert.equal((await readFile(scenario.reportArtifact.path, "utf8")).includes('"status": "pass"'), true);

  const failureScenario = await runtime.runScenario(
    {
      version: 1,
      name: "mapped console failure",
      steps: [
        {
          kind: "luau",
          dataModelType: "Server",
          code: "-- PI_ROBLOX_ADD_CONSOLE_ERROR\nreturn true",
          expect: { truthy: true }
        }
      ],
      failOnConsoleErrors: true
    },
    async () => true
  );
  assert.equal(failureScenario.status, "fail");
  assert.equal(failureScenario.diagnostics[0]?.studioPath, "game.ReplicatedStorage.Shared.Main");
  assert.equal(failureScenario.diagnostics[0]?.sourcePath, "src/shared/Main.luau");
  assert.equal(failureScenario.diagnostics[0]?.line, 2);

  const audit = await runtime.audit.recent(200);
  assert.ok(audit.some((record) => record.event === "file-transaction.complete"));
  assert.ok(audit.some((record) => record.event === "studio-transaction.complete"));
  assert.ok(audit.some((record) => record.event === "scenario.complete"));

  const state = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
  await writeJson(statePath, { ...state, placeId: 999999999 });
  await assert.rejects(
    runtime.mutateStudio(
      [
        {
          kind: "create",
          parent: "game.Workspace.Runtime",
          className: "Folder",
          name: "WrongPlace"
        }
      ],
      async () => true
    ),
    /expected one of 123456789/
  );
});
