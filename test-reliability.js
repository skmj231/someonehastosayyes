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
      ALLOW_DIRECT_ADMIN_KEYS: "true",
      DB_PATH: path.join(tmp, "test.db"), ALLOW_PRIVATE_CALLBACKS: "true",
      TIMEOUT_SWEEP_MS: "50", DELIVERY_SWEEP_MS: "50", CALLBACK_BACKOFF_SCALE: "0.001",
      SLACK_SIGNING_SECRET: "test-slack-secret",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let childErr = "";
  child.stderr.on("data", (d) => { childErr += d; });
  await waitForServer();

  const publicFiles = [
    ["/approval-flow-motion.html", "Approval Flow Motion"],
    ["/trust", "Trust"],
    ["/status", "Status"],
    ["/relay", "Relay"],
    ["/starters/n8n-email-approval.json", "someonehastosayyes"],
    ["/starters/n8n-slack-approval.json", "someonehastosayyes"],
  ];
  for (const [publicPath, expected] of publicFiles) {
    const publicResponse = await fetch(BASE + publicPath);
    assert.equal(publicResponse.status, 200, `${publicPath} must be served`);
    assert.match(await publicResponse.text(), new RegExp(expected, "i"));
  }
  const motionResponse = await fetch(BASE + "/approval-flow-motion.html");
  assert.equal(motionResponse.headers.get("x-frame-options"), "SAMEORIGIN", "the product-flow iframe must be visible only on this site");

  let r = await fetch(BASE + "/v1/approvals", { method: "POST", headers: { ...headers, authorization: "Bearer demo" }, body: JSON.stringify({ question: "x" }) });
  assert.equal(r.status, 401, "public demo credential must not authorize the API");

  ({ r } = await create({ question: "   " }));
  assert.equal(r.status, 400, "blank question must be rejected");
  ({ r } = await create({ question: "x".repeat(501) }));
  assert.equal(r.status, 400, "oversized question must be rejected");
  ({ r } = await create({ question: "x", timeout_minutes: 60 * 24 * 91 }));
  assert.equal(r.status, 400, "unbounded timeout must be rejected");

  r = await fetch(BASE + "/request-key", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ email: "verified@example.com", tool: "code" }) });
  const verificationPage = await r.text();
  assert.equal(r.status, 200);
  const verificationUrl = verificationPage.match(/href="(http:\/\/127\.0\.0\.1:3996\/verify-email\?token=[^"]+)"/)?.[1];
  assert.ok(verificationUrl, "development verification must expose the one-time link");
  r = await fetch(verificationUrl);
  assert.match(await r.text(), /Verify email and create key/, "GET must not create a key for a link scanner");
  r = await fetch(verificationUrl, { method: "POST" });
  const keyPage = await r.text();
  const verifiedKey = keyPage.match(/<pre>(ah_[A-Za-z0-9_-]+)<\/pre>/)?.[1];
  assert.ok(verifiedKey, "email verification must issue a real key exactly once");
  assert.equal((await fetch(verificationUrl)).status, 400, "verification link must be one-time");
  const verifiedHeaders = { "content-type": "application/json", authorization: `Bearer ${verifiedKey}` };
  r = await fetch(BASE + "/v1/access-requests", { method: "POST", headers: verifiedHeaders, body: JSON.stringify({ intended_use: "production refund approvals", limits: { approvals_month: 500 }, identity_confidence: 3, intended_use_score: 4, blast_radius_score: 2, behavioral_history_score: 1 }) });
  const accessRequest = await r.json();
  assert.equal(r.status, 201, "verified accounts may request elevated access separately");
  r = await fetch(BASE + `/admin/access-requests/${accessRequest.id}`, { method: "PATCH", headers: { "content-type": "application/json", "x-admin-secret": "adm" }, body: JSON.stringify({ outcome: "APPROVE_WITH_LIMITS", reason: "verified use, keep a small email limit" }) });
  assert.equal(r.status, 200, "admin review outcome and rationale must be recorded");

  r = await fetch(BASE + "/v1/approvals", { method: "POST", headers: verifiedHeaders, body: JSON.stringify({ question: "Structured authorization", actor: { type: "agent", id: "refund-bot" }, principal: { type: "account", id: "merchant-1" }, action: { name: "refund" }, resource: { type: "order", id: "A-184" }, context: { amount: 380 }, constraints: { currency: "USD" } }) });
  const structured = await r.json();
  assert.equal(r.status, 201);
  assert.ok(structured.action_request_id);
  await fetch(structured.approve_url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "decision=approved&name=reviewer" });
  r = await fetch(BASE + `/v1/approvals/${structured.id}/receipt`, { headers: verifiedHeaders });
  const structuredReceipt = await r.json();
  assert.equal(structuredReceipt.receipt.receipt_version, 1);
  assert.deepEqual(structuredReceipt.receipt.actor, { type: "agent", id: "refund-bot" });
  assert.deepEqual(structuredReceipt.receipt.constraints, { currency: "USD" });

  r = await fetch(BASE + "/admin/keys", { method: "POST", headers: { "content-type": "application/json", "x-admin-secret": "adm" }, body: JSON.stringify({ label: "test" }) });
  const issued = await r.json();
  assert.equal(r.status, 201);
  assert.ok(issued.slack_install_url.includes("?token="), "Slack install URL must use a separate token");
  assert.ok(!issued.slack_install_url.includes(issued.key), "Slack install URL must not expose the API key");
  const issuedHeaders = { "content-type": "application/json", authorization: `Bearer ${issued.key}` };
  r = await fetch(BASE + "/v1/approvals", { method: "POST", headers: issuedHeaders, body: JSON.stringify({ question: "Hashed credential works" }) });
  assert.equal(r.status, 201, "new hashed credentials must authorize requests");
  r = await fetch(BASE + "/admin/credentials", { headers: { "x-admin-secret": "adm" } });
  const credentials = await r.json();
  assert.equal(credentials[0].id, issued.id);
  assert.equal(Object.hasOwn(credentials[0], "key"), false, "admin list must never return raw keys");
  r = await fetch(BASE + "/admin/overview", { headers: { "x-admin-secret": "adm" } });
  const overview = await r.json();
  assert.ok(overview.events_last_24h.some((event) => event.event_type === "approval.created"));
  r = await fetch(BASE + "/admin");
  assert.equal(r.status, 401, "admin dashboard must require authentication");
  assert.match(r.headers.get("www-authenticate"), /Basic/);
  const basicAdmin = { authorization: `Basic ${Buffer.from("admin:adm").toString("base64")}` };
  r = await fetch(BASE + "/admin", { headers: basicAdmin });
  const adminHtml = await r.text();
  assert.equal(r.status, 200);
  assert.match(adminHtml, /Operations/);
  assert.match(adminHtml, new RegExp(issued.key_prefix));
  assert.ok(!adminHtml.includes(issued.key), "dashboard must never expose raw keys");
  for (const adminPath of ["/admin/key-requests", "/admin/accounts", "/admin/traffic", "/admin/reliability", "/admin/incidents", "/admin/costs"]) {
    r = await fetch(BASE + adminPath, { headers: { ...basicAdmin, accept: "text/html" } });
    const screen = await r.text();
    assert.equal(r.status, 200, `${adminPath} must render a dedicated admin screen`);
    assert.match(screen, /admin\/app\.js/);
    assert.match(screen, new RegExp(`aria-current="page"[^>]*>${adminPath === "/admin/key-requests" ? "Key requests" : adminPath.split("/").pop().replace(/^./, (c) => c.toUpperCase())}`));
  }
  r = await fetch(BASE + "/admin/app.js", { headers: basicAdmin });
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /javascript/);
  const csrf = adminHtml.match(/name="csrf" value="([^"]+)"/)?.[1];
  assert.ok(csrf, "dashboard status form must include a CSRF token");
  r = await fetch(BASE + `/admin/credentials/${issued.id}/status`, { method: "POST", redirect: "manual", headers: { ...basicAdmin, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf, status: "restricted" }) });
  assert.equal(r.status, 303, "dashboard must update credential status");
  r = await fetch(BASE + "/v1/approvals", { method: "POST", headers: issuedHeaders, body: JSON.stringify({ question: "Restricted key stops" }) });
  assert.equal(r.status, 403);
  r = await fetch(BASE + `/admin/credentials/${issued.id}`, { method: "PATCH", headers: { "content-type": "application/json", "x-admin-secret": "adm" }, body: JSON.stringify({ status: "blocked", risk_level: "high" }) });
  assert.equal(r.status, 200);
  r = await fetch(BASE + "/v1/approvals", { method: "POST", headers: issuedHeaders, body: JSON.stringify({ question: "Must be blocked" }) });
  assert.equal(r.status, 403, "blocked credentials must stop working immediately");

  r = await fetch(BASE + "/admin/keys", { method: "POST", headers: { "content-type": "application/json", "x-admin-secret": "adm" }, body: JSON.stringify({ label: "risk-test", limits: { rpm: 1, pending: 50 } }) });
  const riskKey = await r.json();
  const riskHeaders = { "content-type": "application/json", authorization: `Bearer ${riskKey.key}` };
  for (let i = 0; i < 16; i++) await fetch(BASE + "/v1/approvals", { method: "POST", headers: riskHeaders, body: JSON.stringify({ question: `Quota probe ${i}` }) });
  r = await fetch(BASE + "/admin/risk/run", { method: "POST", headers: { "x-admin-secret": "adm" } });
  assert.equal(r.status, 200);
  r = await fetch(BASE + "/v1/approvals", { method: "POST", headers: riskHeaders, body: JSON.stringify({ question: "Must auto suspend" }) });
  assert.equal(r.status, 403, "repeated quota evasion must auto-suspend the credential");
  r = await fetch(BASE + "/admin/incidents", { headers: { "x-admin-secret": "adm", accept: "application/json" } });
  const incidents = await r.json();
  assert.ok(incidents.signals.some((signal) => signal.signal_type === "QUOTA_EVASION_PATTERN"));
  const quotaIncident = incidents.incidents.find((incident) => incident.signal_types.includes("QUOTA_EVASION_PATTERN"));
  assert.ok(quotaIncident);
  r = await fetch(BASE + `/admin/incidents/${quotaIncident.id}`, { method: "PATCH", headers: { "content-type": "application/json", "x-admin-secret": "adm" }, body: JSON.stringify({ status: "ACKNOWLEDGED" }) });
  assert.equal((await r.json()).status, "ACKNOWLEDGED", "incident status changes must remain in the source-of-truth record");
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
  r = await fetch(BASE + "/admin/costs", { headers: { "x-admin-secret": "adm" } });
  const costs = await r.json();
  assert.ok(costs.mtd.estimated > 0, "estimated cost ledger must be visible in admin");
  assert.ok(costs.guardrails.global_daily_usd > 0);

  const canceled = await create({ question: "Cancel me", callback_url: CALLBACK + "/cancel" });
  r = await fetch(BASE + `/v1/approvals/${canceled.body.id}/cancel`, { method: "POST", headers });
  assert.equal((await r.json()).status, "canceled");
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
