import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { extname, resolve } from "node:path";
import type { RobloxConfig } from "./config.js";
import { studioResultImages, studioResultText, type StudioToolResult } from "./studio-client.js";
import {
  assertNoSymbolicLinkComponent,
  atomicWriteFile,
  isInside,
  safeFilename
} from "./util.js";

const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024;
const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif"
]);

function assertArtifactSize(name: string, size: number): void {
  if (size > MAX_ARTIFACT_BYTES) {
    throw new Error(
      `Artifact ${name} is ${size} bytes; the per-artifact limit is ${MAX_ARTIFACT_BYTES} bytes.`
    );
  }
}

function decodeImage(data: string, mimeType: string): Buffer {
  const normalizedMime = mimeType.trim().toLowerCase();
  if (!SUPPORTED_IMAGE_MIME_TYPES.has(normalizedMime)) {
    throw new Error(`Unsupported Studio image MIME type: ${mimeType}`);
  }

  const normalized = data.trim();
  const maximumEncodedLength = Math.ceil(MAX_ARTIFACT_BYTES / 3) * 4 + 4;
  if (normalized.length > maximumEncodedLength) {
    throw new Error(`Studio image exceeds the ${MAX_ARTIFACT_BYTES}-byte artifact limit.`);
  }
  if (
    normalized.length === 0 ||
    normalized.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      normalized
    )
  ) {
    throw new Error("Studio returned invalid base64 image data.");
  }

  const decoded = Buffer.from(normalized, "base64");
  assertArtifactSize("Studio image", decoded.byteLength);
  const canonicalInput = normalized.replace(/=+$/u, "");
  const canonicalOutput = decoded.toString("base64").replace(/=+$/u, "");
  if (canonicalInput !== canonicalOutput) {
    throw new Error("Studio returned non-canonical or corrupted base64 image data.");
  }
  return decoded;
}

function resultWithoutInlineImages(result: StudioToolResult): StudioToolResult {
  return {
    ...result,
    content: result.content.map((block) => {
      if (typeof block !== "object" || block === null) return block;
      const value = block as Record<string, unknown>;
      if (
        value.type !== "image" ||
        typeof value.data !== "string" ||
        typeof value.mimeType !== "string"
      ) {
        return block;
      }
      return {
        ...value,
        data: `[omitted inline image: ${value.data.length} base64 characters]`
      };
    })
  };
}

export interface ArtifactReference {
  kind: "json" | "text" | "image";
  path: string;
  mimeType?: string;
  size: number;
}

function imageExtension(mimeType: string): string {
  switch (mimeType.toLowerCase()) {
    case "image/jpeg":
      return ".jpg";
    case "image/webp":
      return ".webp";
    case "image/gif":
      return ".gif";
    default:
      return ".png";
  }
}

export class ArtifactRun {
  readonly id: string;
  readonly directory: string;

  constructor(
    private readonly root: string,
    label: string
  ) {
    const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
    this.id = `${stamp}-${safeFilename(label, "run")}-${randomUUID().slice(0, 8)}`;
    this.directory = resolve(root, this.id);
    if (!isInside(root, this.directory)) throw new Error("Invalid artifact run path.");
  }

  async initialize(): Promise<void> {
    assertNoSymbolicLinkComponent(this.root, this.directory, "artifact run");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    assertNoSymbolicLinkComponent(this.root, this.directory, "artifact run");
  }

  async writeJson(name: string, value: unknown): Promise<ArtifactReference> {
    await this.initialize();
    const path = this.path(name, ".json");
    assertNoSymbolicLinkComponent(this.directory, path, "JSON artifact");
    const data = `${JSON.stringify(value, null, 2)}\n`;
    assertArtifactSize(name, Buffer.byteLength(data));
    await atomicWriteFile(path, data, { mode: 0o600 });
    return { kind: "json", path, size: Buffer.byteLength(data) };
  }

  async writeText(name: string, value: string): Promise<ArtifactReference> {
    await this.initialize();
    const path = this.path(name, ".txt");
    assertNoSymbolicLinkComponent(this.directory, path, "text artifact");
    assertArtifactSize(name, Buffer.byteLength(value));
    await atomicWriteFile(path, value, { mode: 0o600 });
    return { kind: "text", path, size: Buffer.byteLength(value) };
  }

  async writeStudioResult(name: string, result: StudioToolResult): Promise<ArtifactReference[]> {
    const references: ArtifactReference[] = [];
    references.push(await this.writeJson(`${name}-result`, resultWithoutInlineImages(result)));

    const text = studioResultText(result);
    if (text) references.push(await this.writeText(`${name}-text`, text));

    const images = studioResultImages(result);
    for (const [index, image] of images.entries()) {
      await this.initialize();
      const extension = imageExtension(image.mimeType);
      const path = this.path(`${name}-${index + 1}`, extension);
      assertNoSymbolicLinkComponent(this.directory, path, "image artifact");
      const data = decodeImage(image.data, image.mimeType);
      await atomicWriteFile(path, data, { mode: 0o600 });
      references.push({
        kind: "image",
        path,
        mimeType: image.mimeType,
        size: data.byteLength
      });
    }
    return references;
  }

  private path(name: string, preferredExtension: string): string {
    const safe = safeFilename(name);
    const extension = extname(safe) || preferredExtension;
    const basename = extname(safe) ? safe.slice(0, -extname(safe).length) : safe;
    const path = resolve(this.directory, `${basename}${extension}`);
    if (!isInside(this.directory, path)) throw new Error("Invalid artifact path.");
    return path;
  }
}

export class ArtifactStore {
  readonly root: string;

  constructor(cwd: string, config: RobloxConfig) {
    this.root = resolve(cwd, config.scenarios.artifactsDirectory);
    if (!isInside(cwd, this.root)) {
      throw new Error(`Artifact directory must be inside the workspace: ${this.root}`);
    }
    assertNoSymbolicLinkComponent(cwd, this.root, "artifact storage");
  }

  run(label: string): ArtifactRun {
    return new ArtifactRun(this.root, label);
  }
}
