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
// 운영에서는 DB 발급 키만으로 실행할 수 있다. 개발 환경에서만 편의용 기본 키를 둔다.
const API_KEYS = (process.env.API_KEYS || (process.env.NODE_ENV === "production" ? "" : "dev-key"))
  .split(",").map((s) => s.trim()).filter(Boolean);
const SIGNING_SECRET = process.env.SIGNING_SECRET || "change-me"; // 내부 상태 토큰용 (슬랙 OAuth state)
// 서명키: 환경변수 SIGNING_KEY (PEM). 없으면 DB에 하나 만들어 보관.
let SIGN_PRIV = null, SIGN_PUB_PEM = null, SIGN_KEY_ID = null;
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
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
const RESEND_API_URL = process.env.RESEND_API_URL || "https://api.resend.com/emails";
const SLACK_API_BASE = (process.env.SLACK_API_BASE || "https://slack.com/api").replace(/\/$/, "");
const DECISION_RETENTION_MS = Math.max(1, Number(process.env.DECISION_RETENTION_DAYS) || 90) * 86400e3;
const DELIVERY_RETENTION_MS = Math.max(1, Number(process.env.DELIVERY_RETENTION_DAYS) || 30) * 86400e3;
const RECEIPT_RETENTION_MS = Math.max(1, Number(process.env.RECEIPT_RETENTION_DAYS) || 365) * 86400e3;
const RETENTION_SWEEP_MS = Math.max(1000, Number(process.env.RETENTION_SWEEP_MS) || 6 * 3600e3);
const KEY_REQUEST_RETENTION_MS = Math.max(1, Number(process.env.KEY_REQUEST_RETENTION_DAYS) || 90) * 86400e3;
const REVIEW_KEY_RATE_LIMIT = Math.max(1, Number(process.env.REVIEW_KEY_RATE_LIMIT) || 60);
const KEY_MONTHLY_APPROVAL_LIMIT = Math.max(1, Number(process.env.KEY_MONTHLY_APPROVAL_LIMIT) || 1000);
const KEY_MONTHLY_EMAIL_LIMIT = Math.max(1, Number(process.env.KEY_MONTHLY_EMAIL_LIMIT) || 300);
const KEY_PENDING_LIMIT = Math.max(1, Number(process.env.KEY_PENDING_LIMIT) || 100);
const GLOBAL_MONTHLY_APPROVAL_LIMIT = Math.max(1, Number(process.env.GLOBAL_MONTHLY_APPROVAL_LIMIT) || 10000);
const GLOBAL_DAILY_EMAIL_LIMIT = Math.max(1, Number(process.env.GLOBAL_DAILY_EMAIL_LIMIT) || 90);
const GLOBAL_DAILY_KEY_REQUEST_LIMIT = Math.max(1, Number(process.env.GLOBAL_DAILY_KEY_REQUEST_LIMIT) || 120);
const ALLOW_DIRECT_ADMIN_KEYS = process.env.ALLOW_DIRECT_ADMIN_KEYS === "true";
const EMAIL_VERIFICATION_TTL_MS = Math.max(5, Number(process.env.EMAIL_VERIFICATION_TTL_MINUTES) || 30) * 60e3;
const KEY_REVEAL_TTL_MS = Math.max(1, Number(process.env.KEY_REVEAL_TTL_HOURS) || 24) * 3600e3;
const NEW_KEY_MONITOR_MS = 24 * 3600e3;
const NEW_KEY_ALERT_APPROVALS_HOUR = Math.max(1, Number(process.env.NEW_KEY_ALERT_APPROVALS_HOUR) || 30);
const KEY_MONITOR_SWEEP_MS = Math.max(50, Number(process.env.KEY_MONITOR_SWEEP_MS) || 60e3);

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
  created_at INTEGER NOT NULL,
  key_hash TEXT,
  email TEXT,
  tool TEXT,
  delivery TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  last_used_at INTEGER,
  source TEXT NOT NULL DEFAULT 'admin',
  rate_limit_per_minute INTEGER NOT NULL DEFAULT 600
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
  approval_id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'initial',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL,
  state TEXT NOT NULL,
  provider_id TEXT,
  last_status INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  delivered_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_notification_due ON notification_outbox(state, next_at);
