// someonehastosayyes v0.4 — 승인 링크 API
// 해결하는 문제: (1) n8n 슬랙 승인 버튼 404/스피너/새탭/일회용 resumeUrl 문제
//               (2) Make.com 무료·프로 플랜에 승인 단계가 없는 문제
// 한 파일. 의존성: express, better-sqlite3. 저장소: SQLite.

const express = require("express");
const Database = require("better-sqlite3");
const crypto = require("crypto");
const dns = require("dns").promises;
const net = require("net");

const PORT = process.env.PORT || 3000;
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const API_KEYS = (process.env.API_KEYS || (process.env.NODE_ENV === "production" ? "" : "dev-key")).split(",").map((s) => s.trim()).filter(Boolean);
const SIGNING_SECRET = process.env.SIGNING_SECRET || "change-me"; // 내부 상태 토큰용 (슬랙 OAuth state)
// 서명키: 환경변수 SIGNING_KEY (PEM). 없으면 DB에 하나 만들어 보관.
let SIGN_PRIV = null, SIGN_PUB_PEM = null, SIGN_KEY_ID = null;
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const RESEND_API_URL = process.env.RESEND_API_URL || "https://api.resend.com/emails";
const EMAIL_FROM = process.env.EMAIL_FROM || "approvals@example.com";
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || "";
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET || "";
const SLACK_CLIENT_ID = process.env.SLACK_CLIENT_ID || "";
const SLACK_CLIENT_SECRET = process.env.SLACK_CLIENT_SECRET || "";
const ADMIN_SECRET = process.env.ADMIN_SECRET || "";
const NOTIFY_SLACK_CHANNEL = process.env.NOTIFY_SLACK_CHANNEL || "";
const NOTIFY_SLACK_KEY = process.env.NOTIFY_SLACK_KEY || (process.env.API_KEYS || "").split(",")[0].trim();
const DEMO_KEY = "demo";
const BRAND = "someonehastosayyes";
const IS_PRODUCTION = process.env.NODE_ENV === "production";
const ALLOW_PRIVATE_CALLBACKS = process.env.ALLOW_PRIVATE_CALLBACKS === "true" || !IS_PRODUCTION;
const DELIVERY_SWEEP_MS = Math.max(50, Number(process.env.DELIVERY_SWEEP_MS) || 5000);
const TIMEOUT_SWEEP_MS = Math.max(50, Number(process.env.TIMEOUT_SWEEP_MS) || 30000);
const CALLBACK_BACKOFF_SCALE = Math.max(0.001, Number(process.env.CALLBACK_BACKOFF_SCALE) || 1);
const NOTIFICATION_BACKOFF_SCALE = Math.max(0.001, Number(process.env.NOTIFICATION_BACKOFF_SCALE) || 1);
const SLACK_API_BASE = (process.env.SLACK_API_BASE || "https://slack.com/api").replace(/\/$/, "");
const DECISION_RETENTION_MS = Math.max(1, Number(process.env.DECISION_RETENTION_DAYS) || 90) * 86400e3;
const DELIVERY_RETENTION_MS = Math.max(1, Number(process.env.DELIVERY_RETENTION_DAYS) || 30) * 86400e3;
const RECEIPT_RETENTION_MS = Math.max(1, Number(process.env.RECEIPT_RETENTION_DAYS) || 365) * 86400e3;
const RETENTION_SWEEP_MS = Math.max(1000, Number(process.env.RETENTION_SWEEP_MS) || 6 * 3600e3);
const EVENT_RETENTION_DAYS = Math.max(7, Number(process.env.EVENT_RETENTION_DAYS) || 90);
const INITIAL_LIMITS = Object.freeze({
  approvals_month: Math.max(1, Number(process.env.INITIAL_APPROVALS_MONTH) || 50),
  emails_month: Math.max(0, Number(process.env.INITIAL_EMAILS_MONTH) || 30),
  pending: Math.max(1, Number(process.env.INITIAL_PENDING_LIMIT) || 10),
  rpm: Math.max(1, Number(process.env.INITIAL_RPM_LIMIT) || 10),
  callback_domains: Math.max(1, Number(process.env.INITIAL_CALLBACK_DOMAINS) || 3),
});
const COST_RATES_USD = Object.freeze({
  approval_request: Number(process.env.COST_APPROVAL_REQUEST_USD) || 0.00002,
  email: Number(process.env.COST_EMAIL_USD) || 0.0004,
  callback_attempt: Number(process.env.COST_CALLBACK_ATTEMPT_USD) || 0.00001,
  db_write: Number(process.env.COST_DB_WRITE_USD) || 0.000001,
});
const NEW_ACCOUNT_DAILY_COST_GUARD_USD = Math.max(0.01, Number(process.env.NEW_ACCOUNT_DAILY_COST_GUARD_USD) || 5);
const GLOBAL_DAILY_COST_GUARD_USD = Math.max(0.01, Number(process.env.GLOBAL_DAILY_COST_GUARD_USD) || 25);
const ALLOW_DIRECT_ADMIN_KEYS = process.env.ALLOW_DIRECT_ADMIN_KEYS === "true";

function validateProductionConfig() {
  if (!IS_PRODUCTION) return;
  const problems = [];
  if (!BASE_URL.startsWith("https://")) problems.push("BASE_URL must use https");
  if (API_KEYS.includes("dev-key")) problems.push("API_KEYS must not use the development default");
  if (SIGNING_SECRET === "change-me" || SIGNING_SECRET.length < 32) problems.push("SIGNING_SECRET must be at least 32 characters");
  if (ADMIN_SECRET.length < 24) problems.push("ADMIN_SECRET must be at least 24 characters");
  const slackValues = [SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, SLACK_SIGNING_SECRET];
  if (slackValues.some(Boolean) && !slackValues.every(Boolean)) problems.push("Slack OAuth requires CLIENT_ID, CLIENT_SECRET, and SIGNING_SECRET together");
  if (problems.length) throw new Error("Unsafe production configuration:\n- " + problems.join("\n- "));
}
validateProductionConfig();

const db = new Database(process.env.DB_PATH || "askhuman.db");
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");
db.exec(`
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  token TEXT UNIQUE NOT NULL,
  api_key TEXT NOT NULL,
  question TEXT NOT NULL,
  context TEXT,
  approve_label TEXT NOT NULL,
  reject_label TEXT NOT NULL,
  callback_url TEXT,
  channel TEXT NOT NULL,
  recipient TEXT,
  timeout_at INTEGER,
  default_on_timeout TEXT NOT NULL,
  status TEXT NOT NULL,            -- pending | approved | rejected | timed_out
  decided_by TEXT,
  decided_at INTEGER,
  comment TEXT,
  slack_channel TEXT,
  slack_ts TEXT,
  idempotency_key TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  approval_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  status_code INTEGER,
  error TEXT,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pending ON approvals(status, timeout_at);
CREATE TABLE IF NOT EXISTS keys (
  key TEXT PRIMARY KEY,
  label TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS slack_installs (
  api_key TEXT PRIMARY KEY,
  team_id TEXT,
  team_name TEXT,
  bot_token TEXT NOT NULL,
  installed_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS slack_install_tokens (
  token TEXT PRIMARY KEY,
  api_key TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS outbox (
  approval_id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  body TEXT NOT NULL,
  signature TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL,
  state TEXT NOT NULL,            -- queued | delivered | endpoint_gone | failed
  last_status INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outbox_due ON outbox(state, next_at);
CREATE TABLE IF NOT EXISTS notification_outbox (
  approval_id TEXT PRIMARY KEY, channel TEXT NOT NULL, purpose TEXT NOT NULL DEFAULT 'initial',
  attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, state TEXT NOT NULL,
  provider_id TEXT, last_status INTEGER, last_error TEXT, created_at INTEGER NOT NULL,
  delivered_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_notification_due ON notification_outbox(state, next_at);
CREATE TABLE IF NOT EXISTS notification_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT, approval_id TEXT NOT NULL, attempt INTEGER NOT NULL,
  status_code INTEGER, error TEXT, at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS receipt_archive (
  approval_id TEXT PRIMARY KEY, api_key TEXT NOT NULL, receipt_json TEXT NOT NULL,
  signature TEXT NOT NULL, key_id TEXT NOT NULL, decided_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_receipt_expiry ON receipt_archive(expires_at);
CREATE TABLE IF NOT EXISTS ratelimit (bucket TEXT PRIMARY KEY, count INTEGER NOT NULL, window_start INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS key_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  tool TEXT,
  note TEXT,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS api_credentials (
  id TEXT PRIMARY KEY,
  key_prefix TEXT NOT NULL,
  key_hash TEXT UNIQUE NOT NULL,
  label TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  risk_level TEXT NOT NULL DEFAULT 'low',
  plan TEXT NOT NULL DEFAULT 'sandbox',
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  expires_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_credentials_status ON api_credentials(status, risk_level);
CREATE TABLE IF NOT EXISTS operational_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  credential_id TEXT,
  subject_type TEXT,
  subject_id TEXT,
  outcome TEXT,
  metadata TEXT,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_at ON operational_events(at);
CREATE INDEX IF NOT EXISTS idx_events_credential ON operational_events(credential_id, at);
CREATE TABLE IF NOT EXISTS daily_usage (
  credential_id TEXT NOT NULL,
  day TEXT NOT NULL,
  approvals_created INTEGER NOT NULL DEFAULT 0,
  decisions INTEGER NOT NULL DEFAULT 0,
  callback_attempts INTEGER NOT NULL DEFAULT 0,
  callback_failures INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (credential_id, day)
);
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, email_verified_at INTEGER,
  status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS verification_tokens (
  token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL, expires_at INTEGER NOT NULL,
  used_at INTEGER, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS credential_grants (
  credential_id TEXT PRIMARY KEY, account_id TEXT, capabilities TEXT NOT NULL,
  limits_json TEXT NOT NULL, risk_state TEXT NOT NULL DEFAULT 'NORMAL',
  issued_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, revoked_at INTEGER, revoke_reason TEXT
);
CREATE TABLE IF NOT EXISTS action_requests (
  id TEXT PRIMARY KEY, approval_id TEXT UNIQUE NOT NULL, credential_id TEXT,
  actor TEXT, principal TEXT, action TEXT, resource TEXT, context TEXT, constraints TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS challenges (
  id TEXT PRIMARY KEY, action_request_id TEXT UNIQUE NOT NULL, kind TEXT NOT NULL,
  channel TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, completed_at INTEGER
);
CREATE TABLE IF NOT EXISTS authorization_decisions (
  id TEXT PRIMARY KEY, action_request_id TEXT UNIQUE NOT NULL, challenge_id TEXT,
  outcome TEXT NOT NULL, approved INTEGER NOT NULL, decider TEXT, source TEXT,
  comment TEXT, decided_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS authorization_receipts (
  id TEXT PRIMARY KEY, action_request_id TEXT UNIQUE NOT NULL, decision_id TEXT NOT NULL,
  receipt_version INTEGER NOT NULL DEFAULT 1, body TEXT NOT NULL, signature TEXT NOT NULL,
  key_id TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS analytics_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT, credential_id TEXT,
  event_name TEXT NOT NULL, subject_id TEXT, metadata TEXT, at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_analytics_event ON analytics_events(event_name, at);
CREATE TABLE IF NOT EXISTS account_milestones (
  account_id TEXT PRIMARY KEY, demo_started_at INTEGER, demo_completed_at INTEGER,
  key_created_at INTEGER, first_request_at INTEGER, first_decision_at INTEGER,
  first_callback_at INTEGER, first_production_action_at INTEGER, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS access_requests (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, requested_capabilities TEXT NOT NULL,
  requested_limits TEXT NOT NULL, intended_use TEXT, identity_confidence INTEGER NOT NULL DEFAULT 0,
  intended_use_score INTEGER NOT NULL DEFAULT 0, blast_radius_score INTEGER NOT NULL DEFAULT 0,
  behavioral_history_score INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'PENDING',
  review_outcome TEXT, review_reason TEXT, reviewed_by TEXT, created_at INTEGER NOT NULL, reviewed_at INTEGER
);
CREATE TABLE IF NOT EXISTS risk_signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT, credential_id TEXT, signal_type TEXT NOT NULL,
  severity TEXT NOT NULL, observed_value REAL, baseline_value REAL, metadata TEXT,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS incidents (
  id TEXT PRIMARY KEY, credential_id TEXT, severity TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'OPEN',
  title TEXT NOT NULL, signal_types TEXT NOT NULL, details TEXT, created_at INTEGER NOT NULL,
  acknowledged_at INTEGER, resolved_at INTEGER
);
CREATE TABLE IF NOT EXISTS cost_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT, credential_id TEXT, action_request_id TEXT,
  provider TEXT NOT NULL, category TEXT NOT NULL, quantity REAL NOT NULL, unit TEXT NOT NULL,
  estimated_usd REAL NOT NULL, actual_usd REAL, reconciled_at INTEGER, metadata TEXT, at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cost_at ON cost_ledger(at, credential_id);
CREATE TABLE IF NOT EXISTS credential_callback_domains (
  credential_id TEXT NOT NULL, domain TEXT NOT NULL, first_seen_at INTEGER NOT NULL,
  PRIMARY KEY (credential_id, domain)
);
CREATE TABLE IF NOT EXISTS credential_request_fingerprints (
  credential_id TEXT NOT NULL, fingerprint TEXT NOT NULL, first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL, request_count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (credential_id, fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_request_fingerprint_recent ON credential_request_fingerprints(last_seen_at, fingerprint);
`);

// Existing SQLite files are migrated in place. The optional key lets an
// automation safely retry approval creation without making a second request.
if (!db.prepare("PRAGMA table_info(approvals)").all().some((c) => c.name === "idempotency_key")) {
  db.exec("ALTER TABLE approvals ADD COLUMN idempotency_key TEXT");
}
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_approval_idempotency ON approvals(api_key, idempotency_key) WHERE idempotency_key IS NOT NULL");
db.prepare("UPDATE notification_outbox SET state='queued',next_at=? WHERE state='sending'").run(Date.now());

// Key-request triage is kept separately from issuance state. This lets the
// operator distinguish a real prospect, an internal test, and promotional
// spam without deleting the original request or its audit history.
const keyRequestColumns = db.prepare("PRAGMA table_info(key_requests)").all().map((column) => column.name);
if (!keyRequestColumns.includes("classification")) db.exec("ALTER TABLE key_requests ADD COLUMN classification TEXT");
if (!keyRequestColumns.includes("classification_reason")) db.exec("ALTER TABLE key_requests ADD COLUMN classification_reason TEXT");
if (!keyRequestColumns.includes("classified_at")) db.exec("ALTER TABLE key_requests ADD COLUMN classified_at INTEGER");
if (!keyRequestColumns.includes("classified_by")) db.exec("ALTER TABLE key_requests ADD COLUMN classified_by TEXT");
if (!keyRequestColumns.includes("credential_id")) db.exec("ALTER TABLE key_requests ADD COLUMN credential_id TEXT");
if (!keyRequestColumns.includes("management_state")) db.exec("ALTER TABLE key_requests ADD COLUMN management_state TEXT NOT NULL DEFAULT 'ACTIVE'");
if (!keyRequestColumns.includes("management_reason_code")) db.exec("ALTER TABLE key_requests ADD COLUMN management_reason_code TEXT");
if (!keyRequestColumns.includes("management_reason")) db.exec("ALTER TABLE key_requests ADD COLUMN management_reason TEXT");
if (!keyRequestColumns.includes("managed_at")) db.exec("ALTER TABLE key_requests ADD COLUMN managed_at INTEGER");
if (!keyRequestColumns.includes("managed_by")) db.exec("ALTER TABLE key_requests ADD COLUMN managed_by TEXT");
db.exec("CREATE INDEX IF NOT EXISTS idx_key_requests_classification ON key_requests(classification, at)");
db.exec("CREATE INDEX IF NOT EXISTS idx_key_requests_management ON key_requests(management_state, at)");
const verificationTokenColumns = db.prepare("PRAGMA table_info(verification_tokens)").all().map((column) => column.name);
if (!verificationTokenColumns.includes("request_id")) db.exec("ALTER TABLE verification_tokens ADD COLUMN request_id INTEGER");

