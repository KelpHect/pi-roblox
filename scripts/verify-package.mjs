import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const required = [
  "extensions/roblox/index.ts",
  "src/runtime.ts",
  "src/config.ts",
  "src/ownership.ts",
  "src/file-transaction.ts",
  "src/studio-client.ts",
  "src/studio-transaction.ts",
  "src/version.ts",
  "skills/roblox-development/SKILL.md",
  "schemas/roblox.schema.json",
  "schemas/scenario.schema.json",
  "scripts/audit-prod.mjs",
  "scripts/live-acceptance.ts",
  "scripts/live-rojo-lifecycle.ts",
  "scripts/packed-install-smoke.mjs",
  ".github/workflows/ci.yml",
  "README.md",
  "LICENSE"
];

for (const path of required) await access(resolve(root, path));
const versionSource = await readFile(resolve(root, "src/version.ts"), "utf8");
if (!versionSource.includes(`"${packageJson.version}"`)) {
  throw new Error("src/version.ts does not match package.json.");
}
if (packageJson.name !== "@kellhect/pi-roblox") {
  throw new Error(`Unexpected npm package name: ${packageJson.name}`);
}
if (packageJson.publishConfig?.access !== "public") {
  throw new Error("Scoped package publishConfig.access must be public.");
}
if (!Array.isArray(packageJson.pi?.extensions) || packageJson.pi.extensions[0] !== "./extensions/roblox/index.ts") {
  throw new Error("package.json does not declare the pi-roblox extension entrypoint.");
}
for (const peer of ["@earendil-works/pi-coding-agent", "typebox"]) {
  if (packageJson.peerDependencies?.[peer] !== "*") {
    throw new Error(`${peer} must be a Pi-provided peer dependency with range *.`);
  }
}
const lockSource = await readFile(resolve(root, "package-lock.json"), "utf8");
if (lockSource.includes("packages.applied-caas-gateway1.internal")) {
  throw new Error("package-lock.json contains a private build-environment registry URL.");
}
console.log(`Verified ${required.length} required package files and version ${packageJson.version}.`);
