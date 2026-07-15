import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  stat
} from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import type { RobloxConfig } from "./config.js";
import {
  assertNoSymbolicLinkComponent,
  atomicWriteFile,
  isInside,
  sha256,
  toPosixPath
} from "./util.js";

export interface CheckpointFile {
  /** Absolute workspace path. */
  path: string;
  relativePath: string;
  /** Whether the file existed when the checkpoint was created. */
  existed: boolean;
  backupPath?: string;
  sha256Before?: string;
  sizeBefore?: number;
  modeBefore?: number;
  /** Populated by finalize(). */
  existedAfter?: boolean;
  sha256After?: string;
  sizeAfter?: number;
}

export interface CheckpointStudioData {
  snapshotPath: string;
  rollbackSupported: boolean;
  summary?: string;
}

export interface CheckpointManifest {
  /** Version 2 preserves compatibility with checkpoints created by the original 0.1 package. */
  version: 2;
  id: string;
  label: string;
  createdAt: string;
  finalizedAt?: string;
  restoredAt?: string;
  workspace: string;
  files: CheckpointFile[];
  studio?: CheckpointStudioData;
  metadata?: Record<string, unknown>;
}

export interface RestoreOptions {
  force?: boolean | undefined;
  /** Absolute or workspace-relative paths to restore. Omit to restore every file. */
  paths?: string[] | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class CheckpointManager {
  readonly root: string;

  constructor(
    private readonly cwd: string,
    private readonly config: RobloxConfig
  ) {
    this.root = resolve(cwd, config.checkpoints.directory);
    if (!isInside(cwd, this.root)) {
      throw new Error(`Checkpoint directory must be inside the workspace: ${this.root}`);
    }
    assertNoSymbolicLinkComponent(cwd, this.root, "checkpoint storage");
  }

  async create(
    paths: string[],
    label: string,
    metadata?: Record<string, unknown>
  ): Promise<CheckpointManifest> {
    const id = `${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
    const directory = this.directory(id);
    await mkdir(directory, { recursive: true, mode: 0o700 });

    const files: CheckpointFile[] = [];
    for (const candidate of [...new Set(paths.map((path) => resolve(path)))].sort()) {
      this.assertWorkspacePath(candidate);
      if (isInside(this.root, candidate)) {
        throw new Error(`Refusing to recursively checkpoint checkpoint storage: ${candidate}`);
      }

      const relativePath = toPosixPath(relative(this.cwd, candidate));
      if (!existsSync(candidate)) {
        files.push({ path: candidate, relativePath, existed: false });
        continue;
      }

      const info = await stat(candidate);
      if (!info.isFile()) throw new Error(`Checkpoint targets must be files: ${candidate}`);

      const backupPath = resolve(directory, "files", relativePath);
      if (!isInside(directory, backupPath)) throw new Error(`Unsafe checkpoint backup path: ${backupPath}`);
      assertNoSymbolicLinkComponent(directory, backupPath, "checkpoint backup");
      await mkdir(dirname(backupPath), { recursive: true, mode: 0o700 });
      await copyFile(candidate, backupPath);
      await chmod(backupPath, 0o600).catch(() => undefined);
      const data = await readFile(candidate);
      files.push({
        path: candidate,
        relativePath,
        existed: true,
        backupPath,
        sha256Before: sha256(data),
        sizeBefore: data.byteLength,
        modeBefore: info.mode & 0o777
      });
    }

    const manifest: CheckpointManifest = {
      version: 2,
      id,
      label: label.slice(0, 500),
      createdAt: new Date().toISOString(),
      workspace: this.cwd,
      files
    };
    if (metadata && Object.keys(metadata).length > 0) manifest.metadata = structuredClone(metadata);

    await this.writeManifest(manifest);
    await this.prune().catch(() => undefined);
    return manifest;
  }

  async finalize(id: string): Promise<CheckpointManifest> {
    const manifest = await this.read(id);
    for (const file of manifest.files) {
      this.assertWorkspacePath(file.path);
      if (!existsSync(file.path)) {
        file.existedAfter = false;
        delete file.sha256After;
        delete file.sizeAfter;
        continue;
      }

      const info = await stat(file.path);
      if (!info.isFile()) {
        throw new Error(`Checkpoint target became a non-file before finalization: ${file.path}`);
      }
      const data = await readFile(file.path);
      file.existedAfter = true;
      file.sha256After = sha256(data);
      file.sizeAfter = data.byteLength;
    }
    manifest.finalizedAt = new Date().toISOString();
    await this.writeManifest(manifest);
    return manifest;
  }

  async attachStudioSnapshot(
    id: string,
    snapshot: unknown,
    options: { rollbackSupported: boolean; summary?: string }
  ): Promise<CheckpointManifest> {
    const manifest = await this.read(id);
    const path = resolve(this.directory(id), "studio-snapshot.json");
    assertNoSymbolicLinkComponent(this.directory(id), path, "Studio snapshot");
    await atomicWriteFile(path, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
    manifest.studio = {
      snapshotPath: path,
      rollbackSupported: options.rollbackSupported
    };
    if (options.summary) manifest.studio.summary = options.summary.slice(0, 1_000);
    await this.writeManifest(manifest);
    return manifest;
  }

  async readStudioSnapshot(id: string): Promise<unknown | undefined> {
    const manifest = await this.read(id);
    if (!manifest.studio) return undefined;
    const path = resolve(manifest.studio.snapshotPath);
    if (!isInside(this.directory(id), path)) {
      throw new Error(`Checkpoint ${id} contains an unsafe Studio snapshot path.`);
    }
    assertNoSymbolicLinkComponent(this.directory(id), path, "Studio snapshot");
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  }

  async restore(id: string, options: RestoreOptions = {}): Promise<CheckpointManifest> {
    const manifest = await this.read(id);
    if (resolve(manifest.workspace) !== resolve(this.cwd)) {
      throw new Error(`Checkpoint ${id} belongs to another workspace: ${manifest.workspace}`);
    }

    const selected = this.selectFiles(manifest, options.paths);
    if (!options.force) this.assertRestorePreconditions(manifest, selected);

    for (const file of selected) {
      this.assertWorkspacePath(file.path);

      if (!file.existed) {
        await rm(file.path, { recursive: false, force: true });
        continue;
      }

      if (!file.backupPath) throw new Error(`Checkpoint ${id} is missing backup metadata.`);
      const backupPath = resolve(file.backupPath);
      if (!isInside(this.directory(id), backupPath)) {
        throw new Error(`Checkpoint ${id} contains an unsafe backup path.`);
      }
      assertNoSymbolicLinkComponent(this.directory(id), backupPath, "checkpoint backup");
      if (!existsSync(backupPath)) throw new Error(`Checkpoint backup is missing: ${backupPath}`);

      await mkdir(dirname(file.path), { recursive: true });
      await copyFile(backupPath, file.path);
      if (file.modeBefore !== undefined) await chmod(file.path, file.modeBefore).catch(() => undefined);
    }

    if (selected.length === manifest.files.length) {
      manifest.restoredAt = new Date().toISOString();
    } else {
      const history = Array.isArray(manifest.metadata?.partialRestores)
        ? [...manifest.metadata.partialRestores]
        : [];
      history.push({
        timestamp: new Date().toISOString(),
        paths: selected.map((file) => file.relativePath),
        forced: options.force === true
      });
      manifest.metadata = { ...manifest.metadata, partialRestores: history.slice(-100) };
    }
    await this.writeManifest(manifest);
    return manifest;
  }

  async read(id: string): Promise<CheckpointManifest> {
    const manifestPath = this.manifestPath(id);
    assertNoSymbolicLinkComponent(this.directory(id), manifestPath, "checkpoint manifest");
    const parsed = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
    if (!isRecord(parsed) || parsed.version !== 2 || parsed.id !== id || !Array.isArray(parsed.files)) {
      throw new Error(`Invalid checkpoint manifest: ${manifestPath}`);
    }
    if (typeof parsed.workspace !== "string" || typeof parsed.label !== "string") {
      throw new Error(`Invalid checkpoint manifest fields: ${manifestPath}`);
    }
    return parsed as unknown as CheckpointManifest;
  }

  async list(limit = 50): Promise<CheckpointManifest[]> {
    let names: string[];
    try {
      names = await readdir(this.root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }

    const manifests: CheckpointManifest[] = [];
    for (const name of names.sort().reverse()) {
      try {
        manifests.push(await this.read(name));
      } catch {
        // Ignore unrelated or incomplete directories. Doctor/audit can expose write failures.
      }
      if (manifests.length >= Math.max(1, Math.min(limit, 1_000))) break;
    }
    return manifests;
  }

  async remove(id: string): Promise<void> {
    await rm(this.directory(id), { recursive: true, force: true });
  }

  async prune(): Promise<void> {
    const manifests = await this.list(10_000);
    for (const manifest of manifests.slice(this.config.checkpoints.keep)) {
      await this.remove(manifest.id);
    }
  }

  private assertRestorePreconditions(
    manifest: CheckpointManifest,
    files: CheckpointFile[] = manifest.files
  ): void {
    if (!manifest.finalizedAt) {
      throw new Error(
        `Checkpoint ${manifest.id} was not finalized, so its post-mutation state is unknown. ` +
          "Review it and use force only when overwriting newer work is intentional."
      );
    }

    for (const file of files) {
      this.assertWorkspacePath(file.path);
      const currentExists = existsSync(file.path);
      const expectedExists = file.existedAfter;

      // Older v2 manifests did not have existedAfter. Fail closed unless force is explicit.
      if (expectedExists === undefined) {
        throw new Error(
          `Checkpoint ${manifest.id} predates post-state tracking for ${file.relativePath}. ` +
            "Use force only after reviewing the current file."
        );
      }

      if (currentExists !== expectedExists) {
        throw new Error(
          `Rollback conflict for ${file.relativePath}: expected it to be ${expectedExists ? "present" : "absent"}, ` +
            `but it is ${currentExists ? "present" : "absent"}.`
        );
      }

      if (currentExists) {
        const currentHash = sha256(readFileSync(file.path));
        if (!file.sha256After || currentHash !== file.sha256After) {
          throw new Error(
            `Rollback conflict for ${file.relativePath}: expected current ${file.sha256After ?? "unknown"}, ` +
              `found ${currentHash}. Use force only after reviewing the newer change.`
          );
        }
      }
    }
  }

  private selectFiles(
    manifest: CheckpointManifest,
    requestedPaths: string[] | undefined
  ): CheckpointFile[] {
    if (!requestedPaths) return manifest.files;
    if (requestedPaths.length === 0) return [];

    const requested = new Set(
      requestedPaths.map((path) => resolve(this.cwd, path))
    );
    const selected = manifest.files.filter((file) => requested.has(resolve(file.path)));
    if (selected.length !== requested.size) {
      const known = new Set(manifest.files.map((file) => resolve(file.path)));
      const unknown = [...requested].filter((path) => !known.has(path));
      throw new Error(
        `Checkpoint ${manifest.id} does not contain requested path(s): ${unknown.join(", ")}`
      );
    }
    return selected;
  }

  private assertWorkspacePath(path: string): void {
    if (!isInside(this.cwd, path)) {
      throw new Error(`Refusing to operate on a path outside the workspace: ${path}`);
    }
    assertNoSymbolicLinkComponent(this.cwd, path, "workspace file");
  }

  private directory(id: string): string {
    if (!/^[a-zA-Z0-9._-]+$/.test(id)) throw new Error("Invalid checkpoint ID.");
    const directory = resolve(this.root, id);
    if (!isInside(this.root, directory)) throw new Error("Invalid checkpoint ID.");
    assertNoSymbolicLinkComponent(this.root, directory, "checkpoint directory");
    return directory;
  }

  private manifestPath(id: string): string {
    return resolve(this.directory(id), "manifest.json");
  }

  private async writeManifest(manifest: CheckpointManifest): Promise<void> {
    await atomicWriteFile(
      this.manifestPath(manifest.id),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { mode: 0o600 }
    );
  }
}