CREATE TABLE IF NOT EXISTS notification_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  approval_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  status_code INTEGER,
  error TEXT,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS receipt_archive (
  approval_id TEXT PRIMARY KEY,
  api_key TEXT NOT NULL,
  receipt_json TEXT NOT NULL,
  signature TEXT NOT NULL,
  key_id TEXT NOT NULL,
  decided_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_receipt_expiry ON receipt_archive(expires_at);
CREATE TABLE IF NOT EXISTS ratelimit (bucket TEXT PRIMARY KEY, count INTEGER NOT NULL, window_start INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS key_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  tool TEXT,
  note TEXT,
  delivery TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS key_reveals (
  token_hash TEXT PRIMARY KEY,
  key_ref TEXT NOT NULL,
  request_id INTEGER,
  secret_box TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS email_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  purpose TEXT NOT NULL,
  reference TEXT,
  api_key TEXT,
  recipient_hash TEXT,
  provider_id TEXT,
  status TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_email_events_at ON email_events(at);
`);

// Existing SQLite files are migrated in place. The optional key lets an
// automation safely retry approval creation without making a second request.
if (!db.prepare("PRAGMA table_info(approvals)").all().some((c) => c.name === "idempotency_key")) {
  db.exec("ALTER TABLE approvals ADD COLUMN idempotency_key TEXT");
}
if (!db.prepare("PRAGMA table_info(notification_outbox)").all().some((c) => c.name === "purpose")) {
  db.exec("ALTER TABLE notification_outbox ADD COLUMN purpose TEXT NOT NULL DEFAULT 'initial'");
}
const keyColumns = db.prepare("PRAGMA table_info(keys)").all().map((c) => c.name);
if (!keyColumns.includes("key_hash")) db.exec("ALTER TABLE keys ADD COLUMN key_hash TEXT");
if (!keyColumns.includes("email")) db.exec("ALTER TABLE keys ADD COLUMN email TEXT");
if (!keyColumns.includes("tool")) db.exec("ALTER TABLE keys ADD COLUMN tool TEXT");
if (!keyColumns.includes("delivery")) db.exec("ALTER TABLE keys ADD COLUMN delivery TEXT");
if (!keyColumns.includes("status")) db.exec("ALTER TABLE keys ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
if (!keyColumns.includes("last_used_at")) db.exec("ALTER TABLE keys ADD COLUMN last_used_at INTEGER");
if (!keyColumns.includes("source")) db.exec("ALTER TABLE keys ADD COLUMN source TEXT NOT NULL DEFAULT 'admin'");
if (!keyColumns.includes("rate_limit_per_minute")) db.exec("ALTER TABLE keys ADD COLUMN rate_limit_per_minute INTEGER NOT NULL DEFAULT 600");
if (!keyColumns.includes("monthly_limit")) db.exec(`ALTER TABLE keys ADD COLUMN monthly_limit INTEGER NOT NULL DEFAULT ${KEY_MONTHLY_APPROVAL_LIMIT}`);
if (!keyColumns.includes("email_monthly_limit")) db.exec(`ALTER TABLE keys ADD COLUMN email_monthly_limit INTEGER NOT NULL DEFAULT ${KEY_MONTHLY_EMAIL_LIMIT}`);
if (!keyColumns.includes("pending_limit")) db.exec(`ALTER TABLE keys ADD COLUMN pending_limit INTEGER NOT NULL DEFAULT ${KEY_PENDING_LIMIT}`);
if (!keyColumns.includes("activated_at")) db.exec("ALTER TABLE keys ADD COLUMN activated_at INTEGER");
if (!keyColumns.includes("revoked_at")) db.exec("ALTER TABLE keys ADD COLUMN revoked_at INTEGER");
if (!keyColumns.includes("revoke_reason")) db.exec("ALTER TABLE keys ADD COLUMN revoke_reason TEXT");
if (!keyColumns.includes("quota_warned_month")) db.exec("ALTER TABLE keys ADD COLUMN quota_warned_month TEXT");
if (!keyColumns.includes("monitor_alerted_at")) db.exec("ALTER TABLE keys ADD COLUMN monitor_alerted_at INTEGER");
db.prepare("UPDATE keys SET activated_at=created_at WHERE activated_at IS NULL AND status='active'").run();
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_keys_hash ON keys(key_hash) WHERE key_hash IS NOT NULL");
const keyRequestColumns = db.prepare("PRAGMA table_info(key_requests)").all().map((c) => c.name);
if (!keyRequestColumns.includes("delivery")) db.exec("ALTER TABLE key_requests ADD COLUMN delivery TEXT");
if (!keyRequestColumns.includes("status")) db.exec("ALTER TABLE key_requests ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'");
if (!keyRequestColumns.includes("verify_token_hash")) db.exec("ALTER TABLE key_requests ADD COLUMN verify_token_hash TEXT");
if (!keyRequestColumns.includes("verification_expires_at")) db.exec("ALTER TABLE key_requests ADD COLUMN verification_expires_at INTEGER");
if (!keyRequestColumns.includes("verification_sent_at")) db.exec("ALTER TABLE key_requests ADD COLUMN verification_sent_at INTEGER");
if (!keyRequestColumns.includes("verified_at")) db.exec("ALTER TABLE key_requests ADD COLUMN verified_at INTEGER");
if (!keyRequestColumns.includes("ip_hash")) db.exec("ALTER TABLE key_requests ADD COLUMN ip_hash TEXT");
if (!keyRequestColumns.includes("risk_json")) db.exec("ALTER TABLE key_requests ADD COLUMN risk_json TEXT");
if (!keyRequestColumns.includes("reviewed_at")) db.exec("ALTER TABLE key_requests ADD COLUMN reviewed_at INTEGER");
if (!keyRequestColumns.includes("review_note")) db.exec("ALTER TABLE key_requests ADD COLUMN review_note TEXT");
if (!keyRequestColumns.includes("issued_key_ref")) db.exec("ALTER TABLE key_requests ADD COLUMN issued_key_ref TEXT");
if (!keyRequestColumns.includes("rejected_reason")) db.exec("ALTER TABLE key_requests ADD COLUMN rejected_reason TEXT");
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_approval_idempotency ON approvals(api_key, idempotency_key) WHERE idempotency_key IS NOT NULL");
db.prepare("DELETE FROM ratelimit WHERE window_start<?").run(Date.now() - 2 * 86400e3);
// A process can stop after claiming a notification but before recording the
// provider response. Stable provider idempotency keys make replay safe.
db.prepare("UPDATE notification_outbox SET state='queued', next_at=? WHERE state='sending'").run(Date.now());

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
  if (req.path.startsWith("/a/") || req.path.startsWith("/admin/")) res.set("Cache-Control", "no-store");
  next();
});

const now = () => Date.now();
const newId = () => "apr_" + crypto.randomBytes(8).toString("hex");
const newToken = () => crypto.randomBytes(24).toString("base64url");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const hashApiKey = (key) => crypto.createHash("sha256").update(String(key)).digest("hex");
const privateHash = (purpose, value) => crypto.createHmac("sha256", SIGNING_SECRET).update(`${purpose}:${String(value).toLowerCase()}`).digest("hex");
const monthStart = (t = now()) => { const d = new Date(t); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); };
const nextMonthStart = (t = now()) => { const d = new Date(t); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1); };
const dayStart = (t = now()) => { const d = new Date(t); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); };
const nextDayStart = (t = now()) => dayStart(t) + 86400e3;
const monthId = (t = now()) => new Date(t).toISOString().slice(0, 7);

function encryptTemporarySecret(value) {
  const key = crypto.createHash("sha256").update(`key-reveal:${SIGNING_SECRET}`).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((x) => x.toString("base64url")).join(".");
}

function decryptTemporarySecret(box) {
  const [iv, tag, encrypted] = String(box).split(".").map((x) => Buffer.from(x, "base64url"));
  const key = crypto.createHash("sha256").update(`key-reveal:${SIGNING_SECRET}`).digest();
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

function emailCountSince(since, apiKey = null, purpose = null) {
  if (apiKey && purpose) return db.prepare("SELECT COUNT(*) c FROM email_events WHERE status='accepted' AND api_key=? AND purpose=? AND at>=?").get(apiKey, purpose, since).c;
  if (apiKey) return db.prepare("SELECT COUNT(*) c FROM email_events WHERE status='accepted' AND api_key=? AND at>=?").get(apiKey, since).c;
  if (purpose) return db.prepare("SELECT COUNT(*) c FROM email_events WHERE status='accepted' AND purpose=? AND at>=?").get(purpose, since).c;
  return db.prepare("SELECT COUNT(*) c FROM email_events WHERE status='accepted' AND at>=?").get(since).c;
}

function approvalCountSince(since, apiKey = null) {
  return apiKey
    ? db.prepare("SELECT COUNT(*) c FROM approvals WHERE api_key=? AND created_at>=?").get(apiKey, since).c
    : db.prepare("SELECT COUNT(*) c FROM approvals WHERE api_key<>? AND created_at>=?").get(DEMO_KEY, since).c;
}

function quotaResponse(res, name, used, limit, resetAt) {
  return res.status(429).json({
    error: `${name} reached`, limit, used,
    reset_at: new Date(resetAt).toISOString(),
  });
}

// Database keys are stored as a one-way hash. The stable internal reference is
// used by approvals and Slack connections, so the original secret is never
// needed again after it is shown to the user.
function migrateStoredKeysToHashes() {
  const legacy = db.prepare("SELECT key FROM keys WHERE key_hash IS NULL").all();
  if (!legacy.length) return;
  db.transaction(() => {
    for (const row of legacy) {
      const raw = row.key;
      const hash = hashApiKey(raw);
      const ref = "key_" + hash.slice(0, 32);
      db.prepare("UPDATE approvals SET api_key=? WHERE api_key=?").run(ref, raw);
      db.prepare("UPDATE receipt_archive SET api_key=? WHERE api_key=?").run(ref, raw);
      db.prepare("UPDATE slack_installs SET api_key=? WHERE api_key=?").run(ref, raw);
      db.prepare("UPDATE slack_install_tokens SET api_key=? WHERE api_key=?").run(ref, raw);
      db.prepare("UPDATE keys SET key=?,key_hash=? WHERE key=?").run(ref, hash, raw);
    }
  })();
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.exec("VACUUM");
  console.log(`[keys] migrated ${legacy.length} stored key(s) to one-way hashes`);
}
migrateStoredKeysToHashes();

function createStoredKey({
  label = "", email = null, tool = null, delivery = null, source = "admin",
  rateLimit = 600, status = "active", monthlyLimit = KEY_MONTHLY_APPROVAL_LIMIT,
  emailMonthlyLimit = KEY_MONTHLY_EMAIL_LIMIT, pendingLimit = KEY_PENDING_LIMIT,
} = {}) {
  const raw = "ah_" + crypto.randomBytes(24).toString("base64url");
  const hash = hashApiKey(raw);
  const ref = "key_" + hash.slice(0, 32);
  const activatedAt = status === "active" ? now() : null;
  db.prepare(`INSERT INTO keys (key,label,created_at,key_hash,email,tool,delivery,status,source,rate_limit_per_minute,monthly_limit,email_monthly_limit,pending_limit,activated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(ref, String(label).slice(0, 200), now(), hash, email, tool, delivery, status, source, rateLimit, monthlyLimit, emailMonthlyLimit, pendingLimit, activatedAt);
  return { raw, ref, hash };
}

function resolveApiKey(raw) {
  if (!raw) return null;
  if (API_KEYS.includes(raw)) return {
    ref: raw, limit: 600, monthlyLimit: GLOBAL_MONTHLY_APPROVAL_LIMIT,
    emailMonthlyLimit: GLOBAL_MONTHLY_APPROVAL_LIMIT, pendingLimit: KEY_PENDING_LIMIT,
    source: "environment",
  };
  const row = db.prepare(`SELECT key,rate_limit_per_minute,monthly_limit,email_monthly_limit,pending_limit
    FROM keys WHERE key_hash=? AND status='active'`).get(hashApiKey(raw));
  return row ? {
    ref: row.key,
    limit: row.rate_limit_per_minute || REVIEW_KEY_RATE_LIMIT,
    monthlyLimit: row.monthly_limit || KEY_MONTHLY_APPROVAL_LIMIT,
    emailMonthlyLimit: row.email_monthly_limit || KEY_MONTHLY_EMAIL_LIMIT,
    pendingLimit: row.pending_limit || KEY_PENDING_LIMIT,
    source: "database",
  } : null;
}

// ---------- 인증 ----------
function auth(req, res, next) {
  const raw = (req.headers.authorization || "").replace(/^Bearer\s+/i, "") || req.headers["x-api-key"];
  const resolved = resolveApiKey(raw);
  if (!resolved) return res.status(401).json({ error: "invalid api key" });
  req.apiKey = resolved.ref;
  req.apiKeyLimit = resolved.limit;
  req.apiKeyMonthlyLimit = resolved.monthlyLimit;
  req.apiKeyEmailMonthlyLimit = resolved.emailMonthlyLimit;
  req.apiKeyPendingLimit = resolved.pendingLimit;
  if (resolved.source === "database") db.prepare("UPDATE keys SET last_used_at=? WHERE key=?").run(now(), resolved.ref);
  next();
}

function sameSecret(value, expected) {
  const a = Buffer.from(String(value || ""));
  const b = Buffer.from(String(expected || ""));
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

function adminAuth(req, res, next) {
  if (rateLimited("admin:" + privateHash("admin-ip", ip(req)), 30, 60e3)) return res.status(429).json({ error: "rate limited" });
  if (!ADMIN_SECRET || !sameSecret(req.headers["x-admin-secret"], ADMIN_SECRET)) return res.status(401).json({ error: "unauthorized" });
  next();
}

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
  const notification = a.channel === "link" ? null : db.prepare("SELECT state,attempts,last_error FROM notification_outbox WHERE approval_id=?").get(a.id);
  return {
    callback: callbackState(a),
    notification: notification ? { state: notification.state === "queued" ? "retrying" : notification.state, attempts: notification.attempts, last_error: notification.last_error } : (a.channel === "link" ? { state: "not_needed", attempts: 0, last_error: null } : null),
    id: a.id,
    status: a.status,
    approved: a.status === "pending" ? null : a.status === "approved",
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
  const perMinute = req.apiKeyLimit || 600;
  if (rateLimited("create:" + req.apiKey, perMinute, 60e3)) return res.status(429).json({ error: `rate limit: ${perMinute} approvals per minute per key` });
  const b = req.body || {};
  if (!b.question || typeof b.question !== "string" || !b.question.trim()) return res.status(400).json({ error: "question (non-empty string) required" });
  if (b.question.length > 500) return res.status(400).json({ error: "question must be 500 characters or fewer" });
  if (b.context != null && Buffer.byteLength(JSON.stringify(b.context), "utf8") > 20_000) return res.status(400).json({ error: "context must be 20 KB or smaller; keep detailed business data in n8n or Make" });
  const channel = b.channel || "link";
  if (!["link", "email", "slack"].includes(channel)) return res.status(400).json({ error: "channel must be link|email|slack" });
  if (channel === "email" && !b.to) return res.status(400).json({ error: "to (email) required for channel=email" });
  if (channel === "slack" && !b.to) return res.status(400).json({ error: "to (slack channel id or user id) required for channel=slack" });
  const keyMonthUsed = approvalCountSince(monthStart(), req.apiKey);
  if (keyMonthUsed >= req.apiKeyMonthlyLimit) return quotaResponse(res, "monthly approval limit", keyMonthUsed, req.apiKeyMonthlyLimit, nextMonthStart());
  const globalMonthUsed = approvalCountSince(monthStart());
  if (globalMonthUsed >= GLOBAL_MONTHLY_APPROVAL_LIMIT) return quotaResponse(res, "hosted preview monthly capacity", globalMonthUsed, GLOBAL_MONTHLY_APPROVAL_LIMIT, nextMonthStart());
  const pendingUsed = db.prepare("SELECT COUNT(*) c FROM approvals WHERE api_key=? AND status='pending'").get(req.apiKey).c;
  if (pendingUsed >= req.apiKeyPendingLimit) return quotaResponse(res, "pending approval limit", pendingUsed, req.apiKeyPendingLimit, nextMonthStart());
  if (channel === "email") {
    const keyEmailUsed = emailCountSince(monthStart(), req.apiKey, "approval");
    if (keyEmailUsed >= req.apiKeyEmailMonthlyLimit) return quotaResponse(res, "monthly approval email limit", keyEmailUsed, req.apiKeyEmailMonthlyLimit, nextMonthStart());
    const globalEmailToday = emailCountSince(dayStart());
    if (globalEmailToday >= GLOBAL_DAILY_EMAIL_LIMIT) return quotaResponse(res, "hosted email daily capacity", globalEmailToday, GLOBAL_DAILY_EMAIL_LIMIT, nextDayStart());
  }
  let callbackUrl;
  try { callbackUrl = await validateCallbackUrl(b.callback_url); }
  catch (e) { return res.status(400).json({ error: e.message }); }
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

  const remaining = Math.max(0, req.apiKeyMonthlyLimit - keyMonthUsed - 1);
  res.set("X-Approval-Limit-Monthly", String(req.apiKeyMonthlyLimit));
  res.set("X-Approval-Remaining-Monthly", String(remaining));
  res.set("X-Approval-Limit-Reset", new Date(nextMonthStart()).toISOString());
  if (remaining <= Math.ceil(req.apiKeyMonthlyLimit * 0.2) && req.apiKey.startsWith("key_")) {
    const warningMonth = monthId();
    const changed = db.prepare("UPDATE keys SET quota_warned_month=? WHERE key=? AND (quota_warned_month IS NULL OR quota_warned_month<>?)").run(warningMonth, req.apiKey, warningMonth);
    if (changed.changes) notifyOwner("An API key is nearing its monthly approval limit", [{ type: "section", text: { type: "mrkdwn", text: `*Usage warning*\nKey ${keyFingerprintForRef(req.apiKey)} has ${remaining} of ${req.apiKeyMonthlyLimit} monthly approvals remaining.` } }]);
  }

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
  db.prepare("DELETE FROM deliveries WHERE approval_id=?").run(id);
  db.prepare("DELETE FROM outbox WHERE approval_id=?").run(id);
  db.prepare("DELETE FROM notification_deliveries WHERE approval_id=?").run(id);
  db.prepare("DELETE FROM notification_outbox WHERE approval_id=?").run(id);
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
    archiveReceipt(fresh, source);
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

function receiptFor(a, source) {
  return {
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
  };
}

function archiveReceipt(a, source) {
  const body = JSON.stringify(receiptFor(a, source));
  db.prepare(`INSERT OR REPLACE INTO receipt_archive
    (approval_id,api_key,receipt_json,signature,key_id,decided_at,expires_at) VALUES (?,?,?,?,?,?,?)`)
    .run(a.id, a.api_key, body, sign(body), SIGN_KEY_ID, a.decided_at || now(), (a.decided_at || now()) + RECEIPT_RETENTION_MS);
}

function enqueueCallback(a, source) {
  if (!a.callback_url) return;
  const body = JSON.stringify(receiptFor(a, source));
  db.prepare(`INSERT OR IGNORE INTO outbox (approval_id,url,body,signature,attempts,next_at,state,created_at) VALUES (?,?,?,?,0,?,'queued',?)`)
    .run(a.id, a.callback_url, body, sign(body), now(), now());
  deliverDue().catch(() => {});
}

let delivering = false;
async function deliverDue() {
  if (delivering) return; delivering = true;
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
      if (state === "failed") notifyOwner("A callback delivery permanently failed", [{ type: "section", text: { type: "mrkdwn", text: "*Callback delivery failed*\nCheck authenticated delivery history for details. Customer URLs and approval content are not copied into operator Slack." } }]);
    }
  } finally { delivering = false; }
}
setInterval(() => deliverDue().catch(() => {}), DELIVERY_SWEEP_MS).unref();

// 영수증: 자기완결 JSON + 서명. 고객이 보관하고, 누구나 공개키로 검증.
app.get("/v1/approvals/:id/receipt", auth, (req, res) => {
  const a = db.prepare("SELECT * FROM approvals WHERE id=? AND api_key=?").get(req.params.id, req.apiKey);
  const archived = db.prepare("SELECT * FROM receipt_archive WHERE approval_id=? AND api_key=?").get(req.params.id, req.apiKey);
  if (!a && !archived) return res.status(404).json({ error: "not found" });
  if (a?.status === "pending") return res.status(409).json({ error: "not decided yet" });
  const body = archived?.receipt_json || JSON.stringify(receiptFor(a, "receipt"));
  const signature = archived?.signature || sign(body);
  res.json({ receipt: JSON.parse(body), receipt_json: body, signature, key_id: archived?.key_id || SIGN_KEY_ID, retained_until: archived ? new Date(archived.expires_at).toISOString() : null, public_key_url: `${BASE_URL}/.well-known/approval-signing-key`, verify_url: `${BASE_URL}/v1/verify` });
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
  const delivery = db.prepare("SELECT channel,state,attempts,provider_id,last_status,last_error,delivered_at FROM notification_outbox WHERE approval_id=?").get(a.id);
  const attempts = db.prepare("SELECT attempt,status_code,error,at FROM notification_deliveries WHERE approval_id=? ORDER BY attempt").all(a.id);
  res.json({ delivery: delivery || { state: "not_needed", attempts: 0 }, attempts });
});

// ---------- 타임아웃 스윕 ----------
setInterval(() => {
  const due = db.prepare("SELECT * FROM approvals WHERE status='pending' AND timeout_at <= ?").all(now());
  for (const a of due) decide(a, a.default_on_timeout, "timeout", null, "timeout");
  // 랜딩 데모로 만든 요청은 하루 뒤 삭제
  db.prepare("DELETE FROM approvals WHERE api_key=? AND created_at < ?").run(DEMO_KEY, now() - 24 * 3600 * 1000);
}, TIMEOUT_SWEEP_MS).unref();

function cleanupRetention() {
  const cutoff = now() - DECISION_RETENTION_MS;
  const old = db.prepare("SELECT id FROM approvals WHERE status<>'pending' AND decided_at IS NOT NULL AND decided_at<?").all(cutoff);
  const result = db.transaction(() => {
    const callbackAttempts = db.prepare("DELETE FROM deliveries WHERE at<?").run(now() - DELIVERY_RETENTION_MS).changes;
    const notificationAttempts = db.prepare("DELETE FROM notification_deliveries WHERE at<?").run(now() - DELIVERY_RETENTION_MS).changes;
    for (const { id } of old) purgeApproval(id, false);
    const receipts = db.prepare("DELETE FROM receipt_archive WHERE expires_at<?").run(now()).changes;
    const reveals = db.prepare("DELETE FROM key_reveals WHERE expires_at<? OR used_at IS NOT NULL").run(now()).changes;
    const emailEvents = db.prepare("DELETE FROM email_events WHERE at<?").run(now() - 400 * 86400e3).changes;
    const expiredVerifications = db.prepare("UPDATE key_requests SET status='verification_expired',verify_token_hash=NULL WHERE status IN ('pending_verification','verification_delivery_failed') AND verification_expires_at<?").run(now()).changes;
    const keyRequests = db.prepare("DELETE FROM key_requests WHERE at<? AND status IN ('issued','rejected','verification_expired')").run(now() - KEY_REQUEST_RETENTION_MS).changes;
    const rateBuckets = db.prepare("DELETE FROM ratelimit WHERE window_start<?").run(now() - 2 * 86400e3).changes;
    return { decisions: old.length, callback_attempts: callbackAttempts, notification_attempts: notificationAttempts, receipts, key_reveals: reveals, email_events: emailEvents, expired_verifications: expiredVerifications, key_requests: keyRequests, rate_buckets: rateBuckets };
  })();
  if (Object.values(result).some(Boolean)) console.log("[retention]", JSON.stringify(result));
  return result;
}
setInterval(cleanupRetention, RETENTION_SWEEP_MS).unref();

// ---------- Slack / email notification outbox ----------
// The approval is committed first. Provider outages therefore cannot lose the
// request, and a restart simply resumes queued rows from SQLite.
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
      .run(attempt, result.providerId, result.status || 200, now(), approvalId);
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
async function sendResendMessage({ to, subject, html, purpose, reference, apiKey = null, idempotencyKey }) {
  if (!RESEND_API_KEY) { const e = new Error("RESEND_API_KEY not set"); e.status = 503; throw e; }
  const already = db.prepare("SELECT provider_id FROM email_events WHERE purpose=? AND reference=? AND status='accepted' ORDER BY id DESC LIMIT 1").get(purpose, reference);
  if (already) return { providerId: already.provider_id, status: 200, replayed: true };
  const sentToday = emailCountSince(dayStart());
  if (sentToday >= GLOBAL_DAILY_EMAIL_LIMIT) {
    const e = new Error(`hosted email daily capacity reached (${GLOBAL_DAILY_EMAIL_LIMIT})`);
    e.status = 429;
    e.retryAfter = Math.max(1, Math.ceil((nextDayStart() - now()) / 1000));
    throw e;
  }
  const recipientHash = privateHash("email", to);
  let response;
  try {
    response = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${RESEND_API_KEY}`, "content-type": "application/json", "idempotency-key": idempotencyKey },
      body: JSON.stringify({ from: EMAIL_FROM, to, subject, html }),
    });
    const text = await response.text();
    if (!response.ok) {
      db.prepare("INSERT INTO email_events (purpose,reference,api_key,recipient_hash,status,at) VALUES (?,?,?,?,?,?)")
        .run(purpose, reference, apiKey, recipientHash, `failed_${response.status}`, now());
      const e = new Error(`resend ${response.status}: ${text}`);
      e.status = response.status;
      e.retryAfter = response.headers.get("retry-after");
      throw e;
    }
    let body = {}; try { body = JSON.parse(text); } catch {}
    db.prepare("INSERT INTO email_events (purpose,reference,api_key,recipient_hash,provider_id,status,at) VALUES (?,?,?,?,?,'accepted',?)")
      .run(purpose, reference, apiKey, recipientHash, body.id || null, now());
    return { providerId: body.id || null, status: response.status };
  } catch (error) {
    if (!response) db.prepare("INSERT INTO email_events (purpose,reference,api_key,recipient_hash,status,at) VALUES (?,?,?,?,?,?)")
      .run(purpose, reference, apiKey, recipientHash, "network_failed", now());
    throw error;
  }
}

async function sendEmail(a) {
  const url = `${BASE_URL}/a/${a.token}`;
  const ctx = a.context ? JSON.parse(a.context) : null;
  const html = `<p style="font-size:16px"><b>${esc(a.question)}</b></p>${ctx ? `<pre style="background:#f4f4f5;padding:12px">${esc(typeof ctx === "string" ? ctx : JSON.stringify(ctx, null, 2))}</pre>` : ""}
  <p><a href="${url}" style="display:inline-block;padding:12px 20px;background:#111;color:#fff;border-radius:8px;text-decoration:none">Open and decide</a></p>
  <p style="color:#666;font-size:13px">Answer by ${fmt(a.timeout_at)} UTC (about ${Math.round((a.timeout_at - now()) / 3600000)} hours from now)</p>`;
  return sendResendMessage({
    to: a.recipient,
    subject: `[Needs a yes] ${a.question.slice(0, 60)}`,
    html,
    purpose: "approval",
    reference: a.id,
    apiKey: a.api_key,
    idempotencyKey: `approval-email/${a.id}`,
  });
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
    const e = new Error(`slack ${method}: ${code}`);
    e.status = r.status;
    e.retryAfter = r.headers.get("retry-after");
    e.permanent = ["invalid_auth", "not_authed", "missing_scope", "token_revoked", "account_inactive", "channel_not_found", "no_permission", "invalid_arguments"].includes(code);
    throw e;
  }
  return j;
}

function slackClientMessageId(id) {
  const h = crypto.createHash("sha256").update(id).digest("hex").slice(0, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20)}`;
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
  if (!token || !a.slack_ts) { const e = new Error("Slack message is not available for update"); e.permanent = true; throw e; }
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

function monitorNewKeys() {
  const rows = db.prepare("SELECT * FROM keys WHERE status='active' AND activated_at>=? AND monitor_alerted_at IS NULL").all(now() - NEW_KEY_MONITOR_MS);
  for (const row of rows) {
    const usage = keyUsage(row.key);
    const signals = [];
    if (usage.approvals_hour >= NEW_KEY_ALERT_APPROVALS_HOUR) signals.push(`${usage.approvals_hour} approvals in the last hour`);
    if (usage.pending >= Math.ceil((row.pending_limit || KEY_PENDING_LIMIT) * 0.8)) signals.push(`${usage.pending} pending approvals`);
    if (usage.emails_month >= Math.ceil((row.email_monthly_limit || KEY_MONTHLY_EMAIL_LIMIT) * 0.8)) signals.push(`${usage.emails_month} approval emails this month`);
    if (usage.delivery_failures_24h || usage.callback_failures_24h) signals.push(`${usage.delivery_failures_24h} notification and ${usage.callback_failures_24h} callback failures`);
    if (!signals.length) continue;
    db.prepare("UPDATE keys SET monitor_alerted_at=? WHERE key=? AND monitor_alerted_at IS NULL").run(now(), row.key);
    notifyOwner("A new API key needs an operator check", [{ type: "section", text: { type: "mrkdwn", text: `*First-day usage alert*\n${row.email || row.label || keyFingerprint(row.key, row.key_hash)}\n• ${signals.join("\n• ")}` } }, { type: "context", elements: [{ type: "mrkdwn", text: "Review the key console and revoke immediately if this is not expected." }] }]);
  }
}
setInterval(monitorNewKeys, KEY_MONITOR_SWEEP_MS).unref();

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
  const notifications = db.prepare("SELECT n.state,COUNT(*) c FROM notification_outbox n JOIN approvals a ON a.id=n.approval_id WHERE a.api_key=? GROUP BY n.state").all(req.apiKey);
  res.json({ by_status: Object.fromEntries(rows.map((r) => [r.status, r.c])), callbacks: Object.fromEntries(cb.map((r) => [r.state, r.c])), notifications: Object.fromEntries(notifications.map((r) => [r.state, r.c])) });
});

// ---------- 슬랙 설치 (워크스페이스마다 한 번) ----------
// 설치 링크에는 API 키 대신 만료되는 별도 토큰만 넣는다.
function stateFor(token) { return token + "." + crypto.createHmac("sha256", SIGNING_SECRET).update("slack:" + token).digest("hex").slice(0, 32); }
app.get("/slack/install", (req, res) => {
  if (!SLACK_CLIENT_ID) return res.status(503).send(page("Slack not configured", "<p>SLACK_CLIENT_ID is not set on this server.</p>"));
  const key = String(req.query.key || "");
  if (key) {
    const resolved = resolveApiKey(key);
    if (!resolved) return res.status(401).send(page("Unknown key", "<p>That install link is not valid.</p>"));
    return res.redirect(303, `/slack/install?token=${issueSlackInstallToken(resolved.ref)}`);
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
app.post("/admin/keys", adminAuth, (req, res) => {
  if (!ALLOW_DIRECT_ADMIN_KEYS) return res.status(403).json({ error: "Direct key creation is disabled in production. Issue a verified request from the review console." });
  const created = createStoredKey({ label: req.body?.label || "", source: "admin", rateLimit: 600 });
  const installToken = issueSlackInstallToken(created.ref);
  res.status(201).json({ key: created.raw, label: req.body?.label || "", slack_install_url: `${BASE_URL}/slack/install?token=${installToken}` });
});

function keyFingerprint(key, storedHash = null) {
  return (storedHash || hashApiKey(key)).slice(0, 16);
}
function keyFingerprintForRef(key) {
  const row = String(key).startsWith("key_") ? db.prepare("SELECT key_hash FROM keys WHERE key=?").get(key) : null;
  return keyFingerprint(key, row?.key_hash || null);
}

function keyUsage(key) {
  const approvals = db.prepare("SELECT COUNT(*) c FROM approvals WHERE api_key=?").get(key).c;
  const pending = db.prepare("SELECT COUNT(*) c FROM approvals WHERE api_key=? AND status='pending'").get(key).c;
  const approvals_month = approvalCountSince(monthStart(), key);
  const approvals_hour = approvalCountSince(now() - 3600e3, key);
  const emails_month = emailCountSince(monthStart(), key, "approval");
  const delivery_failures_24h = db.prepare(`SELECT COUNT(*) c FROM notification_outbox n JOIN approvals a ON a.id=n.approval_id
    WHERE a.api_key=? AND n.state='failed' AND n.created_at>=?`).get(key, now() - 86400e3).c;
  const callback_failures_24h = db.prepare(`SELECT COUNT(*) c FROM outbox o JOIN approvals a ON a.id=o.approval_id
    WHERE a.api_key=? AND o.state IN ('failed','endpoint_gone') AND o.created_at>=?`).get(key, now() - 86400e3).c;
  const pending_items = db.prepare("SELECT id,question,channel,created_at,timeout_at FROM approvals WHERE api_key=? AND status='pending' ORDER BY created_at").all(key);
  const slack = db.prepare("SELECT team_id,team_name,installed_at FROM slack_installs WHERE api_key=?").get(key);
  return { approvals, approvals_month, approvals_hour, emails_month, pending, delivery_failures_24h, callback_failures_24h, pending_items, slack: slack || null };
}

// 비밀값을 저장하지 않는 작은 운영 화면. 브라우저 메모리에서만 관리자 요청에 사용한다.
app.get("/admin/key-console", (_req, res) => {
  res.type("html").send(require("fs").readFileSync(__dirname + "/admin-console.html", "utf8"));
});

app.post("/admin/approvals/:id/cancel", adminAuth, (req, res) => {
  const a = db.prepare("SELECT * FROM approvals WHERE id=?").get(req.params.id);
  if (!a) return res.status(404).json({ error: "not found" });
  if (a.status !== "pending") return res.status(409).json(publicView(a));
  const { fresh } = decide(a, "canceled", "admin", null, "admin cleanup");
  res.json(publicView(fresh));
});

// 원문 키를 노출하지 않는 운영용 목록. fingerprint로 사용처를 확인한다.
app.get("/admin/keys", adminAuth, (_req, res) => {
  const stored = db.prepare(`SELECT key,key_hash,label,email,tool,delivery,status,source,created_at,last_used_at,rate_limit_per_minute,
    monthly_limit,email_monthly_limit,pending_limit,activated_at,revoked_at,revoke_reason,monitor_alerted_at FROM keys ORDER BY created_at DESC`).all().map(row => ({
    fingerprint: keyFingerprint(row.key, row.key_hash),
    label: row.label || "",
    email: row.email || null,
    tool: row.tool || null,
    delivery: row.delivery || null,
    status: row.status,
    created_at: new Date(row.created_at).toISOString(),
    last_used_at: row.last_used_at ? new Date(row.last_used_at).toISOString() : null,
    activated_at: row.activated_at ? new Date(row.activated_at).toISOString() : null,
    revoked_at: row.revoked_at ? new Date(row.revoked_at).toISOString() : null,
    monitor_alerted_at: row.monitor_alerted_at ? new Date(row.monitor_alerted_at).toISOString() : null,
    revoke_reason: row.revoke_reason || null,
    source: row.source || "database",
    rate_limit_per_minute: row.rate_limit_per_minute || 600,
    monthly_limit: row.monthly_limit || KEY_MONTHLY_APPROVAL_LIMIT,
    email_monthly_limit: row.email_monthly_limit || KEY_MONTHLY_EMAIL_LIMIT,
    pending_limit: row.pending_limit || KEY_PENDING_LIMIT,
    revocable: row.status === "active" || row.status === "pending_delivery",
    ...keyUsage(row.key)
  }));
  const configured = API_KEYS.map(key => ({
    fingerprint: keyFingerprint(key),
    label: "environment key",
    created_at: null,
    status: "active",
    source: "environment",
    rate_limit_per_minute: 600,
    monthly_limit: GLOBAL_MONTHLY_APPROVAL_LIMIT,
    email_monthly_limit: GLOBAL_MONTHLY_APPROVAL_LIMIT,
    pending_limit: KEY_PENDING_LIMIT,
    revocable: false,
    ...keyUsage(key)
  }));
  res.json([...configured, ...stored]);
});

// 즉시 폐기는 새 요청을 차단하고, 대기 중 승인을 취소하며, 이력은 보존한다.
app.delete("/admin/keys/:fingerprint", adminAuth, (req, res) => {
  const matches = db.prepare("SELECT key,key_hash,label,status FROM keys").all()
    .filter(row => keyFingerprint(row.key, row.key_hash) === req.params.fingerprint);
  if (matches.length !== 1) return res.status(404).json({ error: "key not found" });
  const row = matches[0];
  const usage = keyUsage(row.key);
  const pendingRows = db.prepare("SELECT * FROM approvals WHERE api_key=? AND status='pending'").all(row.key);
  for (const approval of pendingRows) decide(approval, "canceled", "admin", null, "key revoked");
  db.transaction(() => {
    db.prepare("DELETE FROM slack_install_tokens WHERE api_key=?").run(row.key);
    db.prepare("DELETE FROM slack_installs WHERE api_key=?").run(row.key);
    db.prepare("UPDATE keys SET status='revoked',revoked_at=?,revoke_reason=? WHERE key=?").run(now(), "revoked from admin console", row.key);
    db.prepare("DELETE FROM key_reveals WHERE key_ref=?").run(row.key);
  })();
  res.json({ revoked: true, fingerprint: req.params.fingerprint, label: row.label || "", canceled_pending: pendingRows.length, historical_approvals_retained: usage.approvals });
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

const PUBLIC_EMAIL_DOMAINS = new Set(["gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "yahoo.com", "icloud.com", "proton.me", "protonmail.com"]);

function riskForRequest(request) {
  const reasons = [];
  let level = "low";
  const email = String(request.email || "").toLowerCase();
  const domain = email.split("@")[1] || "";
  const sameEmail = db.prepare("SELECT COUNT(*) c FROM key_requests WHERE lower(email)=? AND id<>?").get(email, request.id).c;
  const sameIp = request.ip_hash ? db.prepare("SELECT COUNT(*) c FROM key_requests WHERE ip_hash=? AND id<>? AND at>=?").get(request.ip_hash, request.id, now() - 30 * 86400e3).c : 0;
  const activeKeys = db.prepare("SELECT COUNT(*) c FROM keys WHERE lower(email)=? AND status='active'").get(email).c;
  const revokedKeys = db.prepare("SELECT COUNT(*) c FROM keys WHERE lower(email)=? AND status='revoked'").get(email).c;
  if (!request.verified_at) { level = "blocked"; reasons.push("Email has not been verified."); }
  if (activeKeys > 0) { level = "blocked"; reasons.push("This email already has an active key."); }
  if (sameIp >= 3) { level = "high"; reasons.push(`${sameIp + 1} requests came from the same network fingerprint in 30 days.`); }
  else if (sameIp > 0 && level !== "blocked") { level = "review"; reasons.push(`${sameIp + 1} requests share the same network fingerprint.`); }
  if (sameEmail > 0 && level === "low") { level = "review"; reasons.push(`${sameEmail} earlier request(s) used this email.`); }
  if (PUBLIC_EMAIL_DOMAINS.has(domain) && level === "low") { level = "review"; reasons.push("Public email domain; this is allowed but merits a quick identity check."); }
  if (revokedKeys > 0 && level !== "blocked") { level = "review"; reasons.push(`${revokedKeys} previously revoked key(s) are linked to this email.`); }
  if (!reasons.length) reasons.push("Verified email, no duplicate key, and no repeated network fingerprint.");
  return { level, reasons, facts: { same_email_requests: sameEmail, same_network_requests_30d: sameIp + 1, active_keys: activeKeys, revoked_keys: revokedKeys, public_email_domain: PUBLIC_EMAIL_DOMAINS.has(domain) } };
}

function requestView(row) {
  const liveRisk = ["pending_verification", "verification_delivery_failed", "pending_review"].includes(row.status);
  let risk;
  try { risk = !liveRisk && row.risk_json ? JSON.parse(row.risk_json) : riskForRequest(row); }
  catch { risk = riskForRequest(row); }
  if (liveRisk && JSON.stringify(risk) !== row.risk_json) db.prepare("UPDATE key_requests SET risk_json=? WHERE id=?").run(JSON.stringify(risk), row.id);
  return {
    id: row.id, email: row.email, tool: row.tool, delivery: row.delivery, status: row.status,
    requested_at: new Date(row.at).toISOString(),
    verification_sent_at: row.verification_sent_at ? new Date(row.verification_sent_at).toISOString() : null,
    verified_at: row.verified_at ? new Date(row.verified_at).toISOString() : null,
    reviewed_at: row.reviewed_at ? new Date(row.reviewed_at).toISOString() : null,
    review_note: row.review_note || null, rejected_reason: row.rejected_reason || null,
    issued_key_fingerprint: row.issued_key_ref ? keyFingerprintForRef(row.issued_key_ref) : null,
    risk,
  };
}

async function sendVerificationEmail(request, rawToken, attempt = "initial") {
  const url = `${BASE_URL}/verify-key-request/${rawToken}`;
  const html = `<p><b>Verify your email to request an API key.</b></p>
  <p>Tool: ${esc(request.tool)} · Default delivery: ${esc(request.delivery)}</p>
  <p><a href="${url}" style="display:inline-block;padding:12px 20px;background:#111;color:#fff;border-radius:8px;text-decoration:none">Review and verify email</a></p>
  <p style="color:#666;font-size:13px">Opening the link does not verify anything. You must confirm on the page. The link expires in 30 minutes.</p>`;
  return sendResendMessage({ to: request.email, subject: "Verify your API key request", html, purpose: "key_verification", reference: `${request.id}:${attempt}`, idempotencyKey: `key-verification/${request.id}/${attempt}` });
}

function createKeyReveal(rawKey, keyRef, requestId) {
  const token = newToken();
  db.prepare("INSERT INTO key_reveals (token_hash,key_ref,request_id,secret_box,expires_at,created_at) VALUES (?,?,?,?,?,?)")
    .run(hashApiKey(token), keyRef, requestId, encryptTemporarySecret(JSON.stringify({ key: rawKey, token })), now() + KEY_REVEAL_TTL_MS, now());
  return token;
}

async function sendIssuedKeyEmail(request, keyRef, rawRevealToken) {
  const url = `${BASE_URL}/receive-key/${rawRevealToken}`;
  const html = `<p><b>Your someonehastosayyes API key is ready.</b></p>
  <p>Your request for ${esc(request.tool)} with ${esc(request.delivery)} delivery was approved.</p>
  <p><a href="${url}" style="display:inline-block;padding:12px 20px;background:#111;color:#fff;border-radius:8px;text-decoration:none">Receive API key</a></p>
  <p style="color:#666;font-size:13px">The key is shown once. Opening this link alone does not reveal it. The link expires in 24 hours.</p>`;
  return sendResendMessage({ to: request.email, subject: "Your API key is ready", html, purpose: "key_delivery", reference: String(request.id), apiKey: keyRef, idempotencyKey: `key-delivery/${request.id}` });
}

app.get("/admin/key-requests", adminAuth, (_req, res) => {
  res.json(db.prepare("SELECT * FROM key_requests ORDER BY at DESC LIMIT 200").all().map(requestView));
});

// ---------- 수동 검토용 키 요청 (랜딩 폼) ----------
app.post("/request-key", asyncRoute(async (req, res) => {
  const requestsToday = db.prepare("SELECT COUNT(*) c FROM key_requests WHERE at>=?").get(dayStart()).c;
  if (requestsToday >= GLOBAL_DAILY_KEY_REQUEST_LIMIT) return quotaResponse(res, "hosted key request daily capacity", requestsToday, GLOBAL_DAILY_KEY_REQUEST_LIMIT, nextDayStart());
  if (rateLimited("reqkey-ip:" + privateHash("request-rate-ip", ip(req)), 3, 24 * 3600e3)) return res.status(429).json({ error: "You have already sent several requests today. Try again tomorrow." });
  const email = String(req.body.email || "").trim().slice(0, 200);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: "Enter a valid work email." });
  const tool = String(req.body.tool || "").toLowerCase();
  const delivery = String(req.body.delivery || "").toLowerCase();
  if (!["n8n", "make", "zapier", "api"].includes(tool)) return res.status(400).json({ error: "Choose an automation tool." });
  if (!["slack", "email", "link"].includes(delivery)) return res.status(400).json({ error: "Choose a delivery method." });
  const emailBucket = hashApiKey(email.toLowerCase()).slice(0, 24);
  if (rateLimited("reqkey-email:" + emailBucket, 2, 24 * 3600e3)) return res.status(429).json({ error: "A request for this email is already waiting for review." });
  const token = newToken();
  const stored = db.prepare(`INSERT INTO key_requests
    (email,tool,note,delivery,status,at,verify_token_hash,verification_expires_at,ip_hash)
    VALUES (?,?,NULL,?,'pending_verification',?,?,?,?)`).run(email, tool, delivery, now(), hashApiKey(token), now() + EMAIL_VERIFICATION_TTL_MS, privateHash("request-ip", ip(req)));
  const request = db.prepare("SELECT * FROM key_requests WHERE id=?").get(stored.lastInsertRowid);
  try {
    await sendVerificationEmail(request, token);
    db.prepare("UPDATE key_requests SET verification_sent_at=? WHERE id=?").run(now(), request.id);
  } catch (error) {
    db.prepare("UPDATE key_requests SET status='verification_delivery_failed' WHERE id=?").run(request.id);
    return res.status(503).json({ error: "We could not send the verification email. No key was created. Please try again later.", request_id: request.id });
  }
  res.set("Cache-Control", "no-store").status(202).json({
    request_id: stored.lastInsertRowid,
    status: "pending_verification",
    message: "Check your email and verify the request. No API key has been created yet.",
  });
}));

app.get("/verify-key-request/:token", (req, res) => {
  const request = db.prepare("SELECT * FROM key_requests WHERE verify_token_hash=?").get(hashApiKey(req.params.token));
  if (!request || request.verified_at) return res.status(410).send(page("Link unavailable", "<h1>This verification link is no longer available.</h1><p class='muted'>It may already have been used.</p>"));
  if (request.verification_expires_at < now()) return res.status(410).send(page("Link expired", "<h1>This verification link expired.</h1><p class='muted'>Submit a fresh request from the landing page.</p>"));
  res.send(page("Verify email", `<p class="eyebrow">${BRAND}</p><h1>Verify this API key request?</h1><p>${esc(request.email)}</p><p class="muted">${esc(request.tool)} · ${esc(request.delivery)}. Opening this page did not verify anything yet.</p><form method="post"><div class="row"><button class="yes" type="submit">Verify email</button></div></form>`));
});

app.post("/verify-key-request/:token", (req, res) => {
  const tokenHash = hashApiKey(req.params.token);
  const request = db.prepare("SELECT * FROM key_requests WHERE verify_token_hash=?").get(tokenHash);
  if (!request || request.verified_at) return res.status(410).send(page("Link unavailable", "<h1>This verification link is no longer available.</h1>"));
  if (request.verification_expires_at < now()) return res.status(410).send(page("Link expired", "<h1>This verification link expired.</h1>"));
  const verifiedAt = now();
  db.prepare("UPDATE key_requests SET status='pending_review',verified_at=?,verify_token_hash=NULL WHERE id=?").run(verifiedAt, request.id);
  const fresh = db.prepare("SELECT * FROM key_requests WHERE id=?").get(request.id);
  const risk = riskForRequest(fresh);
  db.prepare("UPDATE key_requests SET risk_json=? WHERE id=?").run(JSON.stringify(risk), request.id);
  notifyOwner("A verified API key request is waiting for review", [
    { type: "section", text: { type: "mrkdwn", text: `*Verified API key request #${request.id}*\n${request.email} · ${request.tool} · ${request.delivery} · risk: ${risk.level}` } },
    { type: "context", elements: [{ type: "mrkdwn", text: "No key was created. Issue or reject it from the administrator console." }] },
  ]);
  res.send(page("Email verified", `<p class="eyebrow">${BRAND}</p><h1>Email verified.</h1><p>Your request is now waiting for a human review. No API key has been created yet.</p><p class="muted">You can close this page.</p>`));
});

app.post("/admin/key-requests/:id/issue", adminAuth, asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  const request = db.prepare("SELECT * FROM key_requests WHERE id=?").get(id);
  if (!request) return res.status(404).json({ error: "request not found" });
  if (!request.verified_at) return res.status(409).json({ error: "email must be verified before a key can be issued" });
  if (request.status !== "pending_review") return res.status(409).json({ error: `request is ${request.status}` });
  const risk = riskForRequest(request);
  if (risk.level === "blocked") return res.status(409).json({ error: risk.reasons.join(" "), risk });
  const existingKey = db.prepare("SELECT key,key_hash,status FROM keys WHERE lower(email)=lower(?) AND status IN ('active','pending_delivery')").get(request.email);
  if (existingKey) return res.status(409).json({ error: "this email already has an active or pending-delivery key", fingerprint: keyFingerprint(existingKey.key, existingKey.key_hash) });
  const claimed = db.prepare("UPDATE key_requests SET status='issuing',reviewed_at=?,review_note=? WHERE id=? AND status='pending_review'")
    .run(now(), String(req.body?.note || "Approved after manual review").slice(0, 500), id);
  if (!claimed.changes) return res.status(409).json({ error: "request is already being processed" });
  const created = createStoredKey({
    label: request.email, email: request.email.toLowerCase(), tool: request.tool, delivery: request.delivery,
    source: "reviewed", status: "pending_delivery", rateLimit: REVIEW_KEY_RATE_LIMIT,
  });
  const revealToken = createKeyReveal(created.raw, created.ref, id);
  db.prepare("UPDATE key_requests SET issued_key_ref=? WHERE id=?").run(created.ref, id);
  try {
    await sendIssuedKeyEmail(request, created.ref, revealToken);
    const activatedAt = now();
    db.transaction(() => {
      db.prepare("UPDATE keys SET status='active',activated_at=? WHERE key=?").run(activatedAt, created.ref);
      db.prepare("UPDATE key_requests SET status='issued' WHERE id=?").run(id);
    })();
    return res.status(201).json({ issued: true, fingerprint: keyFingerprint(created.ref, created.hash), email: request.email, reveal_expires_at: new Date(now() + KEY_REVEAL_TTL_MS).toISOString() });
  } catch (error) {
    db.prepare("UPDATE key_requests SET status='delivery_failed' WHERE id=?").run(id);
    return res.status(502).json({ error: "The key was created but its email could not be delivered. It is not active. Use Retry delivery.", detail: String(error.message || error) });
  }
}));

app.post("/admin/key-requests/:id/resend-verification", adminAuth, asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  const request = db.prepare("SELECT * FROM key_requests WHERE id=?").get(id);
  if (!request || !["pending_verification", "verification_delivery_failed"].includes(request.status)) return res.status(409).json({ error: "request is not waiting for email verification" });
  const token = newToken();
  const attempt = String(now());
  db.prepare("UPDATE key_requests SET status='pending_verification',verify_token_hash=?,verification_expires_at=? WHERE id=?")
    .run(hashApiKey(token), now() + EMAIL_VERIFICATION_TTL_MS, id);
  try {
    await sendVerificationEmail(request, token, attempt);
    db.prepare("UPDATE key_requests SET verification_sent_at=? WHERE id=?").run(now(), id);
    res.json({ sent: true, request_id: id });
  } catch (error) {
    db.prepare("UPDATE key_requests SET status='verification_delivery_failed' WHERE id=?").run(id);
    res.status(502).json({ error: "verification email still could not be delivered", detail: String(error.message || error) });
  }
}));

app.post("/admin/key-requests/:id/retry-delivery", adminAuth, asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  const request = db.prepare("SELECT * FROM key_requests WHERE id=?").get(id);
  if (!request || request.status !== "delivery_failed" || !request.issued_key_ref) return res.status(409).json({ error: "request does not have a failed key delivery" });
  const reveal = db.prepare("SELECT * FROM key_reveals WHERE request_id=? AND used_at IS NULL ORDER BY created_at DESC LIMIT 1").get(id);
  if (!reveal || reveal.expires_at < now()) return res.status(410).json({ error: "the temporary key envelope expired; revoke this pending key and issue a fresh one" });
  const secret = JSON.parse(decryptTemporarySecret(reveal.secret_box));
  await sendIssuedKeyEmail(request, request.issued_key_ref, secret.token);
  db.transaction(() => {
    db.prepare("UPDATE keys SET status='active',activated_at=? WHERE key=?").run(now(), request.issued_key_ref);
    db.prepare("UPDATE key_requests SET status='issued' WHERE id=?").run(id);
  })();
  res.json({ delivered: true, fingerprint: keyFingerprintForRef(request.issued_key_ref) });
}));

app.post("/admin/key-requests/:id/reject", adminAuth, asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  const request = db.prepare("SELECT * FROM key_requests WHERE id=?").get(id);
  if (!request) return res.status(404).json({ error: "request not found" });
  if (!["pending_review", "pending_verification", "verification_delivery_failed"].includes(request.status)) return res.status(409).json({ error: `request is ${request.status}` });
  const reason = String(req.body?.reason || "The request did not pass our early-access review.").slice(0, 500);
  db.prepare("UPDATE key_requests SET status='rejected',reviewed_at=?,rejected_reason=?,verify_token_hash=NULL WHERE id=?").run(now(), reason, id);
  if (request.verified_at) {
    const html = `<p><b>Your API key request was not approved.</b></p><p>${esc(reason)}</p><p style="color:#666;font-size:13px">No API key was created.</p>`;
    try { await sendResendMessage({ to: request.email, subject: "Update on your API key request", html, purpose: "key_rejection", reference: String(id), idempotencyKey: `key-rejection/${id}` }); } catch (error) { console.warn("[key-rejection-email]", error.message || error); }
  }
  res.json({ rejected: true, request_id: id });
}));

