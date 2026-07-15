import type { RobloxConfig, ValidationCommand } from "./config.js";
import type { CommandRunner } from "./rojo-index.js";
import { truncateText } from "./util.js";

export interface ValidationResult {
  name: string;
  command: string;
  status: "pass" | "fail" | "cancelled";
  code: number;
  durationMs: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

export interface ValidationRun {
  profile: string;
  status: "pass" | "fail" | "cancelled" | "not-configured";
  startedAt: string;
  durationMs: number;
  results: ValidationResult[];
}

function commandsForProfile(config: RobloxConfig, profile: string): ValidationCommand[] {
  const names = config.validation.profiles[profile];
  if (!names || names.length === 0) {
    return profile === config.validation.defaultProfile || !(profile in config.validation.profiles)
      ? config.validation.commands
      : [];
  }
  const selected = new Set(names);
  return config.validation.commands.filter((command) => selected.has(command.name));
}

export async function runValidation(
  cwd: string,
  config: RobloxConfig,
  run: CommandRunner,
  options: { profile?: string | undefined; signal?: AbortSignal | undefined } = {}
): Promise<ValidationRun> {
  const profile = options.profile ?? config.validation.defaultProfile;
  const commands = commandsForProfile(config, profile);
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const results: ValidationResult[] = [];

  if (commands.length === 0) {
    return {
      profile,
      status: "not-configured",
      startedAt,
      durationMs: 0,
      results
    };
  }

  for (const check of commands) {
    if (options.signal?.aborted) break;
    const checkStarted = Date.now();
    let raw: Awaited<ReturnType<CommandRunner>>;
    try {
      const runOptions: {
        cwd: string;
        signal?: AbortSignal;
        timeout?: number;
        env?: NodeJS.ProcessEnv;
      } = {
        cwd,
        timeout: check.timeoutMs,
        env: { ...process.env, ...check.env }
      };
      if (options.signal) runOptions.signal = options.signal;
      raw = await run(check.command, check.args, runOptions);
    } catch (error) {
      raw = {
        stdout: "",
        stderr: (error as Error).message,
        code: -1,
        killed: options.signal?.aborted ?? false
      };
    }

    const combinedLength = raw.stdout.length + raw.stderr.length;
    const result: ValidationResult = {
      name: check.name,
      command: [check.command, ...check.args].join(" "),
      status: raw.killed ? "cancelled" : raw.code === 0 ? "pass" : "fail",
      code: raw.code,
      durationMs: Date.now() - checkStarted,
      stdout: truncateText(raw.stdout, config.validation.maxOutputChars),
      stderr: truncateText(raw.stderr, config.validation.maxOutputChars),
      truncated: combinedLength > config.validation.maxOutputChars * 2
    };
    results.push(result);

    if (result.status !== "pass" && !check.continueOnFailure) break;
  }

  const status = options.signal?.aborted || results.some((result) => result.status === "cancelled")
    ? "cancelled"
    : results.some((result) => result.status === "fail")
      ? "fail"
      : "pass";

  return {
    profile,
    status,
    startedAt,
    durationMs: Date.now() - started,
    results
  };
}