// 오래된 DB의 평문 키를 한 번만 해시로 바꾸고 새 credential/grant 구조에 연결한다.
const legacyKeyColumns = db.prepare("PRAGMA table_info(keys)").all().map((column) => column.name);
if (!legacyKeyColumns.includes("key_hash")) db.exec("ALTER TABLE keys ADD COLUMN key_hash TEXT");
if (!legacyKeyColumns.includes("status")) db.exec("ALTER TABLE keys ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
if (!legacyKeyColumns.includes("last_used_at")) db.exec("ALTER TABLE keys ADD COLUMN last_used_at INTEGER");
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_keys_hash ON keys(key_hash) WHERE key_hash IS NOT NULL");
(function migrateLegacyCredentials() {
  const plaintextRows = db.prepare("SELECT key FROM keys WHERE key_hash IS NULL").all();
  db.transaction(() => {
    for (const row of plaintextRows) {
      const hash = crypto.createHash("sha256").update(String(row.key)).digest("hex");
      const ref = "key_" + hash.slice(0, 32);
      db.prepare("UPDATE approvals SET api_key=? WHERE api_key=?").run(ref, row.key);
      db.prepare("UPDATE receipt_archive SET api_key=? WHERE api_key=?").run(ref, row.key);
      db.prepare("UPDATE slack_installs SET api_key=? WHERE api_key=?").run(ref, row.key);
      db.prepare("UPDATE slack_install_tokens SET api_key=? WHERE api_key=?").run(ref, row.key);
      db.prepare("UPDATE keys SET key=?,key_hash=? WHERE key=?").run(ref, hash, row.key);
    }
    const legacyRows = db.prepare("SELECT key,key_hash,label,status,created_at,last_used_at FROM keys WHERE key_hash IS NOT NULL").all();
    for (const row of legacyRows) {
      db.prepare(`INSERT OR IGNORE INTO api_credentials (id,key_prefix,key_hash,label,status,risk_level,plan,created_at,last_used_at)
        VALUES (?,?,?,?,?,'low','legacy_migrated',?,?)`).run(row.key, "legacy", row.key_hash, row.label, row.status === "active" ? "active" : "revoked", row.created_at, row.last_used_at);
      db.prepare(`INSERT OR IGNORE INTO credential_grants (credential_id,account_id,capabilities,limits_json,risk_state,issued_at,updated_at)
        VALUES (?,NULL,?,?,'NORMAL',?,?)`).run(row.key, JSON.stringify(["approvals:create", "callbacks:deliver", "links:create", "email:send", "slack:send"]), JSON.stringify({ rpm: 600, pending: 10000, approvals_month: 100000, emails_month: 100000, callback_domains: 1000 }), row.created_at, Date.now());
    }
  })();
  if (plaintextRows.length) {
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.exec("VACUUM");
    console.log(`[keys] migrated ${plaintextRows.length} stored key(s) to one-way hashes`);
  }
})();

(function initSigningKey() {
  let priv = process.env.SIGNING_KEY || null;
  if (!priv) {
    const row = db.prepare("SELECT v FROM meta WHERE k='signing_key'").get();
    if (row) priv = row.v;
    else {
      const kp = crypto.generateKeyPairSync("ed25519");
      priv = kp.privateKey.export({ type: "pkcs8", format: "pem" });
      db.prepare("INSERT INTO meta (k,v) VALUES ('signing_key',?)").run(priv);
      console.log("[sign] generated a new Ed25519 signing key and stored it in the database");
    }
  }
  SIGN_PRIV = crypto.createPrivateKey(priv);
  SIGN_PUB_PEM = crypto.createPublicKey(SIGN_PRIV).export({ type: "spki", format: "pem" });
  SIGN_KEY_ID = crypto.createHash("sha256").update(SIGN_PUB_PEM).digest("hex").slice(0, 16);
})();
function sign(text) { return crypto.sign(null, Buffer.from(text, "utf8"), SIGN_PRIV).toString("base64"); }
function verify(text, sigB64) { try { return crypto.verify(null, Buffer.from(text, "utf8"), crypto.createPublicKey(SIGN_PUB_PEM), Buffer.from(sigB64, "base64")); } catch { return false; } }

// ── 속도 제한: 버킷당 window 안에 max회. DB 기반이라 재시작에도 유지.
function rateLimited(bucket, max, windowMs) {
  const t = now();
  const row = db.prepare("SELECT count, window_start FROM ratelimit WHERE bucket=?").get(bucket);
  if (!row || t - row.window_start > windowMs) { db.prepare("INSERT OR REPLACE INTO ratelimit (bucket,count,window_start) VALUES (?,?,?)").run(bucket, 1, t); return false; }
  if (row.count >= max) return true;
  db.prepare("UPDATE ratelimit SET count=count+1 WHERE bucket=?").run(bucket); return false;
}
const ip = (req) => (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").toString().split(",")[0].trim();
const clientFingerprint = (req) => crypto.createHmac("sha256", SIGNING_SECRET).update(ip(req)).digest("hex").slice(0, 24);

const app = express();
app.set("trust proxy", true);
app.disable("x-powered-by");
const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const keepRaw = (req, _res, buf) => { req.rawBody = buf.toString("utf8"); };
app.use(express.json({ limit: "256kb", verify: keepRaw }));
app.use(express.urlencoded({ extended: false, verify: keepRaw }));
app.use((req, res, next) => {
  res.set("X-Content-Type-Options", "nosniff");
  res.set("Referrer-Policy", "no-referrer");
  res.set("X-Frame-Options", req.path === "/approval-flow-motion.html" ? "SAMEORIGIN" : "DENY");
  if (req.path.startsWith("/a/") || req.path.startsWith("/admin")) res.set("Cache-Control", "no-store");
  if (req.path.startsWith("/admin")) res.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  next();
});

const now = () => Date.now();
const newId = () => "apr_" + crypto.randomBytes(8).toString("hex");
const newToken = () => crypto.randomBytes(24).toString("base64url");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const credentialHash = (key) => crypto.createHash("sha256").update(String(key)).digest("hex");

// 개인정보나 요청 본문은 넣지 않는다. 운영에 필요한 작은 사실만 기록한다.
function recordEvent(eventType, { credentialId = null, subjectType = null, subjectId = null, outcome = null, metadata = null } = {}) {
  const safeMetadata = metadata ? JSON.stringify(metadata).slice(0, 2000) : null;
  db.prepare(`INSERT INTO operational_events (event_type,credential_id,subject_type,subject_id,outcome,metadata,at)
    VALUES (?,?,?,?,?,?,?)`).run(eventType, credentialId, subjectType, subjectId, outcome, safeMetadata, now());
}

function incrementUsage(credentialId, field) {
  if (!credentialId || !["approvals_created", "decisions", "callback_attempts", "callback_failures"].includes(field)) return;
  const day = new Date().toISOString().slice(0, 10);
  db.prepare("INSERT OR IGNORE INTO daily_usage (credential_id,day) VALUES (?,?)").run(credentialId, day);
  db.prepare(`UPDATE daily_usage SET ${field}=${field}+1 WHERE credential_id=? AND day=?`).run(credentialId, day);
}

function jsonValue(value, max = 20000) {
  if (value == null) return null;
  const encoded = JSON.stringify(value);
  if (encoded.length > max) throw new Error(`structured metadata must be ${max} bytes or fewer`);
  return encoded;
}
function grantFor(credentialId) {
  const row = db.prepare("SELECT * FROM credential_grants WHERE credential_id=?").get(credentialId);
  if (!row) return { capabilities: ["approvals:create", "callbacks:deliver", "links:create", "email:send", "slack:send"], limits: { rpm: 600, pending: 10000, approvals_month: 100000, emails_month: 100000, callback_domains: 1000 }, risk_state: "NORMAL" };
  return { ...row, capabilities: JSON.parse(row.capabilities), limits: JSON.parse(row.limits_json) };
}
function accountForCredential(credentialId) {
  return db.prepare("SELECT account_id FROM credential_grants WHERE credential_id=?").get(credentialId)?.account_id || null;
}
function analytics(eventName, { accountId = null, credentialId = null, subjectId = null, metadata = null, milestone = null } = {}) {
  db.prepare("INSERT INTO analytics_events (account_id,credential_id,event_name,subject_id,metadata,at) VALUES (?,?,?,?,?,?)")
    .run(accountId, credentialId, eventName, subjectId, metadata ? JSON.stringify(metadata).slice(0, 2000) : null, now());
  if (!accountId || !milestone) return;
  db.prepare("INSERT OR IGNORE INTO account_milestones (account_id,updated_at) VALUES (?,?)").run(accountId, now());
  db.prepare(`UPDATE account_milestones SET ${milestone}=COALESCE(${milestone},?),updated_at=? WHERE account_id=?`).run(now(), now(), accountId);
}
function addCost({ accountId = null, credentialId = null, actionRequestId = null, provider = "internal", category, quantity = 1, unit = "operation", estimatedUsd, actualUsd = null, metadata = null }) {
  db.prepare(`INSERT INTO cost_ledger (account_id,credential_id,action_request_id,provider,category,quantity,unit,estimated_usd,actual_usd,reconciled_at,metadata,at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(accountId, credentialId, actionRequestId, provider, category, quantity, unit, estimatedUsd, actualUsd, actualUsd == null ? null : now(), metadata ? JSON.stringify(metadata).slice(0, 2000) : null, now());
}
function companionForApproval(approvalId) {
  return db.prepare(`SELECT ar.*,c.id challenge_id,c.status challenge_status,d.id decision_id,d.outcome,d.approved,d.source,d.decided_at,
    r.id receipt_id,r.receipt_version FROM action_requests ar
    LEFT JOIN challenges c ON c.action_request_id=ar.id LEFT JOIN authorization_decisions d ON d.action_request_id=ar.id
    LEFT JOIN authorization_receipts r ON r.action_request_id=ar.id WHERE ar.approval_id=?`).get(approvalId);
}
function createCompanion(a, b, credentialId) {
  const actionId = "act_" + crypto.randomBytes(8).toString("hex");
  const challengeId = "chl_" + crypto.randomBytes(8).toString("hex");
  db.transaction(() => {
    db.prepare(`INSERT INTO action_requests (id,approval_id,credential_id,actor,principal,action,resource,context,constraints,schema_version,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,1,?)`).run(actionId, a.id, credentialId, jsonValue(b.actor), jsonValue(b.principal), jsonValue(b.action), jsonValue(b.resource), jsonValue(b.context), jsonValue(b.constraints), now());
    db.prepare("INSERT INTO challenges (id,action_request_id,kind,channel,status,created_at) VALUES (?,?,'human_approval',?,'PENDING',?)")
      .run(challengeId, actionId, a.channel, now());
  })();
  return { actionId, challengeId };
}
function finalizeCompanion(a, source) {
  const ar = db.prepare("SELECT * FROM action_requests WHERE approval_id=?").get(a.id);
  if (!ar) return;
  const challenge = db.prepare("SELECT * FROM challenges WHERE action_request_id=?").get(ar.id);
  const decisionId = "dec_" + crypto.randomBytes(8).toString("hex");
  const receiptId = "rcp_" + crypto.randomBytes(8).toString("hex");
  const receipt = receiptFor(a, source, ar, { id: decisionId });
  const body = JSON.stringify(receipt);
  db.transaction(() => {
    db.prepare("UPDATE challenges SET status='COMPLETED',completed_at=? WHERE id=?").run(a.decided_at, challenge.id);
    db.prepare(`INSERT OR IGNORE INTO authorization_decisions (id,action_request_id,challenge_id,outcome,approved,decider,source,comment,decided_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(decisionId, ar.id, challenge.id, a.status, a.status === "approved" ? 1 : 0, a.decided_by, source, a.comment, a.decided_at);
    const d = db.prepare("SELECT id FROM authorization_decisions WHERE action_request_id=?").get(ar.id);
    db.prepare(`INSERT OR IGNORE INTO authorization_receipts (id,action_request_id,decision_id,receipt_version,body,signature,key_id,created_at)
      VALUES (?,?,?,1,?,?,?,?)`).run(receiptId, ar.id, d.id, body, sign(body), SIGN_KEY_ID, now());
    const stored = db.prepare("SELECT body,signature,key_id FROM authorization_receipts WHERE action_request_id=?").get(ar.id);
    db.prepare(`INSERT OR REPLACE INTO receipt_archive
      (approval_id,api_key,receipt_json,signature,key_id,decided_at,expires_at) VALUES (?,?,?,?,?,?,?)`)
      .run(a.id, a.api_key, stored.body, stored.signature, stored.key_id, a.decided_at || now(), (a.decided_at || now()) + RECEIPT_RETENTION_MS);
  })();
}
function signalRisk(credentialId, signalType, severity, observedValue, baselineValue = null, metadata = null) {
  db.prepare("INSERT INTO risk_signals (credential_id,signal_type,severity,observed_value,baseline_value,metadata,at) VALUES (?,?,?,?,?,?,?)")
    .run(credentialId, signalType, severity, observedValue, baselineValue, metadata ? JSON.stringify(metadata).slice(0, 2000) : null, now());
  if (!["HIGH", "CRITICAL"].includes(severity)) return;
  const id = "inc_" + crypto.randomBytes(8).toString("hex");
  db.prepare("INSERT INTO incidents (id,credential_id,severity,title,signal_types,details,created_at) VALUES (?,?,?,?,?,?,?)")
    .run(id, credentialId, severity, `${signalType} detected`, JSON.stringify([signalType]), metadata ? JSON.stringify(metadata).slice(0, 4000) : null, now());
  notifyOwner(`${severity} incident: ${signalType}`, [{ type: "section", text: { type: "mrkdwn", text: `*${severity}* ${signalType}\ncredential: ${credentialId || "global"}\nincident: ${id}` } }]);
}

(function backfillCompanionModels() {
  const rows = db.prepare("SELECT a.* FROM approvals a LEFT JOIN action_requests ar ON ar.approval_id=a.id WHERE ar.id IS NULL").all();
  for (const a of rows) {
    createCompanion(a, { context: a.context ? JSON.parse(a.context) : null }, a.api_key);
    if (a.status !== "pending") finalizeCompanion(a, "migration");
  }
  if (rows.length) console.log(`[migration] added companion authorization records for ${rows.length} approvals`);
})();

// ---------- 인증 ----------
function auth(req, res, next) {
  const key = (req.headers.authorization || "").replace(/^Bearer\s+/i, "") || req.headers["x-api-key"];
  const credential = key && db.prepare("SELECT * FROM api_credentials WHERE key_hash=?").get(credentialHash(key));
  const legacy = key && (API_KEYS.includes(key) || db.prepare("SELECT 1 FROM keys WHERE key=?").get(key));
  if (!credential && !legacy) return res.status(401).json({ error: "invalid api key" });
  if (credential && !["active", "throttled"].includes(credential.status)) {
    if (!rateLimited("audit-deny:" + credential.id, 1, 60e3)) recordEvent("credential.auth_denied", { credentialId: credential.id, subjectType: "credential", subjectId: credential.id, outcome: credential.status });
    return res.status(403).json({ error: "api key is not active", status: credential.status });
  }
  if (credential && credential.expires_at && credential.expires_at <= now()) return res.status(403).json({ error: "api key has expired" });
  req.apiKey = credential ? credential.id : key;
  req.credentialId = credential ? credential.id : "legacy_" + credentialHash(key).slice(0, 16);
  req.grant = grantFor(req.apiKey);
  req.accountId = accountForCredential(req.apiKey);
  const fingerprint = clientFingerprint(req);
  db.prepare(`INSERT INTO credential_request_fingerprints (credential_id,fingerprint,first_seen_at,last_seen_at,request_count)
    VALUES (?,?,?,?,1) ON CONFLICT(credential_id,fingerprint) DO UPDATE SET last_seen_at=excluded.last_seen_at,request_count=request_count+1`)
    .run(req.apiKey, fingerprint, now(), now());
  res.on("finish", () => {
    if (res.statusCode >= 400) recordEvent("api.request_rejected", { credentialId: req.credentialId, subjectType: "route", subjectId: req.path.slice(0, 200), outcome: String(res.statusCode), metadata: { method: req.method } });
  });
  if (credential) db.prepare("UPDATE api_credentials SET last_used_at=? WHERE id=?").run(now(), credential.id);
  next();
}

function usageThisMonth(credentialId) {
  const month = new Date().toISOString().slice(0, 7);
  return db.prepare(`SELECT COALESCE(SUM(approvals_created),0) approvals FROM daily_usage WHERE credential_id=? AND substr(day,1,7)=?`).get(credentialId, month);
}
function emailUsageThisMonth(credentialId) {
  const start = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1);
  return db.prepare("SELECT COUNT(*) c FROM operational_events WHERE credential_id=? AND event_type='notification.email_attempt' AND at>=?").get(credentialId, start).c;
}
function enforceCreateGrant(req, res, channel, callbackUrl) {
  const grant = req.grant;
  if (!["NORMAL", "WATCH", "THROTTLED"].includes(grant.risk_state)) return res.status(403).json({ error: "api key is suspended", risk_state: grant.risk_state });
  if (!grant.capabilities.includes("approvals:create")) return res.status(403).json({ error: "capability approvals:create is not granted" });
  const limit = grant.risk_state === "THROTTLED" ? Math.min(2, grant.limits.rpm) : grant.limits.rpm;
  if (rateLimited("grant-create:" + req.apiKey, limit, 60e3)) {
    signalRisk(req.apiKey, "REQUEST_RATE_SPIKE", "HIGH", limit + 1, limit);
    return res.status(429).json({ error: `rate limit: ${limit} approvals per minute per key` });
  }
  const pending = db.prepare("SELECT COUNT(*) c FROM approvals WHERE api_key=? AND status='pending'").get(req.apiKey).c;
  if (pending >= grant.limits.pending) {
    signalRisk(req.apiKey, "PENDING_SPIKE", "HIGH", pending, grant.limits.pending);
    return res.status(429).json({ error: `pending approval limit reached (${grant.limits.pending})` });
  }
  if (usageThisMonth(req.credentialId).approvals >= grant.limits.approvals_month) return res.status(429).json({ error: "monthly approval limit reached" });
  const globalThrottle = Number(db.prepare("SELECT v FROM meta WHERE k='global_expensive_throttled_until'").get()?.v || 0) > now();
  const cohortThrottle = Number(db.prepare("SELECT v FROM meta WHERE k='new_cohort_email_throttled_until'").get()?.v || 0) > now();
  const newAccount = req.accountId && db.prepare("SELECT created_at FROM accounts WHERE id=?").get(req.accountId)?.created_at >= now() - 7 * 24 * 3600 * 1000;
  if (channel === "email" && (globalThrottle || (cohortThrottle && newAccount))) return res.status(503).json({ error: "email delivery is temporarily throttled; use channel=link", capability: "email:send" });
  if (channel === "email" && (!grant.capabilities.includes("email:send") || emailUsageThisMonth(req.credentialId) >= grant.limits.emails_month)) return res.status(429).json({ error: "monthly email limit reached; use channel=link" });
  if (callbackUrl) {
    const domain = new URL(callbackUrl).hostname.toLowerCase();
    const known = db.prepare("SELECT 1 FROM credential_callback_domains WHERE credential_id=? AND domain=?").get(req.apiKey, domain);
    if (!known) {
      const count = db.prepare("SELECT COUNT(*) c FROM credential_callback_domains WHERE credential_id=?").get(req.apiKey).c;
      if (count >= grant.limits.callback_domains) return res.status(403).json({ error: "callback domain limit reached; request elevated access" });
      db.prepare("INSERT INTO credential_callback_domains (credential_id,domain,first_seen_at) VALUES (?,?,?)").run(req.apiKey, domain, now());
      if (count > 0) signalRisk(req.apiKey, "NEW_CALLBACK_DOMAIN", "MEDIUM", count + 1, count);
    }
  }
  return null;
}

function sameSecret(value, expected) {
  const a = Buffer.from(String(value || ""));
  const b = Buffer.from(String(expected || ""));
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

function presentedAdminSecret(req) {
  if (req.headers["x-admin-secret"]) return req.headers["x-admin-secret"];
  const authorization = String(req.headers.authorization || "");
  if (!authorization.startsWith("Basic ")) return "";
  try {
    const decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
    return decoded.slice(decoded.indexOf(":") + 1);
  } catch { return ""; }
}

function adminAuth(req, res, next) {
  if (rateLimited("admin:" + clientFingerprint(req), 30, 60e3)) return res.status(429).json({ error: "rate limited" });
  if (!ADMIN_SECRET || !sameSecret(presentedAdminSecret(req), ADMIN_SECRET)) {
    res.set("WWW-Authenticate", 'Basic realm="Someone Has To Say Yes admin", charset="UTF-8"');
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

const adminCsrfToken = () => crypto.createHmac("sha256", SIGNING_SECRET).update("admin-ui-action").digest("base64url");

function isPrivateAddress(address) {
  if (net.isIPv4(address)) {
    const p = address.split(".").map(Number);
    return p[0] === 10 || p[0] === 127 || p[0] === 0 ||
      (p[0] === 169 && p[1] === 254) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && p[1] === 168) || (p[0] === 100 && p[1] >= 64 && p[1] <= 127) ||
      p[0] >= 224;
  }
  if (net.isIPv6(address)) {
    const a = address.toLowerCase();
    return a === "::" || a === "::1" || a.startsWith("fc") || a.startsWith("fd") ||
      a.startsWith("fe8") || a.startsWith("fe9") || a.startsWith("fea") || a.startsWith("feb") ||
      a.startsWith("::ffff:127.") || a.startsWith("::ffff:10.") || a.startsWith("::ffff:192.168.");
  }
  return true;
}

async function validateCallbackUrl(value) {
  if (!value) return null;
  if (typeof value !== "string" || value.length > 2048) throw new Error("callback_url must be a valid URL under 2048 characters");
  let u;
  try { u = new URL(value); } catch { throw new Error("callback_url must be a valid http(s) URL"); }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw new Error("callback_url must be a valid http(s) URL without credentials");
  if (IS_PRODUCTION && u.protocol !== "https:") throw new Error("callback_url must use https in the hosted service");
  if (!ALLOW_PRIVATE_CALLBACKS) {
    let addresses;
    try { addresses = await dns.lookup(u.hostname, { all: true, verbatim: true }); }
    catch { throw new Error("callback_url hostname could not be resolved"); }
    if (!addresses.length || addresses.some((x) => isPrivateAddress(x.address))) {
      throw new Error("callback_url must not point to a private or local network");
    }
  }
  return u.toString();
}

// ---------- 공개 표현 ----------
function callbackState(a) {
  if (!a.callback_url) return "none";
  if (a.status === "pending") return "waiting_for_decision";
  const o = db.prepare("SELECT state FROM outbox WHERE approval_id=?").get(a.id);
  if (!o) return "queued";
  return o.state === "queued" ? "retrying" : o.state; // delivered | endpoint_gone | failed
}
function publicView(a) {
  const companion = companionForApproval(a.id);
  const notification = a.channel === "link" ? null : db.prepare("SELECT state,attempts,last_error FROM notification_outbox WHERE approval_id=?").get(a.id);
  return {
    callback: callbackState(a),
    notification: notification ? { state: notification.state === "queued" ? "retrying" : notification.state, attempts: notification.attempts, last_error: notification.last_error } : (a.channel === "link" ? { state: "not_needed", attempts: 0, last_error: null } : null),
    id: a.id,
    status: a.status,
    question: a.question,
    context: a.context ? JSON.parse(a.context) : null,
    channel: a.channel,
    recipient: a.recipient,
    approve_url: `${BASE_URL}/a/${a.token}`,
    timeout_at: a.timeout_at ? new Date(a.timeout_at).toISOString() : null,
    default_on_timeout: a.default_on_timeout,
    decided_by: a.decided_by,
    decided_at: a.decided_at ? new Date(a.decided_at).toISOString() : null,
    comment: a.comment,
    created_at: new Date(a.created_at).toISOString(),
    ...(companion ? { action_request_id: companion.id, schema_version: companion.schema_version, receipt_version: companion.receipt_version || 1 } : {}),
  };
}

// ---------- 승인 생성 ----------
app.post("/v1/approvals", auth, asyncRoute(async (req, res) => {
  const idem = String(req.headers["idempotency-key"] || "").trim();
  if (idem.length > 200) return res.status(400).json({ error: "Idempotency-Key must be 200 characters or fewer" });
  if (idem) {
    const existing = db.prepare("SELECT * FROM approvals WHERE api_key=? AND idempotency_key=?").get(req.apiKey, idem);
    if (existing) return res.set("Idempotent-Replayed", "true").status(200).json(publicView(existing));
  }
  const b = req.body || {};
  if (!b.question || typeof b.question !== "string" || !b.question.trim()) return res.status(400).json({ error: "question (non-empty string) required" });
  if (b.question.length > 500) return res.status(400).json({ error: "question must be 500 characters or fewer" });
  const channel = b.channel || "link";
  if (!["link", "email", "slack"].includes(channel)) return res.status(400).json({ error: "channel must be link|email|slack" });
  if (channel === "email" && !b.to) return res.status(400).json({ error: "to (email) required for channel=email" });
  if (channel === "slack" && !b.to) return res.status(400).json({ error: "to (slack channel id or user id) required for channel=slack" });
  let callbackUrl;
  try { callbackUrl = await validateCallbackUrl(b.callback_url); }
  catch (e) { return res.status(400).json({ error: e.message }); }
  const denied = enforceCreateGrant(req, res, channel, callbackUrl);
  if (denied) return denied;
  const timeoutMin = b.timeout_minutes == null ? 24 * 60 : Number(b.timeout_minutes);
  if (!(timeoutMin > 0) || timeoutMin > 60 * 24 * 90) return res.status(400).json({ error: "timeout_minutes must be > 0 and no more than 90 days" });
  const defOnTimeout = b.default_on_timeout || "rejected";
  if (!["approved", "rejected", "timed_out"].includes(defOnTimeout)) return res.status(400).json({ error: "default_on_timeout must be approved|rejected|timed_out" });

  const a = {
    id: newId(),
    token: newToken(),
    api_key: req.apiKey,
    question: b.question.trim(),
    context: b.context ? JSON.stringify(b.context) : null,
    approve_label: String(b.approve_label || "Yes").slice(0, 80),
    reject_label: String(b.reject_label || "No").slice(0, 80),
    callback_url: callbackUrl,
    channel,
    recipient: b.to || null,
    timeout_at: now() + timeoutMin * 60 * 1000,
    default_on_timeout: defOnTimeout,
    status: "pending",
    idempotency_key: idem || null,
    created_at: now(),
  };
  db.prepare(`INSERT INTO approvals (id,token,api_key,question,context,approve_label,reject_label,callback_url,channel,recipient,timeout_at,default_on_timeout,status,idempotency_key,created_at)
    VALUES (@id,@token,@api_key,@question,@context,@approve_label,@reject_label,@callback_url,@channel,@recipient,@timeout_at,@default_on_timeout,@status,@idempotency_key,@created_at)`).run(a);
  const companion = createCompanion(a, b, req.apiKey);
  recordEvent("approval.created", { credentialId: req.credentialId, subjectType: "approval", subjectId: a.id, outcome: "pending", metadata: { channel } });
  incrementUsage(req.credentialId, "approvals_created");
  analytics("first_request", { accountId: req.accountId, credentialId: req.credentialId, subjectId: a.id, milestone: "first_request_at" });
  addCost({ accountId: req.accountId, credentialId: req.credentialId, actionRequestId: companion.actionId, category: "Compute", estimatedUsd: COST_RATES_USD.approval_request });
  addCost({ accountId: req.accountId, credentialId: req.credentialId, actionRequestId: companion.actionId, category: "DB", estimatedUsd: COST_RATES_USD.db_write * 3, quantity: 3, unit: "write" });

  if (channel === "email" || channel === "slack") {
    enqueueNotification(a);
    const sent = await deliverNotification(a.id);
    if (!sent.delivered) return res.status(202).json({ ...publicView(a), delivery_warning: sent.error || "notification queued for retry" });
  }
  res.status(201).json(publicView(a));
}));

app.get("/v1/approvals/:id", auth, (req, res) => {
  const a = db.prepare("SELECT * FROM approvals WHERE id=? AND api_key=?").get(req.params.id, req.apiKey);
  if (!a) return res.status(404).json({ error: "not found" });
  res.json(publicView(a));
});

app.post("/v1/approvals/:id/cancel", auth, (req, res) => {
  const a = db.prepare("SELECT * FROM approvals WHERE id=? AND api_key=?").get(req.params.id, req.apiKey);
  if (!a) return res.status(404).json({ error: "not found" });
  if (a.status !== "pending") return res.status(409).json(publicView(a));
  const { fresh } = decide(a, "canceled", "api", null, "api");
  res.json(publicView(fresh));
});

function purgeApproval(id, includeReceipt) {
  const action = db.prepare("SELECT id FROM action_requests WHERE approval_id=?").get(id);
  db.prepare("DELETE FROM deliveries WHERE approval_id=?").run(id);
  db.prepare("DELETE FROM outbox WHERE approval_id=?").run(id);
  db.prepare("DELETE FROM notification_deliveries WHERE approval_id=?").run(id);
  db.prepare("DELETE FROM notification_outbox WHERE approval_id=?").run(id);
  if (action) {
    db.prepare("DELETE FROM authorization_receipts WHERE action_request_id=?").run(action.id);
    db.prepare("DELETE FROM authorization_decisions WHERE action_request_id=?").run(action.id);
    db.prepare("DELETE FROM challenges WHERE action_request_id=?").run(action.id);
    db.prepare("DELETE FROM action_requests WHERE id=?").run(action.id);
  }
  if (includeReceipt) db.prepare("DELETE FROM receipt_archive WHERE approval_id=?").run(id);
  return db.prepare("DELETE FROM approvals WHERE id=?").run(id).changes;
}

app.delete("/v1/approvals/:id", auth, (req, res) => {
  const a = db.prepare("SELECT id,status FROM approvals WHERE id=? AND api_key=?").get(req.params.id, req.apiKey);
  const archived = db.prepare("SELECT approval_id FROM receipt_archive WHERE approval_id=? AND api_key=?").get(req.params.id, req.apiKey);
  if (!a && !archived) return res.status(404).json({ error: "not found" });
  if (a?.status === "pending") return res.status(409).json({ error: "cancel or decide the pending approval before deleting it" });
  db.transaction(() => {
    if (a) purgeApproval(a.id, true);
    else db.prepare("DELETE FROM receipt_archive WHERE approval_id=? AND api_key=?").run(req.params.id, req.apiKey);
  })();
  res.status(204).end();
});

app.delete("/v1/data", auth, (req, res) => {
  if (req.body?.confirm !== "DELETE ALL DATA") return res.status(400).json({ error: "confirm must equal DELETE ALL DATA" });
  const pending = db.prepare("SELECT COUNT(*) c FROM approvals WHERE api_key=? AND status='pending'").get(req.apiKey).c;
  if (pending) return res.status(409).json({ error: "cancel or decide pending approvals first", pending });
  const ids = db.prepare("SELECT id FROM approvals WHERE api_key=?").all(req.apiKey);
  db.transaction(() => {
    for (const { id } of ids) purgeApproval(id, true);
    db.prepare("DELETE FROM receipt_archive WHERE api_key=?").run(req.apiKey);
  })();
  res.json({ deleted: ids.length, receipts_deleted: true });
});

app.get("/v1/retention", auth, (_req, res) => res.json({
  pending: "until decided, canceled, or timed out (maximum 90 days)",
  decision_records_days: Math.round(DECISION_RETENTION_MS / 86400e3),
  delivery_attempt_details_days: Math.round(DELIVERY_RETENTION_MS / 86400e3),
  signed_receipts_days: Math.round(RECEIPT_RETENTION_MS / 86400e3),
  delete_one: "DELETE /v1/approvals/:id",
  delete_all: "DELETE /v1/data with JSON {\"confirm\":\"DELETE ALL DATA\"}",
}));

// ---------- 결정 (공통) ----------
// 멱등: 이미 결정됐으면 아무것도 바꾸지 않고 기존 결정을 돌려준다.
function decide(a, decision, by, comment, source) {
  const r = db.prepare(`UPDATE approvals SET status=?, decided_by=?, decided_at=?, comment=? WHERE id=? AND status='pending'`)
    .run(decision, by, now(), comment || null, a.id);
  const fresh = db.prepare("SELECT * FROM approvals WHERE id=?").get(a.id);
  if (r.changes === 1) {
    finalizeCompanion(fresh, source);
    recordEvent("approval.decided", { credentialId: fresh.api_key, subjectType: "approval", subjectId: fresh.id, outcome: fresh.status, metadata: { source } });
    incrementUsage(fresh.api_key, "decisions");
    const accountId = accountForCredential(fresh.api_key);
    analytics(fresh.api_key === DEMO_KEY ? "demo_completed" : "first_decision", { accountId, credentialId: fresh.api_key, subjectId: fresh.id, milestone: fresh.api_key === DEMO_KEY ? null : "first_decision_at" });
    enqueueCallback(fresh, source);
    if (fresh.channel === "slack" && fresh.slack_ts) {
      enqueueSlackUpdate(fresh);
      deliverNotification(fresh.id).catch(() => {});
    }
  }
  return { fresh, changed: r.changes === 1 };
}

// ---------- 웹 승인 페이지 ----------
// GET은 절대 결정하지 않는다 (메일 보안 스캐너가 링크를 미리 열어보는 문제 방지). 결정은 POST로만.
app.get("/a/:token", (req, res) => {
  const a = db.prepare("SELECT * FROM approvals WHERE token=?").get(req.params.token);
  if (!a) return res.status(404).send(page("Not found", "<p class=\"muted\">This request doesn't exist.</p>"));
  res.send(page("Someone has to say yes", renderApproval(a)));
});

app.post("/a/:token", (req, res) => {
  const a = db.prepare("SELECT * FROM approvals WHERE token=?").get(req.params.token);
  if (!a) return res.status(404).send(page("Not found", "<p class=\"muted\">This request doesn't exist.</p>"));
  const decision = req.body.decision === "approved" ? "approved" : req.body.decision === "rejected" ? "rejected" : null;
  if (!decision) return res.status(400).send(page("Something's off", "<p class=\"muted\">That wasn't a yes or a no.</p>"));
  const by = (req.body.name || "").trim().slice(0, 80) || "web";
  const { fresh } = decide(a, decision, by, (req.body.comment || "").slice(0, 500), "web");
  res.send(page("Recorded", renderApproval(fresh)));
});

const fmt = (t) => new Date(t).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

function renderApproval(a) {
  const ctx = a.context ? JSON.parse(a.context) : null;
  const ctxHtml = ctx && !(ctx.demo) ? `<pre>${esc(typeof ctx === "string" ? ctx : JSON.stringify(ctx, null, 2))}</pre>` : "";
  if (a.status !== "pending") {
    const word = { approved: a.approve_label, rejected: a.reject_label, timed_out: "no answer in time", canceled: "withdrawn" }[a.status] || a.status;
    const cls = a.status === "approved" ? "yes" : "no";
    return `<p class="eyebrow">${BRAND}</p><h1>${esc(a.question)}</h1>${ctxHtml}
      <p class="verdict ${cls}">${esc(word)}.</p>
      <p class="muted">${a.decided_by ? esc(a.decided_by) + " · " : ""}${a.decided_at ? `<time data-ts="${a.decided_at}">${fmt(a.decided_at)} UTC</time>` : ""}${a.comment ? " · " + esc(a.comment) : ""}</p>
      <script>document.querySelectorAll('time[data-ts]').forEach(function(t){var d=new Date(+t.dataset.ts);t.textContent=d.toLocaleString(undefined,{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});});</script>
      <p class="muted">Already recorded. Nothing more to do.</p>`;
  }
  return `<p class="eyebrow">${BRAND}</p><h1>${esc(a.question)}</h1>${ctxHtml}
    <form method="post">
      <input name="name" placeholder="Your name (optional, it goes on the record)" aria-label="Your name">
      <input name="comment" placeholder="A note (optional)" aria-label="Note">
      <div class="row">
        <button name="decision" value="approved" class="yes">${esc(a.approve_label)}</button>
        <button name="decision" value="rejected" class="no">${esc(a.reject_label)}</button>
      </div>
    </form>
    <p class="muted">Answer by <time data-ts="${a.timeout_at}">${fmt(a.timeout_at)} UTC</time>. After that it counts as “${esc(a.default_on_timeout === "approved" ? a.approve_label : a.default_on_timeout === "rejected" ? a.reject_label : "no answer in time") }”.</p>
    <script>document.querySelectorAll('time[data-ts]').forEach(function(t){var d=new Date(+t.dataset.ts);t.textContent=d.toLocaleString(undefined,{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});});</script>`;
}

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,400;12..96,500&family=Geist+Mono&display=swap" rel="stylesheet">
<style>:root{--ink:#111;--ink2:#6F6F6F;--ink3:#B8B8B8;--rule:#E6E6E6;--yes:#1E6B3A;--no:#8A1C1C}
body{font-family:'Bricolage Grotesque',system-ui,sans-serif;max-width:560px;margin:0 auto;padding:56px 24px 80px;color:var(--ink);line-height:1.45;font-size:17px;-webkit-font-smoothing:antialiased}
.eyebrow{font-size:13px;color:var(--ink3);margin:0 0 28px}h1{font-size:clamp(26px,6vw,36px);line-height:1.1;letter-spacing:-.03em;font-weight:500;margin:0 0 20px}
pre{font:13.5px/1.6 'Geist Mono',ui-monospace,monospace;color:var(--ink2);white-space:pre-wrap;margin:0 0 24px;padding:14px 0;border-top:1px solid var(--rule);border-bottom:1px solid var(--rule)}
input{width:100%;border:0;border-bottom:1px solid var(--rule);font:inherit;padding:12px 0;background:transparent;box-sizing:border-box}input::placeholder{color:var(--ink3)}
.row{display:flex;gap:10px;margin-top:28px}button{flex:1;padding:16px;border:1px solid var(--ink);border-radius:999px;font:500 18px 'Bricolage Grotesque',sans-serif;cursor:pointer;background:#fff;color:var(--ink)}
button.yes{background:var(--ink);color:#fff}button:hover{filter:brightness(.92)}
input:focus-visible,button:focus-visible{outline:2px solid var(--ink);outline-offset:3px}
.verdict{font-size:clamp(40px,10vw,64px);letter-spacing:-.04em;line-height:1;margin:8px 0 12px;font-weight:500}.verdict.yes{color:var(--yes)}.verdict.no{color:var(--no)}
.muted{color:var(--ink2);font-size:15px;margin:14px 0 0}</style></head><body>${body}</body></html>`;
}

// ---------- 콜백 (n8n resumeUrl / Make 웹훅) ----------
// 결정 즉시 outbox에 넣고, 스윕이 전달한다. 재시도는 DB에 있으므로 재배포·재시작에도 사라지지 않는다.
// 백오프: 0s, 10s, 1m, 5m, 15m, 1h, 3h, 6h, 12h, 24h → 총 약 2일. 그 뒤 failed.
const BACKOFF = [0, 10e3, 60e3, 300e3, 900e3, 3600e3, 3*3600e3, 6*3600e3, 12*3600e3, 24*3600e3]
  .map((ms) => ms * CALLBACK_BACKOFF_SCALE);

function receiptFor(a, source, actionRequest = null, decision = null) {
  const structured = actionRequest || db.prepare("SELECT * FROM action_requests WHERE approval_id=?").get(a.id);
  return {
    receipt_version: 1,
    schema_version: structured?.schema_version || 1,
    id: a.id,
    status: a.status,
    approved: a.status === "approved",
    decided_by: a.decided_by,
    decided_at: a.decided_at ? new Date(a.decided_at).toISOString() : null,
    comment: a.comment,
    source,
    question: a.question,
    context: a.context ? JSON.parse(a.context) : null,
    channel: a.channel,
    created_at: new Date(a.created_at).toISOString(),
    issuer: BASE_URL,
    key_id: SIGN_KEY_ID,
    ...(structured ? {
      action_request_id: structured.id,
      decision_id: decision?.id || db.prepare("SELECT id FROM authorization_decisions WHERE action_request_id=?").get(structured.id)?.id || null,
      actor: structured.actor ? JSON.parse(structured.actor) : null,
      principal: structured.principal ? JSON.parse(structured.principal) : null,
      action: structured.action ? JSON.parse(structured.action) : null,
      resource: structured.resource ? JSON.parse(structured.resource) : null,
      constraints: structured.constraints ? JSON.parse(structured.constraints) : null,
    } : {}),
  };
}

function enqueueCallback(a, source) {
  if (!a.callback_url) return;
  const body = JSON.stringify(receiptFor(a, source));
  db.prepare(`INSERT OR IGNORE INTO outbox (approval_id,url,body,signature,attempts,next_at,state,created_at) VALUES (?,?,?,?,0,?,'queued',?)`)
    .run(a.id, a.callback_url, body, sign(body), now(), now());
  callbackDeliveryRequested = true;
  deliverDue().catch(() => {});
}

let delivering = false;
let callbackDeliveryRequested = false;
async function deliverDue() {
  if (delivering) return; delivering = true;
  callbackDeliveryRequested = false;
  try {
    const due = db.prepare("SELECT * FROM outbox WHERE state='queued' AND next_at <= ? ORDER BY next_at LIMIT 50").all(now());
    for (const o of due) {
      let status = null, error = null;
      try {
        await validateCallbackUrl(o.url);
        const r = await fetch(o.url, { method: "POST", redirect: "manual", headers: { "content-type": "application/json", "x-approval-signature": o.signature, "x-approval-key-id": SIGN_KEY_ID, "x-approval-id": o.approval_id }, body: o.body, signal: AbortSignal.timeout(15000) });
        status = r.status;
      } catch (e) { error = String(e.message || e); }
      db.prepare("INSERT INTO deliveries (approval_id,attempt,status_code,error,at) VALUES (?,?,?,?,?)").run(o.approval_id, o.attempts + 1, status, error, now());
      let state = "queued", next = now();
      if (status && status >= 200 && status < 300) state = "delivered";
      else if (status === 404 || status === 409 || status === 410) state = "endpoint_gone"; // n8n 일회용 resumeUrl: 소비됐거나 실행이 사라짐. 재시도는 무의미.
      else if (o.attempts + 1 >= BACKOFF.length) state = "failed";
      else next = now() + BACKOFF[o.attempts + 1];
      db.prepare("UPDATE outbox SET attempts=attempts+1, next_at=?, state=?, last_status=?, last_error=? WHERE approval_id=?").run(next, state, status, error, o.approval_id);
      recordEvent("callback.delivery", { credentialId: db.prepare("SELECT api_key FROM approvals WHERE id=?").get(o.approval_id)?.api_key, subjectType: "approval", subjectId: o.approval_id, outcome: state, metadata: { attempt: o.attempts + 1, status_code: status } });
      const callbackCredential = db.prepare("SELECT api_key FROM approvals WHERE id=?").get(o.approval_id)?.api_key;
      incrementUsage(callbackCredential, "callback_attempts");
      const callbackAccount = accountForCredential(callbackCredential);
      const callbackAction = db.prepare("SELECT id FROM action_requests WHERE approval_id=?").get(o.approval_id)?.id || null;
      addCost({ accountId: callbackAccount, credentialId: callbackCredential, actionRequestId: callbackAction, category: "External delivery", estimatedUsd: COST_RATES_USD.callback_attempt, metadata: { state } });
      if (state === "delivered") {
        analytics("first_callback", { accountId: callbackAccount, credentialId: callbackCredential, subjectId: o.approval_id, milestone: "first_callback_at" });
        analytics("first_production_action", { accountId: callbackAccount, credentialId: callbackCredential, subjectId: o.approval_id, milestone: "first_production_action_at" });
      }
      if (state === "failed") incrementUsage(callbackCredential, "callback_failures");
      if (state === "failed") notifyOwner("A callback delivery permanently failed", [{ type: "section", text: { type: "mrkdwn", text: "*Callback delivery failed*\nCheck authenticated delivery history for details. Customer URLs and approval content are not copied into operator Slack." } }]);
    }
  } finally {
    delivering = false;
    if (callbackDeliveryRequested) setImmediate(() => deliverDue().catch(() => {}));
  }
}
setInterval(() => deliverDue().catch(() => {}), DELIVERY_SWEEP_MS).unref();

// 영수증: 자기완결 JSON + 서명. 고객이 보관하고, 누구나 공개키로 검증.
app.get("/v1/approvals/:id/receipt", auth, (req, res) => {
  const a = db.prepare("SELECT * FROM approvals WHERE id=? AND api_key=?").get(req.params.id, req.apiKey);
  const archived = db.prepare("SELECT * FROM receipt_archive WHERE approval_id=? AND api_key=?").get(req.params.id, req.apiKey);
  if (!a && !archived) return res.status(404).json({ error: "not found" });
  if (a?.status === "pending") return res.status(409).json({ error: "not decided yet" });
  const canonical = a && db.prepare("SELECT r.body,r.signature,r.key_id FROM authorization_receipts r JOIN action_requests ar ON ar.id=r.action_request_id WHERE ar.approval_id=?").get(a.id);
  const o = a && db.prepare("SELECT body, signature FROM outbox WHERE approval_id=?").get(a.id);
  const body = archived?.receipt_json || canonical?.body || o?.body || JSON.stringify(receiptFor(a, "receipt"));
  const signature = archived?.signature || canonical?.signature || o?.signature || sign(body);
  res.json({ receipt: JSON.parse(body), receipt_json: body, signature, key_id: archived?.key_id || canonical?.key_id || SIGN_KEY_ID, retained_until: archived ? new Date(archived.expires_at).toISOString() : null, public_key_url: `${BASE_URL}/.well-known/approval-signing-key`, verify_url: `${BASE_URL}/v1/verify` });
});
app.get("/.well-known/approval-signing-key", (_req, res) => res.type("text/plain").send(SIGN_PUB_PEM));
app.get("/v1/signing-key", (_req, res) => res.json({ key_id: SIGN_KEY_ID, algorithm: "Ed25519", public_key_pem: SIGN_PUB_PEM, how: "verify(receipt_json bytes, base64 signature) with this key. Node: crypto.verify(null, Buffer.from(receipt_json), publicKey, Buffer.from(signature,'base64'))" }));
app.post("/v1/verify", (req, res) => {
  const { receipt_json, signature } = req.body || {};
  if (typeof receipt_json !== "string" || typeof signature !== "string") return res.status(400).json({ error: "receipt_json (string) and signature (base64) required" });
  res.json({ valid: verify(receipt_json, signature), key_id: SIGN_KEY_ID });
});
// 공개 카운터: 사람에게 전달된 결정 수 / 콜백 유실 수. 랜딩 하단용.
app.get("/v1/public-stats", (_req, res) => {
  const decided = db.prepare("SELECT COUNT(*) c FROM approvals WHERE status IN ('approved','rejected','timed_out') AND api_key<>?").get(DEMO_KEY).c;
  const delivered = db.prepare("SELECT COUNT(*) c FROM outbox WHERE state='delivered'").get().c;
  const lost = db.prepare("SELECT COUNT(*) c FROM outbox WHERE state='failed'").get().c;
  res.json({ decisions: decided, callbacks_delivered: delivered, callbacks_lost: lost });
});

app.get("/v1/approvals/:id/deliveries", auth, (req, res) => {
  const a = db.prepare("SELECT id FROM approvals WHERE id=? AND api_key=?").get(req.params.id, req.apiKey);
  if (!a) return res.status(404).json({ error: "not found" });
  res.json(db.prepare("SELECT attempt,status_code,error,at FROM deliveries WHERE approval_id=? ORDER BY attempt").all(a.id));
});

app.get("/v1/approvals/:id/notifications", auth, (req, res) => {
  const a = db.prepare("SELECT id FROM approvals WHERE id=? AND api_key=?").get(req.params.id, req.apiKey);
  if (!a) return res.status(404).json({ error: "not found" });
  const delivery = db.prepare("SELECT channel,purpose,state,attempts,provider_id,last_status,last_error,delivered_at FROM notification_outbox WHERE approval_id=?").get(a.id);
  const attempts = db.prepare("SELECT attempt,status_code,error,at FROM notification_deliveries WHERE approval_id=? ORDER BY attempt").all(a.id);
  res.json({ delivery: delivery || { state: "not_needed", attempts: 0 }, attempts });
});

// ---------- 타임아웃 스윕 ----------
setInterval(() => {
  const due = db.prepare("SELECT * FROM approvals WHERE status='pending' AND timeout_at <= ?").all(now());
  for (const a of due) decide(a, a.default_on_timeout, "timeout", null, "timeout");
  // 랜딩 데모로 만든 요청은 하루 뒤 삭제
  db.prepare("DELETE FROM approvals WHERE api_key=? AND created_at < ?").run(DEMO_KEY, now() - 24 * 3600 * 1000);
  db.prepare("DELETE FROM operational_events WHERE at < ?").run(now() - EVENT_RETENTION_DAYS * 24 * 3600 * 1000);
}, TIMEOUT_SWEEP_MS).unref();

function cleanupRetention() {
  const cutoff = now() - DECISION_RETENTION_MS;
  const old = db.prepare("SELECT id FROM approvals WHERE status<>'pending' AND decided_at IS NOT NULL AND decided_at<?").all(cutoff);
  const result = db.transaction(() => {
    const callbackAttempts = db.prepare("DELETE FROM deliveries WHERE at<?").run(now() - DELIVERY_RETENTION_MS).changes;
    const notificationAttempts = db.prepare("DELETE FROM notification_deliveries WHERE at<?").run(now() - DELIVERY_RETENTION_MS).changes;
    for (const { id } of old) purgeApproval(id, false);
    const receipts = db.prepare("DELETE FROM receipt_archive WHERE expires_at<?").run(now()).changes;
    const rateBuckets = db.prepare("DELETE FROM ratelimit WHERE window_start<?").run(now() - 2 * 86400e3).changes;
    return { decisions: old.length, callback_attempts: callbackAttempts, notification_attempts: notificationAttempts, receipts, rate_buckets: rateBuckets };
  })();
  if (Object.values(result).some(Boolean)) console.log("[retention]", JSON.stringify(result));
  return result;
}
setInterval(cleanupRetention, RETENTION_SWEEP_MS).unref();

// ---------- 지속 위험/비용 감시 ----------
function runRiskSweep() {
  const fiveMinutes = now() - 5 * 60 * 1000;
  const dayAgo = now() - 24 * 3600 * 1000;
  const raiseOnce = (bucket, credentialId, type, severity, observed, baseline, metadata = null) => {
    if (!rateLimited(`risk:${bucket}:${credentialId || "global"}`, 1, 3600e3)) signalRisk(credentialId, type, severity, observed, baseline, metadata);
  };
  const restrictExpensive = (credentialId) => {
    const current = grantFor(credentialId);
    const capabilities = current.capabilities.filter((capability) => capability !== "email:send");
    db.prepare("UPDATE credential_grants SET capabilities=?,risk_state=CASE WHEN risk_state='NORMAL' THEN 'WATCH' ELSE risk_state END,updated_at=? WHERE credential_id=?")
      .run(JSON.stringify(capabilities), now(), credentialId);
    db.prepare("UPDATE api_credentials SET risk_level=CASE WHEN risk_level='low' THEN 'medium' ELSE risk_level END WHERE id=?").run(credentialId);
  };
  const throttleCredential = (credentialId) => {
    db.prepare("UPDATE credential_grants SET risk_state='THROTTLED',updated_at=? WHERE credential_id=? AND risk_state IN ('NORMAL','WATCH')").run(now(), credentialId);
    db.prepare("UPDATE api_credentials SET status='throttled',risk_level='high' WHERE id=? AND status='active'").run(credentialId);
  };
  const suspendCredential = (credentialId, reason) => {
    db.prepare("UPDATE credential_grants SET risk_state='SUSPENDED',updated_at=?,revoke_reason=? WHERE credential_id=? AND risk_state<>'REVOKED'").run(now(), reason, credentialId);
    db.prepare("UPDATE api_credentials SET status='suspended',risk_level='critical' WHERE id=? AND status<>'revoked'").run(credentialId);
    recordEvent("credential.auto_suspended", { credentialId, subjectType: "credential", subjectId: credentialId, outcome: "suspended", metadata: { reason } });
  };
  const active = db.prepare("SELECT credential_id,risk_state FROM credential_grants WHERE risk_state NOT IN ('SUSPENDED','REVOKED')").all();
  for (const grant of active) {
    const recent = db.prepare("SELECT COUNT(*) c FROM operational_events WHERE credential_id=? AND event_type='approval.created' AND at>=?").get(grant.credential_id, fiveMinutes).c;
    const prior = db.prepare("SELECT COUNT(*) c FROM operational_events WHERE credential_id=? AND event_type='approval.created' AND at>=? AND at<?").get(grant.credential_id, dayAgo, fiveMinutes).c;
    const baseline5m = prior / 276;
    if (recent >= 10 && recent > Math.max(5, baseline5m * 5)) {
      raiseOnce("request", grant.credential_id, "REQUEST_RATE_SPIKE", "HIGH", recent, baseline5m);
      throttleCredential(grant.credential_id);
    }
    const failed = db.prepare("SELECT COUNT(*) c FROM operational_events WHERE credential_id=? AND event_type='callback.delivery' AND outcome='failed' AND at>=?").get(grant.credential_id, fiveMinutes).c;
    if (failed >= 5) raiseOnce("error", grant.credential_id, "ERROR_RATE_SPIKE", "HIGH", failed, 0);
    const emails = db.prepare("SELECT COUNT(*) c FROM operational_events WHERE credential_id=? AND event_type='notification.email_attempt' AND at>=?").get(grant.credential_id, fiveMinutes).c;
    const priorEmails = db.prepare("SELECT COUNT(*) c FROM operational_events WHERE credential_id=? AND event_type='notification.email_attempt' AND at>=? AND at<?").get(grant.credential_id, dayAgo, fiveMinutes).c;
    const emailBaseline = priorEmails / 276;
    if (emails >= 8 && emails > Math.max(4, emailBaseline * 5)) {
      raiseOnce("email", grant.credential_id, "EMAIL_RATE_SPIKE", "HIGH", emails, emailBaseline);
      restrictExpensive(grant.credential_id);
    }
    const invalid = db.prepare("SELECT COUNT(*) c FROM operational_events WHERE credential_id=? AND event_type='api.request_rejected' AND outcome='400' AND at>=?").get(grant.credential_id, fiveMinutes).c;
    if (invalid >= 20) {
      raiseOnce("invalid", grant.credential_id, "INVALID_REQUEST_SPIKE", invalid >= 60 ? "CRITICAL" : "HIGH", invalid, 2);
      if (invalid >= 60) suspendCredential(grant.credential_id, "INVALID_REQUEST_SPIKE"); else throttleCredential(grant.credential_id);
    }
    const quotaRejects = db.prepare("SELECT COUNT(*) c FROM operational_events WHERE credential_id=? AND event_type='api.request_rejected' AND outcome IN ('429','503') AND at>=?").get(grant.credential_id, fiveMinutes).c;
    if (quotaRejects >= 15) {
      raiseOnce("quota", grant.credential_id, "QUOTA_EVASION_PATTERN", "CRITICAL", quotaRejects, 0);
      suspendCredential(grant.credential_id, "QUOTA_EVASION_PATTERN");
    }
    const fingerprints = db.prepare("SELECT COUNT(*) c FROM credential_request_fingerprints WHERE credential_id=? AND last_seen_at>=?").get(grant.credential_id, fiveMinutes).c;
    if (fingerprints >= 5) {
      raiseOnce("multi-ip", grant.credential_id, "MULTI_IP_ANOMALY", fingerprints >= 12 ? "CRITICAL" : "HIGH", fingerprints, 1);
      throttleCredential(grant.credential_id);
    }
    const recentCost = db.prepare("SELECT COALESCE(SUM(estimated_usd),0) c FROM cost_ledger WHERE credential_id=? AND at>=?").get(grant.credential_id, fiveMinutes).c;
    const priorCost = db.prepare("SELECT COALESCE(SUM(estimated_usd),0) c FROM cost_ledger WHERE credential_id=? AND at>=? AND at<?").get(grant.credential_id, dayAgo, fiveMinutes).c;
    const costBaseline = priorCost / 276;
    if (recentCost >= 0.05 && recentCost > Math.max(0.01, costBaseline * 5)) {
      raiseOnce("cost", grant.credential_id, "COST_RATE_SPIKE", "HIGH", recentCost, costBaseline);
      restrictExpensive(grant.credential_id);
    }
  }
  const today = new Date(); today.setUTCHours(0,0,0,0);
  const globalCost = db.prepare("SELECT COALESCE(SUM(estimated_usd),0) c FROM cost_ledger WHERE at>=?").get(today.getTime()).c;
  if (globalCost >= GLOBAL_DAILY_COST_GUARD_USD) {
    raiseOnce("global-cost", null, "GLOBAL_COST_THRESHOLD", "CRITICAL", globalCost, GLOBAL_DAILY_COST_GUARD_USD);
    db.prepare("INSERT OR REPLACE INTO meta (k,v) VALUES ('global_expensive_throttled_until',?)").run(String(now() + 3600e3));
  }
  const newCohortCost = db.prepare(`SELECT COALESCE(SUM(cl.estimated_usd),0) c FROM cost_ledger cl JOIN accounts a ON a.id=cl.account_id
    WHERE cl.at>=? AND a.created_at>=?`).get(today.getTime(), now() - 7 * 24 * 3600 * 1000).c;
  if (newCohortCost >= NEW_ACCOUNT_DAILY_COST_GUARD_USD) {
    raiseOnce("cohort-cost", null, "GLOBAL_COST_THRESHOLD", "HIGH", newCohortCost, NEW_ACCOUNT_DAILY_COST_GUARD_USD, { cohort: "newly_verified" });
    db.prepare("INSERT OR REPLACE INTO meta (k,v) VALUES ('new_cohort_email_throttled_until',?)").run(String(now() + 3600e3));
  }
  const accountBurst = db.prepare("SELECT COUNT(*) c FROM accounts WHERE created_at>=?").get(fiveMinutes).c;
  if (accountBurst >= 20) raiseOnce("account-burst", null, "ACCOUNT_CREATION_BURST", "CRITICAL", accountBurst, 20);
  const related = db.prepare(`SELECT f.fingerprint,COUNT(DISTINCT COALESCE(g.account_id,f.credential_id)) identities,
    GROUP_CONCAT(DISTINCT f.credential_id) credentials FROM credential_request_fingerprints f
    LEFT JOIN credential_grants g ON g.credential_id=f.credential_id WHERE f.last_seen_at>=?
    GROUP BY f.fingerprint HAVING identities>=3 ORDER BY identities DESC LIMIT 20`).all(fiveMinutes);
  for (const pattern of related) raiseOnce("related-account:" + pattern.fingerprint, null, "RELATED_ACCOUNT_PATTERN", pattern.identities >= 5 ? "CRITICAL" : "HIGH", pattern.identities, 1, { credential_ids: String(pattern.credentials).split(",").slice(0, 10) });
}
setInterval(runRiskSweep, 60e3).unref();

app.post("/admin/risk/run", adminAuth, (_req, res) => {
  runRiskSweep();
  res.json({ ran_at: new Date().toISOString() });
});

// 이메일·Slack 알림은 요청 저장 후 전송한다. 업체 장애나 서버 재시작이
// 생겨도 SQLite에 남은 작업을 같은 식별자로 다시 보내 중복과 유실을 막는다.
const NOTIFICATION_BACKOFF = [0, 10e3, 60e3, 300e3, 900e3, 3600e3, 3*3600e3, 6*3600e3, 12*3600e3, 24*3600e3]
  .map((ms) => ms * NOTIFICATION_BACKOFF_SCALE);

function enqueueNotification(a) {
  db.prepare(`INSERT OR IGNORE INTO notification_outbox
    (approval_id,channel,purpose,attempts,next_at,state,created_at) VALUES (?,?,'initial',0,?,'queued',?)`)
    .run(a.id, a.channel, now(), now());
}

function enqueueSlackUpdate(a) {
  db.prepare(`INSERT INTO notification_outbox
    (approval_id,channel,purpose,attempts,next_at,state,created_at)
    VALUES (?,'slack','update',0,?,'queued',?)
    ON CONFLICT(approval_id) DO UPDATE SET purpose='update',attempts=0,next_at=excluded.next_at,state='queued',provider_id=NULL,last_status=NULL,last_error=NULL,delivered_at=NULL`)
    .run(a.id, now(), now());
}

async function deliverNotification(approvalId) {
  const claimed = db.prepare("UPDATE notification_outbox SET state='sending' WHERE approval_id=? AND state='queued' AND next_at<=?").run(approvalId, now());
  if (!claimed.changes) {
    const current = db.prepare("SELECT state,last_error FROM notification_outbox WHERE approval_id=?").get(approvalId);
    return { delivered: current?.state === "delivered", error: current?.last_error || "notification already being processed" };
  }
  const job = db.prepare("SELECT * FROM notification_outbox WHERE approval_id=?").get(approvalId);
  const a = db.prepare("SELECT * FROM approvals WHERE id=?").get(approvalId);
  if (!a || (job.purpose === "initial" && a.status !== "pending")) {
    db.prepare("UPDATE notification_outbox SET state='canceled',last_error=? WHERE approval_id=?").run("approval is no longer pending", approvalId);
    return { delivered: false, error: "approval is no longer pending" };
  }
  const attempt = job.attempts + 1;
  try {
    const result = job.purpose === "update" ? await updateSlackMessage(a) : job.channel === "email" ? await sendEmail(a) : await sendSlack(a);
    db.prepare("INSERT INTO notification_deliveries (approval_id,attempt,status_code,error,at) VALUES (?,?,?,?,?)").run(approvalId, attempt, result.status || 200, null, now());
    db.prepare("UPDATE notification_outbox SET attempts=?,state='delivered',provider_id=?,last_status=?,last_error=NULL,delivered_at=? WHERE approval_id=?")
      .run(attempt, result.providerId || null, result.status || 200, now(), approvalId);
    return { delivered: true };
  } catch (error) {
    const status = Number(error.status) || null;
    const message = String(error.message || error).slice(0, 1000);
    db.prepare("INSERT INTO notification_deliveries (approval_id,attempt,status_code,error,at) VALUES (?,?,?,?,?)").run(approvalId, attempt, status, message, now());
    const permanent = error.permanent || (status && status >= 400 && status < 500 && ![408, 409, 429].includes(status));
    const state = permanent || attempt >= NOTIFICATION_BACKOFF.length ? "failed" : "queued";
    const retryAfterMs = Number(error.retryAfter) > 0 ? Number(error.retryAfter) * 1000 : 0;
    const nextAt = now() + Math.max(NOTIFICATION_BACKOFF[Math.min(attempt, NOTIFICATION_BACKOFF.length - 1)], retryAfterMs);
    db.prepare("UPDATE notification_outbox SET attempts=?,state=?,next_at=?,last_status=?,last_error=? WHERE approval_id=?")
      .run(attempt, state, nextAt, status, message, approvalId);
    return { delivered: false, error: message };
  }
}

let deliveringNotifications = false;
async function deliverDueNotifications() {
  if (deliveringNotifications) return;
  deliveringNotifications = true;
  try {
    const due = db.prepare("SELECT approval_id FROM notification_outbox WHERE state='queued' AND next_at<=? ORDER BY next_at LIMIT 50").all(now());
    for (const row of due) await deliverNotification(row.approval_id);
  } finally { deliveringNotifications = false; }
}
setInterval(() => deliverDueNotifications().catch(() => {}), DELIVERY_SWEEP_MS).unref();

// ---------- 이메일 (Resend) ----------
async function sendEmail(a) {
  if (!RESEND_API_KEY) throw new Error("RESEND_API_KEY not set; approve_url still works");
  const url = `${BASE_URL}/a/${a.token}`;
  const ctx = a.context ? JSON.parse(a.context) : null;
  const html = `<p style="font-size:16px"><b>${esc(a.question)}</b></p>${ctx ? `<pre style="background:#f4f4f5;padding:12px">${esc(typeof ctx === "string" ? ctx : JSON.stringify(ctx, null, 2))}</pre>` : ""}
  <p><a href="${url}" style="display:inline-block;padding:12px 20px;background:#111;color:#fff;border-radius:8px;text-decoration:none">Open and decide</a></p>
  <p style="color:#666;font-size:13px">Answer by ${fmt(a.timeout_at)} UTC (about ${Math.round((a.timeout_at - now()) / 3600000)} hours from now)</p>`;
  const r = await fetch(RESEND_API_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${RESEND_API_KEY}`, "content-type": "application/json", "idempotency-key": `approval-email/${a.id}` },
    body: JSON.stringify({ from: EMAIL_FROM, to: a.recipient, subject: `[Needs a yes] ${a.question.slice(0, 60)}`, html }),
  });
  recordEvent("notification.email_attempt", { credentialId: a.api_key, subjectType: "approval", subjectId: a.id, outcome: r.ok ? "sent" : "failed" });
  addCost({ accountId: accountForCredential(a.api_key), credentialId: a.api_key, actionRequestId: db.prepare("SELECT id FROM action_requests WHERE approval_id=?").get(a.id)?.id || null, provider: "resend", category: "Email", estimatedUsd: COST_RATES_USD.email, metadata: { outcome: r.ok ? "sent" : "failed" } });
  const text = await r.text();
  if (!r.ok) {
    const error = new Error(`resend ${r.status}: ${text}`);
    error.status = r.status;
    error.retryAfter = r.headers.get("retry-after");
    throw error;
  }
  let body = {}; try { body = JSON.parse(text); } catch {}
  return { providerId: body.id || null, status: r.status };
}

// ---------- 슬랙 ----------
// 우리가 앱을 호스팅한다. 사용자는 봇 토큰과 인터랙션 URL만 한 번 설정.
// 버튼 클릭 → 3초 내 200 응답 → 메시지를 제자리에서 교체 (새 탭 없음, 404 없음).
function slackBlocks(a) {
  const ctx = a.context ? JSON.parse(a.context) : null;
  const blocks = [{ type: "section", text: { type: "mrkdwn", text: `*${a.question}*` } }];
  if (ctx) blocks.push({ type: "section", text: { type: "mrkdwn", text: "```" + (typeof ctx === "string" ? ctx : JSON.stringify(ctx, null, 2)).slice(0, 2500) + "```" } });
  if (a.status === "pending") {
    blocks.push({
      type: "actions",
      block_id: `askhuman:${a.token}`,
      elements: [
        { type: "button", style: "primary", text: { type: "plain_text", text: a.approve_label }, action_id: "approved", value: a.token },
        { type: "button", style: "danger", text: { type: "plain_text", text: a.reject_label }, action_id: "rejected", value: a.token },
      ],
    });
    const dflt = a.default_on_timeout === "approved" ? a.approve_label : a.default_on_timeout === "rejected" ? a.reject_label : "no answer in time";
    const ts = Math.floor(a.timeout_at / 1000);
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `Answer by <!date^${ts}^{date_short_pretty} at {time}|${fmt(a.timeout_at)} UTC> · after that it counts as "${dflt}" · <${BASE_URL}/a/${a.token}|open in browser>` }] });
  } else {
    const label = { approved: a.approve_label, rejected: a.reject_label, timed_out: "no answer in time", canceled: "withdrawn" }[a.status] || a.status;
    const mark = a.status === "approved" ? "✅" : "⛔";
    const dts = a.decided_at ? Math.floor(a.decided_at / 1000) : null;
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `${mark} *${label}* · ${a.decided_by || ""}${dts ? ` · <!date^${dts}^{date_short_pretty} at {time}|${fmt(a.decided_at)} UTC>` : ""}${a.comment ? ` · ${a.comment}` : ""}` }] });
  }
  return blocks;
}

