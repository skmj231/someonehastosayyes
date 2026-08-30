const assert = require("assert/strict");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const tmp = fs.mkdtempSync("/tmp/someonehastosayyes-key-migration-");
const dbPath = path.join(tmp, "legacy.db");
const legacyKey = "ah_legacy_secret_that_must_keep_working";
const db = new Database(dbPath);
db.exec("CREATE TABLE keys (key TEXT PRIMARY KEY,label TEXT,created_at INTEGER NOT NULL)");
db.prepare("INSERT INTO keys (key,label,created_at) VALUES (?,?,?)").run(legacyKey, "legacy", Date.now());
db.close();

const port = 4012;
const child = spawn("node", ["server.js"], {
  env: {
    ...process.env,
    PORT: String(port),
    BASE_URL: `http://127.0.0.1:${port}`,
    API_KEYS: "environment-test-key",
    DB_PATH: dbPath,
    SIGNING_SECRET: "migration-test-signing-secret",
    ADMIN_SECRET: "migration-test-admin-secret",
  },
  stdio: ["ignore", "pipe", "inherit"],
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch {}
    await sleep(100);
  }
  const response = await fetch(`http://127.0.0.1:${port}/v1/approvals`, {
    method: "POST",
    headers: { authorization: `Bearer ${legacyKey}`, "content-type": "application/json" },
    body: JSON.stringify({ question: "Does the migrated key still work?" }),
  });
  assert.equal(response.status, 201);
  const migrated = new Database(dbPath, { readonly: true });
  const row = migrated.prepare("SELECT key,key_hash FROM keys WHERE label='legacy'").get();
  assert.notEqual(row.key, legacyKey);
  assert.equal(row.key_hash.length, 64);
  migrated.close();
  assert.equal(fs.readFileSync(dbPath).includes(Buffer.from(legacyKey)), false);
  console.log("✓ legacy key still authenticates and its plaintext is removed");
  child.kill("SIGTERM");
  fs.rmSync(tmp, { recursive: true, force: true });
})().catch((error) => {
  console.error(error);
  child.kill("SIGTERM");
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(1);
});
