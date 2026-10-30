import { ImapFlow } from "./.deps/node_modules/imapflow/dist/esm/imap-flow.js";
const c = new ImapFlow({ host: "imap.163.com", port: 993, secure: true, auth: { user: "13552586002@163.com", pass: "DQgCSptXub9EaW9B" }, logger: false, tls: { rejectUnauthorized: false }, clientInfo: { name: "deskshell-triage", version: "1.0.0", vendor: "deskshell" } });
await c.connect();
const want = /abrichr|richard\.abrich|openadapt|amrdab|clawdcursor|mailer-daemon|postmaster|undeliverable/i;
for (const box of ["INBOX", "已发送", "垃圾邮件"]) {
  let lock; try { lock = await c.getMailboxLock(box); } catch { continue; }
  try {
    const hits = [];
    for await (const m of c.fetch("1:*", { envelope: true, uid: true })) {
      const env = m.envelope || {};
      const from = (env.from || []).map(a => a.address || "").join(",");
      const hay = from + " " + (env.subject || "");
      if (want.test(hay)) hits.push({ uid: m.uid, env, from });
    }
    console.log(`\n== ${box}: 命中 ${hits.length}`);
    for (const h of hits.slice(-4)) {
      const m = await c.fetchOne(h.uid, { source: true }, { uid: true });
      const raw = m.source ? m.source.toString("utf8") : "";
      const body = raw.split(/\r?\n\r?\n/).slice(1).join("\n\n");
      console.log(`-- [${h.env.date ? new Date(h.env.date).toISOString().slice(0,16) : "?"}] ${h.from} | ${h.env.subject}`);
      console.log(body.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim().slice(0, 1200));
      console.log("");
    }
  } finally { if (lock) lock.release(); }
}
await c.logout();