app.get("/receive-key/:token", (req, res) => {
  const reveal = db.prepare("SELECT * FROM key_reveals WHERE token_hash=? AND used_at IS NULL").get(hashApiKey(req.params.token));
  if (!reveal || reveal.expires_at < now()) return res.status(410).send(page("Key link unavailable", "<h1>This key link is no longer available.</h1><p class='muted'>It may have expired or already been used. Contact the operator to revoke and reissue it.</p>"));
  res.send(page("Receive API key", `<p class="eyebrow">${BRAND}</p><h1>Receive your API key?</h1><p>The key will be shown once on the next screen.</p><p class="muted">Opening this page did not reveal the key. Store it in your password manager or automation credential field.</p><form method="post"><div class="row"><button class="yes" type="submit">Show API key once</button></div></form>`));
});

app.post("/receive-key/:token", (req, res) => {
  const tokenHash = hashApiKey(req.params.token);
  const reveal = db.prepare("SELECT * FROM key_reveals WHERE token_hash=? AND used_at IS NULL").get(tokenHash);
  if (!reveal || reveal.expires_at < now()) return res.status(410).send(page("Key link unavailable", "<h1>This key link is no longer available.</h1>"));
  const secret = JSON.parse(decryptTemporarySecret(reveal.secret_box));
  db.prepare("DELETE FROM key_reveals WHERE token_hash=?").run(tokenHash);
  db.prepare("UPDATE keys SET status='active',activated_at=COALESCE(activated_at,?) WHERE key=? AND status='pending_delivery'").run(now(), reveal.key_ref);
  const installToken = issueSlackInstallToken(reveal.key_ref);
  res.set("Cache-Control", "no-store").send(page("API key", `<p class="eyebrow">${BRAND}</p><h1>Your API key.</h1><pre>${esc(secret.key)}</pre><p><b>Copy it now.</b> We cannot show it again because only its one-way fingerprint remains after this page.</p><p class="muted">Hosted preview limits: ${REVIEW_KEY_RATE_LIMIT}/minute · ${KEY_MONTHLY_APPROVAL_LIMIT}/month · ${KEY_MONTHLY_EMAIL_LIMIT} approval emails/month · ${KEY_PENDING_LIMIT} pending.</p><p><a href="${BASE_URL}/slack/install?token=${installToken}">Connect Slack →</a></p>`));
});

