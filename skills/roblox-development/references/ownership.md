# Ownership rules

`pi-roblox` routes every mutation through the selected Rojo sourcemap and configured Studio-owned roots.

| Ownership | Meaning | Mutation path |
|---|---|---|
| `rojo-owned` | Exact selected-project mapping | Filesystem only |
| `studio-owned` | Explicit Studio root or no managed ancestor | Structured Studio transaction/MCP |
| `ambiguous-rojo-scope` | Missing exact mapping beneath a Rojo-managed ancestor | Blocked by default |
| `filesystem-unmapped` | Workspace file outside the selected map | Filesystem, with care |
| `generated-output` | Build output or pi-roblox internal state | Blocked |
| `external-package` | Dependency or vendored package | Blocked |
| `binary-asset` | Binary Roblox/media file | Blocked by text tools |
| `symbolic-link` | Direct symbolic-link path | Blocked; inspect canonical target |
| `ownership-unresolved` | Rojo mode without a valid sourcemap | Blocked |
| `outside-workspace` | Canonical path escapes the Pi workspace | Blocked |

An explicit `studioOwnedRoots` entry only overrides a Rojo ancestor when the explicit root is more specific. This prevents broad defaults such as `game.Workspace` from stealing ownership of a deeper Rojo subtree.

For existing `rojo-owned` files, use a fresh SHA-256 precondition from `roblox_inspect`. Do not change a target through both Studio and the filesystem.