function slackTokenFor(apiKey) {
  const row = db.prepare("SELECT bot_token FROM slack_installs WHERE api_key=?").get(apiKey);
  return (row && row.bot_token) || SLACK_BOT_TOKEN;
}

function issueSlackInstallToken(apiKey) {
  const token = crypto.randomBytes(24).toString("base64url");
  db.prepare("INSERT INTO slack_install_tokens (token,api_key,expires_at) VALUES (?,?,?)")
    .run(token, apiKey, now() + 30 * 24 * 3600 * 1000);
  return token;
}

async function slackApi(method, payload, token) {
  const r = await fetch(`${SLACK_API_BASE}/${method}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const j = await r.json();
  if (!r.ok || !j.ok) {
    const code = j.error || String(r.status);
    const error = new Error(`slack ${method}: ${code}`);
    error.status = r.status;
    error.retryAfter = r.headers.get("retry-after");
    error.permanent = ["invalid_auth", "not_authed", "missing_scope", "token_revoked", "account_inactive", "channel_not_found", "no_permission", "invalid_arguments"].includes(code);
    throw error;
  }
  return j;
}

function slackClientMessageId(id) {
  const hash = crypto.createHash("sha256").update(id).digest("hex").slice(0, 32);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20)}`;
}

async function sendSlack(a) {
  const token = slackTokenFor(a.api_key);
  if (!token) throw new Error(`Slack not connected for this key. Connect at ${BASE_URL}/slack/install?key=<your key>. approve_url still works`);
  const j = await slackApi("chat.postMessage", { channel: a.recipient, text: a.question, blocks: slackBlocks(a), client_msg_id: slackClientMessageId(a.id) }, token);
  db.prepare("UPDATE approvals SET slack_channel=?, slack_ts=? WHERE id=?").run(j.channel, j.ts, a.id);
  return { providerId: `${j.channel}:${j.ts}`, status: 200 };
}

async function updateSlackMessage(a) {
  const token = slackTokenFor(a.api_key);
  if (!token || !a.slack_ts) { const error = new Error("Slack message is not available for update"); error.permanent = true; throw error; }
  const j = await slackApi("chat.update", { channel: a.slack_channel, ts: a.slack_ts, text: a.question, blocks: slackBlocks(a) }, token);
  return { providerId: `${j.channel || a.slack_channel}:${j.ts || a.slack_ts}`, status: 200 };
}

// ---------- 운영자 알림 ----------
async function notifyOwner(text, blocks) {
  if (!NOTIFY_SLACK_CHANNEL) return;
  const token = slackTokenFor(NOTIFY_SLACK_KEY);
  if (!token) return;
  try { await slackApi("chat.postMessage", { channel: NOTIFY_SLACK_CHANNEL, text, blocks }, token); }
  catch (e) { console.warn("[notify]", e.message || e); }
}

function verifySlack(req) {
  if (!SLACK_SIGNING_SECRET) { console.warn("[slack] SLACK_SIGNING_SECRET is not configured"); return false; }
  const ts = req.headers["x-slack-request-timestamp"];
  const sig = req.headers["x-slack-signature"];
  if (!ts || !sig) { console.warn("[slack] missing signature headers"); return false; }
  if (Math.abs(now() / 1000 - Number(ts)) > 300) { console.warn("[slack] stale timestamp"); return false; }
  if (typeof req.rawBody !== "string") { console.warn("[slack] no raw body captured"); return false; }
  const mine = "v0=" + crypto.createHmac("sha256", SLACK_SIGNING_SECRET).update(`v0:${ts}:${req.rawBody}`).digest("hex");
  const a = Buffer.from(mine, "utf8"), b = Buffer.from(String(sig), "utf8");
  if (a.length !== b.length) { console.warn("[slack] signature mismatch (length)"); return false; }
  const ok = crypto.timingSafeEqual(a, b);
  if (!ok) console.warn("[slack] signature mismatch");
  return ok;
}

app.post("/slack/interactions", (req, res) => {
  if (!verifySlack(req)) return res.status(401).send("bad signature");
  let payload;
  try { payload = JSON.parse(req.body.payload); } catch { return res.status(400).send("bad payload"); }
  const action = (payload.actions || [])[0];
  if (!action) return res.status(200).send();
  if (!["approved", "rejected"].includes(action.action_id)) return res.status(400).send("unknown action");
  const a = db.prepare("SELECT * FROM approvals WHERE token=?").get(action.value);
  if (!a) return res.status(200).send();
  const by = payload.user?.name || payload.user?.username || payload.user?.id || "slack";
  const { fresh, changed } = decide(a, action.action_id, by, null, "slack");
  // 두 번째 클릭이어도 에러 대신 현재 상태로 메시지를 갱신해준다.
  res.status(200).json({ replace_original: true, text: fresh.question, blocks: slackBlocks(fresh) });
  void changed;
});

app.get("/v1/stats", auth, (req, res) => {
  const rows = db.prepare("SELECT status, COUNT(*) c FROM approvals WHERE api_key=? GROUP BY status").all(req.apiKey);
  const cb = db.prepare("SELECT state, COUNT(*) c FROM outbox o JOIN approvals a ON a.id=o.approval_id WHERE a.api_key=? GROUP BY state").all(req.apiKey);
  res.json({ by_status: Object.fromEntries(rows.map((r) => [r.status, r.c])), callbacks: Object.fromEntries(cb.map((r) => [r.state, r.c])) });
});

// ---------- 슬랙 설치 (워크스페이스마다 한 번) ----------
// 설치 링크에는 API 키 대신 만료되는 별도 토큰만 넣는다.
function stateFor(token) { return token + "." + crypto.createHmac("sha256", SIGNING_SECRET).update("slack:" + token).digest("hex").slice(0, 32); }
app.get("/slack/install", (req, res) => {
  if (!SLACK_CLIENT_ID) return res.status(503).send(page("Slack not configured", "<p>SLACK_CLIENT_ID is not set on this server.</p>"));
  const key = String(req.query.key || "");
  if (key) {
    const known = API_KEYS.includes(key) || db.prepare("SELECT 1 FROM keys WHERE key=?").get(key);
    if (!known) return res.status(401).send(page("Unknown key", "<p>That install link is not valid.</p>"));
    return res.redirect(303, `/slack/install?token=${issueSlackInstallToken(key)}`);
  }
  const token = String(req.query.token || "");
  const install = db.prepare("SELECT * FROM slack_install_tokens WHERE token=? AND used_at IS NULL AND expires_at>?").get(token, now());
  if (!install) return res.status(401).send(page("Install link expired", "<p>Generate a fresh Slack install link and try again.</p>"));
  const u = new URL("https://slack.com/oauth/v2/authorize");
  u.searchParams.set("client_id", SLACK_CLIENT_ID);
  u.searchParams.set("scope", "chat:write,chat:write.public,im:write");
  u.searchParams.set("redirect_uri", `${BASE_URL}/slack/oauth/callback`);
  u.searchParams.set("state", stateFor(token));
  res.redirect(u.toString());
});
app.get("/slack/oauth/callback", asyncRoute(async (req, res) => {
  const state = String(req.query.state || ""); const token = state.split(".")[0];
  const install = token && stateFor(token) === state
    ? db.prepare("SELECT * FROM slack_install_tokens WHERE token=? AND used_at IS NULL AND expires_at>?").get(token, now())
    : null;
  if (!install) return res.status(400).send(page("Bad state", "<p>Start again from a fresh Slack install link.</p>"));
  if (!req.query.code) return res.status(400).send(page("Slack declined", `<p>${esc(req.query.error || "no code")}</p>`));
  const form = new URLSearchParams({ client_id: SLACK_CLIENT_ID, client_secret: SLACK_CLIENT_SECRET, code: String(req.query.code), redirect_uri: `${BASE_URL}/slack/oauth/callback` });
  const j = await (await fetch("https://slack.com/api/oauth.v2.access", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form })).json();
  if (!j.ok) return res.status(400).send(page("Slack error", `<p>${esc(j.error)}</p>`));
  db.transaction(() => {
    db.prepare("INSERT OR REPLACE INTO slack_installs (api_key,team_id,team_name,bot_token,installed_at) VALUES (?,?,?,?,?)").run(install.api_key, j.team?.id, j.team?.name, j.access_token, now());
    db.prepare("UPDATE slack_install_tokens SET used_at=? WHERE token=?").run(now(), token);
  })();
  res.send(page("Slack connected", `<h1>Slack connected</h1><p><b>${esc(j.team?.name || j.team?.id)}</b> is now linked to your key.</p><p>Send an approval with <code>"channel": "slack", "to": "C…"</code>. Invite the bot to private channels first.</p>`));
}));

