import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { DeepSeekBackend } from "../../models/src/deepseek.ts";
import { ModelBudget } from "../../models/src/budget.ts";
import { loadDeepSeekApiKey } from "../../models/src/credentials.ts";
import { PHOTO_MODEL_LIMITS, openPhotoHost, preparePhotoTask, inspectPhotoPlan, applyPhotoPlan, photoPreview } from "./photo-agent.ts";
import type { ProposalBackend } from "./photo-agent.ts";
import { ensurePrivateState, validateHostDirectories } from "./private-state.ts";
import { IpcError, readEndpoint } from "./ipc.ts";
import type { HostEndpoint } from "./ipc.ts";
import { createNotepadTaskHost } from "../../runtime/src/notepad-task.ts";
import type { NotepadDriver } from "../../runtime/src/notepad-task.ts";
import { createServiceNotepadDriver } from "../../drivers/windows/notepad-profile-selection.ts";
import type { SelectedNotepadDriver, ServiceNotepadDriver } from "../../drivers/windows/notepad-profile-selection.ts";
import { createAutonomyHost } from "./autonomy.ts";
import { createNotepadAutonomyAdapter, notepadEnvelope } from "./notepad-agent.ts";

const object = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const requireFields = (v: unknown, allowed: string[], required: string[] = []): Record<string, any> => {
  if (!object(v) || Object.keys(v).some((key) => !allowed.includes(key)) || required.some((key) => !Object.hasOwn(v, key))) throw new IpcError("INVALID_REQUEST");
  return v;
};
const string = (v: unknown): string => { if (typeof v !== "string" || !v.trim() || v.length > 32_768) throw new IpcError("INVALID_REQUEST"); return v; };
const safeCode = (error: unknown): string => object(error) && typeof error.code === "string" && /^[A-Z0-9_]{1,80}$/.test(error.code) ? error.code : error instanceof Error && "code" in error && typeof error.code === "string" && /^[A-Z0-9_]{1,80}$/.test(error.code) ? error.code : "HOST_OPERATION_FAILED";
const matching = (supplied: string, expected: string): boolean => {
  const a = Buffer.from(supplied); const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

/** One authenticated loopback host per private state directory. Same-account code is trusted, not sandboxed. */
export async function startAgentService(options: {
  root: string; stateDir: string;
  /** Trusted in-process dependency for offline tests; never configurable through IPC or environment. */
  backendFactory?: (budget: ModelBudget) => Promise<ProposalBackend> | ProposalBackend;
  /** Trusted test dependency; production shares one current-user budget across host directories. */
  budgetDir?: string;
  /** Trusted test dependency only. IPC callers cannot supply drivers or native profiles. */
  notepadDriver?: NotepadDriver;
  /** Trusted offline seam for the production lifecycle; never accepted through IPC/environment. */
  nativeNotepadFactory?: () => SelectedNotepadDriver;
}) {
  validateHostDirectories(options.root, options.stateDir);
  const root = fs.realpathSync.native(path.resolve(options.root));
  const budgetDir = options.budgetDir ?? path.join(process.platform === "win32" ? process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local") : path.join(os.homedir(), ".local", "share"), "deskshell", "model-budget");
  validateHostDirectories(root, budgetDir);
  const stateDir = ensurePrivateState(options.stateDir);
  const host = openPhotoHost(root, stateDir);
  let budget: ModelBudget;
  try { budget = new ModelBudget(ensurePrivateState(budgetDir)); } catch (error) { host.close(); throw error; }
  const endpoint: HostEndpoint = { version: 1, instanceId: randomUUID(), pid: process.pid, port: 0, root, taskToken: randomBytes(32).toString("hex"), controlToken: randomBytes(32).toString("hex") };
  const active = new Set<Promise<unknown>>();
  const planning = new Set<AbortController>();
  let closing = false;
  let mutationTask: string | undefined;
  let application: ReturnType<typeof createNotepadTaskHost> | undefined;
  let autonomy: ReturnType<typeof createAutonomyHost> | undefined;
  let nativeDriver: ServiceNotepadDriver | undefined;
  let nativeSelection: SelectedNotepadDriver["selection"] | undefined;
  let nativeTaskId: string | undefined;
  const productionDriver = (): ServiceNotepadDriver => {
    if (closing && !nativeDriver) throw new IpcError("HOST_STOPPING");
    if (!nativeDriver) {
      const selected = (options.nativeNotepadFactory ?? createServiceNotepadDriver)();
      nativeDriver = selected.driver; nativeSelection = selected.selection;
    }
    return nativeDriver;
  };
  const assertNativeTask = (taskId?: string, claim = false): void => {
    if (options.notepadDriver) return;
    if (nativeTaskId && nativeTaskId !== taskId) throw new IpcError("NOTEPAD_HOST_RESTART_REQUIRED");
    if (claim) nativeTaskId ??= taskId;
  };
  const applicationHost = () => {
    if (closing && !application) throw new IpcError("HOST_STOPPING");
    return application ??= createNotepadTaskHost({ dataDir: path.join(stateDir, "notepad"), allowedRoots: [root], driver: options.notepadDriver ?? productionDriver() });
  };
  const autonomyHost = () => {
    if (closing && !autonomy) throw new IpcError("HOST_STOPPING");
    return autonomy ??= createAutonomyHost({
    dataDir: ensurePrivateState(path.join(stateDir, "autonomy")), adapter: createNotepadAutonomyAdapter(applicationHost(), root),
    backendFactory: async ({ remainingRounds }) => options.backendFactory ? options.backendFactory(budget) : new DeepSeekBackend({ apiKey: await loadDeepSeekApiKey(), limits: { maxRequests: remainingRounds, maxInputBytes: 16_384, maxOutputTokens: 512, timeoutMs: 30_000, maxEstimatedCostUsd: 0.05 }, budget }),
    });
  };
  let shutdownAttempt: Promise<void> | undefined;
  let stopped = false;
  let shutdownError: string | undefined;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
  const track = <T>(promise: Promise<T>): Promise<T> => {
    active.add(promise); void promise.finally(() => { active.delete(promise); }).catch(() => undefined); return promise;
  };
  const mutate = (taskId: string, operation: () => Promise<unknown>, current: () => unknown = () => host.tasks.get(taskId)): Promise<unknown> => {
    if (mutationTask) {
      if (mutationTask === taskId) return Promise.resolve(current());
      throw new IpcError("HOST_BUSY");
    }
    mutationTask = taskId;
    return track(Promise.resolve().then(() => {
      if (closing) throw new IpcError("HOST_STOPPING");
      return operation();
    }).finally(() => { mutationTask = undefined; }));
  };
  const assertRoot = (value: unknown): void => {
    const selected = path.resolve(string(value));
    if (process.platform === "win32" ? selected.toLowerCase() !== root.toLowerCase() : selected !== root) throw new IpcError("PLAN_SCOPE_MISMATCH");
  };
  const taskFor = (taskId: unknown) => {
    const task = host.tasks.get(string(taskId)); inspectPhotoPlan(host, root, task.planId); return task;
  };
  const stopWork = async (): Promise<void> => {
    closing = true;
    try {
    for (const controller of planning) controller.abort();
    for (const session of autonomy?.sessions.list() ?? []) if (["ready", "running", "paused", "cancelling"].includes(session.status)) autonomy!.sessions.cancel(session.sessionId);
    for (const task of application?.tasks.list() ?? []) if (["ready", "running", "paused", "cancelling"].includes(task.status)) application!.tasks.cancel(task.taskId);
    for (const task of host.tasks.list()) if (["ready", "running", "cancelling", "recovering"].includes(task.status)) { try { host.tasks.cancel(task.taskId); } catch { /* Preserve persisted uncertainty. */ } }
    // Closing a driver terminates its helper transport, never the user's Notepad process.
    nativeDriver?.close(); nativeDriver = undefined;
    await Promise.allSettled([...active]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    // Preflight both stores before closing either one, preserving inspection on an incomplete stop.
    autonomy?.assertIdle(); application?.assertIdle();
    autonomy?.close(); autonomy = undefined;
    application?.close(); application = undefined;
    host.close(); budget.close();
    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeIdleConnections(); });
        try {
          if (readEndpoint(stateDir).instanceId === endpoint.instanceId) fs.unlinkSync(path.join(stateDir, "host-endpoint.json"));
        } catch { /* Missing/replaced discovery must not remove another host's file. */ }
        stopped = true; resolveClosed();
    } catch {
      // Keep discovery and inspection available when unknown in-flight effects cannot be drained.
      shutdownError = "HOST_STOP_INCOMPLETE";
      throw new IpcError("HOST_STOP_INCOMPLETE");
    }
  };
  const stop = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (shutdownAttempt) return shutdownAttempt;
    shutdownError = undefined;
    shutdownAttempt = stopWork().finally(() => { shutdownAttempt = undefined; });
    return shutdownAttempt;
  };
  const dispatch = async (method: string, raw: unknown, control: boolean, response: http.ServerResponse): Promise<unknown> => {
    if (closing && !["health", "host.shutdown", "tasks.get", "tasks.list", "tasks.cancel", "notepad.get", "notepad.list", "notepad.cancel", "sessions.get", "sessions.list", "sessions.cancel"].includes(method)) throw new IpcError("HOST_STOPPING");
    if (["tasks.apply", "recovery.apply", "notepad.apply", "sessions.run", "host.shutdown", "budget.configure"].includes(method) && !control) throw new IpcError("CONTROL_REQUIRED");
    if (active.size >= 16 && ["tasks.plan", "tasks.apply", "recovery.prepare", "recovery.apply", "notepad.prepare", "notepad.apply", "sessions.prepare", "sessions.run"].includes(method)) throw new IpcError("HOST_BUSY");
    if (method === "health") { requireFields(raw, []); return { version: 1, instanceId: endpoint.instanceId, pid: process.pid, root, stateDir, closing, activeOperations: active.size, ...(shutdownError ? { shutdownError } : {}) }; }
    if (method === "host.shutdown") {
      requireFields(raw, []); closing = true;
      setImmediate(() => { void stop().catch(() => { /* health exposes incomplete shutdown; preserve discovery. */ }); });
      return { stopping: true };
    }
    if (method === "budget.get") { requireFields(raw, []); return budget.snapshot(); }
    if (method === "budget.configure") {
      const p = requireFields(raw, ["maxRequests", "maxEstimatedCostUsd"], ["maxRequests", "maxEstimatedCostUsd"]);
      budget.configure({ maxRequests: p.maxRequests, maxEstimatedCostUsd: p.maxEstimatedCostUsd }); return budget.snapshot();
    }
    if (method.startsWith("notepad.") || method.startsWith("sessions.")) {
      const p = requireFields(raw, ["root", "taskId", "planId", "digest", "sourcePath", "copyPath", "desired", "sessionId", "intent", "maxRounds", "cloud"], ["root"]); assertRoot(p.root);
      if (method === "notepad.probe") {
        requireFields(p, ["root"]);
        if (options.notepadDriver) return { driver: "injected", capabilities: options.notepadDriver.capabilities };
        const probe = await track(productionDriver().probe({ readOnly: true }));
        const { profile: _privateProfile, ...selection } = nativeSelection!;
        return { ...probe, runtimeVerified: false, profileSelection: selection, restartRequired: nativeTaskId !== undefined,
          reasons: [...new Set([...probe.reasons, ...selection.reasons, ...(nativeTaskId ? ["NOTEPAD_HOST_RESTART_REQUIRED"] : [])])] };
      }
      const app = applicationHost();
      if (method === "notepad.prepare") { requireFields(p, ["root", "sourcePath", "copyPath", "desired"], ["sourcePath", "copyPath", "desired"]); assertNativeTask(); return await track(app.tasks.prepare({ sourcePath: string(p.sourcePath), copyPath: string(p.copyPath), desired: p.desired })); }
      if (method === "notepad.list") { requireFields(p, ["root"]); return app.tasks.list(); }
      if (method === "notepad.get" || method === "notepad.cancel") { requireFields(p, ["root", "taskId"], ["taskId"]); return method === "notepad.get" ? app.tasks.get(string(p.taskId)) : app.tasks.cancel(string(p.taskId)); }
      if (method === "notepad.inspect") { requireFields(p, ["root", "planId"], ["planId"]); return app.tasks.inspect(string(p.planId)); }
      if (method === "notepad.apply") {
        requireFields(p, ["root", "planId", "digest"], ["planId", "digest"]);
        const plan = app.tasks.inspect(string(p.planId)); if (string(p.digest) !== plan.digest) throw new IpcError("DIGEST_MISMATCH");
        const current = () => app.tasks.get(plan.taskId);
        const state = current().status;
        // running/cancelling 时静默返回快照等于让用户以为 apply 没生效：明确报状态
        if (state === "running" || state === "cancelling") throw new IpcError("TASK_STATE");
        if (!["awaiting_approval", "ready"].includes(state)) return current();
        assertNativeTask(plan.taskId);
        return await mutate(`notepad:${plan.taskId}`, async () => {
          assertNativeTask(plan.taskId);
          const receipt = app.approvals.approve(plan.planId, plan.digest);
          assertNativeTask(plan.taskId, true);
          return await app.tasks.execute({ planId: plan.planId, digest: plan.digest, approvalReceiptId: receipt.approvalId });
        }, current);
      }
      const sessions = autonomyHost();
      if (method === "sessions.prepare") {
        requireFields(p, ["root", "planId", "intent", "maxRounds", "cloud"], ["planId", "intent", "cloud"]);
        if (p.cloud !== true) throw new IpcError("CLOUD_OPT_IN_REQUIRED");
        const plan = app.tasks.inspect(string(p.planId));
        assertNativeTask(plan.taskId);
        if (app.tasks.get(plan.taskId).status !== "awaiting_approval") throw new IpcError("TASK_STATE");
        const prepared = sessions.sessions.prepare(notepadEnvelope(plan, string(p.intent), p.maxRounds ?? 6));
        // 批准的是"要写进副本的正文"，不是一串摘要。把 notepad plan 的 preview 一并交回，
        // 人工在 session-run 之前能逐字核对；摘要本身已经覆盖 plan.digest。
        return { ...prepared, preview: (plan as { preview?: unknown }).preview ?? null };
      }
      if (method === "sessions.list") { requireFields(p, ["root"]); return sessions.sessions.list(); }
      if (method === "sessions.get" || method === "sessions.cancel") { requireFields(p, ["root", "sessionId"], ["sessionId"]); return method === "sessions.get" ? sessions.sessions.inspect(string(p.sessionId)) : sessions.sessions.cancel(string(p.sessionId)); }
      if (method === "sessions.run") {
        requireFields(p, ["root", "sessionId", "digest"], ["sessionId", "digest"]);
        const id = string(p.sessionId); const digest = string(p.digest); const current = () => sessions.sessions.inspect(id);
        if (current().digest !== digest) throw new IpcError("DIGEST_MISMATCH");
        const sessionState = current().status;
        if (sessionState === "running" || sessionState === "cancelling") throw new IpcError("SESSION_STATE");
        if (!["awaiting_approval", "ready"].includes(sessionState)) return current();
        const reference = current().prepared.envelope.resources.plan as { planId: string; digest: string };
        const plan = app.tasks.inspect(string(reference.planId));
        if (reference.digest !== plan.digest) throw new IpcError("DIGEST_MISMATCH");
        assertNativeTask(plan.taskId);
        return await mutate(`session:${id}`, async () => {
          assertNativeTask(plan.taskId);
          const receipt = sessions.approvals.approve(id, digest);
          assertNativeTask(plan.taskId, true);
          return await sessions.sessions.run({ sessionId: id, digest, approvalReceiptId: receipt.approvalId });
        }, current);
      }
      throw new IpcError("UNKNOWN_METHOD");
    }
    const p = requireFields(raw, ["root", "taskId", "planId", "digest", "intent", "cloud", "deduplicate", "recoveryId"], ["root"]);
    assertRoot(p.root);
    if (method === "tasks.list") { requireFields(p, ["root"]); return host.tasks.list(); }
    if (method === "tasks.get") { requireFields(p, ["root", "taskId"], ["taskId"]); return taskFor(p.taskId); }
    if (method === "tasks.cancel") { requireFields(p, ["root", "taskId"], ["taskId"]); return host.tasks.cancel(taskFor(p.taskId).taskId); }
    if (method === "tasks.inspect") {
      requireFields(p, ["root", "planId"], ["planId"]);
      const plan = inspectPhotoPlan(host, root, string(p.planId)); return { ...photoPreview(plan), task: host.tasks.get(plan.taskId) };
    }
    if (method === "tasks.plan") {
      requireFields(p, ["root", "intent", "cloud", "deduplicate"], ["intent", "cloud"]);
      if (p.cloud !== true) throw new IpcError("CLOUD_OPT_IN_REQUIRED");
      if (p.deduplicate !== undefined && typeof p.deduplicate !== "boolean") throw new IpcError("INVALID_REQUEST");
      const intent = string(p.intent); const controller = new AbortController(); planning.add(controller);
      const disconnected = (): void => { if (!response.writableEnded) controller.abort(); };
      response.on("close", disconnected);
      try {
        const work = (async () => {
          const backend = options.backendFactory ? await options.backendFactory(budget) : new DeepSeekBackend({ apiKey: await loadDeepSeekApiKey(), limits: { ...PHOTO_MODEL_LIMITS }, budget });
          if (controller.signal.aborted) throw new IpcError("CANCELLED");
          const result = await preparePhotoTask({ host, root, stateDir, intent, backend, deduplicate: p.deduplicate === true, signal: controller.signal });
          return { ...photoPreview(result.plan), model: result.model };
        })();
        return await track(work);
      } finally { planning.delete(controller); response.off("close", disconnected); }
    }
    if (method === "tasks.apply") {
      requireFields(p, ["root", "planId", "digest"], ["planId", "digest"]);
      const plan = inspectPhotoPlan(host, root, string(p.planId));
      if (string(p.digest) !== plan.digest) throw new IpcError("DIGEST_MISMATCH");
      return await mutate(plan.taskId, () => applyPhotoPlan(host, root, plan.planId, plan.digest));
    }
    if (method === "recovery.prepare") {
      requireFields(p, ["root", "taskId"], ["taskId"]); const task = taskFor(p.taskId);
      return await track(host.tasks.prepareRecovery(task.taskId));
    }
    if (method === "recovery.inspect") {
      requireFields(p, ["root", "recoveryId"], ["recoveryId"]);
      const plan = host.tasks.inspectRecovery(string(p.recoveryId)); taskFor(plan.taskId); return plan;
    }
    if (method === "recovery.apply") {
      requireFields(p, ["root", "recoveryId", "digest"], ["recoveryId", "digest"]);
      const plan = host.tasks.inspectRecovery(string(p.recoveryId)); const task = taskFor(plan.taskId);
      if (string(p.digest) !== plan.digest) throw new IpcError("DIGEST_MISMATCH");
      if (["undone", "restored"].includes(task.status)) return task;
      return await mutate(plan.taskId, () => {
        const approval = host.approvals.approveRecovery(plan.recoveryId, plan.digest);
        return host.tasks.recover({ recoveryId: plan.recoveryId, digest: plan.digest, approvalReceiptId: approval.approvalId });
      });
    }
    throw new IpcError("UNKNOWN_METHOD");
  };
  const server = http.createServer({ maxHeaderSize: 8192 }, (request, response) => {
    const reply = (status: number, data: unknown): void => {
      if (response.destroyed || response.writableEnded) return;
      response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      response.end(JSON.stringify(data));
    };
    void (async () => {
      if (request.method !== "POST" || request.url !== "/rpc" || request.headers.origin !== undefined
          || request.headers.host !== `127.0.0.1:${endpoint.port}` || request.headers["content-type"] !== "application/json") { request.resume(); reply(403, { ok: false, code: "IPC_REJECTED" }); return; }
      const auth = request.headers.authorization ?? "";
      const control = matching(auth, `Bearer ${endpoint.controlToken}`);
      if (!control && !matching(auth, `Bearer ${endpoint.taskToken}`)) { request.resume(); reply(401, { ok: false, code: "UNAUTHORIZED" }); return; }
      let size = 0; const chunks: Buffer[] = [];
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 65_536) { reply(413, { ok: false, code: "REQUEST_LIMIT" }); request.destroy(); return; }
        chunks.push(chunk);
      }
      let id: string | null = null;
      try {
        const data = requireFields(JSON.parse(Buffer.concat(chunks, size).toString("utf8")), ["version", "instanceId", "id", "method", "params"], ["version", "instanceId", "id", "method", "params"]);
        if (data.version !== 1 || data.instanceId !== endpoint.instanceId || typeof data.id !== "string" || !/^[a-f0-9-]{36}$/.test(data.id)) throw new IpcError("INVALID_REQUEST");
        id = data.id;
        const result = await dispatch(string(data.method), data.params, control, response);
        reply(200, { ok: true, id, instanceId: endpoint.instanceId, result });
      } catch (error) { reply(200, { ok: false, id, instanceId: endpoint.instanceId, code: safeCode(error) }); }
    })().catch(() => { reply(400, { ok: false, code: "INVALID_REQUEST" }); });
  });
  server.headersTimeout = 10_000; server.requestTimeout = 15_000; server.keepAliveTimeout = 1000; server.maxConnections = 64;
  server.on("clientError", (_error, socket) => { socket.destroy(); });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
    const address = server.address(); if (!address || typeof address === "string") throw new IpcError("HOST_BIND_FAILED");
    endpoint.port = address.port;
    const file = path.join(stateDir, "host-endpoint.json"); const temporary = path.join(stateDir, `endpoint-${endpoint.instanceId}.tmp`);
    fs.writeFileSync(temporary, JSON.stringify(endpoint), { flag: "wx", mode: 0o600 }); fs.renameSync(temporary, file);
  } catch (error) { server.close(); host.close(); budget.close(); throw error; }
  return { root, stateDir, instanceId: endpoint.instanceId, port: endpoint.port, closed, stop };
}
