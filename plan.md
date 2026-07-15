# Yes—this is the right architecture

The product should be a **Pi package named something like `pi-roblox`**, not a separate AI agent and not primarily another Roblox Studio plugin.

The central contract should be:

> **Pi owns intelligence. `pi-roblox` owns Roblox capabilities.**

Pi chooses the model, provider, planning extension, memory system, subagent system, approval workflow, and repair strategy. The Roblox package contributes tools, deterministic source routing, Studio connectivity, Rojo synchronization, testing, and evidence.

That matches Pi’s design unusually well: Pi separates models/providers from TypeScript extensions, skills, prompts, and UI, while its extension API supports tools, commands, event interception, confirmations, persistent state, custom rendering, and dynamic tool activation. Pi can also switch among many providers and custom models independently of the extension. ([pi.dev][1])

## The responsibility boundary

| Pi and other Pi extensions own   | `pi-roblox` owns                                 |
| -------------------------------- | ------------------------------------------------ |
| Model and provider selection     | Connecting to Roblox Studio                      |
| Agent loop                       | Managing Rojo                                    |
| Planning and task decomposition  | Mapping Roblox instances to source files         |
| Subagents                        | Searching and inspecting Roblox projects         |
| Memory and compaction            | Safely applying Roblox changes                   |
| Deciding how to repair failures  | Running checks and returning test evidence       |
| General-purpose sandboxing       | Roblox-specific permission classifications       |
| User’s preferred coding workflow | Checkpoints, Studio snapshots, and rollback data |

The Roblox package must **never**:

* Call an LLM itself.
* Select or route models.
* Rewrite the user’s request into a hidden task.
* Spawn its own agent.
* Retry or repair autonomously.
* Invoke Roblox’s built-in `subagent` tool in strict Pi-only mode.

It may provide a `SKILL.md` that teaches Pi how Roblox, Rojo, and the package’s tools work. That is capability documentation, not a second agent loop.

---

# What Lemonade publicly appears to do

Lemonade’s exact feature set and implementation are not documented comprehensively enough to claim exact parity today. Officially visible material establishes that it is a Roblox-focused agent with an official Studio plugin. Its privacy policy describes Lemonade as a middle layer between Studio and its implementations and says it does not host or store the user’s project files or codebase. A recent interview with its founder discusses how it plugs into Roblox workflows and where it competes with native Roblox tooling. ([lemonade.gg][2])

Public user reports mention codebase understanding and direct script synchronization. Console mirroring and restoration of previous versions are described by third-party articles rather than clear first-party product documentation, so those should be treated as **benchmark targets to verify**, not facts to copy blindly. ([Reddit][3])

The sensible public parity target is therefore:

| Capability                     | Target for `pi-roblox`                                      |
| ------------------------------ | ----------------------------------------------------------- |
| Understand an existing game    | Unified filesystem, Rojo, and Studio index                  |
| Read and change scripts        | Rojo-aware source edits plus Studio-only editing            |
| Create game systems            | Pi writes code; package routes and verifies it              |
| Create UI and instances        | Declarative Rojo content or Studio MCP mutations            |
| See runtime failures           | Console capture with source-path remapping                  |
| Test gameplay                  | Playtest control, input simulation, assertions, screenshots |
| Search and insert assets       | Creator Store search and controlled insertion               |
| Undo changes                   | Git-backed checkpoints plus Studio snapshots                |
| Work without copy/paste        | Direct filesystem and Studio integration                    |
| Support large projects         | Incremental indexing and targeted context retrieval         |
| Work with any model            | Inherited entirely from Pi                                  |
| Work with other agent features | Composable with any Pi extension                            |

Instead of promising “everything Lemonade does,” the repository should contain a **public capability benchmark**. Parity is claimed only when the same test scenarios pass in both products.

---

# Recommended system architecture

```text
┌──────────────────────────────────────────────────────────────┐
│                         Pi Harness                           │
│                                                              │
│  Model/provider chosen by user                               │
│  Planner / memory / subagents / review / permission packs    │
│  Pi session, context, TUI, tool loop                         │
└────────────────────────────┬─────────────────────────────────┘
                             │ Pi tool calls and events
┌────────────────────────────▼─────────────────────────────────┐
│                    @kellhect/pi-roblox                       │
│                                                              │
│  Pi integration layer                                        │
│  ├─ commands and status UI                                   │
│  ├─ compact Roblox tool facade                               │
│  ├─ dynamic tool-group activation                            │
│  └─ extension-to-extension events                            │
│                                                              │
│  Roblox capability core                                      │
│  ├─ project index                                            │
│  ├─ source ownership resolver                                │
│  ├─ mutation transaction manager                             │
│  ├─ permission classifier                                    │
│  ├─ checkpoint/audit system                                  │
│  └─ validation and scenario runner                           │
│                                                              │
│  Backends                                                     │
│  ├─ filesystem + Git                                         │
│  ├─ Rojo CLI / sourcemap / live-sync manager                 │
│  └─ direct Roblox Studio MCP client                          │
└───────────────┬─────────────────────────────┬────────────────┘
                │                             │
       ┌────────▼─────────┐          ┌────────▼───────────────┐
       │ Filesystem/Rojo  │          │ Roblox Studio          │
       │                  │          │ built-in MCP server     │
       │ Luau source      │          │ data model              │
       │ project files    │          │ runtime/playtests       │
       │ tests/config     │          │ viewport/input/assets   │
       └──────────────────┘          └────────────────────────┘
                                                │
                              Optional later: thin companion plugin
```

