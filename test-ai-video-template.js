const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = __dirname;
const landing = fs.readFileSync(path.join(root, "landing.html"), "utf8");
const approval = fs.readFileSync(path.join(root, "approval.html"), "utf8");
const guide = fs.readFileSync(path.join(root, "examples/make-ai-video-draft-approval.md"), "utf8");
const catalog = require("./template-catalog.json");
const item = catalog.find((entry) => entry.id === "ai-video-draft-release");

assert.ok(item, "catalog must include the AI video template");
assert.equal(item.platform, "make");
assert.equal(item.protected, "video.publish");
assert.match(item.summary, /exact video version, hash, and destination/i);
assert.match(landing, /template=ai-video-draft-release/);
assert.match(approval, /data-template="ai-video-draft-release"/);
assert.match(approval, /ai-video-draft-release[\s\S]*?verified-badge/i);
assert.match(approval, /SHA-256 draft hash/);
assert.match(approval, /draft version/);
assert.match(approval, /publish destination/);
assert.match(approval, /const verifiedDetails=/);
assert.match(approval, /"timed-outreach-veto"[\s\S]*?This is a short chance to stop an email/);
assert.match(approval, /If nobody responds within 60 seconds/);
assert.match(approval, /The waiting happens outside Make/);
assert.match(approval, /What SHSY handles for you/);
assert.match(approval, /More approval templates/);
assert.match(guide, /Idempotency-Key: ai-video-\{\{request_id\}\}-\{\{draft_sha256\}\}/);
assert.match(guide, /status` equals `approved`/);
assert.match(guide, /context\.draft_sha256/);
assert.match(guide, /context\.draft_version/);
assert.match(guide, /context\.destination/);
assert.match(guide, /default_on_timeout/);
assert.doesNotMatch(guide, /ah_[A-Za-z0-9_-]{10,}/, "guide must not contain an API key");
assert.doesNotMatch(guide, /hook\.us2\.make\.com\/[A-Za-z0-9]{10,}/, "guide must not contain a live callback URL");
assert.equal(item.status, "verified");

console.log("AI video template contract: PASS");
