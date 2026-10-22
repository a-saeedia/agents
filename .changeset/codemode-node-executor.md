---
"@cloudflare/codemode": minor
---

Add `NodeExecutor`, a Node.js implementation of the `Executor` interface, exported from `@cloudflare/codemode/node`. It runs generated code in a disposable child process so Code Mode can be used from CLIs, MCP servers and desktop agents, not just Workers.