app.post("/v1/slack/install-link", auth, (req, res) => {
  const token = issueSlackInstallToken(req.apiKey);
  res.status(201).json({ slack_install_url: `${BASE_URL}/slack/install?token=${token}`, expires_in_days: 30 });
});

// ---------- 관리자: 키 발급 (재시작 없이) ----------
function issueCredential({ accountId = null, label = "", plan = "verified_limited", capabilities = null, limits = null } = {}) {
  const key = "ah_" + crypto.randomBytes(24).toString("base64url");
  const id = "cred_" + crypto.randomBytes(8).toString("hex");
  const grantedCapabilities = capabilities || ["approvals:create", "callbacks:deliver", "links:create", "email:send", "slack:send"];
  const grantedLimits = { ...INITIAL_LIMITS, ...(limits || {}) };
  db.transaction(() => {
    db.prepare(`INSERT INTO api_credentials (id,key_prefix,key_hash,label,status,risk_level,plan,created_at)
      VALUES (?,?,?,?,'active','low',?,?)`).run(id, key.slice(0, 10), credentialHash(key), String(label).slice(0, 120), plan, now());
    db.prepare(`INSERT INTO credential_grants (credential_id,account_id,capabilities,limits_json,risk_state,issued_at,updated_at)
      VALUES (?,?,?,?,'NORMAL',?,?)`).run(id, accountId, JSON.stringify(grantedCapabilities), JSON.stringify(grantedLimits), now(), now());
  })();
  recordEvent("credential.created", { credentialId: id, subjectType: "credential", subjectId: id, outcome: "active", metadata: { plan } });
  analytics("key_created", { accountId, credentialId: id, subjectId: id, milestone: "key_created_at", metadata: { plan } });
  return { id, key, key_prefix: key.slice(0, 10), label, plan, capabilities: grantedCapabilities, limits: grantedLimits };
}

