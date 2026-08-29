const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const API_PORT = 4010;
const PROVIDER_PORT = 4011;
const BASE = `http://127.0.0.1:${API_PORT}`;
const PROVIDER = `http://127.0.0.1:${PROVIDER_PORT}`;
const H = { authorization: "Bearer recovery-key", "content-type": "application/json" };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shsy-recovery-"));
const dbPath = path.join(tmp, "recovery.db");
const accepted = { email: new Map(), slack: new Map() };
let providerMode = "outage";

const provider = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => { raw += d; });
  req.on("end", () => {
    const isEmail = req.url === "/emails";
    const kind = isEmail ? "email" : "slack";
    if (providerMode === "outage") {
      res.writeHead(503, { "content-type": "application/json" });
      return res.end(isEmail ? '{"message":"temporary outage"}' : '{"ok":false,"error":"temporary outage"}');
    }
    const payload = JSON.parse(raw || "{}");
    const key = isEmail ? req.headers["idempotency-key"] : (payload.client_msg_id || `update:${payload.channel}:${payload.ts}`);
    const existing = accepted[kind].get(key);
    const value = existing || (isEmail ? { id: "email-once" } : { ok: true, channel: payload.channel, ts: "1700000000.000001" });
    if (!existing) accepted[kind].set(key, value);
    if (!existing && providerMode === "ambiguous") return res.destroy();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(value));
  });
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let app;
function startApp() {
  app = spawn(process.execPath, ["server.js"], {
    cwd: __dirname,
    env: {
      ...process.env,
      PORT: String(API_PORT), BASE_URL: BASE, API_KEYS: "recovery-key", DB_PATH: dbPath,
      RESEND_API_KEY: "re_test", EMAIL_FROM: "test@example.com", SLACK_BOT_TOKEN: "xoxb-test",
      RESEND_API_URL: `${PROVIDER}/emails`, SLACK_API_BASE: PROVIDER,
      DELIVERY_SWEEP_MS: "50", NOTIFICATION_BACKOFF_SCALE: "0.001", RETENTION_SWEEP_MS: "1000",
      ALLOW_PRIVATE_CALLBACKS: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}
async function waitApp() {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${BASE}/health`)).ok) return; } catch {}
    await sleep(50);
  }
  throw new Error("app did not start");
}
async function stopApp() {
  if (!app || app.exitCode != null) return;
  const exited = new Promise((resolve) => app.once("exit", resolve));
  app.kill("SIGTERM");
  await exited;
}
async function create(body) {
  const r = await fetch(`${BASE}/v1/approvals`, { method: "POST", headers: H, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}
async function notification(id) {
  const r = await fetch(`${BASE}/v1/approvals/${id}/notifications`, { headers: H });
  return r.json();
}
async function waitDelivered(id) {
  for (let i = 0; i < 150; i++) {
    const n = await notification(id);
    if (n.delivery?.state === "delivered") return n;
    await sleep(50);
  }
  throw new Error(`${id} was not delivered after recovery`);
}

async function run() {
  await new Promise((resolve) => provider.listen(PROVIDER_PORT, "127.0.0.1", resolve));
  startApp();
  await waitApp();

  const email = await create({ question: "Email survives outage", channel: "email", to: "person@example.com" });
  const slack = await create({ question: "Slack survives outage", channel: "slack", to: "C_TEST" });
  assert.equal(email.status, 202);
  assert.equal(slack.status, 202);
  await sleep(300);
  assert.ok((await notification(email.body.id)).delivery.attempts >= 2, "email failure must be recorded and retried");
  assert.ok((await notification(slack.body.id)).delivery.attempts >= 2, "Slack failure must be recorded and retried");

  await stopApp();
  providerMode = "ambiguous";
  startApp();
  await waitApp();
  await sleep(150);
  providerMode = "healthy";
  const emailDone = await waitDelivered(email.body.id);
  const slackDone = await waitDelivered(slack.body.id);
  assert.equal(accepted.email.size, 1, "email provider idempotency key must prevent duplicates");
  assert.equal(accepted.slack.size, 1, "Slack client_msg_id must prevent duplicates");
  assert.ok(emailDone.attempts.length >= 3);
  assert.ok(slackDone.attempts.length >= 3);

  providerMode = "outage";
  await fetch(slack.body.approve_url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "decision=approved&name=tester" });
  await sleep(150);
  const updateFailed = await notification(slack.body.id);
  assert.equal(updateFailed.delivery.state, "queued", "failed Slack in-place update must be queued");
  providerMode = "ambiguous";
  await sleep(150);
  providerMode = "healthy";
  await waitDelivered(slack.body.id);
  assert.equal(accepted.slack.size, 2, "Slack initial post and in-place update must each happen once");

  const old = await create({ question: "Old retained decision", channel: "link" });
  await fetch(old.body.approve_url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "decision=approved&name=tester" });
  await stopApp();
  const Database = require("better-sqlite3");
  const db = new Database(dbPath);
  db.prepare("UPDATE approvals SET decided_at=? WHERE id=?").run(Date.now() - 91 * 86400e3, old.body.id);
  db.close();
  startApp();
  await waitApp();
  await sleep(1200);
  assert.equal((await fetch(`${BASE}/v1/approvals/${old.body.id}`, { headers: H })).status, 404, "90-day decision record must be purged");
  assert.equal((await fetch(`${BASE}/v1/approvals/${old.body.id}/receipt`, { headers: H })).status, 200, "signed receipt must remain after operational record expires");
  assert.equal((await fetch(`${BASE}/v1/approvals/${old.body.id}`, { method: "DELETE", headers: H })).status, 204, "archived receipt must support immediate deletion");
  assert.equal((await fetch(`${BASE}/v1/approvals/${old.body.id}/receipt`, { headers: H })).status, 404);

  const pending = await create({ question: "Do not silently delete pending", channel: "link" });
  assert.equal((await fetch(`${BASE}/v1/approvals/${pending.body.id}`, { method: "DELETE", headers: H })).status, 409);

  console.log("✓ notification outage, restart, idempotency, retention, and deletion passed");
}

run().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await stopApp();
  await new Promise((resolve) => provider.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
});
