import { ImapFlow } from "./.deps/node_modules/imapflow/dist/esm/imap-flow.js";
const host = process.env.MAIL_HOST || "imap.163.com";
const user = process.env.MAIL_USER, pass = process.env.MAIL_PASS;
const client = new ImapFlow({ host, port: 993, secure: true, auth: { user, pass }, logger: false, tls: { rejectUnauthorized: false }, clientInfo: { name: "deskshell-triage", version: "1.0.0", vendor: "deskshell", supportUrl: "https://github.com/ZhiliangTech/deskshell" } });
try { await client.connect(); console.log("OK connected"); const m = await client.list(); console.log("boxes:", m.map(b=>b.path).join(", ")); }
catch (e) {
  console.log("FAIL", e.code || "", "|", e.message || "", "| responseText:", e.responseText || "", "| authFailed:", e.authenticationFailed);
}
finally { try { await client.logout(); } catch {} }
