// 추가 기능 점검: 키 발급 → 승인 생성, 데모, 키 요청, 공개 데모 자격증명 차단, 랜딩
const { spawn } = require("child_process");
const srv = spawn("node", ["server.js"], { env: { ...process.env, PORT: 3997, BASE_URL: "http://localhost:3997", API_KEYS: "k1", DB_PATH: "/tmp/t2.db", SIGNING_SECRET: "s", ADMIN_SECRET: "adm" }, stdio: "inherit" });
const sleep = (ms) => new Promise(r=>setTimeout(r,ms));
(async () => {
  await sleep(700);
  const B = "http://localhost:3997";
  let r = await fetch(B + "/"); const html = await r.text(); console.log("landing", r.status, html.includes("Human approval for any automation"), html.includes("/v1/approvals"));
  r = await fetch(B + "/admin/keys", { method:"POST", headers:{ "content-type":"application/json", "x-admin-secret":"adm" }, body: JSON.stringify({ label:"steve@n8n-thread" }) });
  const k = await r.json(); console.log("admin key", r.status, k.key.startsWith("ah_"), k.slack_install_url.includes("?token="), !k.slack_install_url.includes(k.key));
  r = await fetch(B + "/v1/approvals", { method:"POST", headers:{ "content-type":"application/json", authorization:"Bearer "+k.key }, body: JSON.stringify({ question:"with db key" }) });
  console.log("db key works", r.status);
  r = await fetch(B + "/v1/approvals", { method:"POST", headers:{ "content-type":"application/json", authorization:"Bearer demo" }, body: JSON.stringify({ question:"x", channel:"slack", to:"C1" }) });
  console.log("public demo credential blocked", r.status);
  r = await fetch(B + "/demo", { method:"POST", headers:{ "content-type":"application/json" }, body: JSON.stringify({ question:"demo q" }) });
  const d = await r.json(); console.log("demo create", r.status, !!d.approve_url);
  await fetch(d.approve_url, { method:"POST", headers:{ "content-type":"application/x-www-form-urlencoded" }, body:"decision=approved&name=visitor" });
  const s = await (await fetch(d.status_url)).json(); console.log("demo status", s.status, s.decided_by, s.callback);
  r = await fetch(B + "/request-key", { method:"POST", headers:{ "content-type":"application/x-www-form-urlencoded" }, body:"email=a%40b.co&tool=n8n&note=refunds" });
  console.log("key request", r.status);
  const kr = await (await fetch(B + "/admin/key-requests", { headers:{ "x-admin-secret":"adm" } })).json(); console.log("key requests stored", kr.length, kr[0]?.email);
  r = await fetch(B + "/slack/install?key=" + k.key); console.log("slack install without client id →", r.status);
  srv.kill(); process.exit(0);
})().catch(e=>{ console.error(e); srv.kill(); process.exit(1); });
