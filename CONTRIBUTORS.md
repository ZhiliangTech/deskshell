# Contributors

感谢每一个让 deskshell 变得可信的人。这张表按**贡献类型**分节，不排名次、不排贡献大小——一行的顺序只按加入时间。

想把自己加进来：改这个文件，开一个 PR，就这一件事。规则在最下面。

## 总览

| 贡献者 | 角色 | 贡献类型 |
| --- | --- | --- |
| [@ciceroyang](https://github.com/ciceroyang) | Author & maintainer | 💻 code · 📖 docs · ✅ tests · 🚇 infra · 🎨 brand |

---

## Maintainer

决定协议走向、发布、以及"这条不违反不变量"的人。

- [@ciceroyang](https://github.com/ciceroyang)

## Driver

实现了某个平台驱动，或对驱动做出被合并的实质改动（并且该平台 `scripts/verify-driver.ts` 能跑出 PASS）。

- [@ciceroyang](https://github.com/ciceroyang) — Windows UIA、macOS Swift AX 桥、Linux X11 窗口级（`xdotool` + `wmctrl`）

## Protocol

写过被接受的 RFC，或对 RFC 给出过改变结论的评审意见。

- [@ciceroyang](https://github.com/ciceroyang) — 协议 v0（`spec/protocol-v0.json`）

## Skill

写了被合并进 `packages/skills/` 的 skill，并且它在 `scripts/regress.ts` 里有自己的检查。

- [@ciceroyang](https://github.com/ciceroyang) — `downloads-cleanup`、`photo-sort`、`log-archive`、`rename-batch`、`dedupe-folders`、`screenshot-organize`、`sync-mirror`、`tile-windows`、`browser-tabs`

## Docs

文档、文档站、示例、翻译。

- [@ciceroyang](https://github.com/ciceroyang) — `docs/` 中英双语、`scripts/build-docs.ts`

## Testing & CI

回归套件、契约测试、快照、CI 工作流。

- [@ciceroyang](https://github.com/ciceroyang) — `scripts/regress.ts`、`scripts/contract-test.ts`、`scripts/snapshot-test.ts`、`.github/workflows/ci.yml`

## Design

品牌、插图、演示素材（`brand/`、`docs/assets/`）。

- [@ciceroyang](https://github.com/ciceroyang)

## Ideas & review

提出被采纳的设计意见、评审过别人的 PR、在 issue 里给出过改变结论的判断。

- 还没有外部条目——这一节通常是第一个变长的。

---

## 怎么把自己加进来

1. Fork，改这个文件，只加你自己那一行/那一条。
2. 类型按实际写，不要凑数：写了文档就只写 📖，不要顺手加 💻。
3. 名字用 GitHub handle 加链接；不想写真名就不写，handle 足够。
4. PR 标题写 `docs(contributors): add @<handle>`，正文贴一下你那个被合并的 PR 编号。

三种类型的写法：

```markdown
<!-- 总览表加一行 -->
| [@your-handle](https://github.com/your-handle) | Contributor | 💻 code · ✅ tests |

<!-- 对应分节加一条 -->
- [@your-handle](https://github.com/your-handle) — `packages/skills/your-skill`
```

维护者合并你的贡献 PR 之后，不会替你改这个文件——这一步是你的署名权，自己来。

## 说明

- 因 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) 被移除的人，历史提交与已合并代码保留，但不再出现在上面的活跃贡献者列表里。
- 贡献者名单同时用于发布说明署名。想让名字出现在某个版本的 release notes 里，在 PR 里说一声。
- 名单里出现的人不代表获得合并权——合并权见 [outreach/CONTRIBUTOR-LADDER.md](outreach/CONTRIBUTOR-LADDER.md)。
