import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type {
  Rect,
  UiDriver,
  UiNode,
  UiSelector,
  WindowInfo,
  WindowRef,
} from "../../core/src/types.ts";

const BRIDGE = fileURLToPath(new URL("./.build/axbridge", import.meta.url));
const hasBridge = (): boolean => existsSync(BRIDGE);

/** 调原生 AX 桥，返回解析后的 JSON；失败时抛错，由调用方决定是否回退 */
function bridge<T>(args: string[], timeoutMs = 15000): Promise<T> {
  return new Promise((resolve, reject) => {
    const proc = spawn(BRIDGE, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    proc.stdout.on("data", (d: string) => (out += d));
    proc.stderr.on("data", (d: string) => (err += d));
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`axbridge timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    proc.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(err.trim() || `axbridge exited ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(out) as T);
      } catch {
        reject(new Error(`axbridge 输出不是 JSON: ${out.slice(0, 120)}`));
      }
    });
  });
}

/**
 * macOS 驱动（实验性）
 *
 * 走 osascript + System Events，因此需要用户在「系统设置 → 隐私与安全性 → 辅助功能」
 * 里给终端 / Node 授权。未验证的能力会在调用时抛出明确错误，而不是静默失败。
 */

function osa(script: string, timeoutMs = 20000): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("osascript", ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    proc.stdout.on("data", (d: string) => (out += d));
    proc.stderr.on("data", (d: string) => (err += d));
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`osascript timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    proc.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(err.trim() || `osascript exited ${code}`));
        return;
      }
      resolve(out.trim());
    });
  });
}

const esc = (s: string): string => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

export class MacDriver implements UiDriver {
  async windows(): Promise<WindowInfo[]> {
    if (hasBridge()) {
      const raw = await bridge<Array<{ name: string; owner: string; pid: number; x: number; y: number; w: number; h: number }>>(
        ["windows"],
      );
      return raw.map((w) => ({
        name: w.name,
        className: w.owner,
        pid: w.pid,
        x: Math.round(w.x),
        y: Math.round(w.y),
        w: Math.round(w.w),
        h: Math.round(w.h),
      }));
    }
    return this.windowsViaAppleScript();
  }

  /** 回退实现：没有编译 AX 桥时使用（真机上 20 秒级，仅作兜底） */
  private async windowsViaAppleScript(): Promise<WindowInfo[]> {
    // 批量取属性：每个进程 3 次 AppleEvent，而不是每个窗口 3 次。
    // 逐窗口访问 System Events 在真机上要 19 秒，这样能压到秒级。
    const out = await osa(`
tell application "System Events"
  set acc to ""
  repeat with p in (every application process whose background only is false)
    try
      set pname to name of p
      set ppid to unix id of p
      set wn to name of every window of p
      if (count of wn) > 0 then
        set pos to position of every window of p
        set sz to size of every window of p
        repeat with i from 1 to count of wn
          set acc to acc & pname & tab & ppid & tab & (item i of wn) & tab & (item 1 of item i of pos) & tab & (item 2 of item i of pos) & tab & (item 1 of item i of sz) & tab & (item 2 of item i of sz) & linefeed
        end repeat
      end if
    end try
  end repeat
  return acc
end tell`, 60000);
    return out
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [name, pid, title, x, y, w, h] = line.split("\t");
        return {
          name: title || name,
          className: name,
          pid: Number(pid),
          x: Number(x),
          y: Number(y),
          w: Number(w),
          h: Number(h),
        };
      });
  }

  private async resolve(ref: WindowRef): Promise<WindowInfo> {
    const wins = await this.windows();
    const hit = ref.pid
      ? wins.find((w) => w.pid === ref.pid)
      : wins.find((w) => (ref.titleRegex ? new RegExp(ref.titleRegex).test(w.name) : true));
    if (!hit) throw new Error(`window not found: ${ref.titleRegex ?? ref.pid}`);
    return hit;
  }

  async tree(ref: WindowRef, depth = 4): Promise<UiNode> {
    const win = await this.resolve(ref);
    if (hasBridge()) {
      const raw = await bridge<UiNode>(["tree", "--pid", String(win.pid), "--depth", String(depth)], 20000);
      return { ...raw, name: win.name, windowPid: win.pid };
    }
    const out = await osa(`
tell application "System Events"
  tell application process "${esc(win.className)}"
    set w to first window whose name is "${esc(win.name)}"
    set acc to ""
    repeat with e in (entire contents of w)
      try
        set acc to acc & (role of e) & tab & (name of e) & linefeed
      end try
    end repeat
    return acc
  end tell
end tell`, 30000);

    const children: UiNode[] = out
      .split("\n")
      .filter(Boolean)
      .slice(0, depth * 400)
      .map((line, i) => {
        const [role, name] = line.split("\t");
        return {
          name: name ?? "",
          automationId: "",
          controlType: (role ?? "").replace(/^AX/, ""),
          className: role ?? "",
          enabled: true,
          value: null,
          x: 0,
          y: 0,
          w: 0,
          h: 0,
          children: [],
          windowPid: win.pid,
        };
      });

    return {
      name: win.name,
      automationId: "",
      controlType: "Window",
      className: win.className,
      enabled: true,
      value: null,
      x: win.x,
      y: win.y,
      w: win.w,
      h: win.h,
      children,
      windowPid: win.pid,
    };
  }

  async focus(ref: WindowRef): Promise<void> {
    const win = await this.resolve(ref);
    // 用 unix id 定位进程：CGWindow 的 owner 名是本地化的（"终端"），
    // 而 System Events 的进程名可能是 "Terminal"，按名字匹配会 -1719。
    await osa(`tell application "System Events" to set frontmost of (first application process whose unix id is ${win.pid}) to true`);
  }

  async keys(ref: WindowRef, combo: string): Promise<void> {
    await this.focus(ref);
    const mods: string[] = [];
    let key = combo;
    if (/^(cmd|command)\+/i.test(key)) {
      mods.push("command down");
      key = key.replace(/^(cmd|command)\+/i, "");
    }
    if (/^ctrl\+/i.test(key)) {
      mods.push("control down");
      key = key.replace(/^ctrl\+/i, "");
    }
    if (/^alt\+/i.test(key)) {
      mods.push("option down");
      key = key.replace(/^alt\+/i, "");
    }
    if (/^shift\+/i.test(key)) {
      mods.push("shift down");
      key = key.replace(/^shift\+/i, "");
    }
    const using = mods.length ? ` using {${mods.join(", ")}}` : "";
    await osa(`tell application "System Events" to keystroke "${esc(key)}"${using}`);
  }

  async type(ref: WindowRef, _selector: UiSelector, text: string): Promise<void> {
    await this.focus(ref);
    if (hasBridge()) {
      await bridge(["type", "--text", text], 20000);
      return;
    }
    await osa(`tell application "System Events" to keystroke "${esc(text)}"`);
  }

  async invoke(ref: WindowRef, selector: UiSelector): Promise<void> {
    const win = await this.resolve(ref);
    if (!hasBridge()) throw new Error("macOS invoke 需要编译 AX 桥：packages/drivers/macos/build.sh");
    const args = ["press", "--pid", String(win.pid)];
    if (selector.controlType) args.push("--role", selector.controlType);
    if (selector.name) args.push("--name", selector.name);
    if (selector.automationId) args.push("--id", selector.automationId);
    const res = await bridge<{ ok: boolean; title?: string }>(args, 20000);
    if (!res.ok) throw new Error(`AXPress 未成功：${selector.controlType ?? ""} ${selector.name ?? ""}`);
  }

  async click(ref: WindowRef, selector: UiSelector): Promise<void> {
    // macOS 上"按选择器点击"等价于对元素执行 AXPress；
    // 需要真实坐标点击时用坐标版（roadmap）。
    await this.invoke(ref, selector);
  }

  async bounds(ref: WindowRef): Promise<Rect> {
    const win = await this.resolve(ref);
    return { x: win.x, y: win.y, w: win.w, h: win.h };
  }

  async moveWindow(ref: WindowRef, rect: Rect): Promise<void> {
    const win = await this.resolve(ref);
    if (!hasBridge()) throw new Error("macOS moveWindow 需要编译 AX 桥");
    const res = await bridge<{ ok: boolean; error?: string; size?: boolean }>(
      ["move", "--pid", String(win.pid), "--x", String(rect.x), "--y", String(rect.y), "--w", String(rect.w), "--h", String(rect.h)],
      20000,
    );
    if (!res.ok) throw new Error(`窗口移动失败：${res.error ?? "系统拒绝设置位置（部分应用固定窗口）"}`);
  }
}
