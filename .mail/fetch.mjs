import { ImapFlow } from "./.deps/node_modules/imapflow/dist/esm/imap-flow.js";

const host = process.env.MAIL_HOST || "imap.163.com";
const user = process.env.MAIL_USER;
const pass = process.env.MAIL_PASS;
const days = Number(process.env.MAIL_DAYS || 3);
if (!user || !pass) { console.error("need MAIL_USER / MAIL_PASS"); process.exit(2); }

const client = new ImapFlow({ host, port: 993, secure: true, auth: { user, pass }, logger: false, tls: { rejectUnauthorized: false } });
try {
  await client.connect();
  console.log("connected as", user, "@", host);
  const boxes = await client.list();
  console.log("mailboxes:", boxes.map(b => b.path).join(", "));
  const since = new Date(Date.now() - days * 86400000);
  for (const box of boxes) {
    if (!/inbox|junk|spam|垃圾|广告/i.test(box.path)) continue;
    let lock;
    try { lock = await client.getMailboxLock(box.path); } catch (e) { console.log("skip", box.path, String(e.message).slice(0,60)); continue; }
    try {
      const msgs = await client.search({ since }, { uid: true });
      console.log(`\n== ${box.path}: ${msgs.length} 封（近 ${days} 天）`);
      for (const uid of msgs.slice(-25)) {
        const m = await client.fetchOne(uid, { envelope: true, bodyStructure: false, source: false }, { uid: true });
        const env = m.envelope || {};
        const from = (env.from || []).map(a => `${a.name || ""} <${a.address}>`).join(", ");
        const subj = env.subject || "";
        console.log(`  [${env.date ? new Date(env.date).toISOString().slice(0,16) : "?"}] ${from} | ${subj}`);
      }
    } catch (e) { console.log("fetch error", box.path, String(e.message).slice(0,100)); }
    finally { if (lock) lock.release(); }
  }
} catch (e) {
  console.log("CONNECT FAILED:", String(e.message).slice(0, 300));
} finally {
  try { await client.logout(); } catch {}
}
