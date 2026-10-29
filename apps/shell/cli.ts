import { apply, cancel, listShellSkills, matchSkills, preview } from "./core.ts";
import { resolveIntent } from "./intent.ts";

/**
 * 桌面壳的 CLI 胶水：UI（PowerShell）只负责画界面，
 * 所有判断都走这里，输出 JSON 方便 UI 解析。
 */
const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const emit = (obj: unknown): void => {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
};

try {
  if (cmd === "skills") {
    emit({ ok: true, skills: listShellSkills().map((s) => ({ name: s.name, description: s.description })) });
  } else if (cmd === "match") {
    const query = argv[1] ?? "";
    const skills = matchSkills(query);
    emit({
      ok: true,
      query,
      matches: skills.slice(0, 5).map((m) => ({
        name: m.skill.name,
        description: m.skill.description,
        score: m.score,
        capabilities: m.skill.capabilities,
      })),
      empty: skills.length === 0,
    });
  } else if (cmd === "plan") {
    const query = argv.slice(1).filter((a) => !a.startsWith("--")).join(" ");
    const intent = await resolveIntent(query);
    emit({ ok: true, query, intent });
  } else if (cmd === "preview" || cmd === "apply") {
    const name = argv[1];
    const root = flag("root") ?? process.cwd();
    const argsRaw = flag("args");
    const args = argsRaw ? (JSON.parse(argsRaw) as Record<string, unknown>) : {};
    const found = listShellSkills().find((s) => s.name === name);
    if (!found) {
      emit({ ok: false, error: `没有这个技能：${name}` });
    } else if (cmd === "preview") {
      const p = await preview(found, { root, args });
      emit({ ok: true, ...p });
    } else {
      const r = await apply(found, { root, args });
      emit({ ok: true, ...r });
    }
  } else if (cmd === "cancel") {
    emit({ ok: true, ...cancel() });
  } else {
    emit({ ok: false, error: `未知命令：${cmd ?? "(空)"}` });
    process.exitCode = 2;
  }
} catch (err) {
  emit({ ok: false, error: err instanceof Error ? err.message : String(err) });
  process.exitCode = 1;
}
