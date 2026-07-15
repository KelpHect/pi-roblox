# Troubleshooting

## `/roblox doctor` reports Studio disconnected

- Confirm Studio is open on the target place.
- Enable **Studio as MCP server** from Assistant's MCP management UI.
- Run `/roblox connect` again.
- On a nonstandard Studio installation, set `studio.command` and `studio.args` explicitly.
- Inspect the Studio MCP stderr tail in `roblox_status`/doctor details.

## Rojo server is running but sync is unverified

A TCP-ready Rojo server does not prove that the Studio plugin is connected to it.

- Confirm the Rojo plugin is connected to the address/port from the selected project file or `.pi/roblox.json`.
- Run `/roblox rojo refresh` and inspect the target again.
- Confirm the open place is allowed by `expectedPlaceIds` and the project has the intended `servePlaceIds`.
- Check that the Studio source path exactly matches the current sourcemap.

## Ownership is `ambiguous-rojo-scope`

The target is below a Rojo-owned ancestor but has no exact sourcemap entry. Do not guess the source of truth.

- Regenerate the sourcemap.
- Inspect the Rojo project mapping.
- Add the instance to Rojo, or add a more-specific path to `ownership.studioOwnedRoots` when it is intentionally Studio-owned.

## Stale mutation rejected

The file changed after Pi inspected it. Re-run `roblox_inspect`, review the new content, recompute the desired change, and use the new hash. Do not disable hash protection to make the error disappear.

## Rollback conflict

The current file no longer matches the transaction's recorded post-state. Review the new changes. Use a normal source-control merge or call force rollback only when replacing those newer changes is intentional.

## Missing Studio tool

Studio MCP capabilities may differ by Studio release. `roblox_doctor` lists required tools that are absent. Update Studio or adjust `studio.requiredTools` only when the feature truly is not needed; do not map an unrelated tool by name.

## Scenario fails because of an old console error

The runner compares against a baseline, but Studio output formats or repeated messages can vary. Add an explicit console-cleanup/setup step when supported, close stale play sessions, and capture a new baseline. The report contains the exact diagnostics classified as new.

## Non-interactive invocation refuses a mutation

This is expected for the `develop` profile with `failClosedWithoutUi: true`. Use interactive Pi, remain in `observe`, or explicitly choose `autonomous-local` after configuring `expectedPlaceIds` and reviewing high-risk tools.
