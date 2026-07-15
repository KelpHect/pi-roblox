import { existsSync } from "node:fs";
import { copyFile, lstat, mkdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import type { AuditContext, AuditLog } from "./audit.js";
import type { CheckpointManager } from "./checkpoints.js";
import type { RobloxConfig } from "./config.js";
import type { OwnershipRecord, OwnershipResolver } from "./ownership.js";
import type { ValidationRun } from "./validation.js";
import {
  assertNoSymbolicLinkComponent,
  atomicWriteFile,
  isInside,
  sha256,
  toPosixPath
} from "./util.js";

export interface WriteFileOperation {
  kind: "write";
  target: string;
  content: string;
  /** null asserts that the file must not exist. */
  expectedSha256?: string | null;
}

export interface DeleteFileOperation {
  kind: "delete";
  target: string;
  expectedSha256?: string;
}

export interface MoveFileOperation {
  kind: "move";
  from: string;
  to: string;
  expectedSha256?: string;
  /** null asserts that the destination must not exist. */
  expectedDestinationSha256?: string | null;
  overwrite?: boolean;
}

export type FileMutationOperation = WriteFileOperation | DeleteFileOperation | MoveFileOperation;

export interface PreparedFileOperation {
  kind: FileMutationOperation["kind"];
  target: string;
  sourcePath: string;
  destinationPath?: string;
  ownership: OwnershipRecord;
  existsBefore: boolean;
  sha256Before?: string;
  sizeBefore?: number;
  modeBefore?: number;
  expectedSha256?: string | null;
  destinationExistsBefore?: boolean;
  destinationSha256Before?: string;
  destinationSizeBefore?: number;
  destinationModeBefore?: number;
  expectedDestinationSha256?: string | null;
  content?: string;
  overwrite?: boolean;
}

export interface FileSyncEvidence {
  sourcePath: string;
  studioPath?: string;
  status: "verified" | "unverified" | "not-connected" | "not-mapped" | "not-applicable";
  detail?: string;
}

export interface FileTransactionResult {
  status:
    | "dry-run"
    | "applied"
    | "applied-with-validation-failure"
    | "applied-with-validation-cancelled"
    | "rolled-back";
  checkpointId?: string;
  operations: Array<{
    kind: FileMutationOperation["kind"];
    sourcePath: string;
    destinationPath?: string;
    ownership: OwnershipRecord["ownership"];
    beforeSha256?: string;
    afterSha256?: string;
  }>;
  sync: FileSyncEvidence[];
  validation?: ValidationRun;
  rollbackReason?: string;
}

export interface FileTransactionDependencies {
  cwd: string;
  config: RobloxConfig;
  resolver: OwnershipResolver;
  checkpoints: CheckpointManager;
  audit: AuditLog;
  refreshRojo(signal?: AbortSignal): Promise<void>;
  verifySync(sourcePath: string, studioPath: string | undefined, signal?: AbortSignal): Promise<FileSyncEvidence>;
  validate(profile: string | undefined, signal?: AbortSignal): Promise<ValidationRun>;
}

function assertText(value: string): void {
  if (value.includes("\0")) throw new Error("Text file content cannot contain NUL bytes.");
  if (Buffer.byteLength(value, "utf8") > 20 * 1024 * 1024) {
    throw new Error("A single file mutation is limited to 20 MiB.");
  }
}

async function currentState(path: string): Promise<{
  exists: boolean;
  hash?: string;
  size?: number;
  mode?: number;
}> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false };
    throw error;
  }
  if (info.isSymbolicLink()) {
    throw new Error(`File mutation target is a symbolic link: ${path}`);
  }
  if (!info.isFile()) throw new Error(`File mutation target is not a regular file: ${path}`);
  const data = await readFile(path);
  return {
    exists: true,
    hash: sha256(data),
    size: data.byteLength,
    mode: info.mode & 0o777
  };
}

function stateDescription(state: Awaited<ReturnType<typeof currentState>>): string {
  return state.exists ? state.hash ?? "present" : "missing";
}

