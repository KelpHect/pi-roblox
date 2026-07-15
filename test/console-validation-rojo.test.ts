import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { parseConsoleResult } from "../src/console.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { RojoIndex } from "../src/rojo-index.js";
import { RojoProcessManager } from "../src/rojo-process.js";
import { discoverRojoProjects, readRojoProject } from "../src/rojo-project.js";
import { runValidation } from "../src/validation.js";

test("console parser classifies and remaps Studio stack locations", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-roblox-console-"));
  await mkdir(join(cwd, "src"), { recursive: true });
  await writeFile(join(cwd, "src", "Main.luau"), "return {}\n");
  await writeFile(join(cwd, "default.project.json"), "{}\n");
  await writeFile(
    join(cwd, "sourcemap.json"),
    JSON.stringify({
      name: "Game",
      className: "DataModel",
      children: [{
        name: "ServerScriptService",
        className: "ServerScriptService",
        children: [{ name: "Main", className: "Script", filePaths: ["src/Main.luau"] }]
      }]
    })
  );
  const index = await RojoIndex.load(cwd, join(cwd, "default.project.json"), join(cwd, "sourcemap.json"));
  const snapshot = parseConsoleResult(cwd, index, {
    content: [{
      type: "text",
      text: JSON.stringify({ entries: [{ severity: "Error", message: "ServerScriptService.Main:12: attempt to index nil" }] })
    }]
  });
  assert.equal(snapshot.errors.length, 1);
  assert.equal(snapshot.errors[0]?.studioPath, "game.ServerScriptService.Main");
  assert.equal(snapshot.errors[0]?.sourcePath, "src/Main.luau");
  assert.equal(snapshot.errors[0]?.line, 12);
});

test("Rojo project reader accepts JSONC metadata and discovery prioritizes default.project.json", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-roblox-project-"));
  await writeFile(
    join(cwd, "default.project.json"),
    `{
      // Live-sync guard
      "name": "Example",
      "serveAddress": "127.0.0.1",
      "servePort": 45678,
      "servePlaceIds": [123, 123],
      "tree": { "$className": "DataModel" },
    }`
  );
  await mkdir(join(cwd, "places"));
  await writeFile(join(cwd, "places", "lobby.project.json"), `{ "tree": {} }`);
  const project = await readRojoProject(cwd, "default.project.json");
  assert.equal(project.name, "Example");
  assert.equal(project.servePort, 45678);
  assert.deepEqual(project.servePlaceIds, [123]);
  const discovered = await discoverRojoProjects(cwd);
  assert.equal(discovered[0], resolve(cwd, "default.project.json"));
  assert.equal(discovered.length, 2);
});

test("validation profiles execute selected commands and stop on failure", async () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.validation.commands = [
    { name: "first", command: "first", args: [], timeoutMs: 1000, continueOnFailure: false, env: {} },
    { name: "second", command: "second", args: [], timeoutMs: 1000, continueOnFailure: false, env: {} }
  ];
  config.validation.profiles = { default: ["first", "second"], fast: ["second"] };
  const called: string[] = [];
  const run = await runValidation("/tmp", config, async (command) => {
    called.push(command);
    return { stdout: command, stderr: "", code: command === "first" ? 1 : 0, killed: false };
  });
  assert.equal(run.status, "fail");
  assert.deepEqual(called, ["first"]);

  called.length = 0;
  const fast = await runValidation("/tmp", config, async (command) => {
    called.push(command);
    return { stdout: "ok", stderr: "", code: 0, killed: false };
  }, { profile: "fast" });
  assert.equal(fast.status, "pass");
  assert.deepEqual(called, ["second"]);
});

test("Rojo process status forgets an external server after it disappears", async () => {
  const server = createServer((request, response) => {
    if (request.url !== "/api/rojo") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        sessionId: "external-session",
        serverVersion: "7.7.0",
        protocolVersion: 5,
        projectName: "ExternalTest",
        expectedPlaceIds: null,
        unexpectedPlaceIds: null,
        gameId: null,
        placeId: null,
        rootInstanceId: "root"
      })
    );
  });
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const cwd = await mkdtemp(join(tmpdir(), "pi-roblox-rojo-process-"));
  const config = structuredClone(DEFAULT_CONFIG);
  config.rojo.server.address = "127.0.0.1";
  config.rojo.server.port = address.port;
  const project = {
    path: join(cwd, "default.project.json"),
    directory: cwd,
    name: "ExternalTest",
    serveAddress: "127.0.0.1",
    servePort: address.port,
    servePlaceIds: [],
    hasTree: true,
    raw: {}
  };
  const manager = new RojoProcessManager(cwd, config, async () => ({ stdout: "", stderr: "", code: 0, killed: false }));
  const running = await manager.start(project);
  assert.equal(running.running, true);
  assert.equal(running.ownedByExtension, false);

  await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  const stopped = await manager.status();
  assert.equal(stopped.ready, false);
  assert.equal(stopped.running, false);
});

test("Rojo process does not mistake an unrelated HTTP service for Rojo", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" }).end("not rojo");
  });
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const cwd = await mkdtemp(join(tmpdir(), "pi-roblox-unrelated-service-"));
  const config = structuredClone(DEFAULT_CONFIG);
  config.rojo.server.address = "127.0.0.1";
  config.rojo.server.port = address.port;
  config.rojo.server.readinessTimeoutMs = 500;
  const project = {
    path: join(cwd, "default.project.json"),
    directory: cwd,
    name: "Expected",
    serveAddress: "127.0.0.1",
    servePort: address.port,
    servePlaceIds: [],
    hasTree: true,
    raw: {}
  };
  const manager = new RojoProcessManager(
    cwd,
    config,
    async () => ({ stdout: "", stderr: "", code: 0, killed: false })
  );

  const status = await manager.status();
  assert.equal(status.ready, false);
  assert.equal(status.running, false);
  await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
});

test("Rojo process rejects a different project already bound to the endpoint", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        sessionId: "wrong-session",
        serverVersion: "7.7.0",
        protocolVersion: 5,
        projectName: "WrongProject"
      })
    );
  });
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const cwd = await mkdtemp(join(tmpdir(), "pi-roblox-rojo-mismatch-"));
  const config = structuredClone(DEFAULT_CONFIG);
  config.rojo.server.address = "127.0.0.1";
  config.rojo.server.port = address.port;
  const project = {
    path: join(cwd, "default.project.json"),
    directory: cwd,
    name: "ExpectedProject",
    serveAddress: "127.0.0.1",
    servePort: address.port,
    servePlaceIds: [],
    hasTree: true,
    raw: {}
  };
  const manager = new RojoProcessManager(
    cwd,
    config,
    async () => ({ stdout: "", stderr: "", code: 0, killed: false })
  );

  await assert.rejects(manager.start(project), /WrongProject.*ExpectedProject/);
  await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
});
