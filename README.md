# pi-roblox

A production-oriented Roblox capability package for the Pi coding harness.

**Pi owns intelligence. `pi-roblox` owns Roblox capabilities.** The package never selects a model, calls an LLM, creates a hidden agent loop, or performs autonomous repair. It gives the active Pi session deterministic access to Roblox Studio, Rojo, source ownership, guarded mutations, checkpoints, validation, playtests, and evidence.

## What is implemented

- Direct stdio connection to Roblox Studio's built-in MCP server.
- Runtime discovery and JSON Schema validation of the installed Studio version's MCP tools.
- Strict denial of Roblox-hosted subagents and generation tools by default.
- Managed `rojo serve` lifecycle with external-server detection, readiness probing, and clean shutdown.
- Atomic Rojo sourcemap generation with non-script mappings.
- Exact Studio-path ↔ filesystem ownership routing, ancestor ambiguity detection, and place-ID guards.
- Unified bounded search across project text, Rojo mappings, and the live Studio tree.
- Source inspection with SHA-256 preconditions and Studio/source correspondence.
- Transactional write, delete, and move batches for filesystem-owned source.
- Structured, reversible Studio transactions for instances, properties, attributes, tags, names, parents, and deletions.
- Binary-safe filesystem checkpoints, Studio rollback snapshots, conflict-aware restore, and retention pruning.
- Deterministic validation profiles for formatters, linters, typecheckers, Rojo builds, and unit tests.
- JSON/JSONC playtest scenarios with runtime Luau, play control, navigation, screenshots, console assertions, saved values, teardown, and artifacts.
- Roblox console parsing with Studio-path-to-source-path remapping.
- JSONL audit records with recursive secret redaction.
- Pi commands, model-visible tools, lifecycle hooks, status context, event emission, skills, and prompt templates.
- Protection around Pi's built-in `edit` and `write` tools, including checkpoints and post-edit Rojo verification.

## Architecture

```text
Pi Harness
  model/provider/planning/memory/review/subagents
                         │
                         │ Pi tools and events
                         ▼
                    pi-roblox
  config · ownership · policy · transactions · evidence
             │                         │
             ▼                         ▼
      Filesystem + Rojo        Roblox Studio MCP
      source of truth          live DataModel/runtime
```

Rojo and Studio are complementary:

- **Rojo/filesystem** owns reviewable source and reproducible structure.
- **Studio MCP** owns the live DataModel, Studio-only instances, runtime execution, playtests, console output, viewport captures, input, and asset operations.
- **The ownership resolver** prevents the same target from being edited through both paths.

See [Architecture](docs/architecture.md), [Security](docs/security.md), [Transactions](docs/transactions.md), [Scenarios](docs/scenarios.md), [Troubleshooting](docs/troubleshooting.md), and the [live Studio acceptance checklist](docs/live-e2e.md).

## Requirements

- Node.js 22.19 or newer.
- Pi coding agent.
- Roblox Studio with **Studio as MCP server** enabled.
- Rojo on `PATH` for `mode: "rojo"`.
- The Rojo Studio plugin connected when live filesystem-to-Studio synchronization proof is required.

Windows is the supported and release-verified platform. Studio MCP is discovered automatically on Windows; an unverified macOS discovery path remains available for contributors who choose to test it. Other environments can provide `studio.command` and `studio.args` explicitly.

## Install

During development:

```bash
npm install
npm run check
pi install -l /absolute/path/to/pi-roblox
```

For a one-off Pi run:

```bash
pi -e /absolute/path/to/pi-roblox
```

After publishing under your own npm scope:

```bash
pi install npm:@kellhect/pi-roblox
```

The package name is reserved for publication under the `@kellhect` npm scope.

## Enable Studio MCP

In Roblox Studio:

```text
Assistant → … → Manage MCP Servers → Enable Studio as MCP server
```

Then open the intended place before starting Pi.

## Initialize a Roblox project

From the Roblox project directory:

```bash
pi -e /absolute/path/to/pi-roblox
```

Inside Pi:

```text
/roblox init
/roblox doctor
```

`/roblox init` operates in auto mode:

- It discovers `.project.json` files and prefers `default.project.json`.
- For a discovered Rojo project, it writes the project path, server coordinates, and place guards.
- With no Rojo project, it creates a deliberate Studio-only configuration.
- It also writes a smoke playtest scenario without overwriting an existing one.

Explicit forms:

```text
/roblox init rojo path/to/game.project.json
/roblox init studio-only
/roblox init auto
```

Configuration is stored at `.pi/roblox.json`. A complete example is in [`examples/roblox.json`](examples/roblox.json).

## Model-visible Pi tools

