# The desktop shell (MVP)

The shell is the "one box, one sentence" front door. It adds no new capability — it drives the same kernel the CLI drives, and shows you the receipts before anything happens.

## Start it

```powershell
# from the repo root; needs a desktop session (Windows)
$env:DESKSHELL_NODE = "C:\path\to\node.exe"   # optional, defaults to `node` on PATH
powershell -ExecutionPolicy Bypass -File apps/shell/ui.ps1 -Root "C:\Users\me\Downloads"
```

Press **Ctrl+Alt+Space** anywhere to summon it.

## What a sentence does

1. You type something like `清理下载文件夹`.
2. The shell matches it against installed skills **locally** — no model, no network. Ties and near-misses are shown as a list, and a sentence that matches nothing says so instead of guessing:

   ```
   没有匹配的技能。
   当前可用：dedupe-folders、downloads-cleanup、first-skill、…
   ```

3. The panel shows the **capability request sheet**, the step list, and the summary — all from `kernel.preview`, which is read-only.
4. **执行** calls `kernel.apply`. **取消** calls `cancel()` and nothing else.

## One sentence → a plan with arguments

Matching a skill is the easy half; the sentence also carries parameters. Each `skill.json` can declare an `intents` block:

```json
"intents": {
  "triggers": ["日志", "归档日志", "旧日志"],
  "args": { "maxAgeDays": { "type": "days", "hint": "多少天之前的日志算旧日志？" } }
}
```

`apps/shell/intent.ts` fills those slots offline — extensions (`jpg`, `图片`), day counts (`30 天`, `一周`), paths (quoted, `下载文件夹`, or `从 src 到 backup`), prefixes (`前缀 trip`). It returns `confidence`, the `missing` slots, and a `question`, so the panel asks instead of guessing:

```
批量重命名          → rename-batch, missing ["prefix"], conf 0.5
给我订一张机票       → null（不猜）
```

Parameters are not decoration: `把 30 天前的日志归档` and `把 90 天前的日志归档` produce different plans, and the test checks that the step counts differ **and** that the apply step actually leaves the 2-day-old log alone.

Swapping in a model later means implementing one interface:

```ts
interface ModelBackend { name: string; resolve(query: string, skills: ShellSkill[]): Promise<IntentResult | null>; }
```

`RuleBackend` is the default; `FixtureBackend` is the same contract backed by fixed Q&A, which is how the tests prove the seam works.

## Cancel is provably free

That claim is a test, not a promise (`scripts/shell-test.ts`):

```
PASS  取消返回明确信号
PASS  取消后文件系统零变化
PASS  取消后没有产生日志
PASS  预览不写日志
```

And the UI self-test (`scripts/shell-ui-selftest.ts`) drives the real window, registers the real hotkey, runs a preview, cancels, and then checks the fixture directory still contains exactly its two original files with no `.deskshell` journal.

## What is deliberately not here yet

- **No model.** Matching is keyword scoring over skill names and descriptions. Saying "把上周的截图按项目分一下" will not become a plan — that is M08.
- **No background daemon.** The panel runs as a normal process; hotkey registration dies with it.
- **Windows only.** `ui.ps1` is WinForms. The core (`apps/shell/core.ts`) is platform-neutral and already tested; a GTK/Qt shell can reuse it as-is.

## Talk to the same logic without the UI

```bash
node apps/shell/cli.ts skills
node apps/shell/cli.ts match "清理下载"
node apps/shell/cli.ts preview downloads-cleanup --root .
node apps/shell/cli.ts apply downloads-cleanup --root .
node apps/shell/cli.ts cancel
```

Every command prints one JSON line, which is what the PowerShell UI parses.
