import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parse as parseJsonc, printParseErrorCode, type ParseError } from "jsonc-parser";

export type SourceMode = "rojo" | "studio-only";
export type PermissionProfile = "observe" | "develop" | "autonomous-local";

export interface ValidationCommand {
  name: string;
  command: string;
  args: string[];
  timeoutMs: number;
  continueOnFailure: boolean;
  env: Record<string, string>;
}

export interface RobloxConfig {
  version: 1;
  mode: SourceMode;
  projectFile: string;
  expectedPlaceIds: number[];
  studio: {
    autoConnect: boolean;
    command?: string;
    args?: string[];
    deniedTools: string[];
    alwaysAskTools: string[];
    requiredTools: string[];
    connectTimeoutMs: number;
    requestTimeoutMs: number;
    syncTimeoutMs: number;
  };
  rojo: {
    binary: string;
    sourcemapFile: string;
    includeNonScripts: boolean;
    generatedPatterns: string[];
    dependencyPatterns: string[];
    server: {
      autoStart: boolean;
      shutdownOnExit: boolean;
      address: string;
      port: number;
      readinessTimeoutMs: number;
      extraArgs: string[];
    };
  };
  ownership: {
    studioOwnedRoots: string[];
    blockAmbiguousWrites: boolean;
    requireHashForMappedWrites: boolean;
  };
  permissions: {
    profile: PermissionProfile;
    failClosedWithoutUi: boolean;
  };
  validation: {
    commands: ValidationCommand[];
    profiles: Record<string, string[]>;
    defaultProfile: string;
    maxOutputChars: number;
  };
  scenarios: {
    directory: string;
    artifactsDirectory: string;
    defaultTimeoutMs: number;
    failOnConsoleErrors: boolean;
    failOnConsoleWarnings: boolean;
  };
  checkpoints: {
    directory: string;
    keep: number;
    autoRollbackOnApplyFailure: boolean;
    autoRollbackOnValidationFailure: boolean;
  };
  audit: {
    enabled: boolean;
    directory: string;
    maxValueChars: number;
  };
  context: {
    maxFileChars: number;
    maxSearchResults: number;
    injectStatus: boolean;
  };
}

export interface LoadedRobloxConfig {
  config: RobloxConfig;
  path: string;
  exists: boolean;
  warnings: string[];
}

export const DEFAULT_CONFIG: RobloxConfig = {
  version: 1,
  mode: "rojo",
  projectFile: "default.project.json",
  expectedPlaceIds: [],
  studio: {
    autoConnect: true,
    deniedTools: [
      "subagent",
      "generate_mesh",
      "generate_material",
      "generate_procedural_model",
      "wait_job_finished",
      "upload_image"
    ],
    alwaysAskTools: [
      "multi_edit",
      "execute_luau",
      "insert_asset",
      "store_image",
      "start_stop_play",
      "character_navigation",
      "user_keyboard_input",
      "user_mouse_input",
      "set_active_studio"
    ],
    requiredTools: [
      "script_read",
      "search_game_tree",
      "inspect_instance",
      "execute_luau",
      "get_studio_state",
      "start_stop_play",
      "get_console_output",
      "screen_capture"
    ],
    connectTimeoutMs: 10_000,
    requestTimeoutMs: 120_000,
    syncTimeoutMs: 7_500
  },
  rojo: {
    binary: "rojo",
    sourcemapFile: ".pi/roblox/sourcemap.json",
    includeNonScripts: true,
    generatedPatterns: ["out/**", "dist/**", "build/**"],
    dependencyPatterns: ["Packages/**", "ServerPackages/**", "node_modules/**"],
    server: {
      autoStart: true,
      shutdownOnExit: true,
      address: "localhost",
      port: 34_872,
      readinessTimeoutMs: 10_000,
      extraArgs: []
    }
  },
  ownership: {
    studioOwnedRoots: [],
    blockAmbiguousWrites: true,
    requireHashForMappedWrites: true
  },
  permissions: {
    profile: "develop",
    failClosedWithoutUi: true
  },
  validation: {
    commands: [],
    profiles: { default: [] },
    defaultProfile: "default",
    maxOutputChars: 30_000
  },
  scenarios: {
    directory: ".pi/roblox/scenarios",
    artifactsDirectory: ".pi/roblox/artifacts",
    defaultTimeoutMs: 60_000,
    failOnConsoleErrors: true,
    failOnConsoleWarnings: false
  },
  checkpoints: {
    directory: ".pi/roblox/checkpoints",
    keep: 50,
    autoRollbackOnApplyFailure: true,
    autoRollbackOnValidationFailure: false
  },
  audit: {
    enabled: true,
    directory: ".pi/roblox/audit",
    maxValueChars: 8_000
  },
  context: {
    maxFileChars: 40_000,
    maxSearchResults: 100,
    injectStatus: true
  }
};

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function integerValue(value: unknown, fallback: number, min: number, max: number): number {
  return Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max
    ? (value as number)
    : fallback;
}

function stringArray(value: unknown, fallback: readonly string[]): string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? [...value]
    : [...fallback];
}

