import type {
  Rect,
  UiDriver,
  UiNode,
  UiSelector,
  WindowInfo,
  WindowRef,
} from "../../core/src/types.ts";

/**
 * 内存驱动：不碰真实桌面，用来验证"内核只依赖 UiDriver 接口"这句话。
 * 契约测试、CI、以及新平台驱动开发时的对照实现都用它。
 */
export class MockDriver implements UiDriver {
  calls: string[] = [];
  windowsData: WindowInfo[] = [
    { name: "Mock Window", className: "Mock", pid: 1000, x: 0, y: 0, w: 800, h: 600 },
  ];
  treeData: UiNode = {
    name: "Mock Window",
    automationId: "",
    controlType: "Window",
    className: "Mock",
    enabled: true,
    value: null,
    x: 0,
    y: 0,
    w: 800,
    h: 600,
    children: [
      {
        name: "编辑区",
        automationId: "editor",
        controlType: "Document",
        className: "MockEdit",
        enabled: true,
        value: "",
        x: 10,
        y: 10,
        w: 400,
        h: 200,
        children: [],
      },
      {
        name: "确定",
        automationId: "ok",
        controlType: "Button",
        className: "MockButton",
        enabled: true,
        value: null,
        x: 10,
        y: 300,
        w: 80,
        h: 30,
        children: [],
      },
    ],
  };

  async windows(): Promise<WindowInfo[]> {
    this.calls.push("windows");
    return this.windowsData;
  }

  async tree(ref: WindowRef, _depth = 6): Promise<UiNode> {
    this.calls.push(`tree:${ref.titleRegex ?? ref.pid}`);
    return structuredClone(this.treeData);
  }

  async invoke(ref: WindowRef, selector: UiSelector): Promise<void> {
    this.calls.push(`invoke:${ref.titleRegex}:${selector.automationId ?? selector.name}`);
    this.treeData.children[1].enabled = false;
  }

  async click(ref: WindowRef, selector: UiSelector): Promise<void> {
    this.calls.push(`click:${ref.titleRegex}:${selector.automationId ?? selector.name}`);
  }

  async type(ref: WindowRef, selector: UiSelector, text: string): Promise<void> {
    this.calls.push(`type:${ref.titleRegex}:${selector.automationId ?? selector.name}:${text}`);
    const target = this.treeData.children.find((c) => c.automationId === selector.automationId);
    if (target) target.value = text;
  }

  async keys(ref: WindowRef, combo: string): Promise<void> {
    this.calls.push(`keys:${ref.titleRegex}:${combo}`);
  }

  async focus(ref: WindowRef): Promise<void> {
    this.calls.push(`focus:${ref.titleRegex}`);
  }

  async bounds(ref: WindowRef): Promise<Rect> {
    this.calls.push(`bounds:${ref.titleRegex ?? ref.pid}`);
    const w = this.windowsData.find((x) => (ref.titleRegex ? new RegExp(ref.titleRegex).test(x.name) : x.pid === ref.pid));
    if (!w) throw new Error(`window not found: ${ref.titleRegex ?? ref.pid}`);
    return { x: w.x, y: w.y, w: w.w, h: w.h };
  }

  async moveWindow(ref: WindowRef, rect: Rect): Promise<void> {
    this.calls.push(`moveWindow:${ref.titleRegex}:${rect.x},${rect.y}`);
    const w = this.windowsData.find((x) => (ref.titleRegex ? new RegExp(ref.titleRegex).test(x.name) : x.pid === ref.pid));
    if (!w) throw new Error(`window not found: ${ref.titleRegex ?? ref.pid}`);
    w.x = rect.x;
    w.y = rect.y;
    w.w = rect.w;
    w.h = rect.h;
    this.treeData.x = rect.x;
    this.treeData.y = rect.y;
    this.treeData.w = rect.w;
    this.treeData.h = rect.h;
  }
}
