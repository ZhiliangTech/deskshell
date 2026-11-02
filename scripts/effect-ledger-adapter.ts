/**
 * Effect Ledger v0 —— 内核上的适配实现。
 *
 * 它证明的是另一件事：这套协议**可以加在已有的 agent 运行时之上**，不必重写执行层。
 * 执行与撤销仍走 packages/core（runActions / undoTask），协议记录写在旁路账本里。
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { runActions, undoTask } from "../packages/core/src/kernel.ts";
import type { Action } from "../packages/core/src/types.ts";

export interface KernelAction {
  kind: "write" | "delete" | "move";
  path?: string;
  content?: string;
  from?: string;
  to?: string;
  undo?: "none" | "noop" | "restore";
}

const sha = (text: string): string => `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;

export function createKernelImpl(root: string) {
  fs.mkdirSync(root, { recursive: true });
  const journalPath = path.join(root, ".deskshell", "journal.jsonl");
  const ledgerPath = path.join(root, ".deskshell", "effects.jsonl");
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
        return line;
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

  const manifest = {
    name: "effect-ledger",
    version: "0.0.0",
    description: "Effect Ledger v0 adapter",
    entry: "./adapter.ts",
    capabilities: [{ id: "fs.write" as const, scope: root, reason: "执行协议动作" }],
  };

  async function apply(action: KernelAction): Promise<{ status: "ok" | "refused"; reason?: string; id?: string }> {
    const seq = nextSeq();
    const id = `s${seq}`;
    const taskId = `eff-${seq}-${Date.now()}`;
    const at = Date.now();
    const base = { v: 0, id, taskId, seq, at };

    if (action.kind === "delete" && (action.undo === undefined || action.undo === "none")) {
      return { status: "refused", reason: "DELETE_WITHOUT_UNDO" };
    }
    if (action.kind !== "write" && action.undo === "noop") {
      return { status: "refused", reason: "DELETE_WITH_PLACEHOLDER_UNDO" };
    }

    if (action.kind === "write" && action.path !== undefined) {
      const before = read(action.path);
      const acts: Action[] = [
        {
          id: "a1",
          kind: "fs.write",
          path: abs(action.path),
          content: action.content ?? "",
          undo: { kind: "fs.restore", path: abs(action.path), content: before.exists ? before.content ?? null : null },
        },
      ];
      const report = await runActions(manifest, acts, { mode: "apply", root, granted: ["fs.write"], journalPath }, {}, { taskId });
      if (report.steps[0]?.status !== "ok") return { status: "refused", reason: "UNSUPPORTED" };
      append({ ...base, kind: "fs.write", object: action.path, beforeHash: before.exists ? sha(before.content ?? "") : null, afterHash: sha(action.content ?? ""), undo: { kind: "restore", content: before.exists ? before.content ?? null : null }, status: "ok" });
      return { status: "ok", id };
    }

    if (action.kind === "delete" && action.path !== undefined) {
      const before = read(action.path);
      if (!before.exists) return { status: "refused", reason: "UNSUPPORTED" };
      const acts: Action[] = [
        {
          id: "a1",
          kind: "fs.delete",
          path: abs(action.path),
          undo: { kind: "fs.restore", path: abs(action.path), content: before.content ?? null },
        },
      ];
      const report = await runActions(manifest, acts, { mode: "apply", root, granted: ["fs.write"], journalPath }, {}, { taskId });
      if (report.steps[0]?.status !== "ok") return { status: "refused", reason: "UNSUPPORTED" };
      append({ ...base, kind: "fs.delete", object: action.path, beforeHash: sha(before.content ?? ""), afterHash: null, undo: { kind: "restore", content: before.content ?? null }, status: "ok" });
      return { status: "ok", id };
    }

    if (action.kind === "move" && action.from && action.to) {
      const acts: Action[] = [
        {
          id: "a1",
          kind: "fs.move",
          from: abs(action.from),
          to: abs(action.to),
          undo: { kind: "fs.move", from: abs(action.to), to: abs(action.from) },
        },
      ];
      const report = await runActions(manifest, acts, { mode: "apply", root, granted: ["fs.write"], journalPath }, {}, { taskId });
      if (report.steps[0]?.status !== "ok") return { status: "refused", reason: "UNSUPPORTED" };
      append({ ...base, kind: "fs.move", object: action.to, beforeHash: null, afterHash: null, undo: { kind: "move", from: action.to, to: action.from }, status: "ok" });
      return { status: "ok", id };
    }

    return { status: "refused", reason: "UNSUPPORTED" };
  }

  async function revert(target: string): Promise<{ status: "restored" | "refused"; reason?: string; id?: string }> {
    const all = entries();
    if (all.length === 0) return { status: "refused", reason: "NOTHING_TO_REVERT" };
    const entry = target === "last" ? all[all.length - 1] : all.find((e) => e.id === target);
    if (!entry) return { status: "refused", reason: "NOTHING_TO_REVERT" };
    if (entry.status === "rolled-back") return { status: "refused", reason: "ALREADY_REVERTED" };

    const current = read(String(entry.object));
    const currentHash = current.exists ? sha(current.content ?? "") : null;
    if (currentHash !== (entry.afterHash ?? null)) return { status: "refused", reason: "CONFLICT" };

    const report = await undoTask(String(entry.taskId), { mode: "undo", root, granted: [], journalPath });
    if (report.rolledBack < 1) return { status: "refused", reason: "CONFLICT" };
    markRolledBack(String(entry.id));
    return { status: "restored", id: String(entry.id) };
  }

  return { root, ledgerPath, apply, revert, read, ledger: async () => entries() };
}
