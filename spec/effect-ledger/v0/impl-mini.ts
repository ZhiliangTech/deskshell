/**
 * Effect Ledger v0 —— 独立最小实现（不引用本仓库内核，只依赖 spec/effect-ledger/v0/README.md）
 *
 * 存在的意义：证明这套协议不是"只有我们的实现能跑"。
 * 它只做四件事：apply / revert / read / ledger；账本是 JSONL，坏行跳过且原样保留。
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type MiniAction =
  | { kind: "write"; path: string; content: string }
  | { kind: "delete"; path: string; undo?: "none" | "noop" | "restore" }
  | { kind: "move"; from: string; to: string; undo?: "none" | "noop" };

export interface MiniResult {
  status: "ok" | "restored" | "refused";
  reason?: string;
  id?: string;
}

const sha = (text: string): string => `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;

export function createMini(root: string) {
  fs.mkdirSync(root, { recursive: true });
  const ledgerPath = path.join(root, "effects.jsonl");
  const abs = (p: string): string => path.join(root, p);

  const readRaw = (): string[] =>
    fs.existsSync(ledgerPath) ? fs.readFileSync(ledgerPath, "utf8").split("\n") : [];

  const entries = (): Array<Record<string, any>> =>
    readRaw()
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, any>;
        } catch {
          return null;
        }
      })
      .filter((e): e is Record<string, any> => e !== null)
      .sort((a, b) => Number(a.seq) - Number(b.seq));

  const append = (entry: Record<string, any>): void => {
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    fs.appendFileSync(ledgerPath, `${JSON.stringify(entry)}\n`, "utf8");
  };

  const markRolledBack = (id: string): void => {
    const patched = readRaw().map((line) => {
      if (!line.trim()) return line;
      try {
        const row = JSON.parse(line) as Record<string, any>;
        return row.id === id ? JSON.stringify({ ...row, status: "rolled-back" }) : line;
      } catch {
        return line; // 坏行原样保留（不变量 5）
      }
    });
    const body = patched.join("\n").replace(/\n+$/, "");
    fs.writeFileSync(ledgerPath, body ? `${body}\n` : "", "utf8");
  };

  const read = (p: string): { exists: boolean; content?: string } => {
    const file = abs(p);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return { exists: false };
    return { exists: true, content: fs.readFileSync(file, "utf8") };
  };

  const nextSeq = (): number => entries().reduce((max, e) => Math.max(max, Number(e.seq)), 0) + 1;

  async function apply(action: MiniAction): Promise<MiniResult> {
    const seq = nextSeq();
    const id = `s${seq}`;
    const at = Date.now();
    const base = { v: 0, id, taskId: `t-${seq}`, seq, at };

    if (action.kind === "write") {
      const before = read(action.path);
      fs.mkdirSync(path.dirname(abs(action.path)), { recursive: true });
      fs.writeFileSync(abs(action.path), action.content, "utf8");
      append({
        ...base,
        kind: "fs.write",
        object: action.path,
        beforeHash: before.exists ? sha(before.content ?? "") : null,
        afterHash: sha(action.content),
        undo: { kind: "restore", content: before.exists ? before.content : null },
        status: "ok",
      });
      return { status: "ok", id };
    }

    if (action.kind === "delete") {
      if (action.undo === undefined || action.undo === "none") return { status: "refused", reason: "DELETE_WITHOUT_UNDO" };
      if (action.undo === "noop") return { status: "refused", reason: "DELETE_WITH_PLACEHOLDER_UNDO" };
      const before = read(action.path);
      if (!before.exists) return { status: "refused", reason: "UNSUPPORTED" };
      fs.rmSync(abs(action.path), { force: true });
      append({
        ...base,
        kind: "fs.delete",
        object: action.path,
        beforeHash: sha(before.content ?? ""),
        afterHash: null,
        undo: { kind: "restore", content: before.content ?? null },
        status: "ok",
      });
      return { status: "ok", id };
    }

    if (action.undo !== undefined && action.undo !== "restore" as never) {
      return { status: "refused", reason: action.undo === "noop" ? "DELETE_WITH_PLACEHOLDER_UNDO" : "DELETE_WITHOUT_UNDO" };
    }
    fs.mkdirSync(path.dirname(abs(action.to)), { recursive: true });
    fs.renameSync(abs(action.from), abs(action.to));
    append({
      ...base,
      kind: "fs.move",
      object: action.to,
      beforeHash: null,
      afterHash: null,
      undo: { kind: "move", from: action.to, to: action.from },
      status: "ok",
    });
    return { status: "ok", id };
  }

  async function revert(target: string): Promise<MiniResult> {
    const all = entries();
    if (all.length === 0) return { status: "refused", reason: "NOTHING_TO_REVERT" };
    const entry = target === "last" ? all[all.length - 1] : all.find((e) => e.id === target);
    if (!entry) return { status: "refused", reason: "NOTHING_TO_REVERT" };
    if (entry.status === "rolled-back") return { status: "refused", reason: "ALREADY_REVERTED" };

    const current = read(String(entry.object));
    const currentHash = current.exists ? sha(current.content ?? "") : null;
    if (currentHash !== (entry.afterHash ?? null)) return { status: "refused", reason: "CONFLICT" };

    const undo = entry.undo as Record<string, any> | null;
    if (!undo) return { status: "refused", reason: "UNSUPPORTED" };
    if (undo.kind === "restore") {
      if (undo.content === null) fs.rmSync(abs(String(entry.object)), { force: true });
      else {
        fs.mkdirSync(path.dirname(abs(String(entry.object))), { recursive: true });
        fs.writeFileSync(abs(String(entry.object)), String(undo.content), "utf8");
      }
    } else if (undo.kind === "move") {
      fs.renameSync(abs(String(undo.from)), abs(String(undo.to)));
    } else {
      return { status: "refused", reason: "UNSUPPORTED" };
    }

    markRolledBack(String(entry.id));
    return { status: "restored", id: String(entry.id) };
  }

  return { root, ledgerPath, apply, revert, read, ledger: async () => entries() };
}
