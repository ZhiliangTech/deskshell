<p align="center"><img src="../brand/logo-mark.svg" width="72" alt=""></p>

# Drivers

A driver does one thing: translate "look at the screen, act on it" into structured actions the kernel can use. It never makes permission decisions — that is the kernel's job.

## Interface

```ts
interface UiDriver {
  windows(): Promise<WindowInfo[]>;
  tree(ref: WindowRef, depth?: number): Promise<UiNode>;
  invoke(ref: WindowRef, selector: UiSelector): Promise<void>;
  click(ref: WindowRef, selector: UiSelector): Promise<void>;
  type(ref: WindowRef, selector: UiSelector, text: string): Promise<void>;
  keys(ref: WindowRef, combo: string): Promise<void>;
  bounds?(ref: WindowRef): Promise<Rect>;
  moveWindow?(ref: WindowRef, rect: Rect): Promise<void>;
}
```

## Platform status

**Windows — verified**

- Stack: UI Automation + a `WH_MOUSE_LL` hook.
- Verified: enumerate windows, read the control tree (including ValuePattern), focus, type, keys, click by selector, read/write window geometry.
- Gotchas: minimized windows report an infinite bounding rectangle (guarded); Windows 11 Notepad exposes its editor as `Document`, not `Edit`.

**macOS — verified on hardware (macOS 26.6, arm64)**

- Stack: a native Swift AX bridge (`axbridge`) with an `osascript` fallback.
- Verified: window enumeration (20 windows in 36 ms), control tree (181 nodes), focus, Unicode typing, AXPress (Calculator: 7 × 8 = 56), **coordinate clicks with automatic fallback** (press the element centre when AXPress is refused), window move and pixel-exact restore.
- Build the bridge first: `packages/drivers/macos/build.sh` (Xcode Command Line Tools).
- Bridge commands the driver relies on: `windows`, `tree`, `press`, `rect`, `click --x --y`, `cursor`, `type`, `move`, `trusted`. `rect` reads an element's frame without triggering it; `cursor` reports the mouse position, which is how the coordinate-click test proves the synthetic click landed on the element's centre.
- Grant accessibility permission: System Settings → Privacy & Security → Accessibility.

Four things the hardware taught us:

1. **Don't enumerate windows with AppleScript.** `System Events` takes 19–23 s per call; `CGWindowList` + `AXUIElement` takes 36 ms.
2. **Don't type with `keystroke`.** It goes through the active input method — under a Chinese IME, `hello` becomes `和力量`. The bridge posts Unicode via `CGEvent` instead.
3. **Focus by pid.** `CGWindowList` reports localized owner names ("终端"), while System Events uses "Terminal"; matching by name fails with `-1719`.
4. **Buttons often have no title.** Calculator's buttons expose only `AXIdentifier` (`Seven`, `Multiply`, `Equals`), and the display text carries U+200E marks that must be stripped before comparison.

**Linux — X11, window-level (verified in CI)**

- Stack: `wmctrl` for the window list, `xdotool` for geometry, activation, typing, keys and moves.
- What works: enumerate windows, read title/geometry, activate, type, send key combos, move/resize, and restore geometry.
- What does **not** work: control-level operations (`invoke`, `click` by selector). X11 has no system-wide accessibility tree; that needs an AT-SPI2 backend. The driver says so explicitly instead of pretending to click:

  ```
  click 需要控件级定位，X11 驱动暂不支持（没有可访问性树）。
  ```

- Dependencies: `sudo apt-get install -y xvfb xterm xdotool wmctrl`. Without `DISPLAY` or the two binaries the driver refuses to construct and prints the exact command to run.
- Verification: `xvfb-run -a --server-args="-screen 0 1280x800x24" node scripts/linux-driver-smoke.ts` — the CI job `linux-ui` runs exactly this, so "it works on Linux" is backed by an Actions log, not by a claim.

## Mock driver

`packages/drivers/mock/driver.ts` is a pure in-memory driver. Its job is to prove the kernel is platform-agnostic:

```bash
node scripts/contract-test.ts
```

Eleven contracts: tree traversal, typing + `ui.value`, assertion blocking, cross-domain rollback, invoke dispatch, capability denial, window move + undo, `window.exists`, `ui.exists`, and manifest validation.

A new platform driver only has to pass these; the rest is "is it accurate on this OS".

## Verifying a new machine

```bash
node bin/deskshell.ts doctor          # Node / platform / permission / manifests / writability
node scripts/verify-driver.ts         # read-only: windows, tree, focus
node scripts/verify-driver.ts --input # also sends one keystroke and a short string
```

A failing check prints the original error, not just "failed" — on macOS, `-1719` means missing accessibility permission.

## Writing a driver

1. Create `packages/drivers/<platform>/driver.ts` implementing `UiDriver`.
2. Add the platform branch to `scripts/verify-driver.ts`.
3. In the docs, state **what is verified, what is not, and how to check** — all three, otherwise nobody can judge whether it is usable.
