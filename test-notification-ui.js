const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const API_PORT = 4022;
const PROVIDER_PORT = 4023;
const BASE = `http://127.0.0.1:${API_PORT}`;
const PROVIDER = `http://127.0.0.1:${PROVIDER_PORT}`;
const payloads = [];
const tmp = fs.mkdtempSync(path.join(__dirname, ".test-notification-ui-"));
const dbPath = path.join(tmp, "ui.db");

const provider = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => { raw += chunk; });
  req.on("end", () => {
    payloads.push({ url: req.url, body: JSON.parse(raw || "{}") });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(req.url === "/emails" ? '{"id":"email-ui"}' : '{"ok":true,"channel":"C_TEST","ts":"1700000000.1"}');
  });
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let app;

async function run() {
  await new Promise((resolve) => provider.listen(PROVIDER_PORT, "127.0.0.1", resolve));
  app = spawn(process.execPath, ["server.js"], {
    cwd: __dirname,
    env: {
      ...process.env,
      PORT: String(API_PORT), BASE_URL: BASE, API_KEYS: "ui-key", DB_PATH: dbPath,
      RESEND_API_KEY: "re_test", EMAIL_FROM: "test@example.com", SLACK_BOT_TOKEN: "xoxb-test",
      RESEND_API_URL: `${PROVIDER}/emails`, SLACK_API_BASE: PROVIDER,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${BASE}/health`)).ok) break; } catch {}
    await sleep(30);
  }
  const context = {
    case_id: "make-community-112270",
    request_id: "AVD-20260907-001",
    draft_id: "AVD-20260907-001",
    draft_url: "https://example.com/video-drafts/AVD-20260907-001-v3",
    draft_version: "v3",
    draft_sha256: "ac89b4d46d8180a5dfe4f094e1937d52196608ed9c0ecfc1c77d5b3023118233",
    original_brief: "Create a 20-second product launch teaser.",
    prompt_summary: "Warm editorial motion, no logos changed, 16:9.",
    destination: "Private staging release log",
    reviewer_role: "Creative lead",
  };
  const headers = { authorization: "Bearer ui-key", "content-type": "application/json" };
  for (const channel of ["email", "slack"]) {
    const response = await fetch(`${BASE}/v1/approvals`, {
      method: "POST", headers,
      body: JSON.stringify({
        question: "Release AI video draft AVD-20260907-001 v3 to the publish queue?",
        context, channel, to: channel === "email" ? "reviewer@example.com" : "C_TEST",
        approve_label: "Release video", reject_label: "Send back for changes",
        timeout_minutes: 60, default_on_timeout: "rejected",
      }),
    });
    assert.equal(response.status, 201);
  }

  const email = payloads.find((item) => item.url === "/emails").body;
  assert.match(email.html, /Approval requested/);
  assert.match(email.html, /Video preview/);
  assert.match(email.html, /Open video on example\.com/);
  assert.match(email.html, /Review and decide/);
  assert.doesNotMatch(email.html, /<pre/);
  assert.doesNotMatch(email.html, /make-community-112270/);

  const slack = payloads.find((item) => item.url === "/chat.postMessage").body;
  assert.equal(slack.blocks[0].type, "header");
  assert.equal(slack.blocks[0].text.text, "Approval requested");
  assert.ok(slack.blocks.some((block) => block.fields?.some((field) => field.text.includes("Video preview"))));
  assert.ok(slack.blocks.some((block) => block.fields?.some((field) => field.text.includes("Open video on example.com"))));
  assert.ok(slack.blocks.some((block) => block.type === "actions"));
  assert.ok(!JSON.stringify(slack.blocks).includes("make-community-112270"));
  assert.ok(!JSON.stringify(slack.blocks).includes("```"));
  console.log("✓ email and Slack approval notifications use human-readable cards");
}

run().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (app && app.exitCode == null) {
    const exited = new Promise((resolve) => app.once("exit", resolve));
    app.kill("SIGTERM");
    await exited;
  }
  await new Promise((resolve) => provider.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
});
