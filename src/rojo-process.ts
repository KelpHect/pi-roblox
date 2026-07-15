import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { basename, dirname } from "node:path";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { RobloxConfig } from "./config.js";
import type { CommandRunner } from "./rojo-index.js";
import type { RojoProjectMetadata } from "./rojo-project.js";
import { truncateText } from "./util.js";

export interface RojoServerInfo {
  sessionId: unknown;
  serverVersion: string;
  protocolVersion: number;
  projectName: string;
  expectedPlaceIds?: number[] | null;
  unexpectedPlaceIds?: number[] | null;
  gameId?: number | null;
  placeId?: number | null;
  rootInstanceId?: unknown;
}

export interface RojoServerStatus {
  configured: boolean;
  running: boolean;
  ready: boolean;
  ownedByExtension: boolean;
  pid?: number;
  address: string;
  port: number;
  url: string;
  startedAt?: string;
  exitCode?: number | null;
  serverInfo?: RojoServerInfo;
  error?: string;
  logTail: string;
}

function probeAddress(address: string): string {
  if (address === "0.0.0.0") return "127.0.0.1";
  if (address === "::" || address === "[::]") return "[::1]";
  if (address.includes(":") && !address.startsWith("[")) return `[${address}]`;
  return address;
}

function serverUrl(address: string, port: number): string {
  return `http://${probeAddress(address)}:${port}/`;
}

function isRojoServerInfo(value: unknown): value is RojoServerInfo {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    "sessionId" in candidate &&
    typeof candidate.serverVersion === "string" &&
    Number.isSafeInteger(candidate.protocolVersion) &&
    typeof candidate.projectName === "string"
  );
}

