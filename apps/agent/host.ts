import { startAgentService } from "../../packages/agent/src/service.ts";
const args = process.argv.slice(2);
let service: Awaited<ReturnType<typeof startAgentService>> | undefined;
try {
  if (args.length !== 4 || args[0] !== "--root" || args[2] !== "--state") throw new Error();
  service = await startAgentService({ root: args[1], stateDir: args[3] });
  const stop = (): void => { void service!.stop().catch(() => { process.exitCode = 1; }); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  await service.closed;
  process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
} catch { console.error("HOST_START_OR_STOP_FAILED"); process.exitCode = 1; }