function adminOverviewData() {
  const since = now() - 24 * 3600 * 1000;
  const counts = Object.fromEntries(db.prepare("SELECT status, COUNT(*) c FROM approvals GROUP BY status").all().map((r) => [r.status, r.c]));
  const activationFunnel = Object.fromEntries(db.prepare("SELECT event_name,COUNT(DISTINCT COALESCE(account_id,credential_id)) c FROM analytics_events GROUP BY event_name").all().map((r) => [r.event_name, r.c]));
  const callbacksFailed = db.prepare("SELECT COUNT(*) c FROM outbox WHERE state='failed'").get().c;
  const callbacksRetrying = db.prepare("SELECT COUNT(*) c FROM outbox WHERE state='queued'").get().c;
  const incidentsOpen = db.prepare("SELECT COUNT(*) c FROM incidents WHERE status='OPEN'").get().c;
  const pendingReviews = db.prepare("SELECT COUNT(*) c FROM access_requests WHERE status='PENDING'").get().c;
  const estimatedCostToday = db.prepare("SELECT COALESCE(SUM(estimated_usd),0) c FROM cost_ledger WHERE at>=?").get(new Date().setHours(0,0,0,0)).c;
  const requestSummary = db.prepare(`SELECT COUNT(*) total,
    COALESCE(SUM(CASE WHEN COALESCE(classification,'UNCLASSIFIED')='UNCLASSIFIED' THEN 1 ELSE 0 END),0) unclassified,
    COALESCE(SUM(CASE WHEN classification='VALID_REQUEST' THEN 1 ELSE 0 END),0) valid,
    COALESCE(SUM(CASE WHEN classification='INTERNAL_TEST' THEN 1 ELSE 0 END),0) internal_tests,
    COALESCE(SUM(CASE WHEN classification='PROMOTIONAL_SPAM' THEN 1 ELSE 0 END),0) promotional
    FROM key_requests WHERE COALESCE(management_state,'ACTIVE')<>'DELETED'`).get();
  requestSummary.valid_unverified = db.prepare(`SELECT COUNT(*) c FROM key_requests kr LEFT JOIN accounts a ON lower(a.email)=lower(kr.email)
    WHERE kr.classification='VALID_REQUEST' AND COALESCE(kr.management_state,'ACTIVE')<>'DELETED' AND a.email_verified_at IS NULL`).get().c;
  const credentialSummary = db.prepare(`SELECT COUNT(*) total,
    COALESCE(SUM(CASE WHEN status='active' AND risk_level='low' THEN 1 ELSE 0 END),0) healthy,
    COALESCE(SUM(CASE WHEN status IN ('restricted','throttled','suspended') OR (status='active' AND risk_level<>'low') THEN 1 ELSE 0 END),0) attention,
    COALESCE(SUM(CASE WHEN status IN ('revoked','blocked') THEN 1 ELSE 0 END),0) closed
    FROM api_credentials`).get();
  const protectedActions = Object.values(counts).reduce((sum, value) => sum + Number(value || 0), 0);
  const briefingItems = [];
  const addBriefing = (level, title, detail, recommendation, href, actionLabel) => briefingItems.push({ level, title, detail, recommendation, href, action_label: actionLabel });

  if (incidentsOpen || callbacksFailed) {
    addBriefing("critical", "운영 문제를 바로 확인해야 합니다.", `미해결 사고 ${incidentsOpen}건, 영구 실패 콜백 ${callbacksFailed}건이 있습니다.`, "Incidents에서 원인을 확인하고, Reliability에서 실패한 전달을 조사하세요.", incidentsOpen ? "/admin/incidents" : "/admin/reliability", "문제 확인");
  } else if (callbacksRetrying || credentialSummary.attention || Number(counts.pending || 0)) {
    addBriefing("warning", "긴급 장애는 없지만 확인할 운영 항목이 있습니다.", `재시도 중 콜백 ${callbacksRetrying}건, 제한 또는 정지된 키 ${credentialSummary.attention}개, 대기 중 승인 ${Number(counts.pending || 0)}건입니다.`, "가장 큰 숫자가 있는 섹션부터 확인하세요. 원인이 명확하지 않으면 키를 먼저 Suspend하는 것이 안전합니다.", callbacksRetrying ? "/admin/reliability" : credentialSummary.attention ? "/admin/accounts" : "/admin/traffic", "운영 항목 확인");
  } else {
    addBriefing("good", "서비스 운영은 안정적입니다.", `미해결 사고와 콜백 재시도가 없고, 현재 추가 조사가 필요한 API Key도 없습니다. 폐기 완료된 키 ${credentialSummary.closed}개는 조치 대상에서 제외했습니다.`, "긴급 조치는 없습니다. 아래 고객 요청과 활성화 기회만 확인하세요.", "/admin/reliability", "안정성 보기");
  }

  if (requestSummary.unclassified || pendingReviews) {
    addBriefing("warning", "새 요청을 분류하거나 검토해야 합니다.", `미분류 요청 ${requestSummary.unclassified}건, 사용량 확대 검토 ${pendingReviews}건이 남아 있습니다.`, "Key requests에서 실제 요청인지 먼저 분류하고, 고용량 요청은 근거를 확인한 뒤 제한과 함께 승인하세요.", "/admin/key-requests", "요청 검토");
  } else if (requestSummary.valid_unverified) {
    addBriefing("opportunity", "실제 사용 가능성이 있는 요청이 인증을 기다리고 있습니다.", `유효 요청 ${requestSummary.valid}건 중 ${requestSummary.valid_unverified}건은 아직 이메일 인증과 API Key 발급이 완료되지 않았습니다.`, "지금은 키를 수동 발급하지 말고 인증 완료 여부를 지켜보세요. 인증되면 Accounts에서 실제 사용 전환을 확인하세요.", "/admin/key-requests", "유효 요청 보기");
  } else if (requestSummary.valid) {
    addBriefing("good", "유효 요청이 정리되어 있습니다.", `현재 유효 요청 ${requestSummary.valid}건, 내부 테스트 ${requestSummary.internal_tests}건, 광고성 제출 ${requestSummary.promotional}건입니다.`, "유효 요청이 실제 API 사용으로 이어지는지 Accounts의 최초 사용 시점을 확인하세요.", "/admin/key-requests", "요청 현황 보기");
  } else {
    addBriefing("info", "새로운 유효 요청은 아직 없습니다.", `현재 활성 요청 ${requestSummary.total}건 중 실제 사용 후보로 분류된 요청이 없습니다.`, "광고성·테스트 요청은 정리된 상태로 두고, 새로운 이메일 인증 완료를 기다리세요.", "/admin/key-requests", "요청함 보기");
  }

  const firstProductionActions = Number(activationFunnel.first_production_action || 0);
  if (protectedActions > 0 && firstProductionActions === 0) {
    addBriefing("opportunity", "API 동작 기록은 있지만 실제 고객 활성화는 아직 0건입니다.", `보호된 작업은 ${protectedActions}건이지만 요청 → 사람의 결정 → 콜백 성공까지 완료한 계정은 없습니다. 테스트 또는 이전 키 사용이 섞였을 가능성이 높습니다.`, "성장 판단에는 전체 작업 수보다 ‘첫 실제 사용 완료’를 우선 보세요. 실제 사용자 1명이 전체 흐름을 완료하는 것을 다음 목표로 추천합니다.", "/admin/accounts", "활성화 확인");
  } else if (firstProductionActions > 0) {
    addBriefing("good", "실제 고객의 전체 승인 흐름이 동작했습니다.", `${firstProductionActions}개 계정이 실제 요청, 사람의 결정, 콜백 성공까지 완료했습니다.`, "Accounts에서 반복 사용 여부를 확인하고, 막히는 단계가 생기면 Activation funnel을 비교하세요.", "/admin/accounts", "활성 고객 보기");
  } else {
    addBriefing("opportunity", "첫 실제 사용을 만드는 것이 다음 목표입니다.", "아직 실제 API Key로 요청 → 결정 → 콜백 성공까지 완료한 계정이 없습니다.", "유효 요청 한 건의 설치를 도와 ‘첫 실제 사용 완료’ 1건을 만드는 데 집중하세요.", "/admin/accounts", "활성화 준비");
  }

  const costRatio = estimatedCostToday / GLOBAL_DAILY_COST_GUARD_USD;
  if (costRatio >= 0.8) {
    addBriefing("critical", "오늘 비용이 안전 한도에 가까워졌습니다.", `오늘 추정 비용은 $${Number(estimatedCostToday).toFixed(4)}로 일일 보호 한도의 ${Math.round(costRatio * 100)}%입니다.`, "Costs에서 비용이 큰 계정과 키를 확인하고 비싼 기능부터 제한하세요.", "/admin/costs", "비용 확인");
  } else if (costRatio >= 0.5) {
    addBriefing("warning", "오늘 비용 증가를 지켜봐야 합니다.", `오늘 추정 비용은 일일 보호 한도의 ${Math.round(costRatio * 100)}%입니다.`, "비용 상위 키가 정상 고객인지 확인하고 필요하면 이메일 기능부터 제한하세요.", "/admin/costs", "비용 추세 보기");
  } else {
    addBriefing("good", "오늘 비용은 안전 범위입니다.", `오늘 추정 비용은 $${Number(estimatedCostToday).toFixed(5)}이며 일일 보호 한도 $${GLOBAL_DAILY_COST_GUARD_USD.toFixed(2)}보다 충분히 낮습니다.`, "비용 때문에 지금 조치할 일은 없습니다. 실제 청구서가 오면 수동으로 입력한 확정 비용과 비교하세요.", "/admin/costs", "비용 근거 보기");
  }

  const criticalCount = briefingItems.filter((item) => item.level === "critical").length;
  const warningCount = briefingItems.filter((item) => item.level === "warning").length;
  const opportunityCount = briefingItems.filter((item) => item.level === "opportunity").length;
  const briefingStatus = criticalCount ? "ACTION" : warningCount ? "WATCH" : opportunityCount ? "OPPORTUNITY" : "CLEAR";
  const briefingHeadline = criticalCount ? `지금 바로 확인할 항목이 ${criticalCount}개 있습니다.` : warningCount ? `긴급 장애는 없고, 오늘 확인할 항목이 ${warningCount}개 있습니다.` : opportunityCount ? "서비스는 안정적입니다. 지금은 성장 전환을 확인할 때입니다." : "오늘은 별도 조치가 필요 없습니다.";
  return {
    generated_at: new Date().toISOString(),
    approvals: counts,
    callbacks_failed: callbacksFailed,
    callbacks_retrying: callbacksRetrying,
    credentials_needing_attention: credentialSummary.attention,
    incidents_open: incidentsOpen,
    pending_reviews: pendingReviews,
    activation_funnel: activationFunnel,
    estimated_cost_today_usd: estimatedCostToday,
    events_last_24h: db.prepare("SELECT event_type, outcome, COUNT(*) c FROM operational_events WHERE at>=? GROUP BY event_type,outcome ORDER BY c DESC").all(since),
    request_summary: requestSummary,
    credential_summary: credentialSummary,
    briefing: { status: briefingStatus, headline: briefingHeadline, action_count: criticalCount + warningCount, opportunity_count: opportunityCount, items: briefingItems },
  };
}

