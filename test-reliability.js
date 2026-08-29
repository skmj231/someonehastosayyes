const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const API_PORT = 3996;
const CALLBACK_PORT = 3995;
const BASE = `http://127.0.0.1:${API_PORT}`;
const CALLBACK = `http://127.0.0.1:${CALLBACK_PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shsy-test-"));
const received = [];
const counts = new Map();

const callbackServer = http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => { body += d; });
  req.on("end", () => {
    const route = req.url;
    counts.set(route, (counts.get(route) || 0) + 1);
    received.push({ route, headers: req.headers, body: body ? JSON.parse(body) : null });
    if (route === "/retry" && counts.get(route) === 1) { res.writeHead(500); return res.end("retry"); }
    if (route === "/gone") { res.writeHead(404); return res.end("gone"); }
    if (route === "/redirect") { res.writeHead(302, { location: CALLBACK + "/should-not-follow" }); return res.end(); }
    res.writeHead(200); res.end("ok");
  });
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const headers = { "content-type": "application/json", authorization: "Bearer k1" };
const create = async (body, extraHeaders = {}) => {
  const r = await fetch(BASE + "/v1/approvals", { method: "POST", headers: { ...headers, ...extraHeaders }, body: JSON.stringify(body) });
  return { r, body: await r.json() };
};
const status = async (id) => (await fetch(BASE + `/v1/approvals/${id}`, { headers })).json();

let child;
async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(BASE + "/health")).ok) return; } catch {}
    await sleep(50);
  }
  throw new Error("server did not start");
}

function slackHeaders(body) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const signature = "v0=" + require("node:crypto").createHmac("sha256", "test-slack-secret").update(`v0:${ts}:${body}`).digest("hex");
  return { "content-type": "application/x-www-form-urlencoded", "x-slack-request-timestamp": ts, "x-slack-signature": signature };
}

async function run() {
  await new Promise((resolve) => callbackServer.listen(CALLBACK_PORT, "127.0.0.1", resolve));
  child = spawn(process.execPath, ["server.js"], {
    cwd: __dirname,
    env: {
      ...process.env,
      PORT: String(API_PORT), BASE_URL: BASE, API_KEYS: "k1", ADMIN_SECRET: "adm",
      DB_PATH: path.join(tmp, "test.db"), ALLOW_PRIVATE_CALLBACKS: "true",
      TIMEOUT_SWEEP_MS: "50", DELIVERY_SWEEP_MS: "50", CALLBACK_BACKOFF_SCALE: "0.001",
      SLACK_SIGNING_SECRET: "test-slack-secret",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let childErr = "";
  child.stderr.on("data", (d) => { childErr += d; });
  await waitForServer();

  let r = await fetch(BASE + "/v1/approvals", { method: "POST", headers: { ...headers, authorization: "Bearer demo" }, body: JSON.stringify({ question: "x" }) });
  assert.equal(r.status, 401, "public demo credential must not authorize the API");

  ({ r } = await create({ question: "   " }));
  assert.equal(r.status, 400, "blank question must be rejected");
  ({ r } = await create({ question: "x".repeat(501) }));
  assert.equal(r.status, 400, "oversized question must be rejected");
  ({ r } = await create({ question: "x", timeout_minutes: 60 * 24 * 91 }));
  assert.equal(r.status, 400, "unbounded timeout must be rejected");

  r = await fetch(BASE + "/admin/keys", { method: "POST", headers: { "content-type": "application/json", "x-admin-secret": "adm" }, body: JSON.stringify({ label: "test" }) });
  const issued = await r.json();
  assert.equal(r.status, 201);
  assert.ok(issued.slack_install_url.includes("?token="), "Slack install URL must use a separate token");
  assert.ok(!issued.slack_install_url.includes(issued.key), "Slack install URL must not expose the API key");
  r = await fetch(BASE + "/v1/slack/install-link", { method: "POST", headers });
  const freshInstall = await r.json();
  assert.equal(r.status, 201);
  assert.equal(freshInstall.expires_in_days, 30);

  const idem1 = await create({ question: "Refund $380?" }, { "Idempotency-Key": "order-A184-refund" });
  const idem2 = await create({ question: "This retry must not create another approval" }, { "Idempotency-Key": "order-A184-refund" });
  assert.equal(idem1.r.status, 201);
  assert.equal(idem2.r.status, 200);
  assert.equal(idem2.r.headers.get("idempotent-replayed"), "true");
  assert.equal(idem2.body.id, idem1.body.id, "same idempotency key must return same approval");

  const approval = await create({ question: "Approve refund?", callback_url: CALLBACK + "/ok", timeout_minutes: 5 });
  assert.equal(approval.r.status, 201);
  assert.equal(approval.body.approved, null, "pending approval must not look approved or rejected yet");
  r = await fetch(approval.body.approve_url);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("cache-control"), /no-store/);
  assert.equal((await status(approval.body.id)).status, "pending", "GET/link scanner must not decide");

  const form = (decision, name) => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `decision=${decision}&name=${name}` });
  await Promise.all([
    fetch(approval.body.approve_url, form("approved", "alice")),
    fetch(approval.body.approve_url, form("rejected", "bob")),
  ]);
  await sleep(150);
  const decided = await status(approval.body.id);
  assert.ok(["approved", "rejected"].includes(decided.status));
  assert.equal(counts.get("/ok"), 1, "concurrent clicks must make one callback");
  const callback = received.find((x) => x.route === "/ok");
  assert.equal(callback.headers["x-approval-id"], approval.body.id);
  assert.ok(callback.headers["x-approval-signature"]);

  r = await fetch(BASE + `/v1/approvals/${approval.body.id}/receipt`, { headers });
  const receipt = await r.json();
  const verified = await (await fetch(BASE + "/v1/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ receipt_json: receipt.receipt_json, signature: receipt.signature }) })).json();
  assert.equal(verified.valid, true, "signed receipt must verify");

  const canceled = await create({ question: "Cancel me", callback_url: CALLBACK + "/cancel" });
  r = await fetch(BASE + `/v1/approvals/${canceled.body.id}/cancel`, { method: "POST", headers });
  const canceledResponse = await r.json();
  assert.equal(canceledResponse.status, "canceled");
  assert.equal(canceledResponse.approved, false, "cancel response must route through the false branch");
  assert.equal((await status(canceled.body.id)).approved, false, "cancel status lookup must match its callback payload");
  await sleep(100);
  assert.equal(counts.get("/cancel"), 1, "cancel must release the waiting workflow");

  const retry = await create({ question: "Retry callback", callback_url: CALLBACK + "/retry" });
  await fetch(retry.body.approve_url, form("approved", "alice"));
  await sleep(250);
  assert.equal(counts.get("/retry"), 2, "transient callback failure must retry");

  const gone = await create({ question: "Gone callback", callback_url: CALLBACK + "/gone" });
  await fetch(gone.body.approve_url, form("approved", "alice"));
  await sleep(200);
  assert.equal(counts.get("/gone"), 1, "gone one-time endpoint must not retry");
  assert.equal((await status(gone.body.id)).callback, "endpoint_gone");

  const redirect = await create({ question: "Do not follow redirects", callback_url: CALLBACK + "/redirect" });
  await fetch(redirect.body.approve_url, form("approved", "alice"));
  await sleep(120);
  assert.equal(counts.get("/should-not-follow") || 0, 0, "callback redirects must not reach an unchecked destination");

  const timed = await create({ question: "Timeout", timeout_minutes: 0.001, default_on_timeout: "timed_out", callback_url: CALLBACK + "/timeout" });
  await sleep(250);
  assert.equal((await status(timed.body.id)).status, "timed_out");
  assert.equal(counts.get("/timeout"), 1);

  r = await fetch(BASE + "/slack/interactions", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "payload=%7B%7D" });
  assert.equal(r.status, 401, "unsigned Slack interaction must be rejected");

  const slackApproval = await create({ question: "Slack response window" });
  const slackToken = new URL(slackApproval.body.approve_url).pathname.split("/").pop();
  const payload = encodeURIComponent(JSON.stringify({ actions: [{ action_id: "approved", value: slackToken }], user: { id: "U_TEST" } }));
  const raw = `payload=${payload}`;
  const started = Date.now();
  r = await fetch(BASE + "/slack/interactions", { method: "POST", headers: slackHeaders(raw), body: raw });
  assert.equal(r.status, 200);
  assert.ok(Date.now() - started < 3000, "Slack interaction must acknowledge inside 3 seconds");

  const badPayload = encodeURIComponent(JSON.stringify({ actions: [{ action_id: "delete_everything", value: slackToken }], user: { id: "U_TEST" } }));
  const badRaw = `payload=${badPayload}`;
  r = await fetch(BASE + "/slack/interactions", { method: "POST", headers: slackHeaders(badRaw), body: badRaw });
  assert.equal(r.status, 400, "unknown Slack actions must be rejected");

  const productionPort = 3994;
  const productionBase = `http://127.0.0.1:${productionPort}`;
  const production = spawn(process.execPath, ["server.js"], {
    cwd: __dirname,
    env: { ...process.env, NODE_ENV: "production", PORT: String(productionPort), BASE_URL: "https://service.example", API_KEYS: "k2", ADMIN_SECRET: "a".repeat(32), SIGNING_SECRET: "s".repeat(32), DB_PATH: path.join(tmp, "production.db") },
    stdio: "ignore",
  });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(productionBase + "/health")).ok) break; } catch {}
    await sleep(50);
  }
  r = await fetch(productionBase + "/v1/approvals", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer k2" },
    body: JSON.stringify({ question: "must reject local callback", callback_url: CALLBACK + "/private" }),
  });
  assert.equal(r.status, 400, "hosted service must reject non-HTTPS/private callbacks");
  production.kill("SIGTERM");

  assert.equal(child.exitCode, null, childErr || "server exited unexpectedly");
  console.log("✓ reliability suite passed");
}

run().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (child) child.kill("SIGTERM");
  await new Promise((resolve) => callbackServer.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
});
