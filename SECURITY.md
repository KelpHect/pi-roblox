# Security policy

## Supported versions

Security fixes are applied to the latest released minor version. Until the project reaches 1.0, users should upgrade to the newest available release before reporting a problem as unresolved.

## Reporting a vulnerability

Report suspected vulnerabilities privately to the repository owner or organization security contact. Include:

- A concise impact statement.
- Affected version/commit.
- Reproduction steps or a minimal project.
- Whether the issue can expose source, credentials, local files, or mutate the wrong Roblox place.
- Any proposed mitigation.

Do not include live provider keys, private Roblox assets, or proprietary game source. Do not open a public issue until a coordinated disclosure date is agreed.

## Security-sensitive areas

Reports are especially valuable for:

- Workspace or symlink escapes.
- Place-guard bypass.
- Rojo/Studio ownership bypass.
- Unapproved Studio mutation.
- Checkpoint path traversal or rollback overwrite.
- Audit secret leakage.
- MCP tool-schema validation bypass.
- Unexpected network/model-provider calls originating from this package.

See [docs/security.md](docs/security.md) for the trust model and documented limitations.
