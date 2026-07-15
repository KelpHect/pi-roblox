#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("npm_execpath is unavailable; run this script through npm run smoke:pack.");
const temporary = await mkdtemp(join(tmpdir(), "pi-roblox-packed-"));
const userconfig = join(temporary, "user.npmrc");
await writeFile(userconfig, "");
const npmEnvironment = { ...process.env, NPM_CONFIG_USERCONFIG: userconfig };
for (const key of Object.keys(npmEnvironment)) {
  if (key.toLowerCase() === "npm_config_allow_scripts") delete npmEnvironment[key];
}
let tarball;

try {
  const packed = await exec(process.execPath, [npmCli, "pack", "--json", "--ignore-scripts"], {
    cwd: root,
    env: npmEnvironment,
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024
  });
  const report = JSON.parse(packed.stdout);
  assert.ok(Array.isArray(report) && typeof report[0]?.filename === "string", "npm pack did not return a tarball filename");
  tarball = resolve(root, report[0].filename);

  await writeFile(join(temporary, "package.json"), JSON.stringify({ private: true, type: "module" }));
  await exec(process.execPath, [npmCli,
    "install",
    tarball,
    "@earendil-works/pi-coding-agent@0.80.7",
    "typebox@1.3.6",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund"
  ], {
    cwd: temporary,
    env: npmEnvironment,
    windowsHide: true,
    // The isolated install fetches Pi and its complete dependency graph. Hosted
    // Windows runners can legitimately take longer than three minutes here.
    timeout: 300_000,
    maxBuffer: 20 * 1024 * 1024
  });

  const installedManifest = JSON.parse(await readFile(
    join(temporary, "node_modules", "@kellhect", "pi-roblox", "package.json"),
    "utf8"
  ));
  assert.equal(installedManifest.name, "@kellhect/pi-roblox");
  assert.deepEqual(installedManifest.pi.extensions, ["./extensions/roblox/index.ts"]);

  const installedPackage = join(temporary, "node_modules", "@kellhect", "pi-roblox");
  const piCli = join(
    temporary,
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
    "dist",
    "cli.js"
  );
  const piEnvironment = {
    ...npmEnvironment,
    PI_CODING_AGENT_DIR: join(temporary, ".pi-agent"),
    PI_OFFLINE: "1"
  };
  await exec(
    process.execPath,
    [piCli, "install", installedPackage, "--approve"],
    {
      cwd: temporary,
      env: piEnvironment,
      windowsHide: true,
      timeout: 60_000,
      maxBuffer: 10 * 1024 * 1024
    }
  );
  const piList = await exec(process.execPath, [piCli, "list", "--approve"], {
    cwd: temporary,
    env: piEnvironment,
    windowsHide: true,
    timeout: 60_000,
    maxBuffer: 10 * 1024 * 1024
  });
  assert.match(
    piList.stdout,
    /@kellhect\/pi-roblox|node_modules[\\/]@kellhect[\\/]pi-roblox/,
    "Pi did not recognize the installed package"
  );

  // This command completes normal Pi startup and resource loading without
  // selecting or calling a model. An extension/package import error is fatal.
  await exec(process.execPath, [piCli, "--offline", "--list-models"], {
    cwd: temporary,
    env: piEnvironment,
    windowsHide: true,
    timeout: 60_000,
    maxBuffer: 20 * 1024 * 1024
  });

  const smokePath = join(temporary, "smoke.mjs");
  await writeFile(smokePath, `
import assert from "node:assert/strict";
import extension from ${JSON.stringify(pathToFileURL(join(temporary, "node_modules", "@kellhect", "pi-roblox", "extensions", "roblox", "index.ts")).href)};
const tools = [];
const commands = [];
const events = [];
extension({
  registerTool(tool) { tools.push(tool.name); },
  registerCommand(name) { commands.push(name); },
  on(name) { events.push(name); }
});
assert.equal(tools.length, 12);
assert.deepEqual(commands, ["roblox"]);
assert.deepEqual(events, ["session_start", "session_shutdown", "before_agent_start", "tool_call", "tool_result"]);
process.stdout.write(JSON.stringify({ tools, commands, events }) + "\\n");
`);
  const smoke = await exec(process.execPath, ["--import", "tsx", smokePath], {
    cwd: temporary,
    windowsHide: true,
    timeout: 60_000,
    maxBuffer: 10 * 1024 * 1024
  });
  process.stdout.write(
    `Packed install + Pi loader smoke passed for ${basename(tarball)}: ${smoke.stdout}`
  );
} finally {
  if (tarball) await rm(tarball, { force: true });
  await rm(temporary, { recursive: true, force: true });
}