function assertSameState(
  path: string,
  expected: {
    exists: boolean;
    hash?: string;
  },
  actual: Awaited<ReturnType<typeof currentState>>,
  label: string
): void {
  if (actual.exists !== expected.exists || (actual.exists && actual.hash !== expected.hash)) {
    throw new Error(
      `Concurrent change detected for ${label} ${path}. ` +
        `Prepared ${expected.exists ? expected.hash ?? "present" : "missing"}; ` +
        `current ${stateDescription(actual)}.`
    );
  }
}

function requireEditable(record: OwnershipRecord, target: string): string {
  if (!record.editable || !record.sourcePath) {
    throw new Error(`${target} has no safely editable filesystem source: ${record.reason}`);
  }
  return record.sourcePath;
}

function assertExpected(
  prepared: PreparedFileOperation,
  config: RobloxConfig
): void {
  const expected = prepared.expectedSha256;
  if (expected === null) {
    if (prepared.existsBefore) {
      throw new Error(`Expected ${prepared.sourcePath} not to exist, but it currently exists.`);
    }
    return;
  }
  if (expected !== undefined && expected !== prepared.sha256Before) {
    throw new Error(
      `Stale mutation rejected for ${prepared.sourcePath}. ` +
        `Expected ${expected}; current ${prepared.sha256Before ?? "missing"}.`
    );
  }
  if (
    config.ownership.requireHashForMappedWrites &&
    prepared.ownership.ownership === "rojo-owned" &&
    prepared.existsBefore &&
    expected === undefined
  ) {
    throw new Error(
      `A SHA-256 precondition is required for mapped source ${prepared.sourcePath}. ` +
        "Inspect it first and pass expectedSha256."
    );
  }
}

function assertExpectedDestination(
  prepared: PreparedFileOperation
): void {
  if (prepared.kind !== "move") return;
  const expected = prepared.expectedDestinationSha256;
  const exists = prepared.destinationExistsBefore ?? false;
  const current = prepared.destinationSha256Before;

  if (expected === null) {
    if (exists) {
      throw new Error(
        `Expected move destination ${prepared.destinationPath} not to exist, but it currently exists.`
      );
    }
    return;
  }

  if (expected !== undefined && (!exists || expected !== current)) {
    throw new Error(
      `Stale move destination rejected for ${prepared.destinationPath}. ` +
        `Expected ${expected}; current ${exists ? current ?? "present" : "missing"}.`
    );
  }

  if (exists && prepared.overwrite && expected === undefined) {
    throw new Error(
      `Overwriting existing move destination ${prepared.destinationPath} requires ` +
        "expectedDestinationSha256. Inspect the destination first and pass its current hash."
    );
  }
}

async function recheckPreparedOperation(
  cwd: string,
  item: PreparedFileOperation
): Promise<void> {
  assertNoSymbolicLinkComponent(cwd, item.sourcePath, "file transaction source");
  const source = await currentState(item.sourcePath);
  assertSameState(
    item.sourcePath,
    { exists: item.existsBefore, ...(item.sha256Before ? { hash: item.sha256Before } : {}) },
    source,
    "source"
  );

  if (item.destinationPath) {
    assertNoSymbolicLinkComponent(cwd, item.destinationPath, "file transaction destination");
    const destination = await currentState(item.destinationPath);
    assertSameState(
      item.destinationPath,
      {
        exists: item.destinationExistsBefore ?? false,
        ...(item.destinationSha256Before ? { hash: item.destinationSha256Before } : {})
      },
      destination,
      "destination"
    );
  }
}

