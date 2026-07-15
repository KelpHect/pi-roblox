#!/usr/bin/env node
import { copyFile, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";

const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("Rojo 7.5.1-fake");
  process.exit(0);
}

if (args[0] === "sourcemap") {
  const outputIndex = args.indexOf("--output");
  if (outputIndex < 0 || !args[outputIndex + 1]) {
    console.error("missing --output");
    process.exit(2);
  }
  const source = resolve(process.cwd(), ".fake-rojo-sourcemap.json");
  JSON.parse(await readFile(source, "utf8"));
  await copyFile(source, resolve(args[outputIndex + 1]));
  process.exit(0);
}

if (args[0] === "serve") {
  const projectPath = resolve(args[1]);
  const project = JSON.parse(await readFile(projectPath, "utf8"));
  const projectFile = projectPath.split(/[\\/]/).at(-1) ?? "default.project.json";
  const projectName =
    typeof project.name === "string" && project.name.length > 0
      ? project.name
      : /^default\.project\.jsonc?$/i.test(projectFile)
        ? projectPath.split(/[\\/]/).at(-2) ?? "Game"
        : projectFile.replace(/\.project\.jsonc?$/i, "");
  const addressIndex = args.indexOf("--address");
  const portIndex = args.indexOf("--port");
  const address = addressIndex >= 0 ? args[addressIndex + 1] : "127.0.0.1";
  const port = portIndex >= 0 ? Number(args[portIndex + 1]) : 34872;
  const server = createServer((request, response) => {
    if (request.url !== "/api/rojo") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      sessionId: "fake-session",
      serverVersion: "7.7.0-fake",
      protocolVersion: 5,
      projectName,
      expectedPlaceIds: Array.isArray(project.servePlaceIds) ? project.servePlaceIds : null,
      unexpectedPlaceIds: null,
      gameId: project.gameId ?? null,
      placeId: project.placeId ?? null,
      rootInstanceId: "fake-root"
    }));
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  server.listen(port, address, () => console.log(`Rojo server listening on ${address}:${port}`));
  await new Promise(() => {});
}

console.error(`unsupported fake rojo command: ${args.join(" ")}`);
process.exit(2);
