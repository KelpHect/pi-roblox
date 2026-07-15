# Windows live acceptance evidence

Status: **pass** on 2026-07-15.

## Environment

- Windows 11 Pro `10.0.26200` x64
- Node `v24.18.0`
- Roblox Studio `0.729.597.7291029`
- Rojo CLI and Studio plugin `7.6.1`
- Private disposable place `118023848497907`; universe `10371824046`; observed place version `8`
- 27 dynamically discovered Studio MCP tools

## Results

The [main report](windows-live-report.json) records 22/22 passing checks. It includes the exact tool list and evidence for doctor/status, place identity, deterministic validation, mapped inspection, live source synchronization, stale-hash rejection, filesystem rollback, structured Studio transactions and rollback, playtest teardown, controlled error remapping, wrong-place rejection, strict hosted-subagent denial, and audit redaction.

The wrong-place check retained the real live place and temporarily changed only the runtime's expected ID to `1`; the attempted live Studio mutation failed with `Studio place 118023848497907 is not allowed; expected one of 1.` No mutation was sent.

The smoke scenario produced a decoded [viewport capture](fixture/.pi/roblox/artifacts/2026-07-15T06-42-33-078Z-scenario-Windows-live-smoke-0012f386/windows-live-viewport-1.jpg), captured `PI_ROBLOX_LIVE_READY`, and stopped Play successfully. The controlled-error scenario mapped `game.ServerScriptService.PiRobloxLiveError:1` to `src/server/LiveError.server.luau:1` before its checkpoint was restored.

The [Rojo lifecycle report](windows-rojo-lifecycle.json) separately proves extension-owned startup (`ownedByExtension: true`, recorded PID `32208`) and clean shutdown (`portOpenAfterClose: false`). The main report records the preceding server as external, demonstrating both lifecycle branches.

All successful mutation checkpoints were restored. The fixture source ended byte-for-byte at its original content, temporary Studio-owned instances were removed, Play was stopped, and port `34872` was closed.
