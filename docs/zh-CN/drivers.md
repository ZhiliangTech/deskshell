# 驱动

驱动只做一件事：把"看屏幕、点东西"翻译成内核能用的结构化动作。它不做权限判断，那是内核的事。

## 接口

```ts
interface UiDriver {
  windows(): Promise<WindowInfo[]>;
  tree(ref: WindowRef, depth?: number): Promise<UiNode>;
  invoke(ref: WindowRef, selector: UiSelector): Promise<void>;
  click(ref: WindowRef, selector: UiSelector): Promise<void>;
  type(ref: WindowRef, selector: UiSelector, text: string): Promise<void>;
  keys(ref: WindowRef, combo: string): Promise<void>;
  focus(ref: WindowRef): Promise<void>;
}
```

## 各平台状态

**Windows（已验证）**

- 技术栈：UI Automation + `WH_MOUSE_LL` 钩子
- 已验证：枚举窗口、读控件树（含 ValuePattern 取值）、聚焦、输入、按键、按选择器点击
- 已知问题：最小化窗口的 `BoundingRectangle` 是无穷大，已做兜底；Windows 11 新记事本的编辑区是 `Document` 而不是 `Edit`

**macOS（已在真机验证）**

- 技术栈：原生 Swift AX 桥（`axbridge`）+ `osascript` 兜底
- 已验证（macOS 26.6 / arm64）：窗口枚举（20 个 36ms）、控件树（181 节点）、聚焦、Unicode 输入、**AXPress 点击**（计算器 7×8=56）、**窗口移动与还原**（TextEdit 逐像素还原）
- 坐标点击：AXPress 被拒时自动回退为点击元素矩形中心（`clickAt`），真机验证通过
- 必须编译桥：`packages/drivers/macos/build.sh`（需要 Xcode Command Line Tools）
- 驱动用到的桥命令：`windows`、`tree`、`press`、`rect`、`click --x --y`、`cursor`、`type`、`move`、`trusted`。`rect` 只读元素矩形、不触发动作；`cursor` 返回鼠标位置——坐标点击测试靠它证明合成点击落在元素中心。
- 前置条件：系统设置 → 隐私与安全性 → 辅助功能，给终端授权

四条实测踩出来的坑，写在这里省别人时间：

1. **别用 AppleScript 枚举窗口**：`System Events` 逐窗口取属性在真机上要 **19–23 秒**，用 `CGWindowList` + `AXUIElement` 的原生桥是 **36 毫秒**。
2. **别用 `keystroke` 打英文**：它会走当前输入法，中文输入法下 `hello` 会变成 `和力量`。桥里改用 `CGEvent` 直接投递 Unicode。
3. **聚焦要按 pid**：`CGWindowList` 的 owner 名是本地化的（"终端"），System Events 的进程名是 "Terminal"，按名字匹配会 `-1719`。
4. **按钮常常没有标题**：macOS 计算器的按钮 `AXTitle` 为空，只能靠 `AXIdentifier`（`Seven` / `Multiply` / `Equals`）定位；显示区文本还带 U+200E 方向标记，比对前要剥掉。


- `setValue(ref, selector, value)` —— 直接写回控件值（ValuePattern，不支持时退回聚焦 + 全选 + 粘贴）。`ui.type` 能撤销就是靠它。已在真实 WinForms 窗口上验过；因为那个夹具走的是 legacy UIA proxy，没法稳定自动化。

**Linux — X11，窗口级（CI 实测）**

- 技术栈：`wmctrl` 列窗口，`xdotool` 做几何、激活、输入、按键、移动。
- 能做的：枚举窗口、读标题与几何、激活、输入文字、发组合键、移动/缩放、还原几何。
- 不能做的：控件级操作（`invoke`、按 selector 的 `click`）。X11 没有系统级可访问性树，那需要 AT-SPI2 后端。驱动会**明确报不支持**，而不是假装点成功：

  ```
  click 需要控件级定位，X11 驱动暂不支持（没有可访问性树）。
  ```

- 依赖：`sudo apt-get install -y xvfb xterm xdotool wmctrl`。没有 `DISPLAY` 或缺二进制时，驱动直接拒绝构造，并打印要执行的命令。
- 验证：`xvfb-run -a --server-args="-screen 0 1280x800x24" node scripts/linux-driver-smoke.ts`——CI 的 `linux-ui` 作业跑的就是它，所以"Linux 能跑"有 Actions 日志背书，不是一句声明。

- 技术栈：AT-SPI2
- 尚未开始

## 在一台新机器上验证驱动

```bash
node bin/deskshell.ts doctor           # 环境自检：Node / 平台 / 权限 / 清单 / 可写
node scripts/verify-driver.ts          # 只读检查：窗口枚举、控件树、聚焦
node scripts/verify-driver.ts --input  # 额外测试按键与输入（会向当前窗口发一次按键）
```

输出是一张能力表：

```
PASS windows()  24 个窗口，例如：...
PASS tree()     记事本 → 37 个节点
PASS focus()    已聚焦
SKIP click()    需指定窗口与控件，verifier 不自动点击
```

失败的项会打印原始错误（例如 macOS 的 `-1719` 就是没给辅助功能权限）。

## 内存驱动（MockDriver）

`packages/drivers/mock/driver.ts` 是一个纯内存驱动：不碰真实桌面，行为完全可预测。

它的用途不是替代真驱动，而是**证明内核对平台无感**：

```bash
node scripts/contract-test.ts
```

六项契约：

| 契约 | 验证什么 |
| --- | --- |
| driver.tree | 树结构与选择器匹配 |
| ui.type+assert | 输入后 `ui.value` 断言通过 |
| assert.blocks | 错误断言必须阻断执行 |
| rollback.cross-domain | 文件写入 + UI 失败 → 文件被回滚 |
| ui.invoke | invoke 真的调到驱动 |
| policy.deny | 未声明 `ui.input` 时点击被拒绝 |

新平台驱动只要通过这六项，就说明它和内核的契约是对的——剩下的只是"它在这个系统上准不准"。

## 写一个新驱动

1. 新建 `packages/drivers/<platform>/driver.ts`，实现 `UiDriver`；
2. 在 `scripts/verify-driver.ts` 里加平台分支；
3. 文档里写清楚：**已验证什么、未验证什么、怎么验证**——三者缺一不可，否则别人没法判断能不能用。