As of July 2026, Roblox Studio’s built-in MCP server already exposes script reading and editing, game-tree search, instance inspection, Luau execution, playtest control, console output, screenshots, player input, asset operations, documentation access, and multiple Studio-window selection. It runs locally over stdio and works with any compatible client. ([Creator Hub][4])

That means a custom Studio plugin is **not required for the first version**. The difficult and valuable work is the layer above MCP:

1. Determining whether a target belongs to Rojo or Studio.
2. Preventing the same script from being edited through both paths.
3. Producing reviewable diffs and checkpoints.
4. Verifying that disk changes actually reached Studio.
5. Returning compact, structured evidence to Pi.

---

# Use both Rojo and Studio MCP

Rojo and Studio MCP solve different problems.

## Rojo should own source and reproducible structure

Rojo can map Luau files, directories, models, JSON/TOML modules, project files, and metadata into Roblox instances. Its project format also supports `servePlaceIds`, specifically to prevent a project from being synchronized into the wrong place. ([Rojo][5])

Rojo provides:

* Normal filesystem editing.
* Git diffs and branches.
* Code review.
* Reproducible builds.
* Source files usable by Pi’s normal coding tools.
* A sourcemap between Roblox instance paths and files.
* A clean path for linting, formatting, type checking, and unit tests.

## Studio MCP should own live Studio and runtime operations

Studio MCP provides:

* Inspection of the actual open data model.
* Studio-only instances and properties.
* Runtime Client and Server execution.
* Playtest state.
* Console output.
* Screenshots.
* Keyboard, mouse, and character simulation.
* Asset search and insertion.
* Multiple running Studio windows.

## Why not use Roblox Script Sync instead?

Script Sync is useful but only synchronizes scripts and folders; other instances are ignored, and attributes or tags on scripts can be problematic. Roblox’s documentation explicitly distinguishes it from broader filesystem-source-of-truth workflows. ([Creator Hub][6])

`pi-roblox` should support three modes:

| Mode          | Use case                                                 |
| ------------- | -------------------------------------------------------- |
| `rojo`        | Recommended; filesystem is the primary source of truth   |
| `script-sync` | Existing script-heavy projects that do not want Rojo yet |
| `studio-only` | Fast setup or projects that remain entirely in Studio    |

The architecture must not assume that every user already has a clean Rojo project.

---

# The most important component: source ownership

Every editable Roblox target receives an ownership classification.

| Ownership          | Meaning                                                       | Allowed mutation path              |
| ------------------ | ------------------------------------------------------------- | ---------------------------------- |
| `rojo-owned`       | Represented by the selected Rojo project and sourcemap        | Filesystem only                    |
| `studio-owned`     | Exists in Studio but is not represented by Rojo               | Studio MCP                         |
| `runtime-only`     | Exists only during Client/Server playtest                     | Test tools only                    |
| `generated-output` | Built output such as compiled roblox-ts or generated packages | Read-only; edit its source instead |
| `external-package` | Wally, Pesde, or vendored dependency                          | Read-only by default               |
| `ambiguous`        | Conflicting or duplicated ownership                           | Block until resolved               |

This rule prevents the most dangerous failure mode:

> Pi edits a script on disk, then later edits the Studio copy through MCP, after which Rojo overwrites one version and silently loses the other.

## Ownership resolution algorithm

For every target:

1. Normalize its Studio path and filesystem path.
2. Look it up in the Rojo project model and generated sourcemap.
3. Check whether the file is generated output or a dependency.
4. Compare the disk hash with the currently open Studio source.
5. Assign ownership and confidence.
6. Block mutation when confidence is insufficient.

Example result:

```json
{
  "studioPath": "game.ReplicatedStorage.Inventory.InventoryService",
  "className": "ModuleScript",
  "ownership": "rojo-owned",
  "sourcePath": "src/shared/Inventory/InventoryService.luau",
  "diskHash": "sha256:...",
  "studioHash": "sha256:...",
  "syncState": "verified",
  "editable": true
}
```

The extension should regenerate its sourcemap on demand and after relevant project changes. It should write to a temporary path and atomically replace the active index so Pi never reads a partially generated file.

---

# Direct MCP integration versus a generic Pi MCP adapter

For a proof of concept, a generic MCP package can connect Pi to Roblox Studio.

For the released product, `pi-roblox` should contain its **own direct MCP client** using the official MCP SDK.

That gives the package control over:

* Automatic Windows/macOS Studio executable discovery.
* Reconnection and process lifecycle.
* Multiple Studio selection.
* Roblox-specific result normalization.
* Compact TUI rendering.
* Tool filtering.
* Permission classification.
* Source-ownership checks.
* Audit trails.
* Output truncation and artifact storage.
* Hiding Roblox-hosted AI tools.

Roblox documents the current Studio MCP launch commands as:

```text
Windows:
cmd.exe /c %LOCALAPPDATA%\Roblox\mcp.bat

macOS:
/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP
```

([Creator Hub][4])

The direct client still uses the open MCP protocol; it merely avoids exposing the raw Studio server to Pi without Roblox-specific safeguards.

---

# Pi package layout

