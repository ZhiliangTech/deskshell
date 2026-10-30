# HOURLY — 每小时账号运营（这一小时做什么）

> 这是一份**给任何新会话直接执行**的运行手册。开场只需要一句话：
> `读 deskshell/outreach/HOURLY.md，执行这一小时的账号运营。`
>
> 每小时只做一遍，做完就停，不续跑、不加班。目标是让"发出去的消息"和"回过来的人"始终有人接。

## 0. 先看状态（2 分钟）

先读 [STATE.md](STATE.md)（对外唯一口径：仓库地址、安装渠道、能说什么），再跑状态脚本：

```bash
node scripts/outreach-hour.ts            # 到期/逾期/今日配额/待回复，一次列清
node scripts/outreach-hour.ts --json     # 给脚本用
```

它读 `outreach/TRACKER.csv`，只做三件事：算今天该发谁、谁逾期没跟、今天还剩多少配额。**它不改任何文件，也不联网。**

## 1. 处理回复（优先级最高，10 分钟）

任何回信都先于"发新消息"。先看两个地方，再动嘴：

1. `outreach/INBOUND.md` —— 别人主动发来的（issue 评论、PR、私信），上一轮回了什么。
2. GitHub 通知 —— 用配好的 token 拉，别靠印象：

```bash
curl -s -H "Authorization: Bearer $GITHUB_TOKEN" \
  "https://api.github.com/notifications?all=false&per_page=50" \
  | head -c 2000
```

**回之前先翻该 issue 的最新评论。** 不靠 INBOUND.md 的记忆，靠接口返回的时间戳：已经有本账号回复的，就别再补一条。两个会话同时跑这一小时时，第二个只补"没人答过"的问题。

按这个顺序回：

| 对方的动作 | 你回什么 | 时长 |
| --- | --- | --- |
| 问"这是做什么的" | 一句话定位 + 一个 30 分钟动作（跑 `doctor`） | 3 分钟 |
| 问"我能帮什么" | 直接给 `GOOD-FIRST-ISSUES.md` 里最匹配的一个编号，附验收命令 | 5 分钟 |
| 挑毛病 | 先承认具体的那一点，再给证据（哪个文件哪一行），不辩解 | 10 分钟 |
| 说"没时间" | 回一句"理解"，把出口给他，然后从名单里划掉 | 1 分钟 |
| 要钱 / 要报酬 | 明确说没有现金（`bounty` = 可认领，不是奖金），不绕弯 | 2 分钟 |

回完立刻在 `TRACKER.csv` 里把 `reply` 改成 `yes/no/question`，`outcome` 改成 `replied`。

## 2. 发今天的配额（15 分钟，上限 3 条）

- 从 `SEND-QUEUE.md` 取**下一批没发过的**，不要跳着发、不要重发已标记的。
- 每条必须先写一句"只有看过他仓库才写得出来"的开场（≤25 字），写不出来就换下一个人。
- 一天最多 5 条、每小时最多 3 条、同一仓库最多 2 人。
- 发完在 `TRACKER.csv` 追加一行：`handle,segment,tier,repo,ask,channel,今天,5天后,12天后,,sent,`。
- **渠道没凭据就不发。** 环境里只有 GitHub token 时，X / 邮箱那条路就是发不出去的：在 `TRACKER.csv` 里保持 `planned`，worklog 记 `sent:0` 并写原因。不要为了凑数去陌生人仓库开推广 issue（见红线 1），也不要把"准备好了"写成"发过了"。
- **GitHub 上的触达只有一种形态：** 在他已有的相关 issue / discussion 里写一条不带链接的技术评论。没有合适的现成线程，就换下一个人。

## 3. 跟进（5 分钟，只在到期日做）

- 首次触达后 **5 天**发跟进 1（补一个新证据：CI 绿、新 skill 合并、Linux 窗口层落地）。
- **12 天**发跟进 2（最后一次，明说"这是最后一次，不合适回 no 就行"）。
- 两次都没回 = 从活跃名单移除，`outcome=dead`，不再发。

## 4. 维护公开面（10 分钟，可以隔一小时做一次）

环境里配了 GitHub token，能直接做这些（都不需要新凭据）：

```bash
# 有没有人回复/开 issue/发 discussion（只读，安全）
curl -s -H "Authorization: Bearer $GITHUB_TOKEN" \
  "https://api.github.com/notifications?all=false&participating=false" | head -c 2000
```

- 有新 issue / PR 评论：48 小时内必须有人回（哪怕只是"我看过了，周三给结论"）。
- 有新 discussion：优先回，公开场合的一句话比十封私信值钱。
- 回完在 `outreach/INBOUND.md` 记一行（谁、要什么、我们怎么回的），下一轮就不用重新读一遍 issue。
- 标签也是公开面：`bounty` 这种会被读成"有钱"的标签不要挂；写"可认领"就用 `help wanted`。
- 不要为了"有动静"去星标、去别人仓库刷评论、去 @ 人。

## 5. 收尾（3 分钟）

在本轮结束时输出三行，写进当次回复里：

```
本次：回了 N 条 / 发了 M 条 / 跟进 K 条
下一步：<下一个到期的人或事，带日期>
阻塞：<没有就写"无">
```

并把结果 append 到 `deskshell/.worklog/outreach.jsonl`（一行一个 JSON：`{"ts":"...","replied":N,"sent":M,"followups":K,"note":"..."}`）。

## 红线（每小时都要重新确认一次）

1. **不发群发、不买 star、不刷 issue。** 一个账号的信誉只有一次。
2. **没有现金。** 有人问就说没有，别含糊、别画饼。
3. **不替对方做决定。** 只给一个 30 分钟动作，不追问、不催第二次以上。
4. **不碰代码。** 这一小时只做运营；代码任务走正常 PR 流程，别在私信里承诺工期。
5. **数据只来自仓库。** 不编 star、不编用户数、不编"已有公司采用"。