async function probeRojo(
  address: string,
  port: number,
  timeoutMs = 750
): Promise<RojoServerInfo | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const endpoint = new URL("api/rojo", serverUrl(address, port));
    const response = await fetch(endpoint, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
      redirect: "manual"
    });
    if (!response.ok) return undefined;

    const declaredLength = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > 128 * 1024) return undefined;
    const text = await response.text();
    if (Buffer.byteLength(text) > 128 * 1024) return undefined;
    const parsed = JSON.parse(text) as unknown;
    return isRojoServerInfo(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

function expectedProjectName(project: RojoProjectMetadata): string {
  if (project.name) return project.name;
  const file = basename(project.path);
  if (/^default\.project\.jsonc?$/i.test(file)) return basename(dirname(project.path));
  return file.replace(/\.project\.jsonc?$/i, "");
}

function projectCompatibilityError(
  project: RojoProjectMetadata,
  info: RojoServerInfo,
  url: string
): string | undefined {
  const expected = expectedProjectName(project);
  if (info.projectName !== expected) {
    return (
      `A Rojo server is listening at ${url}, but it serves project ` +
      `${JSON.stringify(info.projectName)} instead of ${JSON.stringify(expected)}.`
    );
  }
  return undefined;
}

async function terminateProcessTree(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.killed) return;

  if (process.platform === "win32" && child.pid) {
    await new Promise<void>((resolvePromise) => {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true
      });
      killer.once("exit", () => resolvePromise());
      killer.once("error", () => {
        child.kill("SIGTERM");
        resolvePromise();
      });
    });
    return;
  }

  try {
    if (child.pid) process.kill(-child.pid, "SIGTERM");
    else child.kill("SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }

  const exited = once(child, "exit").then(() => true).catch(() => true);
  const timedOut = delay(2_000).then(() => false);
  if (!(await Promise.race([exited, timedOut]))) {
    try {
      if (child.pid) process.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}

export class RojoProcessManager {
  #child: ChildProcess | undefined;
  #address = "localhost";
  #port = 34_872;
  #logs = "";
  #startedAt: string | undefined;
  #externalDetected = false;
  #serverInfo: RojoServerInfo | undefined;
  #error: string | undefined;
  #project: RojoProjectMetadata | undefined;

  constructor(
    private readonly cwd: string,
    private readonly config: RobloxConfig,
    private readonly run: CommandRunner
  ) {}

  configure(project: RojoProjectMetadata): void {
    this.#project = project;
    this.#address = this.config.rojo.server.address ?? project.serveAddress;
    this.#port = this.config.rojo.server.port ?? project.servePort;
  }

  async version(signal?: AbortSignal): Promise<string | undefined> {
    const options: { cwd: string; timeout?: number; signal?: AbortSignal } = {
      cwd: this.cwd,
      timeout: 5_000
    };
    if (signal) options.signal = signal;
    try {
      const result = await this.run(this.config.rojo.binary, ["--version"], options);
      if (result.code !== 0) return undefined;
      return (result.stdout || result.stderr).trim() || undefined;
    } catch {
      return undefined;
    }
  }

  async start(project: RojoProjectMetadata, signal?: AbortSignal): Promise<RojoServerStatus> {
    this.configure(project);

    if (this.#child && this.#child.exitCode === null) return this.status();

    const external = await probeRojo(this.#address, this.#port);
    if (external) {
      const incompatibility = projectCompatibilityError(
        project,
        external,
        serverUrl(this.#address, this.#port)
      );
      if (incompatibility) {
        this.#error = incompatibility;
        throw new Error(incompatibility);
      }
      this.#externalDetected = true;
      this.#serverInfo = external;
      this.#error = undefined;
      return this.status();
    }

    this.#externalDetected = false;
    this.#serverInfo = undefined;
    this.#error = undefined;
    this.#logs = "";
    const args = [
      "serve",
      project.path,
      "--address",
      this.#address,
      "--port",
      String(this.#port),
      ...this.config.rojo.server.extraArgs
    ];

    const script = resolve(this.cwd, this.config.rojo.binary);
    const nodeScript = /\.(?:c|m)?js$/i.test(this.config.rojo.binary) && existsSync(script);
    const child = spawn(nodeScript ? process.execPath : this.config.rojo.binary, nodeScript ? [script, ...args] : args, {
      cwd: this.cwd,
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32"
    });
    this.#child = child;
    this.#startedAt = new Date().toISOString();

    const append = (chunk: Buffer | string): void => {
      this.#logs += chunk.toString();
      if (this.#logs.length > 100_000) this.#logs = this.#logs.slice(-50_000);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.once("error", (error) => append(`\n[spawn error] ${error.message}\n`));

    const deadline = Date.now() + this.config.rojo.server.readinessTimeoutMs;
    while (!signal?.aborted && Date.now() < deadline) {
      if (child.exitCode !== null) {
        this.#error = `rojo serve exited with code ${child.exitCode}.`;
        throw new Error(`${this.#error}\n${truncateText(this.#logs, 8_000)}`);
      }
      const info = await probeRojo(this.#address, this.#port);
      if (info) {
        const incompatibility = projectCompatibilityError(
          project,
          info,
          serverUrl(this.#address, this.#port)
        );
        if (incompatibility) {
          await terminateProcessTree(child);
          this.#child = undefined;
          this.#error = incompatibility;
          throw new Error(incompatibility);
        }
        this.#serverInfo = info;
        return this.status();
      }
      await delay(150, undefined, signal ? { signal } : undefined).catch(() => undefined);
    }

    if (signal?.aborted) {
      await terminateProcessTree(child);
      this.#child = undefined;
      this.#error = "Starting rojo serve was cancelled.";
      throw new Error(this.#error);
    }

    await terminateProcessTree(child);
    this.#child = undefined;
    this.#error =
      `rojo serve did not become ready within ${this.config.rojo.server.readinessTimeoutMs}ms ` +
      `at ${serverUrl(this.#address, this.#port)}.`;
    throw new Error(`${this.#error}\n${truncateText(this.#logs, 8_000)}`);
  }

  async stop(): Promise<RojoServerStatus> {
    const child = this.#child;
    this.#child = undefined;
    if (child) await terminateProcessTree(child);
    this.#startedAt = undefined;
    this.#externalDetected = false;
    this.#serverInfo = undefined;
    this.#error = undefined;
    return this.status();
  }

  async restart(project: RojoProjectMetadata, signal?: AbortSignal): Promise<RojoServerStatus> {
    await this.stop();
    return this.start(project, signal);
  }

  async status(): Promise<RojoServerStatus> {
    const child = this.#child;
    const ownedRunning = Boolean(child && child.exitCode === null && !child.killed);
    const info = await probeRojo(this.#address, this.#port);
    const ready = info !== undefined;
    this.#serverInfo = info;
    this.#externalDetected = ready && !ownedRunning;

    if (info && this.#project) {
      this.#error = projectCompatibilityError(
        this.#project,
        info,
        serverUrl(this.#address, this.#port)
      );
    } else if (!info && !ownedRunning) {
      this.#error = undefined;
    }

    const status: RojoServerStatus = {
      configured: true,
      running: ownedRunning || ready,
      ready: ready && !this.#error,
      ownedByExtension: ownedRunning,
      address: this.#address,
      port: this.#port,
      url: serverUrl(this.#address, this.#port),
      logTail: truncateText(this.#logs.slice(-12_000), 12_000)
    };
    if (child?.pid) status.pid = child.pid;
    if (this.#startedAt) status.startedAt = this.#startedAt;
    if (child) status.exitCode = child.exitCode;
    if (info) status.serverInfo = structuredClone(info);
    if (this.#error) status.error = this.#error;
    return status;
  }

  async close(): Promise<void> {
    if (this.config.rojo.server.shutdownOnExit && this.#child) await this.stop();
  }
}
