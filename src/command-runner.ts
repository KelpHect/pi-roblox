import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { CommandRunner } from "./rojo-index.js";

/**
 * Deterministic, shell-free command runner used for Rojo and validation.
 * It supports per-command environment variables, which Pi's public exec API
 * does not currently expose.
 */
export const nodeCommandRunner: CommandRunner = async (command, args, options) => {
  return new Promise((resolvePromise) => {
    const script = resolve(options.cwd, command);
    const nodeScript = /\.(?:c|m)?js$/i.test(command) && existsSync(script);
    const child = spawn(nodeScript ? process.execPath : command, nodeScript ? [script, ...args] : args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let killed = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const maxCapturedChars = 20_000_000;

    const append = (current: string, chunk: Buffer | string): string => {
      const next = current + chunk.toString();
      return next.length > maxCapturedChars ? next.slice(-maxCapturedChars) : next;
    };
    child.stdout?.on("data", (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = append(stderr, chunk);
    });

    const terminate = (): void => {
      if (settled || child.exitCode !== null) return;
      killed = true;
      child.kill("SIGTERM");
      const force = setTimeout(() => child.kill("SIGKILL"), 2_000);
      force.unref?.();
    };

    const onAbort = (): void => terminate();
    if (options.signal) {
      if (options.signal.aborted) terminate();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }
    if (options.timeout && options.timeout > 0) {
      timer = setTimeout(terminate, options.timeout);
      timer.unref?.();
    }

    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolvePromise({ stdout, stderr, code, killed });
    };

    child.once("error", (error) => {
      stderr = append(stderr, error.message);
      finish(-1);
    });
    child.once("exit", (code, signal) => {
      if (signal) killed = true;
      finish(code ?? (killed ? -1 : 1));
    });

    // Avoid an unhandled rejection if a platform emits close without exit.
    void once(child, "close").catch(() => undefined);
  });
};
