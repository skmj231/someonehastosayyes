const Database = require("better-sqlite3");

const path = process.argv[2] || process.env.DB_PATH || "askhuman.db";
const db = new Database(path, { readonly: true, fileMustExist: true });
const findings = [];
const tables = new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map((row) => row.name));

function check(name, passed, detail) { findings.push({ name, passed, detail }); }

const slack = tables.has("slack_installs") ? db.prepare("SELECT COUNT(*) total, SUM(CASE WHEN bot_token LIKE 'enc:v1:%' THEN 1 ELSE 0 END) encrypted FROM slack_installs").get() : { total: 0, encrypted: 0 };
check("Slack installation tokens", Number(slack.total) === Number(slack.encrypted || 0), `${slack.encrypted || 0}/${slack.total} encrypted`);
const meta = tables.has("meta") ? db.prepare("SELECT v FROM meta WHERE k='signing_key'").get() : null;
check("Stored signing private key", !meta || String(meta.v).startsWith("enc:v1:"), meta ? "encrypted envelope" : "provided by environment or not initialized");
const credentials = tables.has("api_credentials") ? db.prepare("SELECT COUNT(*) total, SUM(CASE WHEN key_hash IS NOT NULL AND length(key_hash)=64 THEN 1 ELSE 0 END) hashed FROM api_credentials").get() : { total: 0, hashed: 0 };
check("API credentials", Number(credentials.total) === Number(credentials.hashed || 0), `${credentials.hashed || 0}/${credentials.total} stored as SHA-256 hashes`);
const verification = tables.has("verification_tokens") ? db.prepare("SELECT COUNT(*) total, SUM(CASE WHEN token_hash IS NOT NULL AND length(token_hash)=64 THEN 1 ELSE 0 END) hashed FROM verification_tokens").get() : { total: 0, hashed: 0 };
check("Email verification tokens", Number(verification.total) === Number(verification.hashed || 0), `${verification.hashed || 0}/${verification.total} stored as hashes`);

for (const item of findings) console.log(`${item.passed ? "PASS" : "FAIL"}  ${item.name}: ${item.detail}`);
db.close();
if (findings.some((item) => !item.passed)) process.exitCode = 1;