const { renderAdminConsole, screenPaths: adminScreenPaths } = require("./admin-console");
app.get("/admin/app.js", adminAuth, (_req, res) => res.type("application/javascript").sendFile(__dirname + "/admin-app.js"));
app.get(adminScreenPaths, adminAuth, (req, res, next) => {
  if (req.path !== "/admin" && !String(req.headers.accept || "").includes("text/html")) return next();
  const fallback = req.path === "/admin" ? db.prepare("SELECT id,key_prefix,status FROM api_credentials ORDER BY created_at DESC LIMIT 100").all().map((credential) => `<form method="post" action="/admin/credentials/${encodeURIComponent(credential.id)}/status"><code>${esc(credential.key_prefix)}…</code><input type="hidden" name="csrf" value="${adminCsrfToken()}"><select name="status"><option>${esc(credential.status)}</option></select><button>Save</button></form>`).join("") : "JavaScript is required for this operations screen.";
  res.type("html").send(renderAdminConsole(req.path, fallback));
});

app.get("/admin", adminAuth, (_req, res) => {
  const overview = adminOverviewData();
  const credentials = db.prepare(`SELECT id,key_prefix,label,status,risk_level,plan,created_at,last_used_at
    FROM api_credentials ORDER BY created_at DESC LIMIT 100`).all();
  const usage = db.prepare("SELECT * FROM daily_usage ORDER BY day DESC, credential_id LIMIT 100").all();
  const recentEvents = db.prepare(`SELECT event_type,credential_id,subject_id,outcome,at
    FROM operational_events ORDER BY id DESC LIMIT 50`).all();
  const card = (label, value, warn = false) => `<div class="card${warn ? " warn" : ""}"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`;
  const credentialRows = credentials.map((c) => `<tr>
    <td><code>${esc(c.key_prefix)}…</code><small>${esc(c.label || c.id)}</small></td><td>${esc(c.plan)}</td>
    <td><span class="pill ${esc(c.status)}">${esc(c.status)}</span></td><td>${esc(c.risk_level)}</td>
    <td>${c.last_used_at ? esc(new Date(c.last_used_at).toISOString().slice(0, 16).replace("T", " ")) : "Never"}</td>
    <td><form method="post" action="/admin/credentials/${encodeURIComponent(c.id)}/status">
      <input type="hidden" name="csrf" value="${adminCsrfToken()}">
      <select name="status" aria-label="Status for ${esc(c.label || c.id)}"><option${c.status === "active" ? " selected" : ""}>active</option><option${c.status === "restricted" ? " selected" : ""}>restricted</option><option${c.status === "throttled" ? " selected" : ""}>throttled</option><option${c.status === "suspended" ? " selected" : ""}>suspended</option><option${c.status === "revoked" ? " selected" : ""}>revoked</option></select>
      <button>Save</button></form></td></tr>`).join("") || `<tr><td colspan="6">No issued credentials yet.</td></tr>`;
  const usageRows = usage.map((u) => `<tr><td>${esc(u.day)}</td><td><code>${esc(u.credential_id)}</code></td><td>${u.approvals_created}</td><td>${u.decisions}</td><td>${u.callback_attempts}</td><td>${u.callback_failures}</td></tr>`).join("") || `<tr><td colspan="6">No usage recorded yet.</td></tr>`;
  const eventRows = recentEvents.map((e) => `<tr><td>${esc(new Date(e.at).toISOString().slice(0, 19).replace("T", " "))}</td><td>${esc(e.event_type)}</td><td><code>${esc(e.credential_id || "-")}</code></td><td>${esc(e.subject_id || "-")}</td><td>${esc(e.outcome || "-")}</td></tr>`).join("") || `<tr><td colspan="5">No events recorded yet.</td></tr>`;
  res.type("html").send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SHSY operations</title>
  <style>:root{color-scheme:light;--ink:#171717;--muted:#6b6b6b;--line:#dedbd5;--paper:#f7f5f0;--white:#fff;--danger:#a52a2a}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.45 system-ui,sans-serif}main{max-width:1180px;margin:auto;padding:44px 24px 80px}header{display:flex;justify-content:space-between;align-items:end;gap:20px;margin-bottom:30px}h1{font-size:32px;letter-spacing:-.04em;margin:0}h2{font-size:18px;margin:38px 0 12px}.muted,small{color:var(--muted)}.cards{display:grid;grid-template-columns:repeat(5,1fr);gap:10px}.card{background:var(--white);border:1px solid var(--line);padding:16px}.card span,.card strong{display:block}.card strong{font-size:28px;margin-top:8px}.card.warn strong{color:var(--danger)}.table{overflow:auto;background:var(--white);border:1px solid var(--line)}table{border-collapse:collapse;width:100%;min-width:720px}th,td{text-align:left;padding:11px 13px;border-bottom:1px solid var(--line);white-space:nowrap}th{font-size:12px;text-transform:uppercase;color:var(--muted)}td small{display:block}code{font-size:12px}.pill{display:inline-block;padding:3px 8px;border:1px solid var(--line);border-radius:999px}.pill.blocked,.pill.suspended{color:var(--danger);border-color:#e4b7b7}form{display:flex;gap:6px}select,button{font:inherit;border:1px solid var(--line);background:#fff;padding:6px 8px}button{cursor:pointer;background:var(--ink);color:#fff}@media(max-width:800px){.cards{grid-template-columns:repeat(2,1fr)}header{display:block}}</style></head><body><main>
  <header><div><div class="muted">Someone Has To Say Yes</div><h1>Operations</h1></div><div class="muted">Updated ${esc(overview.generated_at.slice(0, 19).replace("T", " "))} UTC</div></header>
  <section class="cards">${card("Pending", overview.approvals.pending || 0)}${card("Approved", overview.approvals.approved || 0)}${card("Callback retrying", overview.callbacks_retrying, overview.callbacks_retrying > 0)}${card("Open incidents", overview.incidents_open, overview.incidents_open > 0)}${card("Cost today", `$${Number(overview.estimated_cost_today_usd).toFixed(4)}`)}</section>
  <h2>Credentials</h2><div class="table"><table><thead><tr><th>Key</th><th>Plan</th><th>Status</th><th>Risk</th><th>Last used (UTC)</th><th>Control</th></tr></thead><tbody>${credentialRows}</tbody></table></div>
  <h2>Daily usage</h2><div class="table"><table><thead><tr><th>Day</th><th>Credential</th><th>Created</th><th>Decisions</th><th>Callback attempts</th><th>Failures</th></tr></thead><tbody>${usageRows}</tbody></table></div>
  <h2>Recent events</h2><div class="table"><table><thead><tr><th>Time (UTC)</th><th>Event</th><th>Credential</th><th>Subject</th><th>Outcome</th></tr></thead><tbody>${eventRows}</tbody></table></div>
  </main></body></html>`);
});

app.post("/admin/keys", adminAuth, (req, res) => {
  if (!ALLOW_DIRECT_ADMIN_KEYS) return res.status(403).json({ error: "direct key issuance is disabled; use email verification" });
  const label = String(req.body?.label || "").slice(0, 120);
  const plan = ["verified_limited", "production", "enterprise"].includes(req.body?.plan) ? req.body.plan : "verified_limited";
  const issued = issueCredential({ label, plan, limits: req.body?.limits, capabilities: req.body?.capabilities });
  const installToken = issueSlackInstallToken(issued.id);
  // key 원문은 이 응답에서만 볼 수 있다.
  res.status(201).json({ ...issued, slack_install_url: `${BASE_URL}/slack/install?token=${installToken}` });
});

app.get("/admin/overview", adminAuth, (req, res) => {
  res.json(adminOverviewData());
});

app.get("/admin/credentials", adminAuth, (_req, res) => {
  const credentials = db.prepare(`SELECT id,key_prefix,label,status,risk_level,plan,created_at,last_used_at,expires_at
    FROM api_credentials ORDER BY created_at DESC LIMIT 200`).all();
  res.json(credentials.map((credential) => ({ ...credential, grant: grantFor(credential.id) })));
});

app.get("/admin/usage", adminAuth, (req, res) => {
  const days = Math.min(90, Math.max(1, Number(req.query.days) || 30));
  const since = new Date(now() - (days - 1) * 24 * 3600 * 1000).toISOString().slice(0, 10);
  res.json(db.prepare("SELECT * FROM daily_usage WHERE day>=? ORDER BY day DESC, credential_id").all(since));
});

app.patch("/admin/credentials/:id", adminAuth, (req, res) => {
  const current = db.prepare("SELECT * FROM api_credentials WHERE id=?").get(req.params.id);
  if (!current) return res.status(404).json({ error: "credential not found" });
  const status = req.body?.status ?? current.status;
  const risk = req.body?.risk_level ?? current.risk_level;
  if (!["active", "restricted", "throttled", "suspended", "revoked", "blocked"].includes(status)) return res.status(400).json({ error: "status must be active|restricted|throttled|suspended|revoked" });
  if (!["low", "medium", "high", "critical"].includes(risk)) return res.status(400).json({ error: "risk_level must be low|medium|high|critical" });
  if (current.status === "revoked" && status !== "revoked") return res.status(409).json({ error: "revoked credentials cannot be restored" });
  const actionReason = String(req.body?.revoke_reason || "").trim().slice(0, 1000);
  const actionReasonCode = String(req.body?.revoke_reason_code || "").toUpperCase();
  const allowedActionReasons = ["", "ABUSE_SUSPECTED", "ABUSE_CONFIRMED", "NO_LONGER_NEEDED", "ISSUED_BY_MISTAKE", "INTERNAL_TEST_CLEANUP"];
  if (!allowedActionReasons.includes(actionReasonCode)) return res.status(400).json({ error: "invalid revoke_reason_code" });
  if (["suspended", "revoked", "blocked"].includes(status) && !actionReason) return res.status(400).json({ error: "a reason is required when suspending or deleting a credential" });
  const grant = grantFor(current.id);
  const capabilities = Array.isArray(req.body?.capabilities) ? req.body.capabilities : grant.capabilities;
  const limits = req.body?.limits && typeof req.body.limits === "object" ? { ...grant.limits, ...req.body.limits } : grant.limits;
  const knownCapabilities = new Set(["approvals:create", "callbacks:deliver", "links:create", "email:send", "slack:send"]);
  if (!capabilities.length || capabilities.some((capability) => !knownCapabilities.has(capability))) return res.status(400).json({ error: "capabilities contain an unknown or empty value" });
  for (const [name, value] of Object.entries(limits)) {
    if (!Object.hasOwn(INITIAL_LIMITS, name) || !Number.isInteger(Number(value)) || Number(value) < 0 || Number(value) > 1000000) return res.status(400).json({ error: `invalid limit: ${name}` });
    limits[name] = Number(value);
  }
  const riskState = req.body?.risk_state || ({ active: "NORMAL", restricted: "WATCH", throttled: "THROTTLED", suspended: "SUSPENDED", revoked: "REVOKED", blocked: "REVOKED" }[status]);
  if (!["NORMAL", "WATCH", "THROTTLED", "SUSPENDED", "REVOKED"].includes(riskState)) return res.status(400).json({ error: "invalid risk_state" });
  db.prepare("UPDATE api_credentials SET status=?,risk_level=? WHERE id=?").run(status, risk, current.id);
  const storedReason = actionReason ? `${actionReasonCode ? actionReasonCode + ": " : ""}${actionReason}` : null;
  db.prepare("UPDATE credential_grants SET capabilities=?,limits_json=?,risk_state=?,updated_at=?,revoked_at=CASE WHEN ?='REVOKED' THEN ? ELSE revoked_at END,revoke_reason=COALESCE(?,revoke_reason) WHERE credential_id=?")
    .run(JSON.stringify(capabilities), JSON.stringify(limits), riskState, now(), riskState, now(), storedReason, current.id);
  if (riskState === "REVOKED" && actionReasonCode === "ABUSE_CONFIRMED" && grant.account_id) db.prepare("UPDATE accounts SET status='blocked' WHERE id=?").run(grant.account_id);
  recordEvent(riskState === "REVOKED" ? "credential.admin_deleted" : "credential.updated", { credentialId: current.id, subjectType: "credential", subjectId: current.id, outcome: status, metadata: { risk_level: risk, reason_code: actionReasonCode || null, reason: actionReason || null } });
  res.json({ ...db.prepare("SELECT id,key_prefix,label,status,risk_level,plan,created_at,last_used_at,expires_at FROM api_credentials WHERE id=?").get(current.id), grant: grantFor(current.id) });
});

app.post("/admin/credentials/:id/rotate", adminAuth, (req, res) => {
  const current = db.prepare("SELECT * FROM api_credentials WHERE id=?").get(req.params.id);
  if (!current) return res.status(404).json({ error: "credential not found" });
  if (current.status === "revoked") return res.status(409).json({ error: "revoked credentials cannot be rotated" });
  const grant = grantFor(current.id);
  const next = issueCredential({ accountId: grant.account_id, label: current.label, plan: current.plan, capabilities: grant.capabilities, limits: grant.limits });
  db.prepare("UPDATE api_credentials SET status='revoked' WHERE id=?").run(current.id);
  db.prepare("UPDATE credential_grants SET risk_state='REVOKED',revoked_at=?,revoke_reason='ROTATED',updated_at=? WHERE credential_id=?").run(now(), now(), current.id);
  recordEvent("credential.rotated", { credentialId: current.id, subjectType: "credential", subjectId: next.id, outcome: "revoked_and_replaced" });
  res.status(201).json(next);
});

app.post("/v1/access-requests", auth, (req, res) => {
  if (!req.accountId) return res.status(403).json({ error: "access requests require an email-verified account" });
  const id = "arq_" + crypto.randomBytes(8).toString("hex");
  db.prepare(`INSERT INTO access_requests (id,account_id,requested_capabilities,requested_limits,intended_use,identity_confidence,intended_use_score,blast_radius_score,behavioral_history_score,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, req.accountId, JSON.stringify(req.body?.capabilities || []), JSON.stringify(req.body?.limits || {}), String(req.body?.intended_use || "").slice(0, 2000), req.body?.identity_confidence || 0, req.body?.intended_use_score || 0, req.body?.blast_radius_score || 0, req.body?.behavioral_history_score || 0, now());
  recordEvent("access_request.created", { credentialId: req.credentialId, subjectType: "access_request", subjectId: id, outcome: "PENDING" });
  res.status(201).json({ id, status: "PENDING" });
});

app.patch("/admin/access-requests/:id", adminAuth, (req, res) => {
  const current = db.prepare("SELECT * FROM access_requests WHERE id=?").get(req.params.id);
  if (!current) return res.status(404).json({ error: "access request not found" });
  const outcome = req.body?.outcome;
  if (!["APPROVE", "APPROVE_WITH_LIMITS", "REQUEST_INFO", "DENY"].includes(outcome)) return res.status(400).json({ error: "invalid review outcome" });
  if (!String(req.body?.reason || "").trim()) return res.status(400).json({ error: "review reason required" });
  db.prepare("UPDATE access_requests SET status='REVIEWED',review_outcome=?,review_reason=?,reviewed_by=?,reviewed_at=? WHERE id=?")
    .run(outcome, String(req.body.reason).slice(0, 2000), String(req.body.reviewed_by || "admin").slice(0, 120), now(), current.id);
  recordEvent("access_request.reviewed", { subjectType: "access_request", subjectId: current.id, outcome, metadata: { reason: String(req.body.reason).slice(0, 500), scores: { identity_confidence: current.identity_confidence, intended_use: current.intended_use_score, blast_radius: current.blast_radius_score, behavioral_history: current.behavioral_history_score } } });
  res.json(db.prepare("SELECT * FROM access_requests WHERE id=?").get(current.id));
});

app.get("/admin/access-requests", adminAuth, (_req, res) => res.json(db.prepare("SELECT * FROM access_requests ORDER BY created_at DESC LIMIT 200").all()));
app.get("/admin/incidents", adminAuth, (_req, res) => res.json({ incidents: db.prepare("SELECT * FROM incidents ORDER BY created_at DESC LIMIT 200").all(), signals: db.prepare("SELECT * FROM risk_signals ORDER BY id DESC LIMIT 500").all() }));
app.patch("/admin/incidents/:id", adminAuth, (req, res) => {
  const incident = db.prepare("SELECT * FROM incidents WHERE id=?").get(req.params.id);
  if (!incident) return res.status(404).json({ error: "incident not found" });
  const status = String(req.body?.status || "");
  if (!["ACKNOWLEDGED", "RESOLVED"].includes(status)) return res.status(400).json({ error: "status must be ACKNOWLEDGED or RESOLVED" });
  db.prepare("UPDATE incidents SET status=?,acknowledged_at=COALESCE(acknowledged_at,?),resolved_at=CASE WHEN ?='RESOLVED' THEN ? ELSE resolved_at END WHERE id=?")
    .run(status, now(), status, now(), incident.id);
  recordEvent("incident.updated", { credentialId: incident.credential_id, subjectType: "incident", subjectId: incident.id, outcome: status, metadata: { source: "admin_ui" } });
  res.json(db.prepare("SELECT * FROM incidents WHERE id=?").get(incident.id));
});
app.get("/admin/traffic", adminAuth, (_req, res) => res.json(db.prepare("SELECT * FROM daily_usage ORDER BY day DESC,credential_id LIMIT 500").all()));
app.get("/admin/reliability", adminAuth, (_req, res) => res.json({ callbacks: db.prepare("SELECT state,COUNT(*) count FROM outbox GROUP BY state").all(), recent_deliveries: db.prepare("SELECT * FROM deliveries ORDER BY id DESC LIMIT 100").all() }));
app.get("/admin/accounts", adminAuth, (_req, res) => res.json(db.prepare(`SELECT a.id,a.email,a.email_verified_at,a.status,a.created_at,m.* FROM accounts a LEFT JOIN account_milestones m ON m.account_id=a.id ORDER BY a.created_at DESC LIMIT 200`).all()));
app.get("/admin/costs", adminAuth, (req, res) => {
  const startToday = new Date(); startToday.setUTCHours(0, 0, 0, 0);
  const startMonth = Date.UTC(startToday.getUTCFullYear(), startToday.getUTCMonth(), 1);
  const sum = (since) => db.prepare("SELECT COALESCE(SUM(estimated_usd),0) estimated,COALESCE(SUM(actual_usd),0) actual FROM cost_ledger WHERE at>=?").get(since);
  const today = sum(startToday.getTime()), mtd = sum(startMonth);
  const day = Math.max(1, startToday.getUTCDate());
  const unitCosts = db.prepare(`SELECT
    COALESCE(SUM(estimated_usd)/NULLIF(COUNT(DISTINCT action_request_id),0),0) per_protected_action,
    COALESCE(SUM(CASE WHEN category='Email' THEN estimated_usd ELSE 0 END)/NULLIF(SUM(CASE WHEN category='Email' THEN quantity ELSE 0 END),0),0) per_email,
    COALESCE(SUM(CASE WHEN category='External delivery' THEN estimated_usd ELSE 0 END)/NULLIF(SUM(CASE WHEN category='External delivery' THEN quantity ELSE 0 END),0),0) per_callback
    FROM cost_ledger WHERE at>=?`).get(startMonth);
  res.json({ today, mtd, projected_month_estimated_usd: mtd.estimated / day * new Date(Date.UTC(startToday.getUTCFullYear(), startToday.getUTCMonth() + 1, 0)).getUTCDate(), unit_costs: unitCosts, by_category: db.prepare("SELECT category,SUM(estimated_usd) estimated,SUM(actual_usd) actual FROM cost_ledger WHERE at>=? GROUP BY category ORDER BY estimated DESC").all(startMonth), top_accounts: db.prepare("SELECT account_id,SUM(estimated_usd) estimated FROM cost_ledger WHERE at>=? GROUP BY account_id ORDER BY estimated DESC LIMIT 20").all(startMonth), top_keys: db.prepare("SELECT credential_id,SUM(estimated_usd) estimated FROM cost_ledger WHERE at>=? GROUP BY credential_id ORDER BY estimated DESC LIMIT 20").all(startMonth), guardrails: { global_daily_usd: GLOBAL_DAILY_COST_GUARD_USD, newly_verified_daily_usd: NEW_ACCOUNT_DAILY_COST_GUARD_USD } });
});

app.post("/admin/costs/reconcile", adminAuth, (req, res) => {
  const category = String(req.body?.category || "Third-party APIs");
  if (!["Compute", "DB", "Storage", "Email", "External delivery", "Bandwidth", "Background jobs", "Retries", "Third-party APIs"].includes(category)) return res.status(400).json({ error: "invalid cost category" });
  const actual = Number(req.body?.actual_usd);
  if (!Number.isFinite(actual) || actual < 0) return res.status(400).json({ error: "actual_usd must be a non-negative number" });
  addCost({ accountId: req.body?.account_id || null, credentialId: req.body?.credential_id || null, provider: String(req.body?.provider || "manual").slice(0, 100), category, quantity: Number(req.body?.quantity) || 1, unit: String(req.body?.unit || "invoice").slice(0, 50), estimatedUsd: Number(req.body?.estimated_usd) || 0, actualUsd: actual, metadata: { source: "provider_reconciliation", period: req.body?.period || null } });
  recordEvent("cost.reconciled", { credentialId: req.body?.credential_id || null, subjectType: "cost", outcome: "reconciled", metadata: { provider: req.body?.provider || "manual", category, actual_usd: actual } });
  res.status(201).json({ reconciled: true });
});

app.post("/admin/credentials/:id/status", adminAuth, (req, res) => {
  if (!sameSecret(req.body?.csrf, adminCsrfToken())) return res.status(403).send("Invalid form token");
  const current = db.prepare("SELECT * FROM api_credentials WHERE id=?").get(req.params.id);
  if (!current) return res.status(404).send("Credential not found");
  const status = String(req.body?.status || "");
  if (!["active", "restricted", "throttled", "suspended", "revoked"].includes(status)) return res.status(400).send("Invalid status");
  db.prepare("UPDATE api_credentials SET status=? WHERE id=?").run(status, current.id);
  const riskState = ({ active: "NORMAL", restricted: "WATCH", throttled: "THROTTLED", suspended: "SUSPENDED", revoked: "REVOKED" }[status]);
  db.prepare("UPDATE credential_grants SET risk_state=?,updated_at=?,revoked_at=CASE WHEN ?='REVOKED' THEN ? ELSE revoked_at END WHERE credential_id=?").run(riskState, now(), riskState, now(), current.id);
  recordEvent("credential.updated", { credentialId: current.id, subjectType: "credential", subjectId: current.id, outcome: status, metadata: { risk_level: current.risk_level, source: "admin_ui" } });
  res.redirect(303, "/admin");
});

app.get("/admin/events", adminAuth, (req, res) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
  res.json(db.prepare(`SELECT id,event_type,credential_id,subject_type,subject_id,outcome,metadata,at
    FROM operational_events ORDER BY id DESC LIMIT ?`).all(limit));
});
// 서명 비밀키 내보내기 (한 번만 쓰고 Railway 환경변수 SIGNING_KEY에 넣는다. 그러면 볼륨이 날아가도 키는 산다)
app.get("/admin/signing-key-export", adminAuth, (req, res) => {
  const row = db.prepare("SELECT v FROM meta WHERE k='signing_key'").get();
  res.type("text/plain").send(process.env.SIGNING_KEY || (row && row.v) || "");
});
// DB 스냅샷 다운로드 (무료 백업: 주 1회 내려받아 보관)
app.get("/admin/backup", adminAuth, asyncRoute(async (req, res) => {
  const tmp = `/tmp/backup-${Date.now()}.db`;
  await db.backup(tmp);
  res.download(tmp, `approvals-${new Date().toISOString().slice(0, 10)}.db`, () => { try { require("fs").unlinkSync(tmp); } catch {} });
}));