export async function prepareFileOperations(
  dependencies: Pick<FileTransactionDependencies, "cwd" | "config" | "resolver">,
  operations: FileMutationOperation[]
): Promise<PreparedFileOperation[]> {
  if (operations.length === 0) throw new Error("At least one file operation is required.");
  if (operations.length > 200) throw new Error("A file transaction may contain at most 200 operations.");

  const prepared: PreparedFileOperation[] = [];
  const touched = new Set<string>();

  for (const [index, operation] of operations.entries()) {
    if (operation.kind === "write") {
      assertText(operation.content);
      const ownership = dependencies.resolver.resolve(operation.target);
      const sourcePath = requireEditable(ownership, operation.target);
      if (!isInside(dependencies.cwd, sourcePath)) {
        throw new Error(`operations[${index}] resolves outside the workspace: ${sourcePath}`);
      }
      if (touched.has(sourcePath)) throw new Error(`Multiple operations target the same path: ${sourcePath}`);
      touched.add(sourcePath);
      const state = await currentState(sourcePath);
      const item: PreparedFileOperation = {
        kind: "write",
        target: operation.target,
        sourcePath,
        ownership,
        existsBefore: state.exists,
        content: operation.content
      };
      if (state.hash) item.sha256Before = state.hash;
      if (state.size !== undefined) item.sizeBefore = state.size;
      if (state.mode !== undefined) item.modeBefore = state.mode;
      if (operation.expectedSha256 !== undefined) item.expectedSha256 = operation.expectedSha256;
      assertExpected(item, dependencies.config);
      prepared.push(item);
      continue;
    }

    if (operation.kind === "delete") {
      const ownership = dependencies.resolver.resolve(operation.target);
      const sourcePath = requireEditable(ownership, operation.target);
      if (!isInside(dependencies.cwd, sourcePath)) {
        throw new Error(`operations[${index}] resolves outside the workspace: ${sourcePath}`);
      }
      if (touched.has(sourcePath)) throw new Error(`Multiple operations target the same path: ${sourcePath}`);
      touched.add(sourcePath);
      const state = await currentState(sourcePath);
      if (!state.exists) throw new Error(`Cannot delete missing file: ${sourcePath}`);
      const item: PreparedFileOperation = {
        kind: "delete",
        target: operation.target,
        sourcePath,
        ownership,
        existsBefore: true
      };
      if (state.hash) item.sha256Before = state.hash;
      if (state.size !== undefined) item.sizeBefore = state.size;
      if (state.mode !== undefined) item.modeBefore = state.mode;
      if (operation.expectedSha256 !== undefined) item.expectedSha256 = operation.expectedSha256;
      assertExpected(item, dependencies.config);
      prepared.push(item);
      continue;
    }

    const ownership = dependencies.resolver.resolve(operation.from);
    const sourcePath = requireEditable(ownership, operation.from);
    const destinationPath = resolve(dependencies.cwd, operation.to);
    if (!isInside(dependencies.cwd, sourcePath) || !isInside(dependencies.cwd, destinationPath)) {
      throw new Error(`operations[${index}] move must remain inside the workspace.`);
    }
    const destinationOwnership = dependencies.resolver.resolve(destinationPath);
    if (!destinationOwnership.editable) {
      throw new Error(`Move destination is protected: ${destinationOwnership.reason}`);
    }
    if (sourcePath === destinationPath) throw new Error(`Move source and destination are identical: ${sourcePath}`);
    if (touched.has(sourcePath) || touched.has(destinationPath)) {
      throw new Error(`Move overlaps another operation: ${sourcePath} -> ${destinationPath}`);
    }
    touched.add(sourcePath);
    touched.add(destinationPath);
    const state = await currentState(sourcePath);
    if (!state.exists) throw new Error(`Cannot move missing file: ${sourcePath}`);
    const destinationState = await currentState(destinationPath);
    if (destinationState.exists && !operation.overwrite) {
      throw new Error(`Move destination already exists: ${destinationPath}`);
    }
    const item: PreparedFileOperation = {
      kind: "move",
      target: operation.from,
      sourcePath,
      destinationPath,
      ownership,
      existsBefore: true,
      destinationExistsBefore: destinationState.exists,
      overwrite: operation.overwrite === true
    };
    if (state.hash) item.sha256Before = state.hash;
    if (state.size !== undefined) item.sizeBefore = state.size;
    if (state.mode !== undefined) item.modeBefore = state.mode;
    if (operation.expectedSha256 !== undefined) item.expectedSha256 = operation.expectedSha256;
    if (destinationState.hash) item.destinationSha256Before = destinationState.hash;
    if (destinationState.size !== undefined) item.destinationSizeBefore = destinationState.size;
    if (destinationState.mode !== undefined) item.destinationModeBefore = destinationState.mode;
    if (operation.expectedDestinationSha256 !== undefined) {
      item.expectedDestinationSha256 = operation.expectedDestinationSha256;
    }
    assertExpected(item, dependencies.config);
    assertExpectedDestination(item);
    prepared.push(item);
  }

  return prepared;
}

