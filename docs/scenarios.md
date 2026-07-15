# Playtest scenarios

Scenarios are deterministic Studio workflows stored as JSON or JSONC. They do not contain model logic.

## Top-level format

```json
{
  "$schema": "../../node_modules/@kellhect/pi-roblox/schemas/scenario.schema.json",
  "version": 1,
  "name": "Purchase item",
  "description": "Verifies that a player can purchase a sword.",
  "timeoutMs": 60000,
  "failOnConsoleErrors": true,
  "failOnConsoleWarnings": false,
  "alwaysStopPlay": true,
  "setup": [],
  "steps": [],
  "teardown": []
}
```

`steps` is required. Setup and teardown are optional. A failed normal step stops the main flow unless `continueOnFailure` is true. Teardown is attempted even after failure.

## Expectations

A tool, Luau, console, or assert step may select a nested value with `jsonPath` and apply one or more predicates:

```json
{
  "jsonPath": "$.inventory.items[0].name",
  "equals": "Sword",
  "not": false
}
```

Supported predicates:

- `equals`: deep equality.
- `truthy`: expected boolean truthiness.
- `contains`: substring/serialized-container membership.
- `matches`: JavaScript regular expression text.
- `not`: negate the combined result.

## Step types

### Play

```json
{ "kind": "play", "action": "start", "mode": "play" }
{ "kind": "play", "action": "stop" }
```

`mode` may be `play` or `run`.

### Luau

```json
{
  "kind": "luau",
  "dataModelType": "Server",
  "code": "return game:GetService('Players').NumPlayers >= 1",
  "expect": { "truthy": true },
  "saveAs": "player-ready"
}
```

`dataModelType` may be `Edit`, `Client`, or `Server`.

### Raw allowed Studio tool

```json
{
  "kind": "tool",
  "tool": "user_keyboard_input",
  "arguments": { "key": "E", "action": "press" }
}
```

Arguments must match the live tool schema in the installed Studio version. Denied tools remain denied. Always-ask tools still go through approval policy.

### Wait

```json
{ "kind": "wait", "milliseconds": 500 }
```

### Capture

```json
{ "kind": "capture", "name": "after-purchase" }
```

Images returned by Studio are decoded into the run artifact directory.

### Console

```json
{
  "kind": "console",
  "dataModelType": "Server",
  "expect": { "contains": "Purchase complete" },
  "name": "purchase-console"
}
```

The runner also captures baseline/final console diagnostics and can fail on newly introduced warnings/errors independently of explicit console steps.

### Character navigation

```json
{
  "kind": "navigate",
  "target": "game.Workspace.Shop.Counter",
  "arguments": {}
}
```

The package adapts the target argument name to the live Studio schema.

### Assert a literal or saved value

```json
{
  "kind": "assert",
  "from": "player-ready",
  "expect": { "truthy": true }
}
```

Or:

```json
{
  "kind": "assert",
  "value": { "answer": 42 },
  "expect": { "jsonPath": "$.answer", "equals": 42 }
}
```

## Artifacts and result

Each run returns:

- Overall verdict and duration.
- Every step's phase, index, status, summary, value, error, and artifacts.
- New console diagnostics, with Rojo source remapping where available.
- Saved values.
- Artifact run ID/directory.
- A JSON report artifact.

Pi—not the scenario runner—decides whether to attempt a repair.
