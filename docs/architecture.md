# Architecture

## Design rule

`pi-roblox` is a capability extension, not an agent. Pi remains the sole owner of model calls, reasoning, task decomposition, memory, subagents, review, and repair decisions.

The package is split into five layers:

1. **Pi integration** — tools, commands, event hooks, status context, confirmations, and session entries.
2. **Runtime/policy** — config, place guard, permission profile, tool denial, mutation serialization, and evidence aggregation.
3. **Ownership/source** — Rojo project parser, sourcemap index, text index, dependency scan, and authoritative target routing.
4. **Transactions/evidence** — filesystem transactions, Studio transactions, checkpoints, audit, validation, console diagnostics, scenarios, and artifacts.
5. **Backends** — local filesystem, Rojo CLI/server, and Studio's local stdio MCP server.

## Runtime lifecycle

```text
session_start
  load JSONC config
  read Rojo project
  discover/probe/start rojo serve
  generate atomic sourcemap
  build ownership/source indexes
  connect Studio MCP
  discover live tool schemas
  expose status
```

On shutdown, pending built-in edits are finalized as interrupted checkpoints, owned Rojo processes are stopped when configured, MCP is closed, and queued audit writes are flushed.

## Source ownership

An exact Rojo mapping wins. A configured Studio root only wins when it is more specific than the nearest Rojo ancestor. A target that is absent from the sourcemap but lies below a mapped ancestor is ambiguous and blocked by default.

This avoids a common destructive race:

```text
filesystem edit → Rojo sync → Studio edit of same script → next Rojo sync overwrites one side
```

## Mutation serialization

The runtime serializes all package-owned mutations through one promise queue. Pi's built-in file edit/write operations are separately observed through Pi events and receive a checkpoint before execution and post-result synchronization evidence.

A filesystem transaction is logically atomic from the package's perspective:

```text
prepare all operations
  → checkpoint all touched paths
  → apply all operations
  → refresh map
  → finalize checkpoint
  → verify Studio readback
  → run validation
```

Apply failures trigger forced restoration when configured. Validation failures can optionally restore without force, preserving conflict detection.

## Studio MCP adaptation

Studio tools are discovered dynamically. The package uses the live input schemas to:

- Validate raw calls with Ajv.
- Infer argument names when Studio changes naming conventions.
- Adapt enum casing for Play, Run, Client, Server, and Edit values.
- Avoid pinning the package to one Studio tool-schema revision.

Studio calls are serialized because the Studio MCP endpoint and active Studio selection are shared mutable state.

## Studio transactions

`roblox_mutate` converts structured operations into one Edit-mode Luau transaction. The generated program validates targets, captures previous values/tree state, applies operations, and returns a machine-readable snapshot. Rollback generates a second program from that snapshot.

Supported operation families:

- Create.
- Set properties.
- Set attributes.
- Set exact/add/remove tags.
- Rename.
- Reparent.
- Delete with reconstruction data.

## Scenario execution

Scenario execution is deterministic orchestration, not agent logic. Each step is parsed and validated before execution. A run has one timeout signal, baseline console diagnostics, setup/steps/teardown phases, best-effort Play cleanup, saved values, and an artifact directory.

Pi receives the evidence and decides what it means or whether another repair attempt is appropriate.

## Persistent data

```text
.pi/roblox.json                         project config
.pi/roblox/sourcemap.json               generated ownership index
.pi/roblox/checkpoints/<id>/             rollback data
.pi/roblox/audit/YYYY-MM-DD.jsonl        audit stream
.pi/roblox/scenarios/*.json[c]           checked-in scenarios
.pi/roblox/artifacts/<run-id>/            run evidence
```

Generated/internal paths are classified as protected so normal source tools do not recursively edit their own evidence.
