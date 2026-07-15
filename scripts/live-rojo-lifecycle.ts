#!/usr/bin/env node
import { createConnection } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { arch, platform, release, version as osVersion } from "node:os";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { nodeCommandRunner } from "../src/command-runner.js";
import { RobloxRuntime } from "../src/runtime.js";

function valueAfter(argv: string[], name: string): string {
  const index = argv.indexOf(name);
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

async function portOpen(host: string, port: number): Promise<boolean> {
  return new Promise<boolean>((resolvePromise) => {
    const socket = createConnection({ host, port });
    const finish = (value: boolean): void => {
      socket.destroy();
      resolvePromise(value);
    };
    socket.setTimeout(750);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function main(): Promise<void> {
  const cwd = resolve(valueAfter(process.argv, "--cwd"));
  const output = resolve(valueAfter(process.argv, "--output"));
  const host = "127.0.0.1";
  const port = Number(valueAfter(process.argv, "--port"));
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("--port must be valid.");
  if (await portOpen(host, port)) {
    throw new Error(`Port ${host}:${port} must be free before the managed lifecycle test.`);
  }

  const report: Record<string, unknown> = {
    schemaVersion: 1,
    status: "running",
    startedAt: new Date().toISOString(),
    environment: { platform: platform(), arch: arch(), osRelease: release(), osVersion: osVersion() },
    cwd,
    host,
    port,
    portOpenBeforeInitialize: false
  };
  const runtime = new RobloxRuntime(cwd, ".pi", nodeCommandRunner);
  try {
    await runtime.initialize();
    const managed = await runtime.rojoStatus();
    if (!managed?.running || !managed.ready || !managed.ownedByExtension || !managed.pid) {
      throw new Error(`Rojo was not extension-owned and ready: ${JSON.stringify(managed)}`);
    }
    report.managed = managed;
    report.portOpenWhileManaged = await portOpen(host, port);
    if (!report.portOpenWhileManaged) throw new Error("Managed Rojo port was not reachable.");
    await runtime.close();

    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && await portOpen(host, port)) await delay(100);
    report.portOpenAfterClose = await portOpen(host, port);
    if (report.portOpenAfterClose) throw new Error("Managed Rojo port remained open after runtime.close().");
    report.status = "pass";
  } catch (error) {
    report.status = "fail";
    report.error = error instanceof Error ? error.message : String(error);
    await runtime.close().catch(() => undefined);
    process.exitCode = 1;
  } finally {
    report.finishedAt = new Date().toISOString();
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({ status: report.status, output }, null, 2));
  }
}

await main();
