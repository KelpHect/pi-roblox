# Pi-facing API

## Tools

The public tools are registered in `extensions/roblox/index.ts`. Tool input schemas are TypeBox definitions and are visible to Pi at runtime.

- `roblox_status({ refresh? })`
- `roblox_doctor({ connectStudio? })`
- `roblox_search({ query, limit?, source?, regex?, caseSensitive?, studio? })`
- `roblox_inspect({ target })`
- `roblox_studio({ action, tool?, arguments?, studioId?, refresh? })`
- `roblox_files({ operations, dryRun?, validate?, validationProfile?, label? })`
- `roblox_apply({ target, content, expectedSha256?, validate? })`
- `roblox_mutate({ operations, dryRun?, label? })`
- `roblox_test({ validationProfile?, scenario? })`
- `roblox_scenario({ action, scenario? })`
- `roblox_checkpoint({ action, id?, paths?, label?, force?, limit? })`
- `roblox_rojo({ action })`

## Events

```text
pi-roblox/v1:connected
pi-roblox/v1:studio-selected
pi-roblox/v1:before-mutation
pi-roblox/v1:after-mutation
pi-roblox/v1:test-result
pi-roblox/v1:rollback
```

## Session entries

The extension appends compact entries for checkpoints and test results:

```text
pi-roblox-checkpoint
pi-roblox-test-result
```

These entries intentionally contain identifiers and summaries rather than complete source or artifact contents.

## Runtime use outside Pi

The internal `RobloxRuntime` can be instantiated for tests or a local companion process:

```ts
import { nodeCommandRunner } from "@kellhect/pi-roblox/src/command-runner.js";
import { RobloxRuntime } from "@kellhect/pi-roblox/src/runtime.js";

const runtime = new RobloxRuntime(process.cwd(), ".pi", nodeCommandRunner);
try {
  await runtime.initialize();
  console.log(await runtime.doctor({ connectStudio: true }));
} finally {
  await runtime.close();
}
```

The package does not currently declare subpath exports; this direct-source import is intended for repository development. A stable library API should be added only after its compatibility policy is defined.