function stringRecord(value: unknown, fallback: Readonly<Record<string, string>> = {}): Record<string, string> {
  const candidate = object(value);
  if (!Object.values(candidate).every((entry) => typeof entry === "string")) return { ...fallback };
  return { ...candidate } as Record<string, string>;
}

function profiles(value: unknown): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const [name, commands] of Object.entries(object(value))) {
    if (name.length > 0 && Array.isArray(commands) && commands.every((entry) => typeof entry === "string")) {
      result[name] = [...commands];
    }
  }
  return Object.keys(result).length > 0 ? result : structuredClone(DEFAULT_CONFIG.validation.profiles);
}

function validationCommands(value: unknown): ValidationCommand[] {
  if (!Array.isArray(value)) return [];
  const result: ValidationCommand[] = [];
  for (const item of value) {
    const raw = object(item);
    if (typeof raw.name !== "string" || raw.name.length === 0 || typeof raw.command !== "string" || raw.command.length === 0) continue;
    result.push({
      name: raw.name,
      command: raw.command,
      args: stringArray(raw.args, []),
      timeoutMs: integerValue(raw.timeoutMs, 120_000, 1_000, 1_800_000),
      continueOnFailure: booleanValue(raw.continueOnFailure, false),
      env: stringRecord(raw.env)
    });
  }
  return result;
}

function mergeConfig(rawValue: unknown): { config: RobloxConfig; warnings: string[] } {
  const raw = object(rawValue);
  if (raw.version !== undefined && raw.version !== 1) {
    throw new Error(`Unsupported Roblox config version ${String(raw.version)}; expected version 1.`);
  }
  const studio = object(raw.studio);
  const rojo = object(raw.rojo);
  const server = object(rojo.server);
  const ownership = object(raw.ownership);
  const permissions = object(raw.permissions);
  const validation = object(raw.validation);
  const scenarios = object(raw.scenarios);
  const checkpoints = object(raw.checkpoints);
  const audit = object(raw.audit);
  const context = object(raw.context);

  const commandList = validationCommands(validation.commands);
  const configuredProfiles = profiles(validation.profiles);
  const commandNames = new Set(commandList.map((command) => command.name));
  const warnings: string[] = [];
  for (const [profile, names] of Object.entries(configuredProfiles)) {
    for (const name of names) {
      if (!commandNames.has(name)) warnings.push(`Validation profile ${profile} references missing check ${name}.`);
    }
  }

  const config: RobloxConfig = {
    version: 1,
    mode: raw.mode === "studio-only" ? "studio-only" : "rojo",
    projectFile: stringValue(raw.projectFile, DEFAULT_CONFIG.projectFile),
    expectedPlaceIds: [...new Set(
      (Array.isArray(raw.expectedPlaceIds) ? raw.expectedPlaceIds : [])
        .filter((value): value is number => Number.isSafeInteger(value) && (value as number) > 0)
    )],
    studio: {
      autoConnect: booleanValue(studio.autoConnect, DEFAULT_CONFIG.studio.autoConnect),
      deniedTools: stringArray(studio.deniedTools, DEFAULT_CONFIG.studio.deniedTools),
      alwaysAskTools: stringArray(studio.alwaysAskTools, DEFAULT_CONFIG.studio.alwaysAskTools),
      requiredTools: stringArray(studio.requiredTools, DEFAULT_CONFIG.studio.requiredTools),
      connectTimeoutMs: integerValue(studio.connectTimeoutMs, DEFAULT_CONFIG.studio.connectTimeoutMs, 500, 120_000),
      requestTimeoutMs: integerValue(studio.requestTimeoutMs, DEFAULT_CONFIG.studio.requestTimeoutMs, 1_000, 1_800_000),
      syncTimeoutMs: integerValue(studio.syncTimeoutMs, DEFAULT_CONFIG.studio.syncTimeoutMs, 500, 120_000)
    },
    rojo: {
      binary: stringValue(rojo.binary, DEFAULT_CONFIG.rojo.binary),
      sourcemapFile: stringValue(rojo.sourcemapFile, DEFAULT_CONFIG.rojo.sourcemapFile),
      includeNonScripts: booleanValue(rojo.includeNonScripts, DEFAULT_CONFIG.rojo.includeNonScripts),
      generatedPatterns: stringArray(rojo.generatedPatterns, DEFAULT_CONFIG.rojo.generatedPatterns),
      dependencyPatterns: stringArray(rojo.dependencyPatterns, DEFAULT_CONFIG.rojo.dependencyPatterns),
      server: {
        autoStart: booleanValue(server.autoStart, DEFAULT_CONFIG.rojo.server.autoStart),
        shutdownOnExit: booleanValue(server.shutdownOnExit, DEFAULT_CONFIG.rojo.server.shutdownOnExit),
        address: stringValue(server.address, DEFAULT_CONFIG.rojo.server.address),
        port: integerValue(server.port, DEFAULT_CONFIG.rojo.server.port, 1, 65_535),
        readinessTimeoutMs: integerValue(server.readinessTimeoutMs, DEFAULT_CONFIG.rojo.server.readinessTimeoutMs, 500, 120_000),
        extraArgs: stringArray(server.extraArgs, DEFAULT_CONFIG.rojo.server.extraArgs)
      }
    },
    ownership: {
      studioOwnedRoots: stringArray(ownership.studioOwnedRoots, DEFAULT_CONFIG.ownership.studioOwnedRoots),
      blockAmbiguousWrites: booleanValue(ownership.blockAmbiguousWrites, DEFAULT_CONFIG.ownership.blockAmbiguousWrites),
      requireHashForMappedWrites: booleanValue(ownership.requireHashForMappedWrites, DEFAULT_CONFIG.ownership.requireHashForMappedWrites)
    },
    permissions: {
      profile: permissions.profile === "observe" || permissions.profile === "autonomous-local" ? permissions.profile : "develop",
      failClosedWithoutUi: booleanValue(permissions.failClosedWithoutUi, DEFAULT_CONFIG.permissions.failClosedWithoutUi)
    },
    validation: {
      commands: commandList,
      profiles: configuredProfiles,
      defaultProfile: stringValue(validation.defaultProfile, DEFAULT_CONFIG.validation.defaultProfile),
      maxOutputChars: integerValue(validation.maxOutputChars, DEFAULT_CONFIG.validation.maxOutputChars, 1_000, 500_000)
    },
    scenarios: {
      directory: stringValue(scenarios.directory, DEFAULT_CONFIG.scenarios.directory),
      artifactsDirectory: stringValue(scenarios.artifactsDirectory, DEFAULT_CONFIG.scenarios.artifactsDirectory),
      defaultTimeoutMs: integerValue(scenarios.defaultTimeoutMs, DEFAULT_CONFIG.scenarios.defaultTimeoutMs, 1_000, 1_800_000),
      failOnConsoleErrors: booleanValue(scenarios.failOnConsoleErrors, DEFAULT_CONFIG.scenarios.failOnConsoleErrors),
      failOnConsoleWarnings: booleanValue(scenarios.failOnConsoleWarnings, DEFAULT_CONFIG.scenarios.failOnConsoleWarnings)
    },
    checkpoints: {
      directory: stringValue(checkpoints.directory, DEFAULT_CONFIG.checkpoints.directory),
      keep: integerValue(checkpoints.keep, DEFAULT_CONFIG.checkpoints.keep, 1, 10_000),
      autoRollbackOnApplyFailure: booleanValue(checkpoints.autoRollbackOnApplyFailure, DEFAULT_CONFIG.checkpoints.autoRollbackOnApplyFailure),
      autoRollbackOnValidationFailure: booleanValue(checkpoints.autoRollbackOnValidationFailure, DEFAULT_CONFIG.checkpoints.autoRollbackOnValidationFailure)
    },
    audit: {
      enabled: booleanValue(audit.enabled, DEFAULT_CONFIG.audit.enabled),
      directory: stringValue(audit.directory, DEFAULT_CONFIG.audit.directory),
      maxValueChars: integerValue(audit.maxValueChars, DEFAULT_CONFIG.audit.maxValueChars, 500, 100_000)
    },
    context: {
      maxFileChars: integerValue(context.maxFileChars, DEFAULT_CONFIG.context.maxFileChars, 1_000, 500_000),
      maxSearchResults: integerValue(context.maxSearchResults, DEFAULT_CONFIG.context.maxSearchResults, 1, 1_000),
      injectStatus: booleanValue(context.injectStatus, DEFAULT_CONFIG.context.injectStatus)
    }
  };
  if (typeof studio.command === "string" && studio.command.length > 0) config.studio.command = studio.command;
  if (Array.isArray(studio.args) && studio.args.every((entry) => typeof entry === "string")) config.studio.args = [...studio.args];
  return { config, warnings };
}

