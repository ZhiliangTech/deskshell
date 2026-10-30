# MCP adapter

Any MCP client can drive the kernel without reading this repo: four tools over stdio JSON-RPC. No SDK, no dependencies — the "zero dependency kernel" claim holds at the edge too.

```bash
node packages/mcp/server.ts
```

## Tools

| Tool | Arguments | Returns |
| --- | --- | --- |
| `deskshell_skills` | — | installed skills with descriptions |
| `deskshell_preview` | `skill`, `root`, `args?` | capability request sheet, steps, summary — **read-only** |
| `deskshell_apply` | `skill`, `root`, `args?` | `taskId`, step results, rolled-back count |
| `deskshell_undo` | `root`, `taskId?` | rolled-back count; without `taskId` undoes the latest run under `root` |

## Wire it into a client

```json
{
  "mcpServers": {
    "deskshell": {
      "command": "node",
      "args": ["C:/path/to/deskshell/packages/mcp/server.ts"]
    }
  }
}
```

Then an agent can do this instead of guessing:

1. `deskshell_preview` — get the plan and the capability sheet before touching anything;
2. `deskshell_apply` — run it, keep the returned `taskId`;
3. `deskshell_undo` — hand the `taskId` back if the user says "put it back".

## Protocol test

`scripts/mcp-test.ts` spawns the server and talks to it the way a client would:

```
PASS  initialize 返回 serverInfo.name = deskshell
PASS  tools/list 给出四个 tool
PASS  preview 之后目录没变
PASS  apply 返回 taskId
PASS  undo 之后目录逐字节回到原状
PASS  未知技能返回 isError=true
14/14 passed
```

The point of that test is not to check our own code — it is to prove the wire format works for **someone else's** client.

## Limits

- Tools are listed with `inputSchema`, but there is no per-tool prompt template yet; clients must pass `skill` by name (use `deskshell_skills` to discover them).
- No auth, no sandbox negotiation: `root` is whatever the caller passes, and the capability policy is per-skill scope.
- Undo granularity is per task, not per step.
