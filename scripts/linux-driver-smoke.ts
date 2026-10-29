import { execFileSync, spawn } from "node:child_process";
import { LinuxDriver, detect, missingHint } from "../packages/drivers/linux/driver.ts";

/**
 * Linux 驱动的真机冒烟：在 Xvfb 里起一个 xterm，做窗口级操作。
 * 只能在有 DISPLAY 的 Linux 上跑；CI 用 xvfb-run 执行本脚本。
 *
 * 明确不做的事：控件级点击（X11 无可访问性树），那需要 AT-SPI2 后端。
 */
const checks: string[] = [];
const check = (name: string, ok: boolean, detail = ""): void => {
  checks.push(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  (${detail})`}`);
  if (!ok) process.exitCode = 1;
};

const caps = detect();
check("DISPLAY 存在", caps.display, JSON.stringify(caps));
if (!caps.display || !caps.xdotool || !caps.wmctrl) {
  const hint = missingHint(caps);
  check("依赖齐全（xdotool/wmctrl/显示）", false, hint ?? "");
  console.log(checks.join("\n"));
  console.log(`${checks.filter((c) => c.startsWith("PASS")).length}/${checks.length} passed`);
  process.exit(1);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// 起一个最小的 X 客户端，并且**确认窗口真的出现**再继续。
// xterm 在 CI 里偶尔会因为字体/locale 起不来，所以按候选依次尝试并验证。
const listWindows = async (): Promise<string[]> => {
  try {
    const d = new LinuxDriver();
    return (await d.windows()).map((w) => w.name);
  } catch {
    return [];
  }
};

const exists = (bin: string): boolean => {
  try {
    execFileSync("sh", ["-c", `command -v ${bin}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

interface Attempt {
  bin: string;
  args: string[];
}

const ATTEMPTS: Attempt[] = [
  { bin: "xterm", args: ["-T", "deskshell-smoke", "-geometry", "80x24+40+60", "-e", "sleep", "300"] },
  { bin: "xmessage", args: ["-title", "deskshell-smoke", "-geometry", "400x200+40+60", "deskshell-smoke"] },
  { bin: "xclock", args: ["-title", "deskshell-smoke", "-geometry", "200x200+40+60"] },
];

async function spawnWindow(): Promise<{ kill: () => void; label: string }> {
  const errors: string[] = [];
  for (const attempt of ATTEMPTS) {
    if (!exists(attempt.bin)) continue;
    const child = spawn(attempt.bin, attempt.args, { detached: true, stdio: ["ignore", "ignore", "pipe"] });
    child.stderr?.on("data", (d: Buffer) => errors.push(`${attempt.bin}: ${String(d).trim()}`));
    for (let i = 0; i < 20; i++) {
      await sleep(300);
      const names = await listWindows();
      if (names.some((n) => /deskshell-smoke/i.test(n))) {
        return {
          label: attempt.bin,
          kill: () => {
            try {
              process.kill(-child.pid!, "SIGKILL");
            } catch {
              try {
                child.kill("SIGKILL");
              } catch {
                /* 已退出 */
              }
            }
          },
        };
      }
    }
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
  throw new Error(`没能创建测试窗口（试过 ${ATTEMPTS.map((a) => a.bin).join(" / ")}）：${errors.join(" | ").slice(0, 300)}`);
}

const app = await spawnWindow();
await sleep(1500);

try {
  const driver = new LinuxDriver();

  const windows = await driver.windows();
  check("枚举到窗口", windows.length >= 1, `${windows.length} 个`);
  const target = windows.find((w) => /deskshell-smoke/i.test(w.name));
  check("找到测试窗口", Boolean(target), windows.map((w) => w.name).join(" | "));

  if (target) {
    const ref = { pid: target.pid, titleRegex: "deskshell-smoke" };

    const tree = await driver.tree(ref);
    check("读树返回 Window 节点", tree.controlType === "Window" && tree.name.includes("deskshell-smoke"));
    check("树里有内容区子节点", Array.isArray(tree.children) && tree.children.length >= 1);

    const before = await driver.bounds!(ref);
    await driver.moveWindow!(ref, { x: 120, y: 90, w: 640, h: 380 });
    await sleep(600);
    const after = await driver.bounds!(ref);
    // X11 下几何不会精确等于请求值：窗口管理器加装饰边框，
    // xterm 还会按字符格取整。容差 40px 是"移动确实生效"的判据。
    check(
      "移动窗口后几何生效（容差 40，WM 装饰 + 字符格）",
      Math.abs(after.x - 120) <= 40 && Math.abs(after.y - 90) <= 40,
      JSON.stringify(after),
    );
    await driver.moveWindow!(ref, before);
    await sleep(400);
    const restored = await driver.bounds!(ref);
    check(
      "还原几何（同样容差）",
      Math.abs(restored.x - before.x) <= 40 &&
        Math.abs(restored.y - before.y) <= 40 &&
        Math.abs(restored.w - before.w) <= 40 &&
        Math.abs(restored.h - before.h) <= 40,
      `before=${JSON.stringify(before)} after=${JSON.stringify(restored)}`,
    );

    await driver.type(ref, { controlType: "Pane" }, "echo deskshell-linux\n");
    check("type 不抛错", true);
    await driver.keys(ref, "Return");
    check("keys 不抛错", true);

    let unsupported = "";
    try {
      await driver.click(ref, { controlType: "Pane" });
    } catch (err) {
      unsupported = String(err);
    }
    check("控件级 click 明确报不支持（而不是假装成功）", /不支持/.test(unsupported), unsupported.slice(0, 60));
  }
} finally {
  app.kill();
  await sleep(300);
}

console.log(checks.join("\n"));
console.log(`${checks.filter((c) => c.startsWith("PASS")).length}/${checks.length} passed`);
