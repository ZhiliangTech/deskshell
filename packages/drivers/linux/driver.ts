import { execFileSync } from "node:child_process";
import type {
  Rect,
  UiDriver,
  UiNode,
  UiSelector,
  WindowInfo,
  WindowRef,
} from "../../core/src/types.ts";

/**
 * Linux / X11 驱动。
 *
 * X11 没有系统级的可访问性树（AT-SPI 需要应用配合），所以这一版只做
 * **窗口级**操作：枚举、读标题/几何、激活、输入、按键、移动窗口。
 * 单控件定位（selector）要等 AT-SPI 后端，这里明确报"不支持"，
 * 而不是假装成功——一个静默失败的点击比不支持更糟。
 */

const TOOLS = {
  xdotool: "xdotool",
  wmctrl: "wmctrl",
} as const;

function has(tool: string): boolean {
  try {
    execFileSync("sh", ["-c", `command -v ${tool}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function run(bin: string, args: string[]): string {
  return execFileSync(bin, args, { encoding: "utf8" }).trim();
}

const quote = (s: string): string => s.replace(/'/g, "'\\''");

export interface LinuxCapabilities {
  xdotool: boolean;
  wmctrl: boolean;
  display: boolean;
}

export function detect(): LinuxCapabilities {
  return {
    xdotool: has(TOOLS.xdotool),
    wmctrl: has(TOOLS.wmctrl),
    display: Boolean(process.env.DISPLAY),
  };
}

export function missingHint(caps = detect()): string | null {
  const missing: string[] = [];
  if (!caps.display) missing.push("没有 DISPLAY（无头环境请用 xvfb-run）");
  if (!caps.xdotool) missing.push("缺 xdotool：sudo apt-get install -y xdotool");
  if (!caps.wmctrl) missing.push("缺 wmctrl：sudo apt-get install -y wmctrl");
  return missing.length ? missing.join("；") : null;
}

interface RawWindow {
  id: string;
  name: string;
  pid: number;
  desktop: number;
}

export class LinuxDriver implements UiDriver {
  private cached: RawWindow[] = [];

  constructor() {
    const hint = missingHint();
    if (hint) {
      throw new Error(
        `Linux 驱动不可用：${hint}\n` +
          "窗口级操作需要 xdotool + wmctrl；控件级操作需要 AT-SPI2 后端（尚未实现）。",
      );
    }
  }

  private listRaw(): RawWindow[] {
    const out = run("wmctrl", ["-lp"]);
    return out
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const cols = line.split(/\s+/);
        const [id, desktop, pid] = cols;
        const name = line.slice(line.indexOf(cols[3] ?? "")).trim();
        return { id, name, pid: Number(pid), desktop: Number(desktop) };
      })
      .filter((w) => Number.isFinite(w.pid));
  }

  async windows(): Promise<WindowInfo[]> {
    this.cached = this.listRaw();
    return this.cached.map((w) => {
      const geom = run("xdotool", ["getwindowgeometry", "--shell", w.id])
        .split("\n")
        .reduce<Record<string, string>>((acc, line) => {
          const [k, v] = line.split("=");
          if (k && v) acc[k] = v;
          return acc;
        }, {});
      return {
        name: w.name,
        className: "",
        pid: w.pid,
        x: Number(geom.X ?? 0),
        y: Number(geom.Y ?? 0),
        w: Number(geom.WIDTH ?? 0),
        h: Number(geom.HEIGHT ?? 0),
      };
    });
  }

  private resolve(ref: WindowRef): RawWindow {
    if (this.cached.length === 0) this.cached = this.listRaw();
    const byRef = this.cached.find((w) => {
      if (ref.pid !== undefined) return w.pid === ref.pid;
      if (ref.titleRegex) return new RegExp(ref.titleRegex, "i").test(w.name);
      return false;
    });
    if (!byRef) {
      throw new Error(
        `找不到窗口：${ref.pid !== undefined ? `pid=${ref.pid}` : `/${ref.titleRegex}/`}。` +
          "X11 下需要窗口已映射（不是最小化）。",
      );
    }
    return byRef;
  }

  /**
   * X11 没有可枚举的控件树，返回"窗口 + 整块内容区"两层，
   * 让上层代码能拿到几何与标题，但不要指望有子控件。
   */
  async tree(ref: WindowRef, _depth = 6): Promise<UiNode> {
    const w = this.resolve(ref);
    const [info] = await this.windows().then((all) => all.filter((x) => x.pid === w.pid && x.name === w.name));
    const geom = info ?? { x: 0, y: 0, w: 0, h: 0 };
    return {
      name: w.name,
      automationId: w.id,
      controlType: "Window",
      className: "X11Window",
      enabled: true,
      value: null,
      x: geom.x,
      y: geom.y,
      w: geom.w,
      h: geom.h,
      children: [
        {
          name: `${w.name} (content)`,
          automationId: `${w.id}:content`,
          controlType: "Pane",
          className: "X11Content",
          enabled: true,
          value: null,
          x: geom.x,
          y: geom.y,
          w: geom.w,
          h: geom.h,
          children: [],
        },
      ],
    };
  }

  private unsupported(op: string): never {
    throw new Error(
      `${op} 需要控件级定位，X11 驱动暂不支持（没有可访问性树）。` +
        "可用的是：windows / tree（窗口级）/ type / keys / moveWindow。",
    );
  }

  async invoke(_ref: WindowRef, _selector: UiSelector): Promise<void> {
    this.unsupported("invoke");
  }

  async click(_ref: WindowRef, _selector: UiSelector): Promise<void> {
    this.unsupported("click");
  }

  /** 输入到当前聚焦窗口；X11 下需要先 activate */
  async type(ref: WindowRef, _selector: UiSelector, text: string): Promise<void> {
    const w = this.resolve(ref);
    run("xdotool", ["windowactivate", "--sync", w.id]);
    run("sh", ["-c", `xdotool type --delay 12 -- ${quote(text)}`]);
  }

  async keys(ref: WindowRef, combo: string): Promise<void> {
    const w = this.resolve(ref);
    run("xdotool", ["windowactivate", "--sync", w.id]);
    run("xdotool", ["key", "--clearmodifiers", combo]);
  }

  async bounds(ref: WindowRef): Promise<Rect> {
    const list = await this.windows();
    const w = this.resolve(ref);
    const found = list.find((x) => x.pid === w.pid && x.name === w.name);
    if (!found) throw new Error(`窗口消失：${w.name}`);
    return { x: found.x, y: found.y, w: found.w, h: found.h };
  }

  async moveWindow(ref: WindowRef, rect: Rect): Promise<void> {
    const w = this.resolve(ref);
    run("xdotool", ["windowmove", "--sync", w.id, String(rect.x), String(rect.y)]);
    run("xdotool", ["windowsize", "--sync", w.id, String(rect.w), String(rect.h)]);
  }
}
