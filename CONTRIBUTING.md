# Contributing

## Setup

```bash
npm install
npm run check
```

Node.js 22.19 or newer is required.

## Expectations

- Keep Pi as the sole owner of AI/model behavior.
- Preserve the source-ownership invariant.
- Fail closed when ownership, active place, or approval cannot be proven.
- Add tests for every mutation or policy change.
- Keep Studio compatibility dynamic; prefer schema inference to hard-coded parameter names.
- Do not add a network dependency without documenting its trust and privacy implications.
- Keep audit payloads bounded and secret-redacted.

## Test layers

- Unit tests for parsing, ownership, transactions, schemas, and diagnostics.
- Integration tests using the protocol-level fake MCP and managed Rojo fixtures.
- Manual release smoke test with current Roblox Studio and a disposable place.

## Pull-request checklist

- `npm run typecheck`
- `npm test`
- `npm run test:coverage`
- `npm run audit:prod`
- `npm run verify:package`
- Documentation/schema updated for public configuration changes.
- No generated `.pi`, `dist`, coverage, or project artifacts committed.
