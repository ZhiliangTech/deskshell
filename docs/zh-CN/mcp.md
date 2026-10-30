# MCP adapter

任何 MCP 客户端都能驱动这个内核，不用读这个仓库：stdio JSON-RPC 上的四个 tool。不引 SDK、不引依赖——"零依赖内核"这句话在接入层也成立。

```bash
node packages/mcp/server.ts
```

## 工具

| 工具 | 参数 | 返回 |
| --- | --- | --- |
| `deskshell_skills` | — | 已安装技能与描述 |
| `deskshell_preview` | `skill`、`root`、`args?` | 能力申请单、步骤、汇总——**只读** |
| `deskshell_apply` | `skill`、`root`、`args?` | `taskId`、每步结果、回滚数 |
| `deskshell_undo` | `root`、`taskId?` | 回滚数；不给 `taskId` 就撤销 `root` 下最近一单 |

## 接到客户端里

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

然后 agent 就不用猜了：

1. `deskshell_preview` —— 动手前先拿到计划和能力申请单；
2. `deskshell_apply` —— 执行，记下返回的 `taskId`；
3. `deskshell_undo` —— 用户说"放回去"时，把 `taskId` 还回去。

## 接到真实客户端里

服务说的是标准 MCP over stdio，所以配置形状到哪都一样，只是文件位置不同。

**Claude Desktop**

| 系统 | 文件 |
| --- | --- |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |

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

**Cursor** —— 同一个对象，放在项目根的 `.cursor/mcp.json` 或全局 `~/.cursor/mcp.json`。

**其它客户端** —— 这个服务只需要 stdin/stdout；能起子进程的客户端都能用。

### 30 秒验证

1. 重启客户端，让它重新读配置；
2. 问它：*"列出 deskshell 的技能"* → 它应该调 `deskshell_skills`，回来一串 `downloads-cleanup`、`dedupe-folders`…；
3. 问它：*"预览 downloads-cleanup 在 <某个目录>"* → `deskshell_preview` 返回能力申请单和步骤，**那个目录一个文件都没动**；
4. 说 *"执行"*，再说 *"撤回去"* → `deskshell_apply` 返回 `taskId`，`deskshell_undo` 拿它撤回。

如果第 2 步什么都没返回，多半是客户端找不到 `node`——`command` 里用绝对路径，再看客户端自己的 MCP 日志。

## 协议级测试

`scripts/mcp-test.ts` 会真的起一个服务进程，按客户端的方式一问一答：

```
PASS  initialize 返回 serverInfo.name = deskshell
PASS  tools/list 给出四个 tool
PASS  preview 之后目录没变
PASS  apply 返回 taskId
PASS  undo 之后目录逐字节回到原状
PASS  未知技能返回 isError=true
14/14 passed
```

这个测试的意义不是检查我们自己的代码，而是证明这套报文对**别人的**客户端是通的。

## 边界

- tool 带 `inputSchema`，但还没有 per-tool 的提示模板；`skill` 要按名字传（先用 `deskshell_skills` 发现）。
- 没有鉴权、没有沙箱协商：`root` 由调用方给，能力策略按每个 skill 的 scope 走。
- 撤销粒度是"一单任务"，不是单步。
