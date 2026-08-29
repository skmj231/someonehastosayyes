const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const API_PORT = 4030;
const SLACK_PORT = 4031;
const BASE = `http://127.0.0.1:${API_PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shsy-tenant-isolation-"));
const slackPosts = [];
let app;

const slack = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => { raw += d; });
  req.on("end", () => {
    slackPosts.push(JSON.parse(raw || "{}"));
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"ok":true,"channel":"C_OWNER","ts":"1.000001"}');
  });
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitApp() {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${BASE}/health`)).ok) return; } catch {}
    await sleep(50);
  }
  throw new Error("app did not start");
}

async function run() {
  await new Promise((resolve) => slack.listen(SLACK_PORT, "127.0.0.1", resolve));
  app = spawn(process.execPath, ["server.js"], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(API_PORT), BASE_URL: BASE,
      API_KEYS: "owner-key,tenant-key", DB_PATH: path.join(tmp, "isolation.db"),
      SLACK_BOT_TOKEN: "xoxb-owner", SLACK_API_BASE: `http://127.0.0.1:${SLACK_PORT}`,
      NOTIFY_SLACK_KEY: "owner-key", NOTIFY_SLACK_CHANNEL: "C_OWNER" },
    stdio: "ignore",
  });
  await waitApp();

  const create = await fetch(`${BASE}/v1/approvals`, {
    method: "POST",
    headers: { authorization: "Bearer tenant-key", "content-type": "application/json" },
    body: JSON.stringify({ question: "Tenant-private refund details", channel: "link" }),
  });
  const approval = await create.json();
  assert.equal(create.status, 201);
  await fetch(approval.approve_url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "decision=approved&name=tenant-user",
  });
  await sleep(150);
  assert.equal(slackPosts.length, 0, "tenant decisions must not be copied to the operator Slack workspace");

  console.log("✓ tenant approval content stays out of the operator Slack workspace");
}

run().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (app && app.exitCode == null) {
    const exited = new Promise((resolve) => app.once("exit", resolve));
    app.kill("SIGTERM"); await exited;
  }
  await new Promise((resolve) => slack.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
});
