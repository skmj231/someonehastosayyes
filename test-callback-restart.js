const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const API_PORT = 4020;
const CALLBACK_PORT = 4021;
const BASE = `http://127.0.0.1:${API_PORT}`;
const CALLBACK = `http://127.0.0.1:${CALLBACK_PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shsy-callback-restart-"));
const dbPath = path.join(tmp, "restart.db");
const headers = { authorization: "Bearer restart-key", "content-type": "application/json" };
const logicalEffects = new Set();
const attempts = [];
let callbackMode = "outage";
let app;

const callback = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => { raw += d; });
  req.on("end", () => {
    const approvalId = req.headers["x-approval-id"];
    attempts.push({ approvalId, body: JSON.parse(raw || "{}") });
    if (callbackMode === "outage") { res.writeHead(503); return res.end("down"); }
    logicalEffects.add(approvalId);
    if (callbackMode === "ambiguous") return res.destroy();
    res.writeHead(200); res.end("ok");
  });
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function startApp() {
  app = spawn(process.execPath, ["server.js"], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(API_PORT), BASE_URL: BASE, API_KEYS: "restart-key", DB_PATH: dbPath,
      ALLOW_PRIVATE_CALLBACKS: "true", DELIVERY_SWEEP_MS: "50", CALLBACK_BACKOFF_SCALE: "0.001" },
    stdio: "ignore",
  });
}
async function waitApp() {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${BASE}/health`)).ok) return; } catch {}
    await sleep(50);
  }
  throw new Error("app did not start");
}
async function stopApp(signal = "SIGTERM") {
  if (!app || app.exitCode != null) return;
  const exited = new Promise((resolve) => app.once("exit", resolve));
  app.kill(signal); await exited;
}
async function create(question) {
  const r = await fetch(`${BASE}/v1/approvals`, { method: "POST", headers, body: JSON.stringify({ question, channel: "link", callback_url: `${CALLBACK}/resume` }) });
  assert.equal(r.status, 201); return r.json();
}
async function approve(a) {
  const r = await fetch(a.approve_url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "decision=approved&name=restart-test" });
  assert.equal(r.status, 200);
}
async function waitDelivered(id) {
  for (let i = 0; i < 150; i++) {
    const r = await fetch(`${BASE}/v1/approvals/${id}`, { headers });
    const body = await r.json();
    if (body.callback === "delivered") return body;
    await sleep(50);
  }
  throw new Error("callback did not recover");
}

async function run() {
  await new Promise((resolve) => callback.listen(CALLBACK_PORT, "127.0.0.1", resolve));
  startApp(); await waitApp();

  const beforeDelivery = await create("Restart after approval");
  await approve(beforeDelivery);
  await sleep(80);
  assert.ok(attempts.some((x) => x.approvalId === beforeDelivery.id));
  await stopApp("SIGKILL");
  callbackMode = "healthy";
  startApp(); await waitApp();
  await waitDelivered(beforeDelivery.id);
  assert.equal(logicalEffects.has(beforeDelivery.id), true);

  callbackMode = "ambiguous";
  const inFlight = await create("Restart during callback");
  await approve(inFlight);
  for (let i = 0; i < 50 && !logicalEffects.has(inFlight.id); i++) await sleep(20);
  assert.equal(logicalEffects.has(inFlight.id), true, "receiver must observe the first attempt");
  await stopApp("SIGKILL");
  callbackMode = "healthy";
  startApp(); await waitApp();
  await waitDelivered(inFlight.id);
  const repeated = attempts.filter((x) => x.approvalId === inFlight.id);
  assert.ok(repeated.length >= 2, "ambiguous callback must retry after restart");
  assert.equal(new Set(repeated.map((x) => x.approvalId)).size, 1, "every retry must keep the same approval ID");
  assert.equal(logicalEffects.size, 2, "receiver deduplication must keep one logical effect per approval");

  console.log("✓ callback survives restart before delivery and during an ambiguous response");
}

run().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await stopApp();
  await new Promise((resolve) => callback.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
});
