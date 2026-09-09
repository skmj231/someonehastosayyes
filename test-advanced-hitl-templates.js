const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (file) => fs.readFileSync(path.join(__dirname, file), "utf8");
const approval = read("approval.html");
const landing = read("landing.html");
const catalog = require("./template-catalog.json");

const cases = [
  {
    id: "ai-database-change",
    file: "examples/n8n-ai-database-change-approval.json",
    guide: "examples/n8n-ai-database-change-approval.md",
    route: /github\.com\/skmj231\/someonehastosayyes\/raw\/refs\/heads\/main\/examples\/n8n-ai-database-change-approval\.json/,
    protected: "database.mutate",
    required: [/environment/i, /expected affected rows/i, /command hash/i, /authenticated/i],
  },
  {
    id: "sensitive-hr-message-release",
    file: "examples/n8n-sensitive-hr-message-approval.json",
    guide: "examples/n8n-sensitive-hr-message-approval.md",
    route: /github\.com\/skmj231\/someonehastosayyes\/raw\/refs\/heads\/main\/examples\/n8n-sensitive-hr-message-approval\.json/,
    protected: "hr_message.send",
    required: [/sanitized final message/i, /removed-field/i, /message(?:-and-destination)? hash/i, /authenticated/i],
  },
];

for (const item of cases) {
  const entry = catalog.find((candidate) => candidate.id === item.id);
  assert.ok(entry, `${item.id} must exist in the catalog`);
  assert.equal(entry.status, "verified");
  assert.equal(entry.protected, item.protected);
  assert.match(landing, new RegExp(`template=${item.id}`));
  assert.match(approval, new RegExp(`data-template="${item.id}"`));
  assert.match(approval, new RegExp(`"${item.id}"[\\s\\S]*?platformName:"n8n"`));
  assert.match(entry.file, item.route);
  assert.match(approval, item.route);

  const workflowText = read(item.file);
  const workflow = JSON.parse(workflowText);
  assert.ok(workflow.nodes.some((node) => node.name === "Get authenticated SHSY result"));
  assert.ok(workflow.nodes.some((node) => /hash/i.test(node.name)));
  assert.ok(workflow.nodes.some((node) => node.type === "n8n-nodes-base.if"));
  assert.doesNotMatch(workflowText, /Bearer\s+[A-Za-z0-9_-]{8,}/);

  const guide = read(item.guide);
  for (const pattern of item.required) assert.match(guide, pattern);
  assert.match(guide, /VERIFIED/);
  assert.match(guide, /Idempotency key/);
  assert.match(guide, /approve, reject, timeout, duplicate/i);
}

const hrWorkflow = read("examples/n8n-sensitive-hr-message-approval.json");
assert.doesNotMatch(hrWorkflow, /raw_hr|salary|phone number|review notes/i);
assert.match(hrWorkflow, /Keep only the review-safe message/);
assert.match(approval, /Raw HR record absent/);
assert.match(approval, /Tested in a connected n8n workflow/);

const scripts = [...approval.matchAll(/<script>([\s\S]*?)<\/script>/g)];
assert.ok(scripts.length > 0);
new Function(scripts.at(-1)[1]);

console.log("Advanced HITL template contracts: PASS");
