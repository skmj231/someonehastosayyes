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
    messages.push(JSON.parse(body));
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

async function run() {
  await new Promise((resolve) => mailServer.listen(MAIL_PORT, "127.0.0.1", resolve));
  child = spawn(process.execPath, ["server.js"], {
    cwd: __dirname,
    env: {
      ...process.env,
      PORT: String(APP_PORT), BASE_URL: BASE, DB_PATH: path.join(tmp, "test.db"),
      API_KEYS: "operator-key", ADMIN_SECRET: "adm", SIGNING_SECRET: "x".repeat(40),
      RESEND_API_KEY: "re_test", RESEND_API_URL: MAIL + "/emails", EMAIL_FROM: "test@example.com",
      INITIAL_RPM_LIMIT: "10", INITIAL_APPROVALS_MONTH: "3", INITIAL_EMAILS_MONTH: "1", INITIAL_PENDING_LIMIT: "5",
      ALLOW_PRIVATE_CALLBACKS: "true", DELIVERY_SWEEP_MS: "50",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForServer();
  const adminHeaders = { "content-type": "application/json", "x-admin-secret": "adm" };

  let response = await fetch(BASE + "/admin/keys", { method: "POST", headers: adminHeaders, body: JSON.stringify({ label: "bypass" }) });
  assert.equal(response.status, 403, "direct admin issuance stays closed by default");

  response = await fetch(BASE + "/request-key", { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ email: "owner@example.org", tool: "n8n", delivery: "email" }) });
  const requested = await response.json();
  assert.equal(response.status, 202);
  assert.equal(requested.status, "verification_sent");
  assert.equal(messages.length, 1, "only the verification email is sent");
  assert.equal(messages[0].subject, "Verify your email to get your API key");
  let keyRequests = await (await fetch(BASE + "/admin/key-requests", { headers: adminHeaders })).json();
  const keyRequest = keyRequests.find((item) => item.id === requested.request_id);
  assert.equal(keyRequest.classification, "UNCLASSIFIED");
  response = await fetch(BASE + `/admin/key-requests/${keyRequest.id}/classification`, { method: "PATCH", headers: adminHeaders, body: JSON.stringify({ classification: "PROMOTIONAL_SPAM" }) });
  assert.equal(response.status, 400, "classification evidence is required");
  response = await fetch(BASE + `/admin/key-requests/${keyRequest.id}/classification`, { method: "PATCH", headers: adminHeaders, body: JSON.stringify({ classification: "VALID_REQUEST", reason: "n8n integration requested; no promotional content" }) });
  const classified = await response.json();
  assert.equal(response.status, 200);
  assert.equal(classified.classification, "VALID_REQUEST");
  assert.equal(classified.classification_reason, "n8n integration requested; no promotional content");
  const verificationUrl = messages[0].html.match(/http:\/\/127\.0\.0\.1:4010\/verify-email\?token=[A-Za-z0-9_-]+/)?.[0];
  assert.ok(verificationUrl);

  response = await fetch(verificationUrl);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Opening the link alone does not create or reveal a key/);
  response = await fetch(verificationUrl, { method: "POST" });
  const keyPage = await response.text();
  const key = keyPage.match(/ah_[A-Za-z0-9_-]+/)?.[0];
  assert.ok(key, "POST verification issues one limited real key");
  assert.equal((await fetch(verificationUrl, { method: "POST" })).status, 400, "verification link is one-time");

  const authHeaders = { "content-type": "application/json", authorization: `Bearer ${key}` };
  response = await fetch(BASE + "/v1/approvals", { method: "POST", headers: authHeaders, body: JSON.stringify({ question: "First real request", channel: "link" }) });
  assert.equal(response.status, 201);
  const accounts = await (await fetch(BASE + "/admin/accounts", { headers: { "x-admin-secret": "adm", accept: "application/json" } })).json();
  assert.ok(accounts.find((account) => account.email === "owner@example.org")?.email_verified_at);
  const credentials = await (await fetch(BASE + "/admin/credentials", { headers: { "x-admin-secret": "adm" } })).json();
  const issued = credentials.find((credential) => credential.label === "owner@example.org");
  assert.equal(issued.grant.limits.approvals_month, 3);
  assert.equal(issued.grant.limits.emails_month, 1);
  assert.equal(issued.grant.limits.pending, 5);
  assert.equal(issued.grant.limits.rpm, 10);
  keyRequests = await (await fetch(BASE + "/admin/key-requests", { headers: adminHeaders })).json();
  const enrichedRequest = keyRequests.find((item) => item.id === requested.request_id);
  assert.ok(enrichedRequest.email_verified_at, "triage must show email verification evidence");
  assert.equal(enrichedRequest.credentials[0].id, issued.id, "triage must show the issued credential without exposing its secret");
  assert.equal(enrichedRequest.credential_id, issued.id, "the verified request must be linked directly to its key");
  assert.equal(enrichedRequest.credentials[0].approvals_created, 1, "triage must retain attributed usage evidence");

  response = await fetch(BASE + `/admin/key-requests/${keyRequest.id}/management`, { method: "PATCH", headers: adminHeaders, body: JSON.stringify({ action: "SUSPEND", reason_code: "ABUSE_SUSPECTED" }) });
  assert.equal(response.status, 400, "a management reason is required");
  response = await fetch(BASE + `/admin/key-requests/${keyRequest.id}/management`, { method: "PATCH", headers: adminHeaders, body: JSON.stringify({ action: "SUSPEND", reason_code: "ABUSE_SUSPECTED", reason: "Unexpected request spike under investigation" }) });
  let managed = await response.json();
  assert.equal(response.status, 200);
  assert.equal(managed.request.management_state, "SUSPENDED");
  assert.equal(managed.request.credentials[0].status, "suspended");
  assert.equal((await fetch(BASE + "/v1/approvals", { method: "POST", headers: authHeaders, body: JSON.stringify({ question: "Blocked during investigation", channel: "link" }) })).status, 403, "suspended keys cannot create requests");

  response = await fetch(BASE + `/admin/key-requests/${keyRequest.id}/management`, { method: "PATCH", headers: adminHeaders, body: JSON.stringify({ action: "RESTORE", reason_code: "INVESTIGATION_CLEARED", reason: "Owner confirmed the traffic" }) });
  managed = await response.json();
  assert.equal(response.status, 200);
  assert.equal(managed.request.credentials[0].status, "active");
  assert.equal((await fetch(BASE + "/v1/approvals", { method: "POST", headers: authHeaders, body: JSON.stringify({ question: "Works after restore", channel: "link" }) })).status, 201);

  response = await fetch(BASE + `/admin/key-requests/${keyRequest.id}/management`, { method: "PATCH", headers: adminHeaders, body: JSON.stringify({ action: "DELETE", reason_code: "ABUSE_CONFIRMED", reason: "Confirmed automated abuse" }) });
  managed = await response.json();
  assert.equal(response.status, 200);
  assert.equal(managed.request.management_state, "DELETED");
  assert.equal(managed.request.credentials[0].status, "revoked", "deleting the request must revoke the linked key atomically");
  assert.equal(managed.usage_history_preserved, true);
  assert.equal((await fetch(BASE + "/v1/approvals", { method: "POST", headers: authHeaders, body: JSON.stringify({ question: "Cannot use a deleted key", channel: "link" }) })).status, 403);
  keyRequests = await (await fetch(BASE + "/admin/key-requests", { headers: adminHeaders })).json();
  assert.equal(keyRequests.some((item) => item.id === keyRequest.id), false, "deleted requests leave the active queue");
  keyRequests = await (await fetch(BASE + "/admin/key-requests?include_deleted=1", { headers: adminHeaders })).json();
  const archivedRequest = keyRequests.find((item) => item.id === keyRequest.id);
  assert.equal(archivedRequest.credentials[0].approvals_created, 2, "archived requests keep usage for follow-up");
  response = await fetch(BASE + `/admin/credentials/${issued.id}`, { method: "PATCH", headers: adminHeaders, body: JSON.stringify({ status: "active", risk_level: "low" }) });
  assert.equal(response.status, 409, "permanently deleted keys cannot be restored");
  response = await fetch(BASE + "/request-key", { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ email: "owner@example.org", tool: "n8n" }) });
  assert.equal(response.status, 403, "confirmed abuse blocks automatic reissuance");
  assert.equal(messages.length, 1, "blocked accounts receive no new verification email");

  console.log("✓ verified issuance, atomic request/key control, permanent abuse revocation, and retained usage passed");
}

run().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (child) child.kill("SIGTERM");
  await new Promise((resolve) => mailServer.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
});
