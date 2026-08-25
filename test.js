// 로컬 통합 테스트: 승인 생성 → 웹 POST로 승인 → 콜백 수신 → 멱등성 → 타임아웃
const http = require("http");
const { spawn } = require("child_process");
const received = [];
const cb = http.createServer((req, res) => { let b=""; req.on("data",d=>b+=d); req.on("end",()=>{ received.push({hdr:req.headers, body:JSON.parse(b)}); res.writeHead(200); res.end("ok"); }); }).listen(3999);
const srv = spawn("node", ["server.js"], { env: { ...process.env, PORT: 3998, BASE_URL: "http://localhost:3998", API_KEYS: "k1", DB_PATH: "/tmp/t.db", SIGNING_SECRET: "s" }, stdio: "inherit" });
const sleep = (ms) => new Promise(r=>setTimeout(r,ms));
(async () => {
  await sleep(700);
  const H = { "content-type": "application/json", authorization: "Bearer k1" };
  // 1. 생성
  let r = await fetch("http://localhost:3998/v1/approvals", { method:"POST", headers:H, body: JSON.stringify({ question:"환불 35만원 승인?", context:{order:"A-1"}, callback_url:"http://localhost:3999/resume", timeout_minutes: 60 }) });
  const a = await r.json(); console.log("create", r.status, a.status, a.approve_url);
  // 2. GET은 결정하지 않음
  r = await fetch(a.approve_url); const html = await r.text(); console.log("GET page has form:", html.includes("<form"));
  let s = await (await fetch(`http://localhost:3998/v1/approvals/${a.id}`, { headers:H })).json(); console.log("after GET still", s.status);
  // 3. POST 승인
  r = await fetch(a.approve_url, { method:"POST", headers:{ "content-type":"application/x-www-form-urlencoded" }, body:"decision=approved&name=민수&comment=ok" });
  console.log("POST approve", r.status, (await r.text()).includes("Already recorded"));
  await sleep(300);
  s = await (await fetch(`http://localhost:3998/v1/approvals/${a.id}`, { headers:H })).json(); console.log("status", s.status, s.decided_by);
  console.log("callback received", received.length, received[0]?.body.approved, "sig?", !!received[0]?.hdr["x-approval-signature"]);
  // 4. 두 번째 클릭 → 멱등
  r = await fetch(a.approve_url, { method:"POST", headers:{ "content-type":"application/x-www-form-urlencoded" }, body:"decision=rejected" });
  await sleep(300);
  s = await (await fetch(`http://localhost:3998/v1/approvals/${a.id}`, { headers:H })).json(); console.log("second click keeps", s.status, "callbacks still", received.length);
  // 5. 타임아웃 (아주 짧게) — 스윕 30초라 직접 DB 조작 대신 timeout_minutes 소수 허용 확인
  r = await fetch("http://localhost:3998/v1/approvals", { method:"POST", headers:H, body: JSON.stringify({ question:"timeout test", callback_url:"http://localhost:3999/resume", timeout_minutes: 0.01, default_on_timeout:"rejected" }) });
  const t = await r.json(); console.log("timeout created", t.status);
  await sleep(32000);
  s = await (await fetch(`http://localhost:3998/v1/approvals/${t.id}`, { headers:H })).json(); console.log("after sweep", s.status, s.decided_by, "callbacks", received.length);
  const d = await (await fetch(`http://localhost:3998/v1/approvals/${t.id}/deliveries`, { headers:H })).json(); console.log("deliveries", d);
  srv.kill(); cb.close(); process.exit(0);
})().catch(e=>{ console.error(e); srv.kill(); process.exit(1); });