| Tool | Purpose |
|---|---|
| `roblox_status` | Full integration state: config, Rojo, mappings, Studio, and missing capabilities |
| `roblox_doctor` | Deterministic environment diagnostics |
| `roblox_search` | Bounded source/mapping search and optional live Studio search |
| `roblox_inspect` | Ownership, source, hash, dependencies, and live instance evidence |
| `roblox_studio` | Guarded raw Studio MCP access, Studio selection, and connection control |
| `roblox_files` | Transactional batch write/delete/move with rollback and validation |
| `roblox_apply` | Compatibility convenience for one complete-file replacement |
| `roblox_mutate` | Reversible structured Studio-owned DataModel transaction |
| `roblox_test` | Validation profile plus optional playtest scenario |
| `roblox_scenario` | List or run deterministic playtest scenarios |
| `roblox_checkpoint` | Create, list, inspect, restore, or remove checkpoints |
| `roblox_rojo` | Start, stop, restart, inspect, or refresh Rojo and project indexes |

## `/roblox` commands

```text
/roblox init [auto|rojo|studio-only] [project-file]
/roblox doctor
/roblox status
/roblox connect
/roblox disconnect
/roblox tools
/roblox studios
/roblox use <studio-id>
/roblox rojo status|start|stop|restart|refresh
/roblox ownership <path-or-game.*>
/roblox conflicts
/roblox snapshot
/roblox test [validation-profile]
/roblox scenario list
/roblox scenario run <name-or-path>
/roblox checkpoints
/roblox rollback <checkpoint-id> [--force]
/roblox audit [limit]
```

## Ownership contract

Every target receives one classification:

| Classification | Meaning | Mutation path |
|---|---|---|
| `rojo-owned` | Exact source-map ownership | Filesystem only |
| `studio-owned` | Explicit Studio root or no Rojo owner | Structured Studio transaction/MCP |
| `ambiguous-rojo-scope` | Missing from map but below a Rojo-owned ancestor | Blocked by default |
| `filesystem-unmapped` | Workspace file outside selected Rojo mappings | Filesystem, with caution |
| `generated-output` | Build output or pi-roblox internal data | Blocked |
| `external-package` | Package/dependency path | Blocked |
| `binary-asset` | Roblox/media binary | Blocked by text tools |
| `symbolic-link` | Direct symlink target | Blocked; edit canonical path explicitly |
| `ownership-unresolved` | Rojo mode without a valid map | Blocked |
| `outside-workspace` | Escapes the Pi workspace | Blocked |

The key invariant is:

```text
Rojo-owned target   → filesystem mutation only
Studio-owned target → Studio mutation only
Unknown/ambiguous   → fail closed
```

For existing mapped source, inspect immediately before mutation and pass `file.sha256` as `expectedSha256`. Pi's built-in targeted `edit` operation is guarded by its match precondition and a pi-roblox checkpoint; built-in full-file `write` is blocked for existing Rojo-owned source because it cannot provide the required SHA-256 precondition.

## File transactions

`roblox_files` supports up to 200 atomic logical operations:

```json
{
  "operations": [
    {
      "kind": "write",
      "target": "src/shared/Inventory.luau",
      "content": "return {}\n",
      "expectedSha256": "sha256-from-roblox_inspect"
    },
    {
      "kind": "move",
      "from": "src/old/Thing.luau",
      "to": "src/new/Thing.luau",
      "expectedSha256": "sha256-from-roblox_inspect"
    }
  ],
  "dryRun": false,
  "validationProfile": "changed",
  "label": "inventory refactor"
}
```

The runtime:

1. Resolves and validates every target.
2. Rejects stale hashes, symlinks, protected paths, overlap, and workspace escapes.
3. Creates one checkpoint for every touched source/destination.
4. Applies writes atomically and preserves existing Unix modes.
5. Refreshes the Rojo map once.
6. Reads mapped Studio scripts back until synchronization is proven or times out.
7. Runs the selected validation profile.
8. Rolls back on apply failure, and optionally on validation failure.
9. Writes audit evidence and returns the checkpoint ID.

## Structured Studio transactions

Prefer `roblox_mutate` over arbitrary `execute_luau` for Studio-owned content:

```json
{
  "operations": [
    {
      "kind": "create",
      "parent": "game.Workspace.Runtime",
      "className": "Part",
      "name": "Checkpoint",
      "properties": {
        "Anchored": true,
        "Position": { "$type": "Vector3", "value": [0, 5, 0] }
      },
      "tags": ["GeneratedByPi"]
    },
    {
      "kind": "set-attributes",
      "target": "game.Workspace.Runtime.Checkpoint",
      "attributes": { "Enabled": true }
    }
  ],
  "dryRun": false,
  "label": "create runtime checkpoint"
}
```

