#!/usr/bin/env node
import process from "node:process";
import { nodeCommandRunner } from "../src/command-runner.js";
import { RobloxRuntime } from "../src/runtime.js";

interface Options {
  cwd: string;
  configDir: string;
  connectStudio: boolean;
  scenario?: string;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    cwd: process.cwd(),
    configDir: ".pi",
    connectStudio: true
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--cwd") {
      const value = argv[++index];
      if (!value) throw new Error("--cwd requires a value.");
      options.cwd = value;
    } else if (argument === "--config-dir") {
      const value = argv[++index];
      if (!value) throw new Error("--config-dir requires a value.");
      options.configDir = value;
    } else if (argument === "--no-studio") {
      options.connectStudio = false;
    } else if (argument === "--scenario") {
      const value = argv[++index];
      if (!value) throw new Error("--scenario requires a name or path.");
      options.scenario = value;
    } else if (argument === "--help" || argument === "-h") {
      process.stdout.write(
        [
          "Usage: npm run live:doctor -- [options]",
          "",
          "Options:",
          "  --cwd <path>         Roblox workspace (default: current directory)",
          "  --config-dir <name>  Pi config directory (default: .pi)",
          "  --no-studio          Do not attempt Studio MCP connection",
          "  --scenario <name>    Also run an explicitly selected scenario",
          "  --help               Show this help"
        ].join("\n") + "\n"
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const runtime = new RobloxRuntime(options.cwd, options.configDir, nodeCommandRunner);

  try {
    await runtime.initialize(undefined, { connectStudio: options.connectStudio });
    const doctor = await runtime.doctor({ connectStudio: options.connectStudio });
    const output: Record<string, unknown> = { doctor };

    if (options.scenario) {
      output.scenario = await runtime.runScenario(options.scenario, async () => true);
    }

    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    const scenario = output.scenario as { status?: string } | undefined;
    if (doctor.status === "fail" || (scenario && scenario.status !== "pass")) {
      process.exitCode = 1;
    }
  } finally {
    await runtime.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
