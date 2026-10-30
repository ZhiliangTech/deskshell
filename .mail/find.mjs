import { ImapFlow } from "./.deps/node_modules/imapflow/dist/esm/imap-flow.js";
const c = new ImapFlow({ host: "imap.163.com", port: 993, secure: true, auth: { user: "13552586002@163.com", pass: "DQgCSptXub9EaW9B" }, logger: false, tls: { rejectUnauthorized: false }, clientInfo: { name: "deskshell-triage", version: "1.0.0", vendor: "deskshell" } });
await c.connect();
const queries = [
  ["INBOX", { or: [{ from: "abrichr" }, { from: "richard.abrich" }, { subject: "OpenAdapt" }] }],
  ["INBOX", { from: "AmrDab" }],
  ["已发送", { subject: "OpenAdapt" }],
  ["INBOX", { or: [{ from: "mailer-daemon" }, { from: "postmaster" }, { subject: "Undelivered" }] }],
];
for (const [box, q] of queries) {
  let lock; try { lock = await c.getMailboxLock(box); } catch (e) { console.log("skip", box, String(e.message).slice(0,60)); continue; }
  try {
    const uids = await c.search(q, { uid: true });
    console.log(`\n== ${box} 命中 ${uids.length} 封`);
    for (const uid of uids.slice(-3)) {
      const m = await c.fetchOne(uid, { envelope: true, source: true }, { uid: true });
      const env = m.envelope || {};
      const from = (env.from || []).map(a => `${a.name || ""} <${a.address}>`).join(", ");
      let body = "";
      if (m.source) {
        const raw = m.source.toString("utf8");
        body = raw.split(/\r?\n\r?\n/).slice(1).join("\n\n");
      }
      console.log(`-- [${env.date ? new Date(env.date).toISOString().slice(0,16) : "?"}] ${from} | ${env.subject}`);
      console.log(body.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim().slice(0, 900));
      console.log("");
    }
  } finally { if (lock) lock.release(); }
}
await c.logout();
