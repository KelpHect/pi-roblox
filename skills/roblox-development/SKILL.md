---
name: roblox-development
description: Use when inspecting, changing, debugging, or playtesting a Roblox project through pi-roblox, especially projects that use Rojo.
---

# Roblox development with pi-roblox

Pi owns all reasoning, model selection, planning, memory, delegation, and repair decisions. The pi-roblox package only exposes deterministic Roblox, Rojo, filesystem, checkpoint, permission, and validation capabilities.

## Required workflow

1. Call `roblox_status` before substantial Roblox work.
2. Use `roblox_search` to find a small relevant set of Rojo mappings.
3. Use `roblox_inspect` on every source or Studio target before mutation.
4. Respect the returned ownership record:
   - `rojo-owned`: edit the mapped filesystem source. Never use Studio `multi_edit` on it.
   - `studio-owned`: use the guarded `roblox_studio` gateway.
   - `generated-output`, `external-package`, `binary-asset`, `ownership-unresolved`, or `outside-workspace`: do not modify it.
   - `filesystem-unmapped`: modify only when the task genuinely concerns a non-Rojo project file.
5. For `roblox_apply`, pass `file.sha256` from `roblox_inspect` as `expectedSha256`.
6. Examine `syncVerification`, validation output, and checkpoint ID after every apply.
7. Run `roblox_test` for configured static checks. Use `roblox_studio` for playtests, console output, screenshots, and simulated input.
8. Report changed filesystem paths, changed Studio paths, validation/playtest evidence, and rollback checkpoint IDs.

## Studio gateway

Call `roblox_studio` with `action: "list_tools"` before using an unfamiliar Studio tool. The returned schemas are the live schemas from the installed Roblox Studio version.

Use Studio for:

- Live DataModel inspection.
- Studio-owned instances and properties.
- Playtest control and runtime Luau.
- Console output.
- Viewport captures.
- Player, keyboard, and mouse simulation.
- Asset lookup or insertion when explicitly approved.

Do not use Roblox-hosted `subagent`, mesh/material/procedural generation, or other tools denied by `.pi/roblox.json`. Use Pi extensions and the user's selected providers for all AI behavior.

## Failure handling

A failed synchronization check means the filesystem write happened but has not been proven to be live in Studio. Do not claim completion. Diagnose Studio MCP, the Rojo server/plugin, active place, and project mapping.

A stale hash error means the source changed after inspection. Re-inspect and reconsider the patch; do not bypass the precondition.

A failed validation or playtest is evidence for Pi to reason about. The package does not autonomously retry or repair.
