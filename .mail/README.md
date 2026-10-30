# 把导出的邮件放这里

支持两种：
- 单封：邮箱里「更多 → 下载邮件 / 另存为 .eml」
- 整个文件夹：Thunderbird 导出 .mbox，或 Gmail 用 Google Takeout 选 Mail

放进来后在仓库根目录跑：

```bash
node scripts/mail-triage.ts            # 默认扫 .mail/
node scripts/mail-triage.ts D:/mails   # 也可以指定目录
```

它会输出：发件人、主题、时间、正文前 160 字，并标出 `BOUNCE`（退信）和 `NOREPLY`（自动回复）。
不会联网、不会发信、不会改动任何邮件。

这个目录已在 .gitignore 里，不会被提交。
