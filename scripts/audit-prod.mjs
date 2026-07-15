#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("npm_execpath is unavailable; run this script through npm run audit:prod.");
const temporary = await mkdtemp(join(tmpdir(), "pi-roblox-npm-audit-"));
const userconfig = join(temporary, ".npmrc");
await writeFile(userconfig, "");

try {
  const env = { ...process.env, NPM_CONFIG_USERCONFIG: userconfig };
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === "npm_config_allow_scripts") delete env[key];
  }
  const result = await promisify(execFile)(
    process.execPath,
    [npmCli, "audit", "--omit=dev", `--userconfig=${userconfig}`],
    {
      cwd: process.cwd(),
      env,
      windowsHide: true,
      maxBuffer: 20 * 1024 * 1024
    }
  );
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
} catch (error) {
  if (typeof error === "object" && error !== null) {
    const failure = error;
    if (typeof failure.stdout === "string") process.stdout.write(failure.stdout);
    if (typeof failure.stderr === "string") process.stderr.write(failure.stderr);
  }
  process.exitCode = typeof error === "object" && error !== null && typeof error.code === "number"
    ? error.code
    : 1;
} finally {
  await rm(temporary, { recursive: true, force: true });
}
