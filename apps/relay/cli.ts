/**
 * deskshell relay —— AI 的输入输出总线（CLI 入口）
 *
 * 用法:
 *   deskshell relay --from -  [--to out.md] [--prompt "…"] [--dry-run]
 *   deskshell relay --from a.md --to a.md     # 原地改写，可逐字节撤销
 *
 * 设计上只有一条规矩：**清单先于发送**。--dry-run 打印的就是将要离开本机的全部内容摘要。
 */
import fs from "node:fs";
import path from "node:path";
import { RelayError, runRelay, stubBackend } from "../../packages/relay/src/relay.ts";

interface Args {
  from?: string;
  to?: string;
  prompt: string;
  label?: string;
  json: boolean;
  dryRun: boolean;
}

function parse(argv: string[]): Args {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        flags[a.slice(2)] = next;
        i++;
      } else flags[a.slice(2)] = "true";
    }
  }
  return {
    from: flags.from,
    to: flags.to,
    prompt: flags.prompt && flags.prompt !== "true" ? flags.prompt : "",
    label: flags.label,
    json: flags.json === "true",
    dryRun: flags["dry-run"] === "true",
  };
}

function readStdin(): string {
  return fs.readFileSync(0, "utf8");
}

function human(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function fail(error: unknown): never {
  if (error instanceof RelayError) {
    console.error(`relay: ${error.code}${error.message === error.code ? "" : ` — ${error.message}`}`);
    process.exitCode = 2;
  } else {
    console.error(`relay: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
  process.exit(process.exitCode);
}

async function main(): Promise<void> {
  const args = parse(process.argv.slice(2));
  if (!args.from) {
    console.error("用法: deskshell relay --from <文件|-> [--to <文件>] [--prompt \"…\"] [--dry-run] [--json]");
    process.exitCode = 2;
    return;
  }

  const text = args.from === "-" ? readStdin() : fs.readFileSync(path.resolve(args.from), "utf8");
  const label = args.label ?? (args.from === "-" ? "(stdin)" : path.basename(args.from));

  const result = await runRelay({
    text,
    label,
    prompt: args.prompt,
    backend: stubBackend(),
    ...(args.to ? { outPath: path.resolve(args.to) } : {}),
    dryRun: args.dryRun,
  });

  if (args.json) {
    console.log(JSON.stringify({ manifest: result.manifest, written: result.written ?? null, output: result.output }, null, 2));
    return;
  }

  const m = result.manifest;
  console.log(`外发清单  ${m.backend} / ${m.vendor}${m.model ? ` / ${m.model}` : ""}`);
  console.log(`  材料      ${m.label} · ${human(m.inputBytes)} · sha256:${m.inputDigest.slice(0, 12)}`);
  if (args.prompt) console.log(`  指令      sha256:${m.promptDigest.slice(0, 12)}`);
  console.log(`  路径不上送（清单里没有任何绝对路径）`);

  if (args.dryRun) {
    console.log("dry-run：只生成了清单，没有发送、没有写文件。");
    return;
  }

  console.log(`结果 ${human(Buffer.byteLength(result.output, "utf8"))}`);
  if (result.written) {
    console.log(`已写回 ${result.written.path}`);
    if (result.written.taskId) console.log(`可撤回：deskshell undo --task ${result.written.taskId} --root ${path.dirname(result.written.path)}`);
    else console.log(`可撤回：deskshell undo --last --root ${path.dirname(result.written.path)}`);
  } else {
    console.log(result.output);
  }
}

main().catch(fail);
