import { extname, relative, resolve } from "node:path";
import type { RobloxConfig } from "./config.js";
import type { RojoIndex } from "./rojo-index.js";
import {
  findSymbolicLinkComponent,
  isInside,
  isStudioPathPrefix,
  matchesGlob,
  normalizeToolPath,
  toPosixPath
} from "./util.js";

export type OwnershipKind =
  | "rojo-owned"
  | "studio-owned"
  | "generated-output"
  | "external-package"
  | "binary-asset"
  | "symbolic-link"
  | "ambiguous-rojo-scope"
  | "ownership-unresolved"
  | "filesystem-unmapped"
  | "outside-workspace";

const BINARY_ASSET_EXTENSIONS = new Set([
  ".rbxm",
  ".rbxl",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".bmp",
  ".mp3",
  ".ogg",
  ".wav",
  ".flac",
  ".fbx",
  ".glb",
  ".zip"
]);

export interface OwnershipRecord {
  target: string;
  ownership: OwnershipKind;
  editable: boolean;
  reason: string;
  sourcePath?: string;
  studioPath?: string;
}

export class OwnershipResolver {
  constructor(
    private readonly cwd: string,
    private readonly config: RobloxConfig,
    private readonly rojo?: RojoIndex
  ) {}

  resolve(targetValue: string): OwnershipRecord {
    const target = normalizeToolPath(targetValue);
    return target === "game" || target.startsWith("game.")
      ? this.resolveStudio(target)
      : this.resolveFile(target);
  }

  private resolveStudio(target: string): OwnershipRecord {
    if (this.config.mode === "rojo" && !this.rojo) {
      return {
        target,
        ownership: "ownership-unresolved",
        editable: false,
        reason:
          "Rojo mode is enabled, but no valid sourcemap is loaded. Studio mutation is blocked because source ownership cannot be proven.",
        studioPath: target
      };
    }

    const entry = this.rojo?.findStudio(target);
    if (entry) {
      if (entry.sourcePath && !isInside(this.cwd, entry.sourcePath)) {
        return {
          target,
          ownership: "outside-workspace",
          editable: false,
          reason: "The Rojo sourcemap points this instance to source outside Pi's current workspace.",
          studioPath: target,
          sourcePath: entry.sourcePath
        };
      }
      const result: OwnershipRecord = {
        target,
        ownership: "rojo-owned",
        editable: Boolean(entry.sourcePath),
        reason: entry.sourcePath
          ? "The selected Rojo sourcemap maps this instance to a filesystem source."
          : "The selected Rojo sourcemap owns this instance, but it has no directly editable source file.",
        studioPath: target
      };
      if (entry.sourcePath) result.sourcePath = entry.sourcePath;
      return result;
    }

    const explicitStudioRoot = this.config.ownership.studioOwnedRoots
      .filter((root) => root === "game" || root.startsWith("game."))
      .sort((left, right) => right.length - left.length)
      .find((root) => isStudioPathPrefix(root, target));
    if (explicitStudioRoot) {
      return {
        target,
        ownership: "studio-owned",
        editable: true,
        reason: `The target is within the explicitly configured Studio-owned root ${explicitStudioRoot}.`,
        studioPath: target
      };
    }

    const ancestor = this.rojo?.findNearestStudioAncestor(target);
    if (ancestor && this.config.ownership.blockAmbiguousWrites) {
      const result: OwnershipRecord = {
        target,
        ownership: "ambiguous-rojo-scope",
        editable: false,
        reason: `The target is missing from the sourcemap but is below Rojo-owned ancestor ${ancestor.studioPath}.`,
        studioPath: target
      };
      if (ancestor.sourcePath) result.sourcePath = ancestor.sourcePath;
      return result;
    }

    return {
      target,
      ownership: "studio-owned",
      editable: true,
      reason: "No exact entry for this instance exists in the selected Rojo sourcemap.",
      studioPath: target
    };
  }

  private resolveFile(target: string): OwnershipRecord {
    const absolute = resolve(this.cwd, target);
    if (!isInside(this.cwd, absolute)) {
      return {
        target: absolute,
        ownership: "outside-workspace",
        editable: false,
        reason: "The path is outside Pi's current workspace."
      };
    }

    const symbolicLink = findSymbolicLinkComponent(this.cwd, absolute);
    if (symbolicLink) {
      return {
        target: absolute,
        ownership: "symbolic-link",
        editable: false,
        reason: `The path traverses symbolic-link component ${symbolicLink}; edit the canonical path explicitly.`,
        sourcePath: absolute
      };
    }

    const relativePath = toPosixPath(relative(this.cwd, absolute));
    if (this.config.rojo.dependencyPatterns.some((pattern) => matchesGlob(relativePath, pattern))) {
      return {
        target: absolute,
        ownership: "external-package",
        editable: false,
        reason: `The path matches a dependency pattern (${relativePath}).`,
        sourcePath: absolute
      };
    }

    if (this.config.rojo.generatedPatterns.some((pattern) => matchesGlob(relativePath, pattern))) {
      return {
        target: absolute,
        ownership: "generated-output",
        editable: false,
        reason: `The path matches a generated-output pattern (${relativePath}).`,
        sourcePath: absolute
      };
    }

    if (BINARY_ASSET_EXTENSIONS.has(extname(absolute).toLowerCase())) {
      return {
        target: absolute,
        ownership: "binary-asset",
        editable: false,
        reason: "The full-file apply primitive accepts UTF-8 text and will not overwrite binary assets.",
        sourcePath: absolute
      };
    }

    const entry = this.rojo?.findSource(absolute);
    if (entry) {
      return {
        target: absolute,
        ownership: "rojo-owned",
        editable: true,
        reason: "The selected Rojo sourcemap maps this file to a Studio instance.",
        sourcePath: absolute,
        studioPath: entry.studioPath
      };
    }

    return {
      target: absolute,
      ownership: "filesystem-unmapped",
      editable: true,
      reason: "The file is inside the workspace but is not represented by the selected Rojo sourcemap.",
      sourcePath: absolute
    };
  }
}
