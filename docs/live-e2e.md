# Live Roblox Studio acceptance test

The automated suite validates the protocol and runtime against fake Rojo and MCP subprocesses. Run this checklist on each supported operating system before release because only Roblox Studio can validate platform packaging, Studio permissions, viewport behavior, and the installed MCP tool surface.

## Fixture project

Use a disposable place and a clean Git worktree. Add a Rojo-mapped module such as:

```text
src/shared/LiveSmoke.luau
```

Configure:

```json
{
  "version": 1,
  "mode": "rojo",
  "projectFile": "default.project.json",
  "expectedPlaceIds": [THE_DISPOSABLE_PLACE_ID],
  "permissions": {
    "profile": "develop",
    "failClosedWithoutUi": true
  }
}
```

## Checklist

1. Open the disposable place and enable Studio MCP.
2. Run `pi -e /path/to/pi-roblox` from the fixture workspace.
3. Run `/roblox init` if needed, then `/roblox doctor`.
4. Confirm Studio, Rojo CLI, server, sourcemap, place guard, and required tools pass.
5. Run `roblox_inspect` on the mapped module and record its hash.
6. Use `roblox_files` to change it with that hash.
7. Confirm the result reports `sync: verified` and Studio displays the new source.
8. Retry with the old hash and confirm the transaction is rejected before mutation.
9. Roll back the successful checkpoint and confirm both disk and Studio return to the original source.
10. Dry-run then apply a `roblox_mutate` create/set/delete sequence under a configured Studio-owned root.
11. Roll back the Studio checkpoint and confirm the original DataModel state is restored.
12. Run the generated smoke scenario; verify play starts, the assertion passes, an image artifact is written, output is captured, and play stops.
13. Introduce a controlled Luau runtime error in a mapped script; verify the report maps the Studio stack path to the filesystem path and line.
14. Open a different place and confirm a Studio mutation is rejected by `expectedPlaceIds`.
15. Confirm `subagent` and other denied AI tools cannot be called.
16. Exit Pi and verify an extension-owned Rojo process stops when `shutdownOnExit` is true.
17. Review `.pi/roblox/audit/` and verify no source/code payload or secret-shaped value was written verbatim.

Record Studio version, OS, Rojo version, plugin version, tool list, and pass/fail evidence in the release notes.

## Reproducible runner

After preparing the disposable fixture and connecting the Rojo Studio plugin, run:

```bash
npm run live:acceptance -- \
  --cwd /absolute/path/to/fixture \
  --output /absolute/path/to/live-report.json \
  --studio-version STUDIO_VERSION
```

The runner restores every successful mutation checkpoint even on failure and writes a report containing the environment, each check, and artifact paths. Run it from a clean evidence directory so previous audit or scenario records cannot satisfy the current run.

To prove extension-owned Rojo startup and shutdown, first stop the deliberately external server and confirm the configured port is free, then run:

```bash
npm run live:rojo-lifecycle -- \
  --cwd /absolute/path/to/fixture \
  --output /absolute/path/to/rojo-lifecycle.json \
  --port 34872
```

This second report requires `ownedByExtension: true`, a reachable port while the runtime is active, and a closed port after `runtime.close()`.