const keyRequestAccountByEmail = db.prepare("SELECT * FROM accounts WHERE lower(email)=lower(?)");
const keyRequestCredentials = db.prepare(`SELECT c.id,c.key_prefix,c.label,c.status,c.plan,c.last_used_at,g.risk_state,g.revoked_at,g.revoke_reason
    FROM api_credentials c LEFT JOIN credential_grants g ON g.credential_id=c.id
    WHERE c.id=COALESCE(?, '') OR g.account_id=COALESCE(?, '') OR lower(c.label)=lower(?) OR lower(c.label) LIKE lower(?)
    ORDER BY c.created_at DESC`);
const keyRequestUsage = db.prepare(`SELECT COALESCE(SUM(approvals_created),0) approvals_created,COALESCE(SUM(decisions),0) decisions,
    COALESCE(SUM(callback_attempts),0) callback_attempts,COALESCE(SUM(callback_failures),0) callback_failures FROM daily_usage WHERE credential_id=?`);

function keyRequestEvidence(request) {
  const account = keyRequestAccountByEmail.get(request.email);
  const credentials = keyRequestCredentials.all(request.credential_id || null, account?.id || null, request.email, `${request.email} · %`)
    .map((credential) => ({ ...credential, ...keyRequestUsage.get(credential.id) }));
  return {
    ...request,
    classification: request.classification || "UNCLASSIFIED",
    management_state: request.management_state || "ACTIVE",
    account_id: account?.id || null,
    account_status: account?.status || null,
    email_verified_at: account?.email_verified_at || request.verified_at || null,
    credentials,
  };
}