// The previous public auto-issuance endpoint stays closed even if an old page is cached.
app.post("/create-key", (_req, res) => res.status(403).json({ error: "Automatic key creation is disabled. Submit a request for review." }));

// ---------- 데모: 랜딩에서 실제 승인 링크를 만들어 보여줌 ----------
app.post("/demo", (req, res) => {
  if (rateLimited("demo:" + privateHash("demo-ip", ip(req)), 20, 3600e3)) return res.status(429).json({ error: "too many demo requests from this address; try again in an hour" });
  const a = {
    id: newId(), token: newToken(), api_key: DEMO_KEY,
    question: String(req.body.question || "Refund order A-1 for $380?").slice(0, 200),
    context: JSON.stringify({ demo: true, created_from: "landing" }),
    approve_label: "Yes", reject_label: "No", callback_url: null, channel: "link", recipient: null,
    timeout_at: now() + 10 * 60 * 1000, default_on_timeout: "rejected", status: "pending", created_at: now(),
  };
  db.prepare(`INSERT INTO approvals (id,token,api_key,question,context,approve_label,reject_label,callback_url,channel,recipient,timeout_at,default_on_timeout,status,created_at)
    VALUES (@id,@token,@api_key,@question,@context,@approve_label,@reject_label,@callback_url,@channel,@recipient,@timeout_at,@default_on_timeout,@status,@created_at)`).run(a);
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
const FLOW_MOTION = fs.existsSync(__dirname + "/approval-flow-motion.html") ? fs.readFileSync(__dirname + "/approval-flow-motion.html", "utf8") : "";
const TRUST_PAGE = fs.existsSync(__dirname + "/trust.html") ? fs.readFileSync(__dirname + "/trust.html", "utf8") : "";
const STATUS_PAGE = fs.existsSync(__dirname + "/status.html") ? fs.readFileSync(__dirname + "/status.html", "utf8") : "";
const RELAY_PAGE = fs.existsSync(__dirname + "/relay.html") ? fs.readFileSync(__dirname + "/relay.html", "utf8") : "";
const N8N_EMAIL_STARTER = __dirname + "/examples/n8n-email-approval-starter.json";
const N8N_SLACK_STARTER = __dirname + "/examples/n8n-approval-demo.json";
app.get("/", (_req, res) => res.type("html").send(LANDING.replaceAll("{{BASE_URL}}", BASE_URL)));
app.get("/trust", (_req, res) => res.type("html").send(TRUST_PAGE));
app.get("/status", (_req, res) => res.type("html").send(STATUS_PAGE));
app.get("/relay", (_req, res) => res.type("html").send(RELAY_PAGE));
app.get("/approval-flow-motion.html", (_req, res) => res.type("html").send(FLOW_MOTION));
app.get("/starters/n8n-email-approval.json", (_req, res) => res.download(N8N_EMAIL_STARTER, "someonehastosayyes-n8n-email-starter.json"));
app.get("/starters/n8n-slack-approval.json", (_req, res) => res.download(N8N_SLACK_STARTER, "someonehastosayyes-n8n-slack-starter.json"));

app.get("/health", (_req, res) => {
  const check = db.pragma("quick_check", { simple: true });
  res.status(check === "ok" ? 200 : 503).json({
    ok: check === "ok",
    database: check === "ok" ? "ok" : "error",
    pending: db.prepare("SELECT COUNT(*) c FROM approvals WHERE status='pending'").get().c,
    callbacks_queued: db.prepare("SELECT COUNT(*) c FROM outbox WHERE state='queued'").get().c,
    notifications_queued: db.prepare("SELECT COUNT(*) c FROM notification_outbox WHERE state IN ('queued','sending')").get().c,
    email_verification_configured: Boolean(RESEND_API_KEY && EMAIL_FROM),
    manual_review_configured: ADMIN_SECRET.length >= 24,
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
  while ((delivering || deliveringNotifications) && now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  try { db.pragma("wal_checkpoint(TRUNCATE)"); } catch {}
  try { db.close(); } catch {}
  process.exit(0);
}
process.on("SIGTERM", () => { shutdown("SIGTERM").catch(() => process.exit(1)); });
process.on("SIGINT", () => { shutdown("SIGINT").catch(() => process.exit(1)); });
