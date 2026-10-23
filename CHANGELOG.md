# Changelog

All notable changes are documented here.

## 0.3.0-beta.3 - 2026-10-23

### Changed

- Development dependency `@earendil-works/pi-coding-agent` moves from 0.80.7 to 1.3.0 and `typebox` to 1.3.27, the version pi 1.3.0 depends on. No source changes were needed.
- `smoke:pack` copies the host `node_modules` tree into the packed-install fixture, so Pi 1.x runtime dependencies such as `chalk` resolve.
- CI uses `actions/checkout@v7` and `actions/setup-node@v7`.

### Security

- Lockfile refreshed within existing ranges to clear `npm audit --omit=dev`: `@modelcontextprotocol/sdk` 1.32.1, `@hono/node-server` 2.1.5, `hono` 4.13.13, `fast-uri` 3.1.8 and `ip-address` 10.7.4.

## 0.3.0-beta.1 - 2026-07-15

### Added

- Managed Rojo server lifecycle, project discovery, readiness diagnostics, and atomic sourcemap refresh.
- Full ownership resolver with ambiguous ancestor handling, Studio-owned roots, protected internals, binary/dependency/generated classification, and symlink rejection.
- Transactional multi-file write/delete/move operations with stale hashes, atomic writes, permission-mode preservation, sync proof, validation, and rollback.
- Structured reversible Studio transactions and checkpointed inverse snapshots.
- Place-ID mutation guards and multi-Studio selection support.
- Live MCP schema validation and argument adaptation.
- Deterministic validation profiles and playtest scenarios.
- Console diagnostics, source remapping, screenshots/artifacts, audit JSONL, and secret redaction.
- Comprehensive doctor/status/search/inspect/checkpoint/Rojo tools and commands.
- Guarding and post-verification for Pi built-in file edits.
- Protocol-level end-to-end integration test and package/schema documentation.
- Execution-level coverage for the registered Pi tools, `/roblox` command paths, lifecycle hooks, events, scenarios, and rollback flow.
- Reproducible Windows live-acceptance and managed-Rojo lifecycle runners with structured evidence reports.
- Packed-install verification through Pi's own isolated package install/list/resource-loading path, followed by exact extension-surface assertions.

### Changed

- `/roblox init` now discovers a Rojo project or deliberately configures Studio-only mode.
- Source search now works in Studio-only projects while excluding dependencies and package artifacts.
- Strict Pi-only policy remains the default and filters Roblox-hosted AI tools.
- User-created checkpoints are finalized as completed snapshots so they can be restored safely; transaction checkpoints retain their before/after finalization lifecycle.
- Studio argument adaptation now covers the current `target_file`, `is_start`, and `capture_id` schemas while retaining compatibility with older discovered schemas.
- Number-prefixed `script_read` responses are normalized before Rojo synchronization checks.
- Place guards resolve identity from active Edit, Server, or Client DataModels, so guarded playtest operations and teardown remain safe after Play starts.

### Security

- Existing mapped full-file writes require SHA-256 preconditions.
- Restore fails on divergent post-checkpoint work unless forced.
- Observe mode blocks rollback as well as forward mutations.
- Audit records redact source/code strings without hiding numeric command exit codes.

### Live verification

- Windows 11 acceptance passed against Roblox Studio `0.729.597.7291029`, its 27-tool built-in MCP surface, Rojo CLI/plugin `7.6.1`, and a disposable private place.
- Live evidence covers Rojo synchronization, stale-hash rejection, filesystem and Studio rollback, play control, viewport capture, console source remapping, wrong-place rejection, hosted-subagent denial, audit redaction, external-server detection, and managed Rojo shutdown.
- Windows is the supported and release-verified platform; the retained macOS discovery path is unverified and non-release.

## 0.1.0

- Initial vertical-slice Pi package with Studio MCP connection, Rojo mappings, ownership inspection, single-file replacement, validation, and basic checkpoints.