```text
pi-roblox/
├─ package.json
├─ README.md
├─ CHANGELOG.md
├─ LICENSE
│
├─ extensions/
│  └─ roblox/
│     └─ index.ts
│
├─ src/
│  ├─ config/
│  │  ├─ schema.ts
│  │  ├─ load.ts
│  │  └─ defaults.ts
│  │
│  ├─ pi/
│  │  ├─ commands.ts
│  │  ├─ lifecycle.ts
│  │  ├─ events.ts
│  │  ├─ renderers.ts
│  │  └─ status-widget.ts
│  │
│  ├─ project/
│  │  ├─ discover.ts
│  │  ├─ index.ts
│  │  ├─ snapshot.ts
│  │  ├─ dependencies.ts
│  │  └─ ownership.ts
│  │
│  ├─ studio/
│  │  ├─ client.ts
│  │  ├─ process.ts
│  │  ├─ studios.ts
│  │  ├─ schemas.ts
│  │  └─ normalize.ts
│  │
│  ├─ rojo/
│  │  ├─ discover.ts
│  │  ├─ process.ts
│  │  ├─ project.ts
│  │  ├─ sourcemap.ts
│  │  ├─ sync-verifier.ts
│  │  └─ migration.ts
│  │
│  ├─ mutations/
│  │  ├─ transaction.ts
│  │  ├─ preconditions.ts
│  │  ├─ filesystem.ts
│  │  ├─ studio.ts
│  │  ├─ inverse.ts
│  │  └─ audit.ts
│  │
│  ├─ validation/
│  │  ├─ pipeline.ts
│  │  ├─ commands.ts
│  │  ├─ console.ts
│  │  ├─ sourcemap-errors.ts
│  │  ├─ playtest.ts
│  │  └─ scenarios.ts
│  │
│  ├─ permissions/
│  │  ├─ classify.ts
│  │  ├─ policy.ts
│  │  └─ confirm.ts
│  │
│  └─ tools/
│     ├─ status.ts
│     ├─ search.ts
│     ├─ inspect.ts
│     ├─ apply.ts
│     ├─ checkpoint.ts
│     ├─ test.ts
│     ├─ interact.ts
│     ├─ assets.ts
│     └─ raw-luau.ts
│
├─ skills/
│  └─ roblox-development/
│     ├─ SKILL.md
│     └─ references/
│        ├─ architecture.md
│        ├─ security.md
│        ├─ rojo.md
│        └─ testing.md
│
├─ prompts/
│  ├─ roblox-init.md
│  ├─ roblox-feature.md
│  ├─ roblox-debug.md
│  └─ roblox-review.md
│
├─ schemas/
│  ├─ config.schema.json
│  └─ scenario.schema.json
│
└─ optional-studio-companion/
```

Pi packages can bundle extensions, skills, and prompt templates through the `pi` field in `package.json`, and project-local installs can be shared through `.pi/settings.json`. ([pi.dev][7])

```json
{
  "name": "@kellhect/pi-roblox",
  "type": "module",
  "keywords": [
    "pi-package",
    "roblox",
    "rojo"
  ],
  "pi": {
    "extensions": [
      "./extensions/roblox/index.ts"
    ],
    "skills": [
      "./skills"
    ],
    "prompts": [
      "./prompts"
    ]
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "<pinned-version>",
    "fast-glob": "<pinned-version>",
    "jsonc-parser": "<pinned-version>"
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*",
    "typebox": "*"
  }
}
```

Prompt templates should remain optional convenience commands. Disabling them must not remove any core capability.

---

# User-facing commands

Use one `/roblox` command with subcommands rather than filling the command namespace.

```text
/roblox init
/roblox doctor
/roblox status
/roblox connect
/roblox disconnect

/roblox studios
/roblox use <studio-id>

/roblox rojo status
/roblox rojo start
/roblox rojo stop
/roblox rojo verify

/roblox ownership [target]
/roblox conflicts

/roblox test [suite-or-scenario]
/roblox checkpoint [label]
/roblox rollback <checkpoint-id>

/roblox permissions
/roblox dashboard
```

## `/roblox init`

The setup wizard offers:

1. **Use an existing Rojo project.**
2. **Gradually convert an existing Studio project to Rojo.**
3. **Use Studio-only mode.**
4. **Use Script Sync mode.**

It then:

* Detects Studio, MCP, Git, Rojo, Rokit, and project files.
* Selects a `.project.json`.
* Identifies place and universe IDs.
* Recommends adding `servePlaceIds`.
* Creates `.pi/roblox.json`.
* Generates the first source map and project index.
* Starts Rojo when configured.
* Connects to Studio.
* Compares representative disk and Studio scripts.
* Runs a non-destructive smoke test.

## `/roblox doctor`

The diagnostic should report:

```text
Pi package             PASS
Roblox Studio          PASS — 1 instance
Studio MCP             PASS — connected
Active place           PASS — MyGame / place 123...
Rojo CLI               PASS
Rojo server            PASS — localhost:34872
Rojo Studio sync       PASS — verified using 3 source samples
Project file           PASS — default.project.json
servePlaceIds          WARN — missing
Ownership conflicts    PASS — none
Git workspace          WARN — 4 uncommitted files
Formatter              PASS — StyLua
Linter                 PASS — Selene
Type analysis          NOT CONFIGURED
Unit test adapter      PASS — TestEZ
Strict Pi-only AI      PASS
```

A separate distinction between **process running** and **sync verified** is important. A Rojo server can be alive while the Studio plugin is disconnected or stale.

---

# Pi tool surface

