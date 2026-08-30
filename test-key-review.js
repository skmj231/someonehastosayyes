const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const APP_PORT = 4010;
const MAIL_PORT = 4011;
const BASE = `http://127.0.0.1:${APP_PORT}`;
const MAIL = `http://127.0.0.1:${MAIL_PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shsy-key-review-"));
const messages = [];
let child;

const mailServer = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    messages.push({ headers: req.headers, body: JSON.parse(body) });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: `email_${messages.length}` }));
  });
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitForServer() {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(BASE + "/health")).ok) return; } catch {}
    await sleep(50);
  }
  throw new Error("server did not start");
}
const adminHeaders = { "content-type": "application/json", "x-admin-secret": "adm" };
const urlFrom = (html, segment) => {
  const match = html.match(new RegExp(`https?:[^\"']+/${segment}/[A-Za-z0-9_-]+`));
  assert.ok(match, `${segment} link must be present in email`);
  return match[0];
};

async function run() {
  await new Promise((resolve) => mailServer.listen(MAIL_PORT, "127.0.0.1", resolve));
  child = spawn(process.execPath, ["server.js"], {
    cwd: __dirname,
    env: {
      ...process.env,
      PORT: String(APP_PORT), BASE_URL: BASE, DB_PATH: path.join(tmp, "test.db"),
      API_KEYS: "operator-key", ADMIN_SECRET: "adm", SIGNING_SECRET: "x".repeat(40),
      RESEND_API_KEY: "re_test", RESEND_API_URL: MAIL + "/emails", EMAIL_FROM: "test@example.com",
      REVIEW_KEY_RATE_LIMIT: "10", KEY_MONTHLY_APPROVAL_LIMIT: "3", KEY_MONTHLY_EMAIL_LIMIT: "1",
      KEY_PENDING_LIMIT: "5", GLOBAL_MONTHLY_APPROVAL_LIMIT: "50", GLOBAL_DAILY_EMAIL_LIMIT: "20",
      NEW_KEY_ALERT_APPROVALS_HOUR: "2", KEY_MONITOR_SWEEP_MS: "50",
      ALLOW_PRIVATE_CALLBACKS: "true", DELIVERY_SWEEP_MS: "50",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d; });
  await waitForServer();

  let r = await fetch(BASE + "/admin/keys", { method: "POST", headers: adminHeaders, body: JSON.stringify({ label: "bypass" }) });
  assert.equal(r.status, 403, "direct admin issuance must stay closed by default");

  r = await fetch(BASE + "/request-key", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "owner@example.org", tool: "n8n", delivery: "email" }) });
  const requested = await r.json();
  assert.equal(r.status, 202);
  assert.equal(requested.status, "pending_verification");
  assert.equal(messages.length, 1);
  const verifyUrl = urlFrom(messages[0].body.html, "verify-key-request");

  r = await fetch(verifyUrl);
  assert.equal(r.status, 200, "scanner GET must only show a confirmation page");
  let queue = await (await fetch(BASE + "/admin/key-requests", { headers: adminHeaders })).json();
  assert.equal(queue[0].status, "pending_verification");
  assert.equal(queue[0].verified_at, null);

  r = await fetch(verifyUrl, { method: "POST" });
  assert.equal(r.status, 200);
  queue = await (await fetch(BASE + "/admin/key-requests", { headers: adminHeaders })).json();
  assert.equal(queue[0].status, "pending_review");
  assert.ok(queue[0].verified_at);

  r = await fetch(BASE + `/admin/key-requests/${requested.request_id}/issue`, { method: "POST", headers: adminHeaders, body: JSON.stringify({ note: "Known tester" }) });
  const issued = await r.json();
  assert.equal(r.status, 201, JSON.stringify(issued));
  assert.equal(messages.length, 2);
  const receiveUrl = urlFrom(messages[1].body.html, "receive-key");
  r = await fetch(receiveUrl);
  assert.equal(r.status, 200, "scanner GET must not reveal or consume the key");
  r = await fetch(receiveUrl, { method: "POST" });
  const keyPage = await r.text();
  assert.equal(r.status, 200);
  const key = keyPage.match(/ah_[A-Za-z0-9_-]+/)?.[0];
  assert.ok(key, "one-time page must contain the API key");
  assert.equal((await fetch(receiveUrl, { method: "POST" })).status, 410, "key must be shown once");
  assert.equal((await fetch(BASE + `/admin/key-requests/${requested.request_id}/issue`, { method: "POST", headers: adminHeaders, body: "{}" })).status, 409, "same request must not issue twice");

  const authHeaders = { "content-type": "application/json", authorization: `Bearer ${key}` };
  r = await fetch(BASE + "/v1/approvals", { method: "POST", headers: authHeaders, body: JSON.stringify({ question: "First", channel: "link" }) });
  assert.equal(r.status, 201);
  r = await fetch(BASE + "/v1/approvals", { method: "POST", headers: authHeaders, body: JSON.stringify({ question: "Email one", channel: "email", to: "approver@example.org" }) });
  assert.equal(r.status, 201);
  await sleep(150);
  const monitoredRows = await (await fetch(BASE + "/admin/keys", { headers: adminHeaders })).json();
  assert.ok(monitoredRows.find((x) => x.email === "owner@example.org")?.monitor_alerted_at, "first-day usage must trigger operator monitoring");
  r = await fetch(BASE + "/v1/approvals", { method: "POST", headers: authHeaders, body: JSON.stringify({ question: "Email two", channel: "email", to: "approver@example.org" }) });
  assert.equal(r.status, 429);
  assert.match((await r.json()).error, /email limit/);
  r = await fetch(BASE + "/v1/approvals", { method: "POST", headers: authHeaders, body: JSON.stringify({ question: "Third", channel: "link" }) });
  assert.equal(r.status, 201);
  r = await fetch(BASE + "/v1/approvals", { method: "POST", headers: authHeaders, body: JSON.stringify({ question: "Fourth", channel: "link" }) });
  assert.equal(r.status, 429);
  assert.match((await r.json()).error, /monthly approval limit/);

  const keyRows = await (await fetch(BASE + "/admin/keys", { headers: adminHeaders })).json();
  const stored = keyRows.find((x) => x.email === "owner@example.org");
  assert.ok(stored);
  r = await fetch(BASE + `/admin/keys/${stored.fingerprint}`, { method: "DELETE", headers: adminHeaders });
  assert.equal(r.status, 200);
  assert.equal((await fetch(BASE + "/v1/approvals", { method: "POST", headers: authHeaders, body: JSON.stringify({ question: "After revoke" }) })).status, 401);

  console.log("✓ email verification, manual review, one-time delivery, quotas, and immediate revoke passed");
  if (stderr) console.error(stderr);
}

run().then(() => {
  child.kill(); mailServer.close(); fs.rmSync(tmp, { recursive: true, force: true });
}).catch((error) => {
  console.error(error); if (child) child.kill(); mailServer.close(); fs.rmSync(tmp, { recursive: true, force: true }); process.exitCode = 1;
});
