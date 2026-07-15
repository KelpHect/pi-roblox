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
- Final tarball: `dist/kellhect-pi-roblox-0.3.0-beta.1.tgz`, 95,881 bytes.
- Final tarball SHA-256: `22EE76264DAF0BF48657B9FE5D756FDDD4BFE8E82574A8AD56A1A938C8021BC5`.
- The registered Pi surface is execution-tested through the real runtime: all 12 tool wrappers, representative `/roblox` command branches, all 5 lifecycle handlers, event emission, audit/session entries, scenario execution, source replacement, and manual checkpoint rollback.

CI is configured to repeat typecheck, tests, coverage, production audit, package verification, and the packed-install smoke test on Windows. The repository is `https://github.com/KelpHect/pi-roblox`; the first workflow run is recorded with the release commit.

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

### macOS — non-release compatibility path

The source retains an unverified macOS Studio-MCP discovery path, but macOS is not a supported release platform and is not a release gate.

## Publication — blocked externally

- `package.json` is correctly named `@kellhect/pi-roblox`, versioned `0.3.0-beta.1`, and configured with `publishConfig.access: public`.
- Both the normal `npm whoami` and an isolated-config check are unauthorized (`401`/`ENEEDAUTH`); this machine is not authenticated to npm.
- The public registry currently returns `404` for `@kellhect/pi-roblox`, so no published version or dist-tag exists yet.
- No publication or dist-tag mutation has been attempted.
- Publish the first candidate with the `beta` tag after npm authentication and a passing Windows CI run. Do not assign `latest` until the Windows registry smoke passes.