Do not expose all raw Studio MCP schemas on every request. That wastes context and encourages bypassing ownership rules.

Pi supports registering many tools while keeping only a small set active, then enabling additional tools dynamically. ([GitHub][8])

## Always-active tools

| Tool                  | Purpose                                                                           |
| --------------------- | --------------------------------------------------------------------------------- |
| `roblox_status`       | Connection, project, ownership, Git, and validation summary                       |
| `roblox_search`       | Unified search across files, sourcemap, Studio tree, scripts, and optionally docs |
| `roblox_inspect`      | Detailed source/instance inspection with ownership information                    |
| `roblox_capabilities` | Activates source, test, asset, or advanced tool groups                            |

## Source tools

| Tool                | Purpose                                       |
| ------------------- | --------------------------------------------- |
| `roblox_apply`      | Transactional filesystem or Studio mutation   |
| `roblox_checkpoint` | Create or restore a change checkpoint         |
| `roblox_snapshot`   | Produce a compact project or subtree snapshot |

## Test tools

| Tool              | Purpose                                          |
| ----------------- | ------------------------------------------------ |
| `roblox_test`     | Run a configured validation pipeline or scenario |
| `roblox_playtest` | Start, stop, and inspect a playtest              |
| `roblox_interact` | Character, keyboard, and mouse operations        |
| `roblox_capture`  | Capture viewport and diagnostic artifacts        |

## Asset tools

| Tool                  | Purpose                                                 |
| --------------------- | ------------------------------------------------------- |
| `roblox_asset_search` | Search approved Roblox asset sources                    |
| `roblox_asset_insert` | Insert an asset with explicit permission and provenance |

## Advanced tools

| Tool                  | Purpose                                            |
| --------------------- | -------------------------------------------------- |
| `roblox_execute_luau` | Audited arbitrary Luau escape hatch                |
| `roblox_raw_mcp`      | Optional, disabled-by-default raw tool passthrough |

The documented Studio server includes Roblox-hosted `subagent`, `generate_mesh`, `generate_material`, and `generate_procedural_model` tools. These should be filtered out under the default `strictPiOnly` policy, because they cross the boundary that all AI behavior should belong to Pi and the user’s chosen extensions. ([Creator Hub][4])

Users may explicitly enable Roblox-hosted generation without enabling Roblox’s subagent:

```json
{
  "aiBoundary": {
    "robloxSubagent": "deny",
    "robloxMeshGeneration": "ask",
    "robloxMaterialGeneration": "ask",
    "robloxProceduralGeneration": "ask"
  }
}
```

---

# `roblox_apply`: the central mutation API

Pi can continue using its regular filesystem editing tools for ordinary Rojo source. `roblox_apply` is needed for operations that cross the source/Studio boundary or require transactional behavior.

Example request:

```json
{
  "operations": [
    {
      "kind": "patch-script",
      "target": "game.ReplicatedStorage.Inventory.InventoryService",
      "patch": "*** unified diff ***"
    },
    {
      "kind": "set-property",
      "target": "game.Workspace.Shop.Counter",
      "property": "Anchored",
      "value": true
    }
  ],
  "preconditions": {
    "requireCleanOwnership": true,
    "expectedHashes": {
      "game.ReplicatedStorage.Inventory.InventoryService": "sha256:..."
    }
  },
  "checkpoint": "auto",
  "validationProfile": "changed",
  "dryRun": false
}
```

The extension resolves the first operation to a filesystem file and the second to Studio MCP.

Example response:

```json
{
  "mutationId": "mut_01J...",
  "status": "applied-and-verified",
  "checkpointId": "cp_01J...",
  "operations": [
    {
      "target": "game.ReplicatedStorage.Inventory.InventoryService",
      "ownership": "rojo-owned",
      "backend": "filesystem",
      "sourcePath": "src/shared/Inventory/InventoryService.luau",
      "syncVerified": true
    },
    {
      "target": "game.Workspace.Shop.Counter",
      "ownership": "studio-owned",
      "backend": "studio-mcp",
      "syncVerified": true
    }
  ],
  "validation": {
    "format": "pass",
    "lint": "pass",
    "rojoBuild": "pass",
    "unitTests": "pass",
    "playtest": "not-requested"
  },
  "rollbackAvailable": true
}
```

No part of this operation needs another model call.

---

# Transaction model

Every mutation follows the same deterministic sequence:

```text
RESOLVE OWNERSHIP
        ↓
CHECK PRECONDITIONS
        ↓
COMPUTE DIFF / INVERSE
        ↓
PERMISSION DECISION
        ↓
CREATE CHECKPOINT
        ↓
APPLY THROUGH CORRECT BACKEND
        ↓
WAIT FOR ROJO / STUDIO SETTLEMENT
        ↓
READ BACK AND VERIFY
        ↓
RUN REQUESTED VALIDATION
        ↓
WRITE AUDIT RECORD
        ↓
RETURN EVIDENCE TO PI
```

## Preconditions

Before changing anything:

* Re-read the current source or instance.
* Compare its hash to the version Pi inspected.
* Check whether another local transaction is active.
* Check whether ownership changed.
* Check the active Studio and place ID.
* Reject a mutation if Rojo is targeting an unexpected place.
* Require explicit approval for deletion or irreversible asset operations.

This provides compare-and-swap semantics: Pi cannot overwrite a collaborator’s newer change merely because it reasoned from an older copy.

## Checkpoints

Use multiple strategies:

| Target              | Checkpoint strategy                                      |
| ------------------- | -------------------------------------------------------- |
| Clean Git workspace | Lightweight Git commit or temporary checkpoint reference |
| Dirty Git workspace | Binary-safe patch plus copies of changed files           |
| Studio scripts      | Full previous source and metadata                        |
| Studio instances    | Property, attribute, tag, parent, and child manifest     |
| Created instances   | Inverse delete operation                                 |
| Deleted instances   | Serialized reconstruction data when possible             |
| Assets              | Record provenance and inserted instance IDs              |

Git checkpoints should not unexpectedly commit unrelated user changes. When the working tree is dirty, use a package-owned checkpoint directory instead.

## Rollback limitations

Filesystem and script rollback can be strong and byte-exact.

Studio object rollback will initially be best-effort for instance types or properties that cannot be reconstructed losslessly. Destructive operations with incomplete inverse data should say so before approval. A later companion plugin can improve this through Studio undo waypoints.

---

# Integrating Pi’s ordinary file tools

The extension should not force every Luau change through a custom patch tool. Pi is already a coding harness.

Instead, subscribe to Pi tool events:

* Before a built-in file edit, classify the path.
* Block direct edits to generated output and dependency caches.
* Create the task checkpoint before the first project mutation.
* Mark the project index dirty.
* After the edit, regenerate affected mappings.
* Verify the corresponding Studio script after Rojo settles.
* Attach Roblox-specific validation results to the next tool result.

Pi extensions can intercept, block, or modify tool calls, making this possible without replacing Pi’s existing coding experience. ([GitHub][8])

This should cover common built-in edit/write operations, but it cannot guarantee control over every arbitrary third-party tool or shell command. The package’s strongest guarantees apply to its own tools and known Pi built-ins.

---

# Permissions and safety

Pi deliberately does not include a universal built-in permission system; by default it runs with the permissions of the launching user and process. Strong whole-system isolation must therefore come from a Pi permission or sandbox extension. ([GitHub][9])

`pi-roblox` still needs a deterministic internal policy because Roblox mutations have domain-specific consequences.

## Profiles

| Operation                   | Observe |               Develop |   Autonomous local |
| --------------------------- | ------: | --------------------: | -----------------: |
| Search/read/inspect         |   Allow |                 Allow |              Allow |
| Console/screenshot          |   Allow |                 Allow |              Allow |
| Edit Rojo source            |    Deny | Approve once per task | Allow in workspace |
| Create Studio instance      |    Deny |                   Ask |              Allow |
| Change Studio property      |    Deny |                   Ask |              Allow |
| Delete Studio instance      |    Deny |        Ask every time |     Ask every time |
| Start local playtest        |     Ask |                 Allow |              Allow |
| Simulate player input       |    Deny |     Allow in playtest |  Allow in playtest |
| Execute arbitrary Luau      |    Deny |        Ask every time |     Ask every time |
| Insert or upload asset      |    Deny |        Ask every time |     Ask every time |
| Roblox-hosted AI generation |    Deny |       Deny by default |    Deny by default |
| Publish experience          |    Deny |                  Deny |               Deny |

Publishing should not be in the initial release. When introduced, it should remain an explicit user command rather than a model-visible default tool.

For non-interactive Pi modes, an operation configured as `ask` must fail closed unless the user has supplied an explicit non-interactive policy.

Audit records should be written to:

```text
.pi/roblox/audit/YYYY-MM-DD.jsonl
```

They should include:

* Pi session ID.
* Tool call ID.
* Active Studio and place.
* Target ownership.
* Requested operation.
* Permission decision.
* Before and after hashes.
* Validation results.
* Checkpoint/rollback ID.

Secrets and complete provider configuration must never enter these logs.

---

# Project context without dumping the entire game

The package should maintain an incremental project index:

```text
.pi/roblox/index.json
.pi/roblox/sourcemap.json
.pi/roblox/studio-snapshot.json
.pi/roblox/dependency-graph.json
```

The index can contain:

* Selected Rojo projects.
* Place and universe mappings.
* Services and important instance paths.
* Source file mapping.
* Script classes and hashes.
* `require()` dependencies.
* RemoteEvents and RemoteFunctions.
* CollectionService tags.
* Attributes.
* Configured test locations.
* Packages and generated paths.
* Current Studio-only nodes.
* Known ownership conflicts.

`roblox_search` should query this index first and only contact Studio or scan source when necessary.

A small factual status can be injected before a Pi turn:

```text
Roblox project: MyGame
Studio: connected to place 123456
Source mode: Rojo; sync verified
Ownership conflicts: 0
Current validation profile: changed
```

Do not inject the full tree or all script contents automatically. Pi already supports skills and dynamic context, so project detail should be retrieved progressively. ([pi.dev][1])

---

# Validation and playtesting

The extension should return **evidence**, not a subjective “looks good.”

## Validation pipeline

```text
FORMAT
  ↓
LINT
  ↓
TYPE ANALYSIS
  ↓
ROJO PROJECT BUILD
  ↓
UNIT TESTS
  ↓
STUDIO SYNC VERIFICATION
  ↓
PLAYTEST
  ↓
CONSOLE ANALYSIS
  ↓
SCENARIO ASSERTIONS
  ↓
SCREENSHOTS / ARTIFACTS
```

Each stage is adapter-based. The initial adapters can include:

