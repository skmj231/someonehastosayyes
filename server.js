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
const API_KEYS = (process.env.API_KEYS || "dev-key").split(",").map((s) => s.trim());
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

function validateProductionConfig() {
  if (!IS_PRODUCTION) return;
  const problems = [];
  if (!BASE_URL.startsWith("https://")) problems.push("BASE_URL must use https");
  if (!API_KEYS.length || API_KEYS.includes("dev-key")) problems.push("API_KEYS must not use the development default");
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
CREATE TABLE IF NOT EXISTS ratelimit (bucket TEXT PRIMARY KEY, count INTEGER NOT NULL, window_start INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS key_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  tool TEXT,
  note TEXT,
  at INTEGER NOT NULL
);
`);

// Existing SQLite files are migrated in place. The optional key lets an
// automation safely retry approval creation without making a second request.
if (!db.prepare("PRAGMA table_info(approvals)").all().some((c) => c.name === "idempotency_key")) {
  db.exec("ALTER TABLE approvals ADD COLUMN idempotency_key TEXT");
}
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_approval_idempotency ON approvals(api_key, idempotency_key) WHERE idempotency_key IS NOT NULL");

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
  res.set("X-Frame-Options", "DENY");
  if (req.path.startsWith("/a/") || req.path.startsWith("/admin/")) res.set("Cache-Control", "no-store");
  next();
});

const now = () => Date.now();
const newId = () => "apr_" + crypto.randomBytes(8).toString("hex");
const newToken = () => crypto.randomBytes(24).toString("base64url");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---------- 인증 ----------
function auth(req, res, next) {
  const key = (req.headers.authorization || "").replace(/^Bearer\s+/i, "") || req.headers["x-api-key"];
  const ok = key && (API_KEYS.includes(key) || db.prepare("SELECT 1 FROM keys WHERE key=?").get(key));
  if (!ok) return res.status(401).json({ error: "invalid api key" });
  req.apiKey = key;
  next();
}

function sameSecret(value, expected) {
  const a = Buffer.from(String(value || ""));
  const b = Buffer.from(String(expected || ""));
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

function adminAuth(req, res, next) {
  if (rateLimited("admin:" + ip(req), 30, 60e3)) return res.status(429).json({ error: "rate limited" });
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
  return {
    callback: callbackState(a),
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
  if (rateLimited("create:" + req.apiKey, 600, 60e3)) return res.status(429).json({ error: "rate limit: 600 approvals per minute per key" });
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

  try {
    if (channel === "email") await sendEmail(a);
    if (channel === "slack") await sendSlack(a);
  } catch (e) {
    // 발송 실패해도 링크는 살아있음. 상태만 알려줌.
    return res.status(202).json({ ...publicView(a), delivery_warning: String(e.message || e) });
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

// ---------- 결정 (공통) ----------
// 멱등: 이미 결정됐으면 아무것도 바꾸지 않고 기존 결정을 돌려준다.
function decide(a, decision, by, comment, source) {
  const r = db.prepare(`UPDATE approvals SET status=?, decided_by=?, decided_at=?, comment=? WHERE id=? AND status='pending'`)
    .run(decision, by, now(), comment || null, a.id);
  const fresh = db.prepare("SELECT * FROM approvals WHERE id=?").get(a.id);
  if (r.changes === 1) {
    if (fresh.api_key !== DEMO_KEY && fresh.api_key !== NOTIFY_SLACK_KEY) {
      const label = db.prepare("SELECT label FROM keys WHERE key=?").get(fresh.api_key);
      notifyOwner(`Approval decided on ${label?.label || fresh.api_key}`, [
        { type: "section", text: { type: "mrkdwn", text: `*${fresh.status}* · ${label?.label || "a user"}\n${fresh.question.slice(0, 140)}` } },
        { type: "context", elements: [{ type: "mrkdwn", text: `${fresh.id} · via ${source} · ${fresh.decided_by || ""}` }] },
      ]);
    }
    enqueueCallback(fresh, source);
    if (fresh.channel === "slack" && fresh.slack_ts) updateSlackMessage(fresh).catch(() => {});
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
      if (state === "failed") notifyOwner(`Callback FAILED after ${BACKOFF.length} attempts: ${o.approval_id}`, [{ type: "section", text: { type: "mrkdwn", text: `*Callback failed* for ${o.approval_id}\n${o.url}\nlast: ${status || error}` } }]);
    }
  } finally { delivering = false; }
}
setInterval(() => deliverDue().catch(() => {}), DELIVERY_SWEEP_MS).unref();

// 영수증: 자기완결 JSON + 서명. 고객이 보관하고, 누구나 공개키로 검증.
app.get("/v1/approvals/:id/receipt", auth, (req, res) => {
  const a = db.prepare("SELECT * FROM approvals WHERE id=? AND api_key=?").get(req.params.id, req.apiKey);
  if (!a) return res.status(404).json({ error: "not found" });
  if (a.status === "pending") return res.status(409).json({ error: "not decided yet" });
  const o = db.prepare("SELECT body, signature FROM outbox WHERE approval_id=?").get(a.id);
  const body = o ? o.body : JSON.stringify(receiptFor(a, "receipt"));
  const signature = o ? o.signature : sign(body);
  res.json({ receipt: JSON.parse(body), receipt_json: body, signature, key_id: SIGN_KEY_ID, public_key_url: `${BASE_URL}/.well-known/approval-signing-key`, verify_url: `${BASE_URL}/v1/verify` });
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

// ---------- 타임아웃 스윕 ----------
setInterval(() => {
  const due = db.prepare("SELECT * FROM approvals WHERE status='pending' AND timeout_at <= ?").all(now());
  for (const a of due) decide(a, a.default_on_timeout, "timeout", null, "timeout");
  // 랜딩 데모로 만든 요청은 하루 뒤 삭제
  db.prepare("DELETE FROM approvals WHERE api_key=? AND created_at < ?").run(DEMO_KEY, now() - 24 * 3600 * 1000);
}, TIMEOUT_SWEEP_MS).unref();

// ---------- 이메일 (Resend) ----------
async function sendEmail(a) {
  if (!RESEND_API_KEY) throw new Error("RESEND_API_KEY not set; approve_url still works");
  const url = `${BASE_URL}/a/${a.token}`;
  const ctx = a.context ? JSON.parse(a.context) : null;
  const html = `<p style="font-size:16px"><b>${esc(a.question)}</b></p>${ctx ? `<pre style="background:#f4f4f5;padding:12px">${esc(typeof ctx === "string" ? ctx : JSON.stringify(ctx, null, 2))}</pre>` : ""}
  <p><a href="${url}" style="display:inline-block;padding:12px 20px;background:#111;color:#fff;border-radius:8px;text-decoration:none">Open and decide</a></p>
  <p style="color:#666;font-size:13px">Answer by ${fmt(a.timeout_at)} UTC (about ${Math.round((a.timeout_at - now()) / 3600000)} hours from now)</p>`;
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ from: EMAIL_FROM, to: a.recipient, subject: `[Needs a yes] ${a.question.slice(0, 60)}`, html }),
  });
  if (!r.ok) throw new Error(`resend ${r.status}: ${await r.text()}`);
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
  const r = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(`slack ${method}: ${j.error}`);
  return j;
}

async function sendSlack(a) {
  const token = slackTokenFor(a.api_key);
  if (!token) throw new Error(`Slack not connected for this key. Connect at ${BASE_URL}/slack/install?key=<your key>. approve_url still works`);
  const j = await slackApi("chat.postMessage", { channel: a.recipient, text: a.question, blocks: slackBlocks(a) }, token);
  db.prepare("UPDATE approvals SET slack_channel=?, slack_ts=? WHERE id=?").run(j.channel, j.ts, a.id);
}

async function updateSlackMessage(a) {
  const token = slackTokenFor(a.api_key);
  if (!token || !a.slack_ts) return;
  await slackApi("chat.update", { channel: a.slack_channel, ts: a.slack_ts, text: a.question, blocks: slackBlocks(a) }, token);
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
app.post("/admin/keys", adminAuth, (req, res) => {
  const key = "ah_" + crypto.randomBytes(16).toString("base64url");
  db.prepare("INSERT INTO keys (key,label,created_at) VALUES (?,?,?)").run(key, String(req.body?.label || ""), now());
  const installToken = issueSlackInstallToken(key);
  res.status(201).json({ key, label: req.body?.label || "", slack_install_url: `${BASE_URL}/slack/install?token=${installToken}` });
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

app.get("/admin/key-requests", adminAuth, (req, res) => {
  res.json(db.prepare("SELECT * FROM key_requests ORDER BY at DESC LIMIT 200").all());
});

// ---------- 키 요청 (랜딩 폼) ----------
app.post("/request-key", (req, res) => {
  if (rateLimited("reqkey:" + ip(req), 5, 3600e3)) return res.status(429).send(page("Slow down", "<p class=\"muted\">Too many requests from this address. Try again in an hour.</p>"));
  const email = String(req.body.email || "").trim().slice(0, 200);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).send(page("Check the email", "<p>That doesn't look like an email address. Go back and try again.</p>"));
  const stored = db.prepare("INSERT INTO key_requests (email,tool,note,at) VALUES (?,?,?,?)").run(email, String(req.body.tool || "").slice(0, 40), String(req.body.note || "").slice(0, 500), now());
  console.log(`[key-request] stored request ${stored.lastInsertRowid}`);
  const tool = String(req.body.tool || "-"), note = String(req.body.note || "").slice(0, 300);
  notifyOwner(`New key request: ${email}`, [
    { type: "section", text: { type: "mrkdwn", text: `*New key request*\n${email} · ${tool}` } },
    ...(note ? [{ type: "section", text: { type: "mrkdwn", text: `> ${note.replace(/\n/g, " ")}` } }] : []),
    { type: "context", elements: [{ type: "mrkdwn", text: "Issue a key with POST /admin/keys, then reply by hand." }] },
  ]);
  res.send(page("Request received", `<h1>Got it</h1><p>A key goes out to <b>${esc(email)}</b> by hand, usually within a few hours. It comes with a Slack connect link.</p><p><a href="/">Back</a></p>`));
});

// ---------- 데모: 랜딩에서 실제 승인 링크를 만들어 보여줌 ----------
app.post("/demo", (req, res) => {
  if (rateLimited("demo:" + ip(req), 20, 3600e3)) return res.status(429).json({ error: "too many demo requests from this address; try again in an hour" });
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