export async function loadRobloxConfig(cwd: string, configDirName = ".pi"): Promise<LoadedRobloxConfig> {
  const path = resolve(cwd, configDirName, "roblox.json");
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { config: structuredClone(DEFAULT_CONFIG), path, exists: false, warnings: [] };
    }
    throw error;
  }

  const errors: ParseError[] = [];
  const parsed = parseJsonc(source, errors, { allowTrailingComma: true, disallowComments: false }) as unknown;
  if (errors.length > 0) {
    const details = errors.slice(0, 5).map((error) => `${printParseErrorCode(error.error)} at offset ${error.offset}`).join(", ");
    throw new Error(`Invalid JSON/JSONC in Roblox config at ${path}: ${details}`);
  }
  const merged = mergeConfig(parsed);
  return { ...merged, path, exists: true };
}

async function persist(cwd: string, config: RobloxConfig, configDirName: string): Promise<string> {
  const path = resolve(cwd, configDirName, "roblox.json");
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Roblox config already exists: ${path}`);
    throw error;
  }
  return path;
}

export async function writeDefaultRobloxConfig(cwd: string, configDirName = ".pi"): Promise<string> {
  return persist(cwd, structuredClone(DEFAULT_CONFIG), configDirName);
}

export async function writeRobloxConfig(cwd: string, config: RobloxConfig, configDirName = ".pi"): Promise<string> {
  return persist(cwd, structuredClone(config), configDirName);
}