* StyLua.
* Selene.
* Luau LSP or configured Luau analysis command.
* `rojo build`.
* TestEZ.
* User-defined shell checks.
* Studio playtests through MCP.

A project that does not use a particular tool receives `not-configured`, not a false failure.

## Console path remapping

Studio errors refer to Roblox instance paths. The extension should map those paths back through the Rojo sourcemap:

```text
Studio:
ReplicatedStorage.Inventory.InventoryService:57

Pi result:
src/shared/Inventory/InventoryService.luau:57
```

This enables Pi to inspect and patch the correct file immediately.

## Scenario format

Check deterministic gameplay scenarios into the repository:

```json
{
  "name": "purchase-item",
  "mode": "play",
  "timeoutMs": 30000,
  "setup": [
    {
      "kind": "server-luau",
      "code": "return TestHelpers.ResetPlayerData()"
    }
  ],
  "steps": [
    {
      "kind": "navigate",
      "target": "game.Workspace.Shop.Counter"
    },
    {
      "kind": "click",
      "target": "game.Players.LocalPlayer.PlayerGui.Shop.BuyButton"
    },
    {
      "kind": "wait",
      "milliseconds": 500
    }
  ],
  "assertions": [
    {
      "kind": "client-luau",
      "code": "return InventoryClient:HasItem('Sword')",
      "equals": true
    },
    {
      "kind": "no-new-console-errors"
    }
  ],
  "captures": [
    "after-purchase"
  ]
}
```

Studio MCP currently provides the necessary playtest, console, screenshot, navigation, keyboard, and mouse primitives for this layer. ([Creator Hub][4])

The extension should return a structured result:

```json
{
  "verdict": "fail",
  "checks": [
    {
      "name": "rojo-build",
      "status": "pass"
    },
    {
      "name": "purchase-item",
      "status": "fail",
      "failedAssertion": 1
    }
  ],
  "newConsoleErrors": [
    {
      "studioPath": "ReplicatedStorage.Inventory.InventoryService",
      "sourcePath": "src/shared/Inventory/InventoryService.luau",
      "line": 57,
      "message": "attempt to index nil"
    }
  ],
  "screenshots": [
    ".pi/roblox/artifacts/run_01J/after-purchase.png"
  ]
}
```

Pi then decides whether to repair, ask the user, delegate to a reviewer, or stop. The extension does not make that decision.

---

# Core workflows

## Adding a feature

```text
User asks Pi for a feature
        ↓
Pi calls roblox_status
        ↓
Pi searches and inspects relevant source/instances
        ↓
Pi plans using its chosen planning setup
        ↓
Pi edits Rojo source and/or calls roblox_apply
        ↓
Extension checkpoints, routes, and verifies
        ↓
Pi calls roblox_test
        ↓
Extension returns static/runtime evidence
        ↓
Pi decides whether another repair pass is needed
```

## Debugging a runtime failure

```text
Pi starts a playtest
        ↓
Extension captures console output
        ↓
Studio paths are mapped to filesystem paths
        ↓
Pi inspects relevant source and dependencies
        ↓
Pi changes source
        ↓
Extension verifies Rojo synchronization
        ↓
Same scenario is replayed
```

## Gradually converting an existing Studio game to Rojo

1. Inventory all scripts and important non-script instances through MCP.
2. Classify roots suitable for filesystem ownership.
3. Export scripts without changing Studio.
4. Generate a candidate `.project.json`.
5. Generate a source map.
6. Build a temporary place.
7. Compare the built tree with the Studio inventory.
8. Show all additions, deletions, and ownership changes.
9. Require approval.
10. Start Rojo only after the comparison passes.
11. Leave unsupported or intentionally visual content Studio-owned.
12. Migrate additional roots incrementally.

Do not attempt an all-or-nothing conversion of a mature place.

## Working with multiple places

Configuration maps each place to its project and test profile:

```text
lobby     → projects/lobby.project.json
match     → projects/match.project.json
tutorial  → projects/tutorial.project.json
```

Roblox Studio MCP supports listing and selecting among multiple running Studio instances. The package should still prefer explicit place-ID matching instead of relying only on automatic selection. ([Creator Hub][4])

---

# Optional Studio companion plugin

Do not build this first.

The documented MCP surface does not currently list APIs for active Explorer selection, active script cursor position, Studio undo waypoints, or push-style selection/change events. That suggests an optional companion plugin could improve the experience, although the exact gaps should be confirmed during the implementation spike. ([Creator Hub][4])

Its responsibilities would be limited to:

* Report the current Studio selection.
* Report the active script and selected range.
* Create named undo waypoints.
* Stream selection, output, and playtest-state changes.
* Show Pi/Rojo connection status inside Studio.
* Display a pending change preview.
* Provide “send selection to Pi.”
* Improve rollback for Studio-only changes.

It must contain:

* No model SDK.
* No API keys.
* No prompts.
* No agent loop.
* No cloud dependency.

The package must remain fully usable without it.

---

# Configuration

A practical `.pi/roblox.json`:

```json
{
  "$schema": "./node_modules/@kellhect/pi-roblox/schemas/config.schema.json",
  "version": 1,

  "mode": "rojo",

  "projects": {
    "main": {
      "projectFile": "default.project.json",
      "placeIds": [
        123456789
      ],
      "validationProfile": "default"
    }
  },

  "studio": {
    "transport": "builtin-mcp",
    "autoConnect": true,
    "selection": "place-id",
    "strictPlaceMatch": true
  },

  "rojo": {
    "autoStart": true,
    "verifySync": true,
    "syncTimeoutMs": 5000,
    "sourcemapPath": ".pi/roblox/sourcemap.json",
    "requireServePlaceIds": true
  },

  "ownership": {
    "generatedPaths": [
      "out/**",
      "Packages/**",
      "ServerPackages/**"
    ],
    "studioOwnedRoots": [
      "game.Workspace.Map",
      "game.Lighting"
    ],
    "blockAmbiguousWrites": true
  },

  "aiBoundary": {
    "strictPiOnly": true,
    "robloxSubagent": "deny",
    "robloxMeshGeneration": "deny",
    "robloxMaterialGeneration": "deny",
    "robloxProceduralGeneration": "deny"
  },

  "permissions": {
    "profile": "develop",
    "executeLuau": "ask-always",
    "deleteInstance": "ask-always",
    "insertAsset": "ask-always",
    "publish": "deny"
  },

  "validation": {
    "onSourceChange": [
      "format",
      "lint",
      "rojo-build"
    ],
    "onTaskComplete": [
      "format",
      "lint",
      "typecheck",
      "rojo-build",
      "unit-tests",
      "playtest"
    ],
    "failOnNewConsoleWarnings": false,
    "failOnNewConsoleErrors": true
  },

  "checkpoints": {
    "strategy": "git-or-backup",
    "automatic": true,
    "autoRollbackOnApplyFailure": true,
    "autoRollbackOnTestFailure": false
  },

  "rawTools": {
    "exposeStudioMcp": false
  }
}
```

---

# Extension composability

The package should publish versioned Pi events so unrelated extensions can participate without being dependencies:

```text
pi-roblox/v1:connected
pi-roblox/v1:studio-selected
pi-roblox/v1:ownership-conflict
pi-roblox/v1:before-mutation
pi-roblox/v1:after-mutation
pi-roblox/v1:playtest-started
pi-roblox/v1:test-result
pi-roblox/v1:rollback
```

Examples:

* A memory extension records architectural discoveries after `test-result`.
* A plan-mode extension requires an approved plan before `before-mutation`.
* A reviewer extension reviews the checkpoint diff.
* A subagent extension delegates investigation.
* A permission extension overrides or tightens a proposed Roblox decision.
* A notification extension announces passing playtests.

`pi-roblox` should not import or require any of them.

---

# How this becomes better than a closed Roblox agent

“Better” should be defined by verifiable properties rather than claiming that every model invocation produces superior code.

## 1. Complete model and provider freedom

The package never talks to a model. The active Pi model can be changed without changing Roblox integration. Pi currently supports many providers, local models, and custom providers, including model switching during a session. ([pi.dev][1])

## 2. Rojo and Git are first-class

Changes are normal files and normal diffs, not opaque Studio modifications. Studio-only content is still handled deliberately rather than pretending everything belongs on disk.

## 3. Deterministic source ownership

Every mutation states where the authoritative copy lives. Ambiguous writes are blocked instead of silently choosing a copy.

## 4. Evidence-backed completion

A task finishes with:

* Changed source paths.
* Changed Studio paths.
* Diffs.
* Sync verification.
* Static-check results.
* Unit-test results.
* Playtest console evidence.
* Screenshots.
* Rollback identifier.

## 5. Composable harness behavior

Users can combine it with any Pi planning, memory, review, subagent, permission, or UI extension.

## 6. No required proprietary cloud

The core path is Pi, the local filesystem, Rojo, and local Studio MCP.

## 7. Multi-place and multi-Studio support

The same Pi session can explicitly manage multiple places and Studio windows while keeping their projects and checkpoints separate.

## 8. Reproducible automation

The same validation profiles can run interactively from Pi or non-interactively in CI where Studio-independent checks are available.

---

# Implementation roadmap

## Phase 0 — capability audit and technical spike

Build only enough to prove the architecture:

* Connect a Pi extension directly to Studio MCP.
* List available tools dynamically.
* List and select Studio windows.
* Search the game tree.
* Read one Studio script.
* Start and stop a playtest.
* Retrieve console output and a screenshot.
* Detect a Rojo project.
* Generate and parse its sourcemap.
* Map one Studio script to a filesystem file.
* Compare disk and Studio hashes.
* Create a documented Lemonade black-box benchmark suite.

**Exit criterion:** one Pi session can inspect a Rojo-owned script, modify it using normal filesystem tools, verify the change in Studio, run a playtest, and retrieve the console output.

## Phase 1 — package foundation

Implement:

* Pi package manifest.
* Configuration schema.
* `/roblox init`.
* `/roblox doctor`.
* `/roblox status`.
* Studio lifecycle and reconnection.
* Rojo process lifecycle.
* Multiple Studio selection.
* Status widget and compact tool renderers.
* Session shutdown cleanup.

**Exit criterion:** installation, setup, connection, failure diagnosis, and shutdown work without manual configuration beyond enabling Studio MCP.

## Phase 2 — ownership and safe editing

Implement:

* Project index.
* Sourcemap refresh.
* Ownership resolver.
* Generated/dependency path protection.
* Unified search and inspect.
* Transaction manager.
* Preconditions and hash checks.
* Filesystem checkpoints.
* Studio snapshots.
* Audit log.
* `roblox_apply`.
* Rollback.
* Built-in Pi edit/write interception.