The generated Edit-mode Luau captures inverse data before mutation. The checkpoint stores that snapshot and can restore supported operations later.

## Validation

Configure named commands, then compose profiles:

```json
{
  "validation": {
    "commands": [
      {
        "name": "format-check",
        "command": "stylua",
        "args": ["--check", "."],
        "timeoutMs": 120000,
        "continueOnFailure": false,
        "env": {}
      },
      {
        "name": "lint",
        "command": "selene",
        "args": ["."],
        "timeoutMs": 120000,
        "continueOnFailure": false,
        "env": {}
      },
      {
        "name": "rojo-build",
        "command": "rojo",
        "args": ["build", "default.project.json", "--output", ".pi/roblox/check.rbxlx"],
        "timeoutMs": 120000,
        "continueOnFailure": false,
        "env": {}
      }
    ],
    "profiles": {
      "changed": ["format-check", "lint"],
      "default": ["format-check", "lint", "rojo-build"]
    },
    "defaultProfile": "default",
    "maxOutputChars": 30000
  }
}
```

No checker is assumed. A project with no configured commands receives `not-configured`, not a false pass.

## Playtest scenarios

Scenarios live under `.pi/roblox/scenarios` and may be JSON or JSONC. They can:

- Start/stop Play or Run.
- Execute Client, Server, or Edit-mode Luau.
- Call any allowed Studio tool.
- Navigate the character.
- Capture screenshots.
- Read and assert console output.
- Save tool values and assert them later.
- Run setup and teardown phases.
- Fail on newly introduced console errors or warnings.

Example: [`examples/scenarios/smoke.jsonc`](examples/scenarios/smoke.jsonc). Full format: [Scenarios](docs/scenarios.md).

Artifacts are written beneath `.pi/roblox/artifacts/<run-id>/` and include the scenario report, text/JSON tool output, and decoded images.

## Permissions

Profiles:

- `observe`: reads and diagnostics only; file/Studio mutations, playtest scenarios, and rollback are blocked.
- `develop`: mutations ask through Pi's UI and fail closed without one.
- `autonomous-local`: normal local operations can proceed, but destructive Studio transactions and tools listed in `studio.alwaysAskTools` still require approval.

Default-denied Studio tools include Roblox-hosted `subagent` and mesh/material/procedural generation. This keeps all AI behavior in Pi and the user's chosen extensions/providers.

`execute_luau` remains an explicit, always-confirm escape hatch because Studio testing and some advanced operations require it. Arbitrary Luau can evade semantic target extraction, so use `roblox_mutate` whenever possible and review raw code before approval.

## Checkpoints, audit, and rollback

- Checkpoints: `.pi/roblox/checkpoints/`
- Audit JSONL: `.pi/roblox/audit/YYYY-MM-DD.jsonl`
- Scenario artifacts: `.pi/roblox/artifacts/`

Filesystem restore is byte-exact for captured files and preserves modes. Unless `force` is supplied, restore refuses to overwrite work that diverged after checkpoint finalization. Studio rollback is supported for operations generated by `roblox_mutate`; raw MCP calls cannot automatically produce inverse operations.

## Extension events

Other Pi extensions can subscribe to:

```text
pi-roblox/v1:connected
pi-roblox/v1:studio-selected
pi-roblox/v1:before-mutation
pi-roblox/v1:after-mutation
pi-roblox/v1:test-result
pi-roblox/v1:rollback
```

## Development and verification

```bash
npm install
npm run typecheck
npm test
npm run test:coverage
npm run audit:prod
npm run verify:package
```

The integration test launches:

- A real child process speaking MCP over stdio.
- A real managed HTTP process emulating `rojo serve` and sourcemap generation.
- The complete runtime path through discovery, place guard, ownership, stale-write rejection, source sync proof, Studio transaction, rollback, validation, scenario artifacts, and audit records.

It does not substitute for a manual smoke test against a current Roblox Studio installation before release.

## Current limitations

- Publishing places/experiences is deliberately not exposed.
- Team Create conflict detection is limited to local hash and live-readback safeguards; it is not a replacement for collaboration policy.
- Raw `execute_luau` and raw mutating MCP tools can be more powerful than the structured ownership layer and require review.
- Studio rollback is strongest for `roblox_mutate`; arbitrary raw MCP changes have no generated inverse.
- Asset upload/search behavior depends on the Studio MCP tools exposed by the installed Studio version.
- The optional thin Studio companion plugin for active selection, cursor context, and native undo waypoints is not required and is not included in this package.

## License

MIT. See [LICENSE](LICENSE).
