# Publish readiness audit

Audit date: 2026-07-15  
Candidate: `@kellhect/pi-roblox@0.3.0-beta.1`

## Decision

The implementation is now a coherent, production-oriented Pi capability package and is locally beta-ready on Windows, the only supported release platform. The remaining release conditions are a passing Windows CI run and npm authentication. An unverified macOS Studio-MCP discovery path remains in the source but is not a release claim. Do not assign `latest` until the Windows registry smoke passes.

## Stack and contract

| Layer | Implementation | Audit result |
|---|---|---|
| Runtime | Node.js ESM, TypeScript, minimum Node `22.19.0` | Correctly declared and typechecked |
| Pi package | `pi` manifest for extension, skills, and prompts; `pi-package` keyword | Matches Pi package discovery |
| Pi extension | TypeScript extension with tools, `/roblox`, lifecycle interception, UI approvals, events, and session/audit context | 12 tools, 1 command surface, and 5 hooks execution-tested |
| MCP client | Official `@modelcontextprotocol/sdk`, stdio transport, runtime tool discovery, JSON Schema validation | Matches Roblox's built-in stdio server; current 27-tool surface tested |
| Validation | Ajv + formats, JSONC parsing, deterministic command runner | Fail-closed schemas and bounded output |
| Roblox source | Rojo CLI/plugin, project metadata, atomic sourcemap, exact ownership routing | Live synchronization and rollback proven |
| Distribution | Public npm user scope `@kellhect`, beta semver, packed-install Pi loader smoke | Correct metadata; authentication still required |

## Official-document alignment

- Pi packages may bundle extensions, skills, and prompts through the `pi` manifest, use `npm:` install specs, keep runtime libraries in `dependencies`, and list Pi-provided libraries as `peerDependencies: "*"`: <https://pi.dev/docs/latest/packages>.
- Pi extensions are TypeScript modules that register tools and commands and subscribe to lifecycle events; distributed runtime dependencies are unavailable from `devDependencies`: <https://pi.dev/docs/latest/extensions>.
- Roblox Studio's MCP server is built in, communicates over stdio, supports Windows and macOS launch commands, exposes dynamic tools for scripts/DataModel/playtests/screenshots/input/assets/multiple Studios, and warns clients that connections may modify open places: <https://create.roblox.com/docs/studio/mcp>.
- The MCP TypeScript SDK is an official Tier 1 SDK and supports stdio, capability negotiation, tools, and JSON Schema: <https://modelcontextprotocol.io/docs/sdk> and <https://ts.sdk.modelcontextprotocol.io/>.
- Rojo's project format defines `serveAddress`, `servePort`, `servePlaceIds`, `placeId`, `$path`, and the ownership tree; `servePlaceIds` is specifically a wrong-game safeguard: <https://rojo.space/docs/v7/project-format/>.
- Rojo `7.6.1` is the current stable release used for the live run: <https://github.com/rojo-rbx/rojo/releases/tag/v7.6.1>.
- A user-scoped package must be published publicly with `--access public`; a prerelease should use `--tag beta` so it does not become `latest`: <https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/> and <https://docs.npmjs.com/adding-dist-tags-to-packages/>.

## Implementation coverage

The package owns deterministic Roblox capability and delegates intelligence to the active Pi session. No model/provider selection, LLM call, hidden loop, or autonomous repair exists in the package.

Implemented and wired:

- Windows Studio MCP discovery, shared stdio lifecycle, dynamic tool enumeration, live schema validation, multiple-Studio selection, timeouts, and reconnect-safe close. An unverified macOS discovery path remains available outside the supported release contract.
- Strict default denial of Roblox-hosted `subagent` and generative tools, plus an always-confirm raw Luau escape hatch.
- Rojo discovery, external-server recognition, extension-owned startup/readiness/shutdown, atomic sourcemaps, non-script mappings, and live readback proof.
- Exact Studio/filesystem ownership, ambiguity and path-escape rejection, place guards, binary/generated/dependency/symlink protection.
- Bounded source/Studio search, mapped inspection, SHA-256 preconditions, atomic write/delete/move batches, checkpoints, conflict-aware rollback, and validation profiles.
- Reversible structured Studio transactions, scenario setup/steps/teardown, Play/Run control, Luau, input/navigation, screenshots, console capture, saved values, assertions, artifacts, and source remapping.
- Recursive audit redaction, Pi UI approval profiles, built-in `edit`/`write` guarding, commands, status context, extension events, skills, prompts, and package documentation.

## Issues found by real Studio and fixed

1. Current `script_read` requires `target_file`; argument inference previously knew only older path names.
2. Current script reads prefix lines with `N→`; literal comparison made successful Rojo synchronization appear unverified.
3. Current play control requires Boolean `is_start`, not the older string action enum.
4. Place identity disappeared from the Edit DataModel after Play began, blocking guarded server steps and stop; the guard now checks active Edit/Server/Client contexts.
5. Current `screen_capture` requires `capture_id`; scenario captures previously sent `{}`.
6. Audit records needed explicit source/code payload redaction without over-redacting numeric validation exit codes.
7. User-created checkpoints needed finalization before they could be safely restored.

Every compatibility fix has a regression test and passed the real Windows acceptance runner.

## Remaining release work

1. Let the configured Windows GitHub Actions workflow pass for the release commit.
2. Authenticate the `kellhect` npm account with publishing 2FA or an appropriate granular token.
3. Re-run `npm pack`, inspect the final tarball, and publish exactly that tarball with `npm publish <tarball> --access public --tag beta`.
4. Install from the registry with `pi install npm:@kellhect/pi-roblox@beta` and repeat a minimal Pi load/doctor smoke.
5. Promote with `npm dist-tag add @kellhect/pi-roblox@<version> latest` only after the Windows registry smoke passes.

The current evidence is summarized in `VERIFICATION.md`; the structured Windows reports are under `verification/live/windows/`.
