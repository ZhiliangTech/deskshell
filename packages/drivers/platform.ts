import type { UiDriver } from "../core/src/types.ts";

/** CLI 和 MCP 共用的驱动选择；实例化本身不会读取或操作桌面。 */
export async function createPlatformDriver(platform: NodeJS.Platform = process.platform): Promise<UiDriver> {
  switch (platform) {
    case "win32": {
      const { WindowsDriver } = await import("./windows/driver.ts");
      return new WindowsDriver();
    }
    case "darwin": {
      const { MacDriver } = await import("./macos/driver.ts");
      return new MacDriver();
    }
    case "linux": {
      const { LinuxDriver } = await import("./linux/driver.ts");
      return new LinuxDriver();
    }
    default:
      throw new Error(`当前平台还没有驱动实现：${platform}`);
  }
}

export function needsUiDriver(capabilities: readonly string[]): boolean {
  return capabilities.some((id) => id.startsWith("ui.") || id === "window.move");
}
