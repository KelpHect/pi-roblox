#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

async function hostPeerClosure(peerNames) {
  const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
  const packages = lock.packages ?? {};
  const resolveDependency = (fromPath, name) => {
    let base = fromPath;
    for (;;) {
      const candidate = `${base}${base ? "/" : ""}node_modules/${name}`;
      if (packages[candidate]) return candidate;
      const cut = base.lastIndexOf("/node_modules/");
      if (cut !== -1) {
        base = base.slice(0, cut);
      } else if (base.startsWith("node_modules/")) {
        base = "";
      } else {
        return undefined;
      }
    }
  };

  const visited = new Set();
  const queue = peerNames.map((name) => {
    const path = `node_modules/${name}`;
    if (!packages[path]) throw new Error(`${path} is missing from package-lock.json`);
    return path;
  });
  while (queue.length > 0) {
    const entryPath = queue.shift();
    if (visited.has(entryPath)) continue;
    visited.add(entryPath);
    const entry = packages[entryPath];
    for (const name of Object.keys({ ...entry.dependencies, ...entry.optionalDependencies })) {
      const resolved = resolveDependency(entryPath, name);
      if (resolved) queue.push(resolved);
      else if (entry.dependencies?.[name] !== undefined) {
        throw new Error(`${name} required by ${entryPath} is missing from package-lock.json`);
      }
    }
  }

  const topLevel = new Set();
  for (const path of visited) {
    const segments = path.split("/node_modules/");
    topLevel.add(segments[0]);
  }
  return [...topLevel].sort();
}

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
    "--ignore-scripts",
    "--legacy-peer-deps",
    "--no-audit",
    "--no-fund"
  ], {
    cwd: temporary,
    env: npmEnvironment,
    windowsHide: true,
    timeout: 180_000,
    maxBuffer: 20 * 1024 * 1024
  });

  // Pi and TypeBox are host-provided peer dependencies. Reuse the exact host
  // packages installed for this test run, plus only their own dependency
  // closure, instead of doing a second registry resolution in the isolated
  // fixture. Anything else the extension imports must come from its own
  // `dependencies`, so a missing runtime dependency still fails this test.
  for (const packagePath of await hostPeerClosure(["@earendil-works/pi-coding-agent", "typebox"])) {
    await cp(join(root, packagePath), join(temporary, packagePath), {
      recursive: true,
      force: false,
      errorOnExist: false,
      filter: (source) => basename(source) !== ".bin"
    });
  }

  const installedManifest = JSON.parse(await readFile(
    join(temporary, "node_modules", "@kellhect", "pi-roblox", "package.json"),
    "utf8"
  ));
  assert.equal(installedManifest.name, "@kellhect/pi-roblox");
  assert.deepEqual(installedManifest.pi.extensions, ["./extensions/roblox/index.ts"]);

  const installedPackage = join(temporary, "node_modules", "@kellhect", "pi-roblox");
  const piCli = join(
    root,
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