async function moveFile(source: string, destination: string, overwrite: boolean): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  try {
    await rename(source, destination);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EXDEV") {
      if (!overwrite && existsSync(destination)) throw error;
      await copyFile(source, destination);
      await rm(source, { force: true });
      return;
    }
    if (
      overwrite &&
      new Set(["EACCES", "EEXIST", "ENOTEMPTY", "EPERM"]).has(code ?? "")
    ) {
      await rm(destination, { force: true });
      try {
        await rename(source, destination);
      } catch (retryError) {
        if ((retryError as NodeJS.ErrnoException).code !== "EXDEV") throw retryError;
        await copyFile(source, destination);
        await rm(source, { force: true });
      }
      return;
    }
    throw error;
  }
}

export async function executeFileTransaction(
  dependencies: FileTransactionDependencies,
  operations: FileMutationOperation[],
  options: {
    dryRun?: boolean | undefined;
    validationProfile?: string | undefined;
    validate?: boolean | undefined;
    signal?: AbortSignal | undefined;
    auditContext?: AuditContext | undefined;
    label?: string | undefined;
  } = {}
): Promise<FileTransactionResult> {
  const prepared = await prepareFileOperations(dependencies, operations);
  const operationSummary = prepared.map((item) => ({
    kind: item.kind,
    sourcePath: toPosixPath(relative(dependencies.cwd, item.sourcePath)),
    ...(item.destinationPath
      ? { destinationPath: toPosixPath(relative(dependencies.cwd, item.destinationPath)) }
      : {}),
    ownership: item.ownership.ownership,
    ...(item.sha256Before ? { beforeSha256: item.sha256Before } : {})
  }));

  if (options.dryRun) {
    await dependencies.audit.record(
      "file-transaction.dry-run",
      { operations: operationSummary },
      options.auditContext
    );
    return { status: "dry-run", operations: operationSummary, sync: [] };
  }

  const checkpointPaths = prepared.flatMap((item) =>
    item.destinationPath ? [item.sourcePath, item.destinationPath] : [item.sourcePath]
  );
  const checkpoint = await dependencies.checkpoints.create(
    checkpointPaths,
    options.label ?? `file transaction (${prepared.length} operation${prepared.length === 1 ? "" : "s"})`,
    { operationCount: prepared.length }
  );

  await dependencies.audit.record(
    "file-transaction.begin",
    { checkpointId: checkpoint.id, operations: operationSummary },
    options.auditContext
  );

  const attemptedPaths = new Set<string>();
  try {
    // Check every target after checkpoint capture and before the first write.
    // This avoids rolling back unrelated external changes that happened while
    // the checkpoint was being copied.
    for (const item of prepared) await recheckPreparedOperation(dependencies.cwd, item);

    for (const item of prepared) {
      if (options.signal?.aborted) throw options.signal.reason ?? new Error("File transaction cancelled.");
      // Recheck immediately before each operation. The initial preparation and
      // checkpoint copy may have taken long enough for another process to edit
      // the file. This is optimistic concurrency control; it intentionally
      // fails and rolls back rather than overwriting the newer state.
      await recheckPreparedOperation(dependencies.cwd, item);
      attemptedPaths.add(item.sourcePath);
      if (item.destinationPath) attemptedPaths.add(item.destinationPath);
      if (item.kind === "write") {
        await atomicWriteFile(item.sourcePath, item.content!, { mode: item.modeBefore ?? 0o600 });
      } else if (item.kind === "delete") {
        await rm(item.sourcePath, { force: true });
      } else {
        await moveFile(item.sourcePath, item.destinationPath!, item.overwrite ?? false);
      }
    }

    if (dependencies.config.mode === "rojo") await dependencies.refreshRojo(options.signal);
    await dependencies.checkpoints.finalize(checkpoint.id);
  } catch (error) {
    let rollbackError: string | undefined;
    if (
      dependencies.config.checkpoints.autoRollbackOnApplyFailure &&
      attemptedPaths.size > 0
    ) {
      try {
        // Finalize captures the partial state so restore can safely compare it.
        await dependencies.checkpoints.finalize(checkpoint.id).catch(() => undefined);
        await dependencies.checkpoints.restore(checkpoint.id, {
          force: true,
          paths: [...attemptedPaths]
        });
        if (dependencies.config.mode === "rojo") await dependencies.refreshRojo(options.signal);
      } catch (rollbackFailure) {
        rollbackError = (rollbackFailure as Error).message;
      }
    }
    await dependencies.audit.record(
      "file-transaction.failed",
      {
        checkpointId: checkpoint.id,
        error: (error as Error).message,
        rollbackError
      },
      options.auditContext
    );
    throw new Error(
      `File transaction failed: ${(error as Error).message}` +
        (rollbackError ? `\nAutomatic rollback also failed: ${rollbackError}` : "")
    );
  }

  const sync: FileSyncEvidence[] = [];
  for (const item of prepared) {
    if (item.kind !== "write") {
      sync.push({
        sourcePath: item.sourcePath,
        ...(item.ownership.studioPath ? { studioPath: item.ownership.studioPath } : {}),
        status: "not-applicable",
        detail: `${item.kind} synchronization is represented by the refreshed Rojo sourcemap.`
      });
      continue;
    }
    sync.push(
      await dependencies.verifySync(
        item.sourcePath,
        item.ownership.studioPath,
        options.signal
      )
    );
  }

  const resultOperations: FileTransactionResult["operations"] = [];
  for (const item of prepared) {
    const afterPath = item.kind === "move" ? item.destinationPath! : item.sourcePath;
    const after = item.kind === "delete" ? { exists: false } : await currentState(afterPath);
    resultOperations.push({
      kind: item.kind,
      sourcePath: item.sourcePath,
      ...(item.destinationPath ? { destinationPath: item.destinationPath } : {}),
      ownership: item.ownership.ownership,
      ...(item.sha256Before ? { beforeSha256: item.sha256Before } : {}),
      ...(after.hash ? { afterSha256: after.hash } : {})
    });
  }

  let validation: ValidationRun | undefined;
  if (options.validate ?? true) {
    validation = await dependencies.validate(options.validationProfile, options.signal);
  }

  if (
    validation?.status === "fail" &&
    dependencies.config.checkpoints.autoRollbackOnValidationFailure
  ) {
    await dependencies.checkpoints.restore(checkpoint.id);
    if (dependencies.config.mode === "rojo") await dependencies.refreshRojo(options.signal);
    await dependencies.audit.record(
      "file-transaction.rolled-back",
      { checkpointId: checkpoint.id, reason: "validation-failed", validation },
      options.auditContext
    );
    return {
      status: "rolled-back",
      checkpointId: checkpoint.id,
      operations: resultOperations,
      sync,
      validation,
      rollbackReason: "Configured validation failed."
    };
  }

  const status = validation?.status === "fail"
    ? "applied-with-validation-failure"
    : validation?.status === "cancelled"
      ? "applied-with-validation-cancelled"
      : "applied";
  await dependencies.audit.record(
    "file-transaction.complete",
    { checkpointId: checkpoint.id, status, operations: resultOperations, sync, validation },
    options.auditContext
  );
  return {
    status,
    checkpointId: checkpoint.id,
    operations: resultOperations,
    sync,
    ...(validation ? { validation } : {})
  };
}
