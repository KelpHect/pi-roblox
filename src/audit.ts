import { randomUUID } from "node:crypto";
import { readdir, readFile, mkdir, appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { RobloxConfig } from "./config.js";
import { assertNoSymbolicLinkComponent, isInside, redactSecrets } from "./util.js";

export interface AuditContext {
  sessionId?: string;
  toolCallId?: string;
  source?: "pi-tool" | "pi-command" | "builtin-tool" | "runtime" | "system";
}

export interface AuditRecord {
  id: string;
  timestamp: string;
  event: string;
  cwd: string;
  context?: AuditContext;
  data?: unknown;
}

export class AuditLog {
  readonly root: string;
  #queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly cwd: string,
    private readonly config: RobloxConfig
  ) {
    this.root = resolve(cwd, config.audit.directory);
    if (!isInside(cwd, this.root)) {
      throw new Error(`Audit directory must be inside the workspace: ${this.root}`);
    }
    assertNoSymbolicLinkComponent(cwd, this.root, "audit storage");
  }

  async record(event: string, data?: unknown, context?: AuditContext): Promise<AuditRecord> {
    const record: AuditRecord = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      event,
      cwd: this.cwd
    };
    if (context && Object.keys(context).length > 0) record.context = { ...context };
    if (data !== undefined) {
      record.data = redactSecrets(data, this.config.audit.maxValueChars);
    }

    if (!this.config.audit.enabled) return record;

    const date = record.timestamp.slice(0, 10);
    const path = resolve(this.root, `${date}.jsonl`);
    const line = `${JSON.stringify(record)}\n`;

    this.#queue = this.#queue.then(async () => {
      assertNoSymbolicLinkComponent(this.cwd, this.root, "audit storage");
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      assertNoSymbolicLinkComponent(this.cwd, path, "audit log");
      await appendFile(path, line, { encoding: "utf8", mode: 0o600 });
    });
    await this.#queue;
    return record;
  }

  async recent(limit = 100): Promise<AuditRecord[]> {
    if (!this.config.audit.enabled) return [];
    const boundedLimit = Math.max(1, Math.min(limit, 2_000));

    let files: string[];
    try {
      files = (await readdir(this.root))
        .filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
        .sort()
        .reverse();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }

    const output: AuditRecord[] = [];
    for (const file of files) {
      const path = resolve(this.root, file);
      assertNoSymbolicLinkComponent(this.root, path, "audit log");
      const content = await readFile(path, "utf8");
      const lines = content.trimEnd().split("\n").reverse();
      for (const line of lines) {
        if (!line) continue;
        try {
          output.push(JSON.parse(line) as AuditRecord);
        } catch {
          // A partially written final line should not make the whole audit history unusable.
        }
        if (output.length >= boundedLimit) return output;
      }
    }
    return output;
  }

  async close(): Promise<void> {
    await this.#queue;
  }
}
