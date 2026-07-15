import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, type StdioServerParameters } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { RobloxConfig } from "./config.js";
import { PI_ROBLOX_VERSION } from "./version.js";

export interface StudioToolDescriptor {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface StudioToolResult {
  content: unknown[];
  structuredContent?: unknown;
  isError?: boolean;
  [key: string]: unknown;
}

export interface StudioCallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

function serverParameters(cwd: string, config: RobloxConfig): StdioServerParameters {
  if (config.studio.command) {
    return { command: config.studio.command, args: config.studio.args ?? [], cwd, stderr: "pipe" };
  }
  if (process.platform === "win32") {
    return {
      command: "cmd.exe",
      args: ["/c", "%LOCALAPPDATA%\\Roblox\\mcp.bat"],
      cwd,
      stderr: "pipe"
    };
  }
  if (process.platform === "darwin") {
    return {
      command: "/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP",
      args: [],
      cwd,
      stderr: "pipe"
    };
  }
  throw new Error(
    "Roblox Studio MCP is supported automatically on Windows and macOS. " +
      "Set studio.command and studio.args for another environment."
  );
}

export class StudioClient {
  #client: Client | undefined;
  #transport: StdioClientTransport | undefined;
  #connectPromise: Promise<void> | undefined;
  #tools: StudioToolDescriptor[] | undefined;
  #stderr = "";
  #requestTimeoutMs = 120_000;
  #closing = false;

  get connected(): boolean {
    return this.#client !== undefined && this.#transport !== undefined;
  }

  get stderrTail(): string {
    return this.#stderr.slice(-4_000);
  }

  async connect(cwd: string, config: RobloxConfig): Promise<void> {
    if (this.connected) return;
    if (this.#connectPromise) return this.#connectPromise;
    this.#requestTimeoutMs = config.studio.requestTimeoutMs;
    this.#connectPromise = this.#connect(cwd, config).finally(() => {
      this.#connectPromise = undefined;
    });
    return this.#connectPromise;
  }

  async #connect(cwd: string, config: RobloxConfig): Promise<void> {
    this.#stderr = "";
    this.#closing = false;
    const client = new Client({ name: "pi-roblox", version: PI_ROBLOX_VERSION }, { capabilities: {} });
    const transport = new StdioClientTransport(serverParameters(cwd, config));
    transport.stderr?.on("data", (chunk: Buffer | string) => {
      this.#stderr += chunk.toString();
      if (this.#stderr.length > 16_000) this.#stderr = this.#stderr.slice(-8_000);
    });
    transport.onclose = () => {
      if (this.#transport === transport) this.#invalidate();
    };
    transport.onerror = (error) => {
      if (!this.#closing) {
        this.#stderr += `\nStudio MCP transport error: ${error.message}\n`;
        if (this.#stderr.length > 16_000) this.#stderr = this.#stderr.slice(-8_000);
      }
    };

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Roblox Studio MCP connection timed out after ${config.studio.connectTimeoutMs}ms.`)),
        config.studio.connectTimeoutMs
      );
      timer.unref?.();
    });
    try {
      await Promise.race([client.connect(transport), timeout]);
      this.#client = client;
      this.#transport = transport;
      this.#tools = undefined;
    } catch (error) {
      this.#invalidate();
      await transport.close().catch(() => undefined);
      throw new Error(
        `${(error as Error).message}` +
          (this.stderrTail ? `\nStudio MCP stderr:\n${this.stderrTail}` : "")
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async listTools(refresh = false): Promise<StudioToolDescriptor[]> {
    const client = this.#client;
    if (!client || !this.#transport) throw new Error("Roblox Studio MCP is not connected.");
    if (this.#tools && !refresh) return this.#tools;
    try {
      const response = await client.listTools(undefined, { timeout: this.#requestTimeoutMs });
      this.#tools = response.tools.map((tool) => {
        const descriptor: StudioToolDescriptor = {
          name: tool.name,
          inputSchema: tool.inputSchema as Record<string, unknown>
        };
        if (tool.description !== undefined) descriptor.description = tool.description;
        if (tool.outputSchema !== undefined) descriptor.outputSchema = tool.outputSchema as Record<string, unknown>;
        if (tool.annotations !== undefined) descriptor.annotations = tool.annotations as Record<string, unknown>;
        return descriptor;
      });
      return this.#tools;
    } catch (error) {
      if (!this.connected) throw new Error(`Roblox Studio MCP transport closed: ${(error as Error).message}`);
      throw error;
    }
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    options: StudioCallOptions = {}
  ): Promise<StudioToolResult> {
    const client = this.#client;
    if (!client || !this.#transport) throw new Error("Roblox Studio MCP is not connected.");
    const tools = await this.listTools();
    if (!tools.some((tool) => tool.name === name)) {
      throw new Error(`Roblox Studio MCP does not expose a tool named ${name}.`);
    }
    const requestOptions: { timeout: number; signal?: AbortSignal } = {
      timeout: options.timeoutMs ?? this.#requestTimeoutMs
    };
    if (options.signal) requestOptions.signal = options.signal;
    try {
      return (await client.callTool({ name, arguments: args }, undefined, requestOptions)) as StudioToolResult;
    } catch (error) {
      if (!this.connected) throw new Error(`Roblox Studio MCP transport closed: ${(error as Error).message}`);
      throw error;
    }
  }

  async close(): Promise<void> {
    this.#closing = true;
    const client = this.#client;
    const transport = this.#transport;
    this.#invalidate();
    if (client) await client.close().catch(() => undefined);
    else if (transport) await transport.close().catch(() => undefined);
    this.#closing = false;
  }

  #invalidate(): void {
    this.#client = undefined;
    this.#transport = undefined;
    this.#tools = undefined;
  }
}

export function studioResultText(result: StudioToolResult): string {
  const text: string[] = [];
  for (const block of result.content ?? []) {
    if (typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string") {
      text.push((block as { text: string }).text);
    }
  }
  return text.join("\n");
}

export function studioResultJson<T = unknown>(
  result: StudioToolResult,
  predicate?: (value: unknown) => value is T
): T | undefined {
  const values: unknown[] = [];
  if (result.structuredContent !== undefined) values.push(result.structuredContent);
  const complete = studioResultText(result).trim();
  if (complete) {
    try {
      values.push(JSON.parse(complete) as unknown);
    } catch {
      // Some MCP servers return one JSON value per text line.
    }
  }
  for (const text of complete.split("\n")) {
    const candidate = text.trim();
    if (!candidate) continue;
    try {
      values.push(JSON.parse(candidate) as unknown);
    } catch {
      // Textual tool output is still available through studioResultText.
    }
  }
  for (const value of values) {
    if (!predicate || predicate(value)) return value as T;
  }
  return undefined;
}

export function studioResultImages(result: StudioToolResult): Array<{ data: string; mimeType: string }> {
  const images: Array<{ data: string; mimeType: string }> = [];
  for (const block of result.content ?? []) {
    if (typeof block !== "object" || block === null) continue;
    const value = block as Record<string, unknown>;
    if (value.type === "image" && typeof value.data === "string" && typeof value.mimeType === "string") {
      images.push({ data: value.data, mimeType: value.mimeType });
    }
  }
  return images;
}
