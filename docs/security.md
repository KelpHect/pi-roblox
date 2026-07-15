# Security and trust model

## Trusted components

`pi-roblox` runs with the same operating-system permissions as Pi. It does not provide a process sandbox. Use a Pi sandbox/permission extension or an OS/container boundary when stronger isolation is required.

The local trust path is:

```text
Pi process → pi-roblox → local Rojo/Studio child processes → Roblox Studio
```

The extension contains no model-provider SDK and no provider credentials.

## Default-denied AI tools

The default Studio deny list blocks:

- `subagent`
- `generate_mesh`
- `generate_material`
- `generate_procedural_model`
- `wait_job_finished`
- `upload_image`

This prevents an allowed Pi model from silently delegating intelligence or generation to Roblox-hosted AI. Users can modify the list, but doing so changes the trust boundary.

## Place guard

Before any non-read-only Studio tool, the runtime resolves allowed place IDs from:

- `expectedPlaceIds` in `.pi/roblox.json`.
- Rojo `servePlaceIds`.
- Rojo `placeId`.

It then calls `get_studio_state`. If the current place cannot be identified or does not match, the mutation is blocked.

Configure at least one expected place ID for serious projects.

## Filesystem protections

- All managed paths must remain under the current Pi workspace after canonicalization.
- Direct symbolic-link targets are rejected.
- Existing Rojo-owned source requires a SHA-256 precondition for package-owned full-file writes.
- Dependency, generated, binary, audit, checkpoint, artifact, and sourcemap paths are protected.
- Batch operations reject duplicate/overlapping targets.
- Writes use temporary files and atomic rename.
- Existing Unix permission bits are preserved.
- Checkpoint backups are created with restrictive modes where supported.

## Restore protections

A finalized checkpoint records the post-change hash/existence state. Normal restore only proceeds when the current workspace still matches that state. This prevents rollback from overwriting later user or collaborator work.

`force` deliberately disables that conflict check and must receive explicit approval.

## Studio protections

The raw gateway:

- Validates arguments against Studio's live JSON Schema.
- Rejects configured denied tools.
- Rejects extractable Rojo-owned or ambiguous targets for mutating calls.
- Applies the permission profile and always-ask list.
- Applies the place guard.
- Serializes calls.
- Audits argument summaries and result hashes/previews.

### Raw Luau limitation

Code passed to `execute_luau` is opaque text. Static target extraction cannot prove which instances it will touch. It is always-confirmed by default, but approval is a trust decision. Prefer `roblox_mutate`, which validates ownership before generating transaction code and captures inverse data.

## Audit redaction

Audit values are recursively copied and fields with secret-shaped names—such as token, password, API key, authorization, credential, cookie, and secret—are replaced. Long values are truncated.

Redaction reduces accidental leakage but is not a formal data-loss-prevention system. Do not put provider secrets into Roblox tool arguments or project files.

## Non-interactive operation

When `failClosedWithoutUi` is true, any operation that requires approval fails when Pi has no interactive UI. This is the default.

For CI, use `observe` for diagnostics or create a narrowly reviewed autonomous configuration. Do not broadly disable approval merely to make a pipeline green.

## Reporting vulnerabilities

Do not open a public issue for a vulnerability that could expose source, credentials, or Roblox projects. Follow the private reporting process in [SECURITY.md](../SECURITY.md).
