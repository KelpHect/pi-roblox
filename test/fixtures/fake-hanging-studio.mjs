#!/usr/bin/env node
// Deliberately never speaks MCP. Used to prove connection attempts are bounded.
setInterval(() => undefined, 60_000);
