# Verification status

Release candidate: **@kellhect/pi-roblox 0.3.0-beta.1**.

## Automated gates — Windows, 2026-07-15

- `npm ci`: pass using the public npm registry lockfile; 0 vulnerabilities reported.
- `npm run typecheck`: pass.
- `npm test`: 53 pass, 0 fail, 5 Windows platform-permission skips.
- `npm run test:coverage`: pass; 87.11% lines, 65.86% branches, 82.24% functions.
- `npm run audit:prod`: pass; 0 production vulnerabilities.
- `npm run verify:package`: pass.
- `npm run smoke:pack`: pass; a clean temporary project installed the tarball, Pi installed/listed it and completed offline package-resource startup, and the extension exposed all 12 tools, `/roblox`, and all 5 lifecycle hooks.
- Final tarball: `dist/kellhect-pi-roblox-0.3.0-beta.1.tgz`, 95,820 bytes.
- Final tarball SHA-256: `23203B3BF7DEDFEAA6249241111769B5AC8D15771589DAD9281E7E03B79EE215`.
- The registered Pi surface is execution-tested through the real runtime: all 12 tool wrappers, representative `/roblox` command branches, all 5 lifecycle handlers, event emission, audit/session entries, scenario execution, source replacement, and manual checkpoint rollback.

CI is configured to repeat typecheck, tests, coverage, production audit, package verification, and the packed-install smoke test on Ubuntu, Windows, and macOS. This workspace has no `.git` metadata or remote, and `gh repo view kellhect/pi-roblox` found no repository, so the workflow is configured but has not been executed remotely from this checkout. GitHub CLI is authenticated separately as `KelpHect`.

## Live release gates

### Windows — pass

- Windows 11 Pro `10.0.26200`, Node `v24.18.0`.
- Roblox Studio `0.729.597.7291029` with Studio MCP enabled.
- Disposable private place ID `118023848497907`, universe ID `10371824046`, place version `8`.
- Rojo CLI and Studio plugin `7.6.1`.
- All 22 live acceptance checks passed against the 27 dynamically discovered Studio MCP tools.
- The run proved mapped-source inspection, exact hash preconditions, live Rojo readback, stale-write denial, filesystem rollback, structured Studio create/set/delete and rollback, Play/Stop, server Luau, viewport capture, console capture and source remapping, wrong-place denial, hosted-subagent denial, and audit redaction.
- An initially external Rojo server was detected as external. A separate managed lifecycle run proved `ownedByExtension: true` and verified port `34872` closed after runtime shutdown.

Evidence: [Windows live report](verification/live/windows/windows-live-report.json), [Rojo lifecycle report](verification/live/windows/windows-rojo-lifecycle.json), and [Windows evidence notes](verification/live/windows/README.md).

### macOS — pending

No macOS host with Roblox Studio is available in this workspace. The platform discovery path and macOS CI lane are implemented, but the required real Studio/Rojo/plugin acceptance run has not been performed.

## Publication — blocked externally

- `package.json` is correctly named `@kellhect/pi-roblox`, versioned `0.3.0-beta.1`, and configured with `publishConfig.access: public`.
- Both the normal `npm whoami` and an isolated-config check are unauthorized (`401`/`ENEEDAUTH`); this machine is not authenticated to npm.
- The public registry currently returns `404` for `@kellhect/pi-roblox`, so no published version or dist-tag exists yet.
- No publication or dist-tag mutation has been attempted.
- Publish the first candidate with the `beta` tag only after npm authentication and the chosen release policy permits the remaining macOS gap. Do not assign `latest` until both supported live Studio rows pass.