app.get("/admin/key-requests", adminAuth, (req, res) => {
  const includeDeleted = String(req.query.include_deleted || "") === "1";
  const requests = db.prepare(`SELECT * FROM key_requests ${includeDeleted ? "" : "WHERE COALESCE(management_state,'ACTIVE')<>'DELETED'"} ORDER BY at DESC LIMIT 200`).all();
  res.json(requests.map(keyRequestEvidence));
});

app.patch("/admin/key-requests/:id/classification", adminAuth, (req, res) => {
  const request = db.prepare("SELECT * FROM key_requests WHERE id=?").get(req.params.id);
  if (!request) return res.status(404).json({ error: "key request not found" });
  const classification = String(req.body?.classification || "");
  const allowed = ["UNCLASSIFIED", "VALID_REQUEST", "INTERNAL_TEST", "PROMOTIONAL_SPAM"];
  if (!allowed.includes(classification)) return res.status(400).json({ error: "invalid classification" });
  const reason = String(req.body?.reason || "").trim().slice(0, 2000);
  if (classification !== "UNCLASSIFIED" && !reason) return res.status(400).json({ error: "classification reason required" });
  const classifiedAt = classification === "UNCLASSIFIED" ? null : now();
  const classifiedBy = classification === "UNCLASSIFIED" ? null : String(req.body?.classified_by || "admin").slice(0, 120);
  db.prepare("UPDATE key_requests SET classification=?,classification_reason=?,classified_at=?,classified_by=? WHERE id=?")
    .run(classification === "UNCLASSIFIED" ? null : classification, reason || null, classifiedAt, classifiedBy, request.id);
  recordEvent("key_request.classified", { subjectType: "key_request", subjectId: String(request.id), outcome: classification, metadata: { reason, classified_by: classifiedBy } });
  res.json({ ...db.prepare("SELECT * FROM key_requests WHERE id=?").get(request.id), classification });
});

app.patch("/admin/key-requests/:id/management", adminAuth, (req, res) => {
  const request = db.prepare("SELECT * FROM key_requests WHERE id=?").get(req.params.id);
  if (!request) return res.status(404).json({ error: "key request not found" });
  const action = String(req.body?.action || "").toUpperCase();
  if (!["SUSPEND", "RESTORE", "DELETE"].includes(action)) return res.status(400).json({ error: "action must be SUSPEND|RESTORE|DELETE" });
  const reasonCode = String(req.body?.reason_code || "").toUpperCase();
  const allowedReasons = ["ABUSE_SUSPECTED", "ABUSE_CONFIRMED", "NO_LONGER_NEEDED", "ISSUED_BY_MISTAKE", "INTERNAL_TEST_CLEANUP", "INVESTIGATION_CLEARED"];
  if (!allowedReasons.includes(reasonCode)) return res.status(400).json({ error: "invalid management reason code" });
  const reason = String(req.body?.reason || "").trim().slice(0, 2000);
  if (!reason) return res.status(400).json({ error: "management reason required" });
  const evidence = keyRequestEvidence(request);
  if (action === "RESTORE" && evidence.management_state === "DELETED") return res.status(409).json({ error: "deleted requests and revoked keys cannot be restored" });
  const affected = [];
  const managedAt = now();
  db.transaction(() => {
    for (const credential of evidence.credentials) {
      if (action === "SUSPEND" && credential.status !== "revoked") {
        db.prepare("UPDATE api_credentials SET status='suspended',risk_level='critical' WHERE id=?").run(credential.id);
        db.prepare("UPDATE credential_grants SET risk_state='SUSPENDED',updated_at=?,revoke_reason=? WHERE credential_id=? AND risk_state<>'REVOKED'").run(managedAt, reasonCode, credential.id);
        recordEvent("credential.admin_suspended", { credentialId: credential.id, subjectType: "key_request", subjectId: String(request.id), outcome: "suspended", metadata: { reason_code: reasonCode, reason } });
        affected.push(credential.id);
      }
      if (action === "RESTORE" && credential.status === "suspended") {
        db.prepare("UPDATE api_credentials SET status='active',risk_level='low' WHERE id=?").run(credential.id);
        db.prepare("UPDATE credential_grants SET risk_state='NORMAL',updated_at=?,revoke_reason=NULL WHERE credential_id=? AND risk_state='SUSPENDED'").run(managedAt, credential.id);
        recordEvent("credential.admin_restored", { credentialId: credential.id, subjectType: "key_request", subjectId: String(request.id), outcome: "active", metadata: { reason_code: reasonCode, reason } });
        affected.push(credential.id);
      }
      if (action === "DELETE" && credential.status !== "revoked") {
        db.prepare("UPDATE api_credentials SET status='revoked',risk_level='critical' WHERE id=?").run(credential.id);
        db.prepare("UPDATE credential_grants SET risk_state='REVOKED',updated_at=?,revoked_at=COALESCE(revoked_at,?),revoke_reason=? WHERE credential_id=?").run(managedAt, managedAt, reasonCode, credential.id);
        recordEvent("credential.admin_deleted", { credentialId: credential.id, subjectType: "key_request", subjectId: String(request.id), outcome: "revoked", metadata: { reason_code: reasonCode, reason } });
        affected.push(credential.id);
      }
    }
    const nextState = action === "SUSPEND" ? "SUSPENDED" : action === "DELETE" ? "DELETED" : "ACTIVE";
    db.prepare("UPDATE key_requests SET management_state=?,management_reason_code=?,management_reason=?,managed_at=?,managed_by='admin' WHERE id=?")
      .run(nextState, reasonCode, reason, managedAt, request.id);
    if (action === "DELETE" && reasonCode === "ABUSE_CONFIRMED" && evidence.account_id) db.prepare("UPDATE accounts SET status='blocked' WHERE id=?").run(evidence.account_id);
    recordEvent(`key_request.${action.toLowerCase()}`, { subjectType: "key_request", subjectId: String(request.id), outcome: nextState, metadata: { reason_code: reasonCode, reason, affected_credentials: affected.length } });
  })();
  res.json({ request: keyRequestEvidence(db.prepare("SELECT * FROM key_requests WHERE id=?").get(request.id)), affected_credentials: affected, usage_history_preserved: true });
});

// ---------- 키 요청 (랜딩 폼) ----------
async function sendVerificationEmail(email, verificationUrl) {
  if (!RESEND_API_KEY) {
    if (IS_PRODUCTION) throw new Error("email verification provider is not configured");
    console.log(`[verification] ${verificationUrl}`);
    return false;
  }
  const r = await fetch(RESEND_API_URL, { method: "POST", headers: { authorization: `Bearer ${RESEND_API_KEY}`, "content-type": "application/json" }, body: JSON.stringify({
    from: EMAIL_FROM, to: email, subject: "Verify your email to get your API key",
    html: `<p>Confirm this email to create your limited, real API key.</p><p><a href="${esc(verificationUrl)}">Verify email and create key</a></p><p>This link expires in 30 minutes.</p>`,
  }) });
  if (!r.ok) throw new Error(`verification email ${r.status}: ${await r.text()}`);
  return true;
}

app.post("/request-key", asyncRoute(async (req, res) => {
  const wantsJson = req.is("application/json") || String(req.headers.accept || "").includes("application/json");
  if (rateLimited("reqkey:" + clientFingerprint(req), 5, 3600e3)) return wantsJson ? res.status(429).json({ error: "Too many requests from this address. Try again in an hour." }) : res.status(429).send(page("Slow down", "<p class=\"muted\">Too many requests from this address. Try again in an hour.</p>"));
  const email = String(req.body.email || "").trim().toLowerCase().slice(0, 200);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return wantsJson ? res.status(400).json({ error: "Enter a valid email address." }) : res.status(400).send(page("Check the email", "<p>That doesn't look like an email address. Go back and try again.</p>"));
  const stored = db.prepare("INSERT INTO key_requests (email,tool,note,at) VALUES (?,?,?,?)").run(email, String(req.body.tool || "").slice(0, 40), String(req.body.note || "").slice(0, 500), now());
  let account = db.prepare("SELECT * FROM accounts WHERE email=?").get(email);
  if (!account) {
    const id = "acct_" + crypto.randomBytes(8).toString("hex");
    db.prepare("INSERT INTO accounts (id,email,created_at) VALUES (?,?,?)").run(id, email, now());
    db.prepare("INSERT INTO account_milestones (account_id,updated_at) VALUES (?,?)").run(id, now());
    account = db.prepare("SELECT * FROM accounts WHERE id=?").get(id);
  }
  if (account.status === "blocked") {
    db.prepare("UPDATE key_requests SET management_state='DELETED',management_reason_code='ABUSE_CONFIRMED',management_reason='Blocked account attempted to request another key',managed_at=?,managed_by='system' WHERE id=?")
      .run(now(), Number(stored.lastInsertRowid));
    recordEvent("key_request.blocked_reissue", { subjectType: "account", subjectId: account.id, outcome: "blocked", metadata: { request_id: Number(stored.lastInsertRowid) } });
    return wantsJson ? res.status(403).json({ error: "This account cannot request a new key." }) : res.status(403).send(page("Request blocked", "<p>This account cannot request a new key.</p>"));
  }
  const rawToken = crypto.randomBytes(32).toString("base64url");
  db.prepare("INSERT INTO verification_tokens (token_hash,account_id,expires_at,created_at,request_id) VALUES (?,?,?,?,?)")
    .run(credentialHash(rawToken), account.id, now() + 30 * 60 * 1000, now(), Number(stored.lastInsertRowid));
  const verificationUrl = `${BASE_URL}/verify-email?token=${encodeURIComponent(rawToken)}`;
  const sent = await sendVerificationEmail(email, verificationUrl);
  recordEvent("key_request.verification_sent", { subjectType: "account", subjectId: account.id, outcome: sent ? "sent" : "development_logged", metadata: { request_id: Number(stored.lastInsertRowid) } });
  if (wantsJson) return res.status(202).json({ request_id: Number(stored.lastInsertRowid), status: "verification_sent" });
  res.send(page("Check your email", `<h1>Check your email</h1><p>Open the verification link sent to <b>${esc(email)}</b>. Your limited, real API key will be created immediately after verification.</p>${!sent ? `<p class="muted">Development only: <a href="${esc(verificationUrl)}">open verification link</a>.</p>` : ""}<p class="muted">Higher-volume use can be requested for review later.</p>`));
}));

app.get("/verify-email", (req, res) => {
  const tokenHash = credentialHash(String(req.query.token || ""));
  const token = db.prepare("SELECT * FROM verification_tokens WHERE token_hash=? AND used_at IS NULL AND expires_at>?").get(tokenHash, now());
  if (!token) return res.status(400).send(page("Link expired", "<h1>This link is no longer valid.</h1><p>Request a fresh key from the home page.</p>"));
  const account = db.prepare("SELECT * FROM accounts WHERE id=?").get(token.account_id);
  if (!account || account.status === "blocked") return res.status(403).send(page("Request blocked", "<h1>This account cannot create another key.</h1>"));
  res.send(page("Confirm your email", `<p class="eyebrow">Email verification</p><h1>Create my limited API key</h1><p>Press the button to confirm this email. Opening the link alone does not create or reveal a key.</p><form method="post"><button>Verify email and create key</button></form>`));
});

app.post("/verify-email", (req, res) => {
  const tokenHash = credentialHash(String(req.query.token || ""));
  const token = db.prepare("SELECT * FROM verification_tokens WHERE token_hash=? AND used_at IS NULL AND expires_at>?").get(tokenHash, now());
  if (!token) return res.status(400).send(page("Link expired", "<h1>This link is no longer valid.</h1><p>Request a fresh key from the home page.</p>"));
  const account = db.prepare("SELECT * FROM accounts WHERE id=?").get(token.account_id);
  if (!account || account.status === "blocked") return res.status(403).send(page("Request blocked", "<h1>This account cannot create another key.</h1>"));
  let issued;
  db.transaction(() => {
    const used = db.prepare("UPDATE verification_tokens SET used_at=? WHERE token_hash=? AND used_at IS NULL").run(now(), tokenHash);
    if (used.changes !== 1) throw new Error("verification token already used");
    db.prepare("UPDATE accounts SET email_verified_at=COALESCE(email_verified_at,?) WHERE id=?").run(now(), account.id);
    issued = issueCredential({ accountId: account.id, label: account.email, plan: "verified_limited" });
    if (token.request_id) db.prepare("UPDATE key_requests SET credential_id=? WHERE id=?").run(issued.id, token.request_id);
  })();
  const installToken = issueSlackInstallToken(issued.id);
  res.send(page("Your API key", `<p class="eyebrow">Email verified</p><h1>Your real API key is ready.</h1><pre>${esc(issued.key)}</pre><p>Copy it now. For safety, it cannot be shown again.</p><p><a href="${esc(`${BASE_URL}/slack/install?token=${installToken}`)}">Connect Slack</a></p><pre>${esc(JSON.stringify(issued.limits, null, 2))}</pre><p class="muted">This key uses the real API with small safety limits. Higher-volume access requires review.</p>`));
});

// ---------- 데모: 랜딩에서 실제 승인 링크를 만들어 보여줌 ----------
app.post("/demo", (req, res) => {
  if (rateLimited("demo:" + clientFingerprint(req), 20, 3600e3)) return res.status(429).json({ error: "too many demo requests from this address; try again in an hour" });
  const a = {
    id: newId(), token: newToken(), api_key: DEMO_KEY,
    question: String(req.body.question || "Refund order A-1 for $380?").slice(0, 200),
    context: JSON.stringify({ demo: true, created_from: "landing" }),
    approve_label: "Yes", reject_label: "No", callback_url: null, channel: "link", recipient: null,
    timeout_at: now() + 10 * 60 * 1000, default_on_timeout: "rejected", status: "pending", created_at: now(),
  };
  db.prepare(`INSERT INTO approvals (id,token,api_key,question,context,approve_label,reject_label,callback_url,channel,recipient,timeout_at,default_on_timeout,status,created_at)
    VALUES (@id,@token,@api_key,@question,@context,@approve_label,@reject_label,@callback_url,@channel,@recipient,@timeout_at,@default_on_timeout,@status,@created_at)`).run(a);
  createCompanion(a, { context: { demo: true, created_from: "landing" } }, DEMO_KEY);
  analytics("demo_started", { credentialId: DEMO_KEY, subjectId: a.id });
  res.json({ id: a.id, approve_url: `${BASE_URL}/a/${a.token}`, status_url: `${BASE_URL}/demo/${a.id}` });
});
app.get("/demo/:id", (req, res) => {
  const a = db.prepare("SELECT * FROM approvals WHERE id=? AND api_key=?").get(req.params.id, DEMO_KEY);
  if (!a) return res.status(404).json({ error: "not found" });
  res.json(publicView(a));
});

// ---------- 랜딩 ----------
const fs = require("fs");
const LANDING = fs.existsSync(__dirname + "/landing.html") ? fs.readFileSync(__dirname + "/landing.html", "utf8") : "<h1>askhuman</h1>";
const PUBLIC_FILES = new Map([
  ["/approval-flow-motion.html", "approval-flow-motion.html"],
  ["/trust", "trust.html"],
  ["/status", "status.html"],
  ["/relay", "relay.html"],
  ["/relay/templates", "relay-templates.html"],
  ["/starters/n8n-email-approval.json", "examples/n8n-email-approval-starter.json"],
  ["/starters/n8n-slack-approval.json", "examples/n8n-approval-demo.json"],
  ["/templates/n8n-ai-email-approval.json", "examples/n8n-ai-email-approval.json"],
  ["/templates/n8n-refund-approval.json", "examples/n8n-refund-approval.json"],
  ["/templates/n8n-content-publish-approval.json", "examples/n8n-content-publish-approval.json"],
  ["/templates/n8n-crm-bulk-change-approval.json", "examples/n8n-crm-bulk-change-approval.json"],
]);
app.get([...PUBLIC_FILES.keys()], (req, res, next) => {
  res.set("Cache-Control", "public, max-age=300");
  res.sendFile(__dirname + "/" + PUBLIC_FILES.get(req.path), (error) => error ? next(error) : undefined);
});
app.get("/", (_req, res) => res.type("html").send(LANDING.replaceAll("{{BASE_URL}}", BASE_URL)));

app.get("/health", (_req, res) => {
  const check = db.pragma("quick_check", { simple: true });
  res.status(check === "ok" ? 200 : 503).json({
    ok: check === "ok",
    database: check === "ok" ? "ok" : "error",
    pending: db.prepare("SELECT COUNT(*) c FROM approvals WHERE status='pending'").get().c,
    callbacks_queued: db.prepare("SELECT COUNT(*) c FROM outbox WHERE state='queued'").get().c,
  });
});

app.use((err, req, res, _next) => {
  console.error("[request-error]", req.method, req.path, err && (err.stack || err.message || err));
  if (res.headersSent) return res.end();
  res.status(500).json({ error: "internal server error" });
});

const server = app.listen(PORT, () => console.log(`${BRAND} listening on ${BASE_URL}`));
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal}`);
  server.close();
  const deadline = now() + 16000;
  while (delivering && now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  try { db.pragma("wal_checkpoint(TRUNCATE)"); } catch {}
  try { db.close(); } catch {}
  process.exit(0);
}
process.on("SIGTERM", () => { shutdown("SIGTERM").catch(() => process.exit(1)); });
process.on("SIGINT", () => { shutdown("SIGINT").catch(() => process.exit(1)); });