**Exit criterion:** the package never edits a Rojo-owned script through Studio MCP and never edits a Studio-owned script on disk.

## Phase 3 — validation and debugging

Implement:

* Validation adapters.
* `rojo build` integration.
* Unit-test adapter API.
* Playtest runner.
* Console capture.
* Console-to-filesystem source remapping.
* Screenshot artifacts.
* Scenario schema.
* Input simulation.
* Structured test result format.

**Exit criterion:** Pi can introduce a known defect, observe the failing evidence, repair it, replay the same scenario, and receive a passing result.

## Phase 4 — product parity workflows

Implement:

* Existing Studio project migration wizard.
* Studio-only mode.
* Script Sync mode.
* Asset search and insertion.
* Declarative instance creation.
* Multi-place projects.
* Multi-Studio workflows.
* Documentation search.
* UI-building examples.
* Project snapshots suitable for handoff between Pi sessions.
* Optional raw MCP tools.

**Exit criterion:** all public parity benchmark scenarios pass without copy/paste between Pi and Studio.

## Phase 5 — advanced differentiation

Implement:

* Optional companion Studio plugin.
* Undo waypoint integration.
* Active-selection and cursor context.
* Visual before/after comparison.
* Extension event API.
* CI reporting.
* Custom asset-pipeline adapters.
* roblox-ts source strategy.
* Wally/Pesde dependency awareness.
* Team Create conflict improvements.
* Performance and leak-test scenarios.

**Exit criterion:** the optional plugin adds convenience and stronger rollback, but uninstalling it does not remove core functionality.

---

# Release acceptance tests

The first stable release should pass these scenarios:

| Scenario                     | Required result                                   |
| ---------------------------- | ------------------------------------------------- |
| New Rojo project             | Detect, start, connect, edit, sync, and playtest  |
| Existing Rojo project        | Make a targeted change without restructuring it   |
| Existing Studio-only project | Inspect and safely modify through MCP             |
| Gradual Rojo migration       | Export one root without disturbing the rest       |
| Rojo-owned script            | Never edited through Studio                       |
| Studio-owned script          | Never invent a filesystem mapping                 |
| Stale inspected source       | Mutation rejected by hash precondition            |
| Rojo disconnected            | Change reported as unsynchronized, not successful |
| Wrong open place             | Mutation blocked                                  |
| Multiple Studio windows      | Correct place explicitly selected                 |
| Dirty Git workspace          | User changes preserved outside package checkpoint |
| Failed apply                 | Automatic rollback                                |
| Failed test                  | Evidence returned; Pi controls repair decision    |
| Runtime error                | Studio stack path maps to source file             |
| Strict Pi-only mode          | No Roblox subagent or AI generation call possible |
| Provider switch              | Same Roblox project remains connected             |
| Non-interactive mode         | `ask` operations fail closed                      |
| Uninstall companion plugin   | Core toolchain still works                        |

## Network-boundary test

Run the package under network observation with:

* Roblox-hosted generation disabled.
* Documentation and asset search disabled.
* A local or arbitrary Pi model chosen by the user.

The only Roblox integration traffic should be the expected local Studio MCP and local Rojo communication. There should be no hidden model-provider traffic originating from `pi-roblox`.

---

# The build decision I would commit to

Build **`@kellhect/pi-roblox` as a Pi package containing a native TypeScript extension and a Roblox development skill**.

Use:

* **Pi** for all models, providers, reasoning, planning, memory, repair, and subagents.
* **Rojo and the filesystem** for authoritative source and reproducible project structure.
* **Roblox Studio’s built-in MCP server** for the live data model, runtime, playtests, screenshots, input, and assets.
* **A deterministic ownership router** to decide which backend may mutate each target.
* **Transactional checkpoints, permissions, verification, and tests** around every meaningful change.
* **An optional thin Studio companion plugin later**, only for selection context, undo integration, and event streaming.

The first implementation should not begin with asset generation, a custom Studio chat panel, or sophisticated orchestration. It should begin with four things:

```text
/roblox doctor
roblox_status
roblox_search / roblox_inspect
Rojo-aware edit → Studio verification → playtest evidence
```

Once that path is reliable, the rest of the Lemonade-style experience becomes a set of additional Roblox capabilities, while Pi remains completely interchangeable and user-controlled.

[1]: https://pi.dev/ "Pi Coding Agent"
[2]: https://lemonade.gg/?utm_source=chatgpt.com "Lemonade"
[3]: https://www.reddit.com/r/robloxgamedev/comments/1mtgve9/can_i_finally_trust_ai_to_make_roblox_games/?utm_source=chatgpt.com "Can I finally trust AI to make Roblox games?"
[4]: https://create.roblox.com/docs/studio/mcp "Connect to the Roblox Studio MCP server | Documentation - Roblox Creator Hub"
[5]: https://rojo.space/docs/v7/sync-details/ "Sync Details | Rojo"
[6]: https://create.roblox.com/docs/scripting/sync "Script Sync | Documentation - Roblox Creator Hub"
[7]: https://pi.dev/docs/latest/packages "Pi Packages · Docs · Pi"
[8]: https://github.com/earendil-works/pi/raw/refs/heads/main/packages/coding-agent/docs/extensions.md "raw.githubusercontent.com"
[9]: https://github.com/earendil-works/pi "GitHub - earendil-works/pi: AI agent toolkit: unified LLM API, agent loop, TUI, coding agent CLI · GitHub"
