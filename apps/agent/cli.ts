import path from "node:path";
import fs from "node:fs";
import { createPhotoFixture } from "../../packages/runtime/src/photo-task.ts";
import { createNotepadFixture } from "../../packages/runtime/src/notepad-task.ts";
import { callHost, IpcError } from "../../packages/agent/src/ipc.ts";
import { startAgentHost, stopAgentHost } from "../../packages/agent/src/host-client.ts";
import { NOTEPAD_PROFILE_RELEASE_READY } from "../../packages/drivers/windows/notepad-profile-selection.ts";

const help = `deskshell Windows 文件与应用智能体

npm run agent -- fixture [--deduplicate]
npm run agent -- host-start --root <目录> --state <独立状态目录>
npm run agent -- plan --root <目录> --state <状态目录> --intent <目标> --cloud [--deduplicate]
npm run agent -- inspect --root <目录> --state <状态目录> --plan <planId>
npm run agent -- apply --root <目录> --state <状态目录> --plan <planId> --digest <完整摘要>
npm run agent -- list --root <目录> --state <状态目录>
npm run agent -- status --root <目录> --state <状态目录> --task <taskId>
npm run agent -- cancel --root <目录> --state <状态目录> --task <taskId>
npm run agent -- undo --root <目录> --state <状态目录> --task <taskId>
npm run agent -- recovery-apply --root <目录> --state <状态目录> --recovery <recoveryId> --digest <完整摘要>
npm run agent -- budget --state <状态目录>
npm run agent -- budget-set --state <状态目录> --requests <每日次数> --usd <每日估算美元>
npm run agent -- host-status --state <状态目录>
npm run agent -- host-stop --state <状态目录>
npm run agent -- notepad-fixture
npm run agent -- notepad-probe --root <目录> --state <状态目录>
npm run agent -- notepad-plan --root <目录> --state <状态目录> --source <源文件> --copy <新副本> --text-file <UTF-8目标正文文件>
npm run agent -- notepad-inspect --root <目录> --state <状态目录> --plan <planId>
npm run agent -- notepad-apply --root <目录> --state <状态目录> --plan <planId> --digest <完整摘要>
npm run agent -- notepad-status --root <目录> --state <状态目录> --task <taskId>
npm run agent -- notepad-cancel --root <目录> --state <状态目录> --task <taskId>
npm run agent -- session-plan --root <目录> --state <状态目录> --plan <Notepad计划ID> --intent <目标> --cloud [--rounds 6]
npm run agent -- session-run --root <目录> --state <状态目录> --session <sessionId> --digest <完整摘要>
npm run agent -- session-status --root <目录> --state <状态目录> --session <sessionId>
npm run agent -- session-cancel --root <目录> --state <状态目录> --session <sessionId>

根层照片按修改时间、Asia/Shanghai 分月；--deduplicate 将完整字节相同的副本移到 _duplicates 待确认，保留名字排序最前的一份；不删除。
照片 --cloud 发送目标与固定技能说明；应用多轮另发送固定阶段、下一步和执行状态，不自动发送文件清单、路径或正文。
照片每次规划最多 1 请求/0.01 USD估算；应用会话3–10轮、5分钟、0.05 USD估算。每请求512输出token/30秒。
默认持久UTC日额度10请求/0.10 USD，不因重启重置；多轮只在一次精确摘要批准的固定正文和新副本范围内推进。
${NOTEPAD_PROFILE_RELEASE_READY ? "原生发行版配置已放行" : "原生发行版配置仍待放行"}；服务仅匹配记事本11.2607.14.0/zh-CN后选择，notepad-probe报告版本与放行状态。原生仅支持UTF-8无BOM。
每次宿主生命周期只执行一个原生文档任务；NOTEPAD_HOST_RESTART_REQUIRED时先host-stop，再host-start并重新规划。不会自动关闭应用窗口。
持续守卫期间任何桌面输入（包括其他应用）都会使当前执行失效；应用取消或中断后保留现场，不自动重放。
预览10分钟有效，apply明确批准同一摘要；undo只生成恢复预览，recovery-apply才明确批准恢复。
任务命令自动启动隐藏的本地宿主，任务记录跨进程保留；运行时可从另一终端status/cancel。
Ctrl+C请求停止后续动作，保留已产生效果。宿主不注册开机启动，用host-stop结束。
只支持有界文件树：2000节点/单文件16MiB/总64MiB。链接、覆盖和未知恢复效果均拒绝。`;
const command = process.argv[2] ?? "help";
const specs: Record<string, { required: string[]; optional?: string[] }> = {
  fixture: { required: [], optional: ["deduplicate"] },
  "host-start": { required: ["root", "state"] }, "host-stop": { required: ["state"] }, "host-status": { required: ["state"] },
  plan: { required: ["root", "state", "intent"], optional: ["cloud", "deduplicate"] },
  inspect: { required: ["root", "state", "plan"] }, apply: { required: ["root", "state", "plan", "digest"] },
  list: { required: ["root", "state"] }, status: { required: ["root", "state", "task"] }, cancel: { required: ["root", "state", "task"] },
  undo: { required: ["root", "state", "task"] }, "recovery-inspect": { required: ["root", "state", "recovery"] },
  "recovery-apply": { required: ["root", "state", "recovery", "digest"] },
  budget: { required: ["state"] }, "budget-set": { required: ["state", "requests", "usd"] },
  "notepad-fixture": { required: [] }, "notepad-probe": { required: ["root", "state"] },
  "notepad-plan": { required: ["root", "state", "source", "copy", "text-file"] },
  "notepad-inspect": { required: ["root", "state", "plan"] }, "notepad-apply": { required: ["root", "state", "plan", "digest"] },
  "notepad-list": { required: ["root", "state"] }, "notepad-status": { required: ["root", "state", "task"] }, "notepad-cancel": { required: ["root", "state", "task"] },
  "session-plan": { required: ["root", "state", "plan", "intent"], optional: ["cloud", "rounds"] },
  "session-run": { required: ["root", "state", "session", "digest"] }, "session-list": { required: ["root", "state"] },
  "session-status": { required: ["root", "state", "session"] }, "session-cancel": { required: ["root", "state", "session"] },
};
const flags = new Map<string, string | boolean>();
const emit = (value: unknown) => console.log(JSON.stringify(value, null, 2));
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
const required = (name: string): string => { const value = flags.get(name); if (typeof value !== "string" || !value.trim()) throw new IpcError("INVALID_ARGUMENTS"); return value; };
const controller = new AbortController();
let phase = "arguments";
let runningTask: string | undefined;
let cancellationMethod = "tasks.cancel";
let cancellationField = "taskId";
let stateDir: string | undefined;
let root: string | undefined;
let cancellation: Promise<unknown> | undefined;
const stop = (): void => {
  if (controller.signal.aborted) return;
  if (runningTask && stateDir && root) {
    cancellation = callHost(stateDir, cancellationMethod, { root, [cancellationField]: runningTask }).catch(() => { throw new IpcError("CANCEL_REQUEST_FAILED"); });
    void cancellation.catch(() => undefined);
  }
  controller.abort();
};
try {
  if (["help", "--help", "-h"].includes(command)) console.log(help);
  else {
    const spec = specs[command]; if (!spec) throw new IpcError("INVALID_ARGUMENTS");
    for (let i = 3; i < process.argv.length; i++) {
      const token = process.argv[i]; const name = token.slice(2);
      if (!token.startsWith("--") || ![...spec.required, ...(spec.optional ?? [])].includes(name) || flags.has(name)) throw new IpcError("INVALID_ARGUMENTS");
      if (["cloud", "deduplicate"].includes(name)) flags.set(name, true);
      else { const value = process.argv[++i]; if (!value || value.startsWith("--")) throw new IpcError("INVALID_ARGUMENTS"); flags.set(name, value); }
    }
    for (const key of spec.required) required(key);
    if (["plan", "session-plan"].includes(command) && flags.get("cloud") !== true) throw new IpcError("CLOUD_OPT_IN_REQUIRED");
    process.on("SIGINT", stop); process.on("SIGTERM", stop);
    if (command === "fixture") emit({ ...createPhotoFixture(undefined, { duplicate: flags.get("deduplicate") === true }), synthetic: true });
    else if (command === "notepad-fixture") {
      const fixture = createNotepadFixture();
      const textFile = path.join(fixture.fixture, "expected-text.txt"); fs.writeFileSync(textFile, fixture.expectedText, { flag: "wx", encoding: "utf8" });
      emit({ ...fixture, stateDir: path.join(fixture.fixture, "agent-state"), textFile, synthetic: true });
    }
    else {
      stateDir = path.resolve(required("state"));
      if (flags.has("root")) root = path.resolve(required("root"));
      phase = "host";
      if (root) await startAgentHost(root, stateDir);
      if (controller.signal.aborted) throw new IpcError("IPC_CANCELLED");
      if (command === "host-start" || command === "host-status") emit(await callHost(stateDir, "health"));
      else if (command === "host-stop") emit(await stopAgentHost(stateDir));
      else if (command === "budget") emit(await callHost(stateDir, "budget.get"));
      else if (command === "budget-set") emit(await callHost(stateDir, "budget.configure", { maxRequests: Number(required("requests")), maxEstimatedCostUsd: Number(required("usd")) }, { control: true }));
      else {
        phase = command;
        const base = { root };
        if (command.startsWith("notepad-") || command.startsWith("session-")) {
          const session = command.startsWith("session-");
          const family = session ? "sessions" : "notepad";
          const verb = command.slice(command.indexOf("-") + 1);
          if (verb === "probe") emit(await callHost(stateDir, "notepad.probe", base));
          else if (verb === "list") emit(await callHost(stateDir, `${family}.list`, base));
          else if (verb === "status" || verb === "cancel") emit(await callHost(stateDir, `${family}.${verb === "status" ? "get" : "cancel"}`, { ...base, [session ? "sessionId" : "taskId"]: required(session ? "session" : "task") }));
          else if (verb === "inspect") emit(await callHost(stateDir, "notepad.inspect", { ...base, planId: required("plan") }));
          else if (verb === "plan") {
            let result: any;
            if (session) result = await callHost(stateDir, "sessions.prepare", { ...base, planId: required("plan"), intent: required("intent"), cloud: true, maxRounds: flags.has("rounds") ? Number(required("rounds")) : 6 });
            else {
              const textPath = path.resolve(required("text-file")); const stat = fs.lstatSync(textPath);
              if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16_384) throw new IpcError("TEXT_FILE_LIMIT");
              const expectedText = new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(textPath));
              result = await callHost(stateDir, "notepad.prepare", { ...base, sourcePath: path.resolve(required("source")), copyPath: path.resolve(required("copy")), desired: { expectedText } });
            }
            emit({ ...result, nextCommand: `npm run agent -- ${session ? "session-run" : "notepad-apply"} --root ${quote(root!)} --state ${quote(stateDir)} --${session ? "session" : "plan"} ${quote(session ? result.sessionId : result.planId)} --digest ${quote(result.digest)}` });
          } else {
            const preview = await callHost(stateDir, session ? "sessions.get" : "notepad.inspect", { ...base, [session ? "sessionId" : "planId"]: required(session ? "session" : "plan") });
            runningTask = session ? preview.sessionId : preview.taskId;
            cancellationMethod = `${family}.cancel`; cancellationField = session ? "sessionId" : "taskId";
            if (controller.signal.aborted) throw new IpcError("IPC_CANCELLED");
            const result = await callHost(stateDir, session ? "sessions.run" : "notepad.apply", { ...base, [session ? "sessionId" : "planId"]: required(session ? "session" : "plan"), digest: required("digest") }, { control: true, timeoutMs: 360_000 });
            if (cancellation) await cancellation;
            emit(result); if (result.status !== "succeeded") process.exitCode = result.status === "cancelled" ? 130 : 1;
          }
        } else if (command === "plan") {
          const result = await callHost(stateDir, "tasks.plan", { ...base, intent: required("intent"), cloud: true, deduplicate: flags.get("deduplicate") === true }, { signal: controller.signal });
          emit({ ...result, nextCommand: `npm run agent -- apply --root ${quote(root!)} --state ${quote(stateDir)} --plan ${quote(result.planId)} --digest ${quote(result.digest)}` });
        } else if (command === "inspect") emit(await callHost(stateDir, "tasks.inspect", { ...base, planId: required("plan") }));
        else if (command === "list") emit(await callHost(stateDir, "tasks.list", base));
        else if (command === "status" || command === "cancel") emit(await callHost(stateDir, command === "status" ? "tasks.get" : "tasks.cancel", { ...base, taskId: required("task") }));
        else if (command === "undo") emit(await callHost(stateDir, "recovery.prepare", { ...base, taskId: required("task") }));
        else if (command === "recovery-inspect") emit(await callHost(stateDir, "recovery.inspect", { ...base, recoveryId: required("recovery") }));
        else {
          const recovery = command === "recovery-apply";
          const plan = await callHost(stateDir, recovery ? "recovery.inspect" : "tasks.inspect", { ...base, ...(recovery ? { recoveryId: required("recovery") } : { planId: required("plan") }) });
          runningTask = plan.taskId;
          if (controller.signal.aborted) throw new IpcError("IPC_CANCELLED");
          const result = await callHost(stateDir, recovery ? "recovery.apply" : "tasks.apply", { ...base, digest: required("digest"), ...(recovery ? { recoveryId: required("recovery") } : { planId: required("plan") }) }, { control: true, timeoutMs: 120_000 });
          if (cancellation) await cancellation;
          emit(result);
          if (!(recovery ? ["undone", "restored"] : ["succeeded"]).includes(result.status)) process.exitCode = result.status === "cancelled" ? 130 : 1;
        }
      }
    }
  }
} catch (error) {
  const code = error instanceof IpcError ? error.code : "LOCAL_OPERATION_FAILED";
  emit({ ok: false, phase, code, ...(code === "NOTEPAD_HOST_RESTART_REQUIRED" ? { nextAction: "Stop this host, start it again, and prepare a new Notepad plan. Existing application windows remain open." } : {}) }); process.exitCode = ["CANCELLED", "IPC_CANCELLED"].includes(code) ? 130 : 1;
} finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
