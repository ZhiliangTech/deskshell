
for (let i = 0; i < 4; i++) {
  const r = await fetch("https://registry.npmjs.org/deskshell?t=" + Date.now(), { headers: { "cache-control": "no-cache" } });
  const j = await r.json();
  const v = j.versions ? Object.keys(j.versions).join(",") : "?";
  console.log(new Date().toISOString().slice(11,19), r.status, "versions:", v, "| latest:", j["dist-tags"] && j["dist-tags"].latest);
  if (v.includes("0.11.0")) break;
  await new Promise(r => setTimeout(r, 15000));
}
