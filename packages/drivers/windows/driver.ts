import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type {
  Rect,
  UiDriver,
  UiNode,
  UiSelector,
  WindowInfo,
  WindowRef,
} from "../../core/src/types.ts";

const PS = path.join(
  process.env.SystemRoot ?? "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);
const SCRIPT = fileURLToPath(new URL("./driver.ps1", import.meta.url));

interface DriverResponse {
  ok: boolean;
  data?: unknown;
  error?: string;
}

function call(req: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const proc = spawn(PS, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", SCRIPT], {
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    proc.stdout.on("data", (d: string) => (stdout += d));
    proc.stderr.on("data", (d: string) => (stderr += d));
    proc.on("error", reject);
    proc.on("close", (code) => {
      const line = stdout
        .split(/\r?\n/)
        .map((l) => l.replace(/^\uFEFF/, "").trim())
        .filter(Boolean)
        .pop();
      if (!line) {
        reject(new Error(`driver produced no output (exit ${code}): ${stderr.slice(0, 300)}`));
        return;
      }
      try {
        const res = JSON.parse(line) as DriverResponse;
        if (!res.ok) reject(new Error(res.error ?? "driver error"));
        else resolve(res.data);
      } catch {
        reject(new Error(`driver returned non-JSON (exit ${code}): ${line.slice(0, 300)}`));
      }
    });
    proc.stdin.end(JSON.stringify(req), "utf8");
  });
}

export class WindowsDriver implements UiDriver {
  async windows(): Promise<WindowInfo[]> {
    return (await call({ action: "windows" })) as WindowInfo[];
  }

  async tree(ref: WindowRef, depth = 6): Promise<UiNode> {
    return (await call({
      action: "tree",
      titleRegex: ref.titleRegex,
      pid: ref.pid,
      depth,
    })) as UiNode;
  }

  async invoke(ref: WindowRef, selector: UiSelector): Promise<void> {
    await call({ action: "invoke", titleRegex: ref.titleRegex, pid: ref.pid, selector });
  }

  async click(ref: WindowRef, selector: UiSelector): Promise<void> {
    await call({ action: "click", titleRegex: ref.titleRegex, pid: ref.pid, selector });
  }

  async type(ref: WindowRef, selector: UiSelector, text: string): Promise<void> {
    await call({ action: "type", titleRegex: ref.titleRegex, pid: ref.pid, selector, text });
  }

  async keys(ref: WindowRef, combo: string): Promise<void> {
    await call({ action: "keys", titleRegex: ref.titleRegex, pid: ref.pid, combo });
  }

  async launch(file: string, args: string[] = [], waitMs = 1200): Promise<{ pid: number }> {
    return (await call({ action: "launch", file, args, waitMs })) as { pid: number };
  }

  async focus(ref: WindowRef): Promise<void> {
    await call({ action: "focus", titleRegex: ref.titleRegex, pid: ref.pid });
  }

  async bounds(ref: WindowRef): Promise<Rect> {
    return (await call({
      action: "bounds",
      titleRegex: ref.titleRegex,
      pid: ref.pid,
    })) as Rect;
  }

  async moveWindow(ref: WindowRef, rect: Rect): Promise<void> {
    await call({
      action: "move",
      titleRegex: ref.titleRegex,
      pid: ref.pid,
      x: rect.x,
      y: rect.y,
      w: rect.w,
      h: rect.h,
    });
  }
}

/** 从控件树里按控制类型收集节点（深度优先） */
export function collect(node: UiNode, controlType: string): UiNode[] {
  const out: UiNode[] = [];
  const walk = (n: UiNode): void => {
    if (n.controlType === controlType) out.push(n);
    for (const child of n.children) walk(child);
  };
  walk(node);
  return out;
}
