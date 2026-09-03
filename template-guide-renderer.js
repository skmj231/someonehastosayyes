const catalog = require("./template-catalog.json");

const PLATFORM = {
  n8n: {
    label: "n8n",
    workload: "1 workflow, 2 HTTP Request nodes, 1 Wait node, and 1 IF node",
    credential: "an n8n HTTP Header Auth credential",
    capture: "the Wait node output",
  },
  make: {
    label: "Make",
    workload: "2 scenarios, 1 custom webhook, 2 HTTP requests, and 1 router filter",
    credential: "a Make HTTP v4 secure keychain",
    capture: "the webhook bundle captured during Run once",
  },
  zapier: {
    label: "Zapier",
    workload: "2 Zaps, 1 Catch Hook, 2 API requests, and 1 Filter",
    credential: "an API by Zapier app connection",
    capture: "the sample captured by Test trigger",
  },
};

const REVIEW_FIELDS = {
  "zapier-winston-content": ["article title", "draft URL", "AI score", "plagiarism score", "target CMS"],
  "ai-email": ["recipient", "subject", "draft body", "customer record URL"],
  refund: ["order ID", "refund amount", "reason", "customer", "payment link"],
  "content-publish": ["title", "draft URL", "author", "channel", "scheduled time"],
  "crm-bulk-change": ["object type", "operation", "record count", "filter", "sample records"],
  "pipeline-digest": ["pipeline total", "stage changes", "deal owners", "exceptions", "destination channel"],
  "meeting-followup": ["meeting title", "attendees", "recap", "action items", "draft email"],
  "sales-quote": ["account", "line items", "price", "discount", "terms", "quote URL"],
  "candidate-progress": ["candidate", "current stage", "proposed stage", "screening evidence", "profile URL"],
  "account-provisioning": ["employee", "role", "start date", "systems", "access level", "manager"],
  "order-fulfillment": ["order ID", "items", "stock status", "destination", "shipping method"],
  "payment-receipt": ["payment ID", "amount", "customer", "invoice", "receipt recipient"],
  "performance-review": ["employee", "review period", "draft URL", "manager", "visibility"],
  "reddit-outreach": ["thread URL", "prospect", "draft reply", "reason to contact", "CRM destination"],
  "lead-qualification": ["lead", "score", "evidence", "owner", "pipeline destination"],
  "support-response": ["ticket ID", "customer issue", "diagnosis", "draft reply", "risk flags"],
  "health-escalation": ["account", "risk signals", "health score", "owner", "proposed escalation"],
  "email-triage": ["sender", "subject", "classification", "proposed action", "draft reply"],
  "ticket-backlog-digest": ["open tickets", "SLA breaches", "oldest tickets", "team workload", "destination"],
  "review-reply": ["location", "review text", "rating", "draft reply", "business facts"],
  "action-items": ["meeting", "task list", "assignees", "due dates", "project destination"],
  "order-calendar": ["order ID", "customer", "date and time", "event title", "calendar"],
};

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

function jsonForHtml(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function subjectFor(item) {
  return item.title.replace(/^Zapier \+ /i, "").replace(/ approval$/i, "");
}

function platformSteps(item, platform) {
  const action = item.flow[4].toLowerCase();
  if (item.id === "zapier-winston-content") return [
    ["Create the callback Zap", "In Zap B, add Webhooks by Zapier → Catch Hook. Copy the hook URL and keep it private."],
    ["Build the review Zap", "In Zap A, trigger when the article is ready. Run the Winston AI and plagiarism checks, then keep the returned scores."],
    ["Create the approval request", "Use API by Zapier to POST the title, draft URL, scores, approver email, and the Zap B hook URL to SHSY."],
    ["Capture the real callback", "Approve one test request by email. In Zap B, use Test trigger and select the callback that actually arrived."],
    ["Verify the decision", "Use API by Zapier to GET /v1/approvals/{id}. Map id from the captured callback and filter for the verified approved value."],
    ["Connect publishing", "After approve, reject, and timeout tests pass, connect the approved path to the CMS publishing action."],
  ];
  if (platform === "n8n") return [
    ["Import the starter", "Import the n8n starter JSON. Replace the Manual Trigger and final placeholder with your real trigger and action."],
    ["Add the SHSY credential", "Create an HTTP Header Auth credential. Store Authorization as Bearer plus your SHSY key. Do not paste the key into workflow JSON."],
    ["Map the review context", `Map the fields listed below into the approval request. Keep ${item.connect} disconnected.`],
    ["Capture one callback", "Run the workflow manually and decide the request by email. Inspect the Wait node output before mapping any callback field."],
    ["Verify the decision", "Map the captured approval id into the disabled GET node, enable it, and branch on the top-level approved value returned by that request."],
    ["Connect the live action", `Run approve, reject, and timeout tests. Connect ${item.connect} only to the approved branch.`],
  ];
  if (platform === "make") return [
    ["Create the callback scenario", "In Scenario B, add Webhooks → Custom webhook. Copy the URL, keep it private, and select Run once."],
    ["Add the SHSY keychain", "In the HTTP v4 app, create a secure API key credential for the Authorization header. Do not map the raw key into a scenario field."],
    ["Create the request scenario", `In Scenario A, start from ${item.flow[0].toLowerCase()} and POST the approval request. Use the Scenario B webhook URL as callback_url.`],
    ["Capture one webhook bundle", "Approve one test request while Scenario B is listening. Build mappings only from the bundle that Make captures."],
    ["Verify the decision", "In Scenario B, GET /v1/approvals/{id} using the captured id and the same keychain. Add a router filter for approved = true."],
    ["Connect the live action", `Run approve, reject, and timeout tests. Connect ${item.connect} only after the approved filter.`],
  ];
  return [
    ["Create the callback Zap", "In Zap B, add Webhooks by Zapier → Catch Hook. Copy the URL and treat it like a password."],
    ["Create the request Zap", `In Zap A, start from ${item.flow[0].toLowerCase()}. Use API by Zapier to POST the approval request and store the SHSY key in the app connection.`],
    ["Map the review context", `Map the fields listed below. Keep ${item.connect} disconnected.`],
    ["Capture one hook sample", "Approve one test request by email. In Zap B, use Test trigger and select the callback that actually arrived."],
    ["Verify the decision", "Use API by Zapier to GET /v1/approvals/{id}. Map id from the captured sample, then add a Filter for the verified approved value."],
    ["Connect the live action", `Run approve, reject, and timeout tests. Connect ${item.connect} only after the Filter.`],
  ];
}

function buildChecklist(item, platform) {
  const p = PLATFORM[platform];
  return `Build ${item.title} in ${p.label}. Place the approval after "${item.flow[0]}" and before "${item.flow[4]}". Use ${p.credential} for the SHSY API key. POST to /v1/approvals with a unique idempotency key, the approver email, a private callback URL, and these review fields: ${(REVIEW_FIELDS[item.id] || []).join(", ")}. Capture one real callback before mapping fields. Then authenticate GET /v1/approvals/{id} and continue only when its top-level approved value is true. Use timeout_minutes: 1 for QA. Test approval, rejection, and timeout before connecting ${item.connect}.`;
}

function n8nWorkflow(item) {
  const timeout = Number.parseInt(item.timeout, 10);
  const requestName = `Request ${subjectFor(item).toLowerCase()} approval`;
  const finalName = `CONNECT ${item.flow[4].toUpperCase()} HERE`;
  const auth = { httpHeaderAuth: { name: "SHSY Header Auth" } };
  const requestBody = `={{ JSON.stringify({ question: ${JSON.stringify(`Approve this ${item.protected} action?`)}, context: { action: ${JSON.stringify(item.protected)}, details: 'Map: ${(REVIEW_FIELDS[item.id] || []).join(", ")}' }, channel: 'email', to: 'YOUR_APPROVER_EMAIL', callback_url: $execution.resumeUrl, timeout_minutes: ${timeout}, default_on_timeout: 'rejected' }) }}`;
  return {
    name: `Approval: ${item.title}`,
    nodes: [
      { parameters: {}, name: item.flow[0], type: "n8n-nodes-base.manualTrigger", typeVersion: 1, position: [0, 0] },
      { parameters: { method: "POST", url: "https://someonehastosayyes.com/v1/approvals", authentication: "genericCredentialType", genericAuthType: "httpHeaderAuth", sendHeaders: true, headerParameters: { parameters: [{ name: "Idempotency-Key", value: "={{ $execution.id }}" }] }, sendBody: true, specifyBody: "json", jsonBody: requestBody, options: {} }, name: requestName, type: "n8n-nodes-base.httpRequest", typeVersion: 4.2, position: [240, 0], credentials: auth },
      { parameters: { resume: "webhook", httpMethod: "POST", limitWaitTime: true, resumeAmount: timeout + 5, resumeUnit: "minutes", options: {} }, name: "Wait for decision", type: "n8n-nodes-base.wait", typeVersion: 1.1, position: [500, 0], webhookId: `shsy-${item.id}-0001` },
      { parameters: { url: "https://someonehastosayyes.com/v1/approvals/REPLACE_WITH_ID_FROM_CAPTURED_CALLBACK", authentication: "genericCredentialType", genericAuthType: "httpHeaderAuth", options: {} }, name: "CONFIGURE ID, THEN ENABLE: Verify decision", type: "n8n-nodes-base.httpRequest", typeVersion: 4.2, position: [740, 0], credentials: auth, disabled: true },
      { parameters: { conditions: { options: { caseSensitive: true, leftValue: "", typeValidation: "loose" }, conditions: [{ id: "approved", leftValue: "={{ $json.approved }}", rightValue: true, operator: { type: "boolean", operation: "true", singleValue: true } }], combinator: "and" }, options: {} }, name: "Approved?", type: "n8n-nodes-base.if", typeVersion: 2, position: [980, 0] },
      { parameters: {}, name: finalName, type: "n8n-nodes-base.noOp", typeVersion: 1, position: [1220, -120] },
      { parameters: {}, name: "Stop action / notify owner", type: "n8n-nodes-base.noOp", typeVersion: 1, position: [1220, 120] },
    ],
    connections: {
      [item.flow[0]]: { main: [[{ node: requestName, type: "main", index: 0 }]] },
      [requestName]: { main: [[{ node: "Wait for decision", type: "main", index: 0 }]] },
      "Wait for decision": { main: [[{ node: "CONFIGURE ID, THEN ENABLE: Verify decision", type: "main", index: 0 }]] },
      "CONFIGURE ID, THEN ENABLE: Verify decision": { main: [[{ node: "Approved?", type: "main", index: 0 }]] },
      "Approved?": { main: [[{ node: finalName, type: "main", index: 0 }], [{ node: "Stop action / notify owner", type: "main", index: 0 }]] },
    },
    settings: { executionOrder: "v1" },
  };
}

function renderGuide({ templateId, requestedPlatform, baseUrl }) {
  const item = catalog.find((entry) => entry.id === templateId);
  if (!item) return null;
  const supported = item.guide ? ["zapier"] : ["n8n", "make", "zapier"];
  const platformId = supported.includes(requestedPlatform) ? requestedPlatform : supported[0];
  const platform = PLATFORM[platformId];
  const subject = subjectFor(item);
  const title = `Add ${subject.toLowerCase()} approval to ${platform.label}`;
  const canonical = `${baseUrl}${item.guide || `/templates/${item.id}`}?platform=${platformId}`;
  const fields = REVIEW_FIELDS[item.id] || [];
  const steps = platformSteps(item, platformId);
  const checklist = buildChecklist(item, platformId);
  const requestBody = {
    question: `Approve this ${item.protected} action?`,
    context: { action: item.protected, details: `Map: ${fields.join(", ")}` },
    channel: "email",
    to: "YOUR_APPROVER_EMAIL",
    callback_url: "YOUR_PRIVATE_CALLBACK_URL",
    timeout_minutes: Number.parseInt(item.timeout, 10),
    default_on_timeout: "rejected",
  };
  const callbackBody = {
    receipt_version: "<version>", schema_version: "<version>", id: "<approval id>",
    status: "approved | rejected | expired", approved: true, decided_by: "<approver>",
    decided_at: "<ISO timestamp>", comment: null, source: "email",
    question: "<approval question>", context: {}, channel: "email",
    created_at: "<ISO timestamp>", issuer: "someonehastosayyes", key_id: "<signing key id>",
  };
  const schema = {
    "@context": "https://schema.org",
    "@graph": [
      { "@type": "TechArticle", headline: title, description: item.description, mainEntityOfPage: canonical, author: { "@type": "Organization", name: "someonehastosayyes", url: baseUrl }, about: ["human approval", "workflow automation", platform.label, subject] },
      { "@type": "HowTo", name: title, description: item.description, step: steps.map(([name, text], index) => ({ "@type": "HowToStep", position: index + 1, name, text })) },
      { "@type": "BreadcrumbList", itemListElement: [
        { "@type": "ListItem", position: 1, name: "Templates", item: `${baseUrl}/relay/templates` },
        { "@type": "ListItem", position: 2, name: `${subject} approval for ${platform.label}`, item: canonical },
      ] },
    ],
  };
  const faq = [
    [`Where does the approval go?`, `After ${item.flow[0].toLowerCase()} and before ${item.flow[4].toLowerCase()}.`],
    [`Does this require Slack?`, `No. This guide uses email approval. Slack is optional and is not required for the callback.`],
    [`What work is required in ${platform.label}?`, `${platform.workload}. You also connect your existing trigger and ${item.connect}.`],
    [`Can the callback be trusted by itself?`, `Do not use it as the final authorization signal. Capture its id, then authenticate GET /v1/approvals/{id} and branch on that response.`],
    [`Has this template passed account-connected E2E testing?`, `Not yet. The structure and field guidance have passed first-pass QA. The page will show E2E verified only after a real account test passes.`],
  ];
  const relatedPlatforms = supported.filter((id) => id !== platformId).map((id) => `<a href="${esc(item.guide || `/templates/${item.id}`)}?platform=${id}">${esc(PLATFORM[id].label)} version</a>`).join("");
  const css = `:root{--ink:#171914;--muted:#666b62;--line:#dfe2da;--paper:#f7f8f4;--white:#fff;--signal:#e5ed4d;--soft:#f0f2eb;--mono:ui-monospace,SFMono-Regular,Menlo,monospace;--sans:Inter,ui-sans-serif,system-ui,sans-serif}*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.55 var(--sans)}a{color:inherit}.shell{width:min(1040px,calc(100% - 40px));margin:auto}.nav{height:68px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line)}.brand{font-weight:850;text-decoration:none}.back{color:var(--muted);font-size:13px;text-decoration:none}.hero{padding:54px 0 42px}.eyebrow{margin:0 0 13px;color:#697000;font:11px var(--mono);letter-spacing:.055em;text-transform:uppercase}.hero h1{max-width:860px;margin:0;font-size:clamp(40px,6vw,66px);font-weight:680;line-height:.98;letter-spacing:-.052em}.lead{max-width:700px;margin:18px 0 0;color:var(--muted);font-size:19px}.status{display:flex;flex-wrap:wrap;gap:8px;margin:24px 0 0}.chip{padding:7px 9px;border:1px solid var(--line);background:var(--white);font:11px var(--mono)}.chip.pending{background:#fff4cf;border-color:#dfc66c}.actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:24px}.button{display:inline-flex;min-height:44px;align-items:center;justify-content:center;padding:0 15px;border:1px solid var(--ink);background:var(--white);font:800 13px var(--sans);text-decoration:none;cursor:pointer}.button.primary{background:var(--ink);color:var(--white)}.button.signal{background:var(--signal);border-color:#adb62f}.section{padding:52px 0;border-top:1px solid var(--line)}.section-head{display:grid;grid-template-columns:minmax(220px,.58fr) minmax(0,1fr);gap:44px;margin-bottom:24px}.section h2{margin:0;font-size:clamp(28px,4vw,42px);line-height:1;letter-spacing:-.04em}.section-head p{max-width:620px;margin:0;color:var(--muted)}.answer{display:grid;grid-template-columns:repeat(3,1fr);border:1px solid var(--line);background:var(--line);gap:1px}.answer div{padding:18px;background:var(--white)}.answer span,.label{display:block;margin-bottom:5px;color:var(--muted);font:10px var(--mono);letter-spacing:.04em;text-transform:uppercase}.answer strong{font-size:14px}.flow{display:grid;grid-template-columns:repeat(5,1fr);gap:7px}.flow div{display:grid;min-height:68px;place-items:center;padding:10px;border:1px solid var(--line);background:var(--white);text-align:center;font:11px/1.35 var(--mono)}.flow div:nth-child(2){background:var(--signal);border-color:#b6bf35;font-weight:800}.field-list{display:flex;flex-wrap:wrap;gap:7px;margin:0;padding:0;list-style:none}.field-list li{padding:9px 11px;border:1px solid var(--line);background:var(--white);font:12px var(--mono)}.steps{margin:0;padding:0;list-style:none;border-top:1px solid var(--ink);counter-reset:step}.steps li{counter-increment:step;display:grid;grid-template-columns:42px minmax(0,1fr);gap:14px;padding:19px 0;border-bottom:1px solid var(--line)}.steps li:before{content:'0' counter(step);padding-top:3px;color:#697000;font:11px var(--mono)}.steps h3{margin:0 0 3px;font-size:17px}.steps p{margin:0;color:var(--muted)}.mapping{width:100%;border-collapse:collapse;background:var(--white)}.mapping th,.mapping td{padding:13px 14px;border:1px solid var(--line);text-align:left;vertical-align:top}.mapping th{font:10px var(--mono);text-transform:uppercase}.mapping td:first-child{font:12px var(--mono);white-space:nowrap}.tests{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}.test{padding:17px;border:1px solid var(--line);background:var(--white)}.test b{display:block;margin-bottom:5px}.test p{margin:0;color:var(--muted);font-size:13px}.check{margin:0;padding-left:20px}.check li{margin:9px 0}.technical{display:grid;grid-template-columns:1fr 1fr;gap:10px}.codebox{min-width:0;border:1px solid var(--line);background:#f1f3ed}.codebar{display:flex;justify-content:space-between;padding:9px 11px;border-bottom:1px solid var(--line);font:10px var(--mono)}.codebar button{border:0;background:var(--ink);color:#fff;padding:5px 8px;cursor:pointer}.codebox pre{overflow:auto;margin:0;padding:13px;font:11px/1.55 var(--mono);white-space:pre-wrap;word-break:break-word}.faq{margin:0}.faq div{padding:17px 0;border-top:1px solid var(--line)}.faq dt{font-weight:800}.faq dd{margin:4px 0 0;color:var(--muted)}.related{display:flex;flex-wrap:wrap;gap:8px}.related a{padding:10px 12px;border:1px solid var(--line);background:var(--white);font-weight:750;text-decoration:none}.footer{padding:42px 0 70px;border-top:1px solid var(--line);color:var(--muted);font-size:12px}.toast{position:fixed;right:18px;bottom:18px;padding:10px 13px;background:var(--ink);color:#fff;opacity:0;transform:translateY(8px);transition:.16s;pointer-events:none}.toast.show{opacity:1;transform:none}@media(max-width:760px){.hero{padding-top:38px}.section-head{grid-template-columns:1fr;gap:10px}.answer,.tests,.technical,.flow{grid-template-columns:1fr}.flow div{min-height:46px}.actions{display:grid}.button{width:100%}.mapping{display:block;overflow:auto}.steps li{grid-template-columns:32px minmax(0,1fr)}}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} | someonehastosayyes</title><meta name="description" content="${esc(item.description)} Build this approval workflow in ${esc(platform.label)} with exact steps, fields, callback handling, and tests."><link rel="canonical" href="${esc(canonical)}"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(item.description)}"><meta property="og:url" content="${esc(canonical)}"><meta property="og:type" content="article"><script type="application/ld+json">${jsonForHtml(schema)}</script><style>${css}</style></head><body><header class="shell nav"><a class="brand" href="/">someonehastosayyes</a><a class="back" href="/relay/templates">Back to templates</a></header><main><section class="shell hero"><p class="eyebrow">${esc(platform.label)} · ${esc(item.category)} · setup guide</p><h1>${esc(title)}</h1><p class="lead">${esc(item.description)}</p><div class="status"><span class="chip">${esc(platform.workload)}</span><span class="chip pending">First-pass QA complete · E2E pending</span></div><div class="actions"><a class="button primary" href="#build">Build in ${esc(platform.label)}</a>${platformId === "n8n" ? '<button class="button" id="download">Download n8n starter</button>' : `<button class="button" id="copy-build">Copy ${esc(platform.label)} checklist</button>`}<a class="button signal" href="/?tool=${esc(platformId)}&source=template-guide#request">Get an API key</a></div></section><section class="section"><div class="shell"><div class="section-head"><h2>Quick answer</h2><p>Add SHSY at the decision boundary. The workflow may prepare the action before approval, but it must not run the protected action until the verified decision is approved.</p></div><div class="answer"><div><span>Start after</span><strong>${esc(item.flow[0])}</strong></div><div><span>Pause before</span><strong>${esc(item.flow[4])}</strong></div><div><span>On reject or timeout</span><strong>Stop the action</strong></div></div></div></section><section class="section"><div class="shell"><div class="section-head"><h2>Workflow</h2><p>The approval request contains only what the approver needs to make this decision.</p></div><div class="flow">${item.flow.map((step) => `<div>${esc(step)}</div>`).join("")}</div></div></section><section class="section"><div class="shell"><div class="section-head"><h2>Show the approver</h2><p>Map these fields from your existing workflow. Links are better than copying large or sensitive records into the request.</p></div><ul class="field-list">${fields.map((field) => `<li>${esc(field)}</li>`).join("")}</ul></div></section><section class="section" id="build"><div class="shell"><div class="section-head"><h2>Build in ${esc(platform.label)}</h2><p>${esc(platform.workload)}. Store the key in ${esc(platform.credential)}.</p></div><ol class="steps">${steps.map(([name, text]) => `<li><div><h3>${esc(name)}</h3><p>${esc(text)}</p></div></li>`).join("")}</ol><div class="actions">${platformId === "n8n" ? '<button class="button primary" id="download-2">Download n8n starter</button>' : `<button class="button primary" id="copy-build-2">Copy ${esc(platform.label)} checklist</button>`}<a class="button" href="/?tool=${esc(platformId)}&source=template-guide#request">Get the SHSY key</a></div></div></section><section class="section"><div class="shell"><div class="section-head"><h2>Request fields</h2><p>Use these exact SHSY fields. Map platform field paths only after ${esc(platform.capture)} contains a real callback.</p></div><table class="mapping"><thead><tr><th>Field</th><th>What to map</th><th>Why</th></tr></thead><tbody><tr><td>question</td><td>One decision in plain language</td><td>What the approver sees first</td></tr><tr><td>context.action</td><td>${esc(item.protected)}</td><td>Stable action identifier</td></tr><tr><td>context.details</td><td>${esc(fields.join(", "))}</td><td>Evidence needed to decide</td></tr><tr><td>to</td><td>Approver email</td><td>Who owns the decision</td></tr><tr><td>callback_url</td><td>Private ${esc(platform.label)} callback URL</td><td>Where SHSY sends the result</td></tr><tr><td>timeout_minutes</td><td>1 for QA, ${esc(item.timeout.replace(" minutes, then reject", ""))} for this production example</td><td>How long the request stays open</td></tr><tr><td>default_on_timeout</td><td>rejected</td><td>Safe default when nobody answers</td></tr></tbody></table></div></section><section class="section"><div class="shell"><div class="section-head"><h2>Test before connecting</h2><p>Use a harmless test record. Keep ${esc(item.connect)} disconnected until all three cases pass.</p></div><div class="tests"><div class="test"><b>Approve</b><p>Authenticated GET returns approved = true. Only this path may reach ${esc(item.flow[4].toLowerCase())}.</p></div><div class="test"><b>Reject</b><p>The protected action does not run. Keep the decision for audit or notify the workflow owner.</p></div><div class="test"><b>No answer</b><p>Use timeout_minutes: 1. The request expires and follows the rejected path.</p></div></div></div></section><section class="section"><div class="shell"><div class="section-head"><h2>Go-live check</h2><p>The workflow is ready only after these checks pass in the connected account.</p></div><ul class="check"><li>The SHSY key is stored in ${esc(platform.credential)}, not in shared workflow text.</li><li>The callback URL is private and was populated from a real callback sample.</li><li>The workflow authenticates GET /v1/approvals/{id} before branching.</li><li>Only approved = true reaches ${esc(item.connect)}.</li><li>Reject and timeout leave the protected action untouched.</li></ul></div></section><section class="section"><div class="shell"><div class="section-head"><h2>Technical reference</h2><p>The callback is a notification. Use its id to retrieve the final decision with your SHSY credential.</p></div><div class="technical"><div class="codebox"><div class="codebar"><span>POST /v1/approvals</span><button data-copy="request">Copy</button></div><pre id="request-code">Authorization: Bearer $SHSY_API_KEY\nIdempotency-Key: &lt;unique run id&gt;\nContent-Type: application/json\n\n${esc(JSON.stringify(requestBody, null, 2))}</pre></div><div class="codebox"><div class="codebar"><span>CALLBACK BODY</span><button data-copy="callback">Copy</button></div><pre id="callback-code">${esc(JSON.stringify(callbackBody, null, 2))}\n\nHeaders:\nx-approval-signature\nx-approval-key-id\nx-approval-id</pre></div></div></div></section><section class="section"><div class="shell"><div class="section-head"><h2>Common questions</h2><p>Short answers for building and reviewing this workflow.</p></div><dl class="faq">${faq.map(([q, a]) => `<div><dt>${esc(q)}</dt><dd>${esc(a)}</dd></div>`).join("")}</dl>${relatedPlatforms ? `<div class="related">${relatedPlatforms}</div>` : ""}</div></section></main><footer class="footer"><div class="shell">someonehastosayyes · approval infrastructure for automated actions</div></footer><div class="toast" id="toast" role="status" aria-live="polite">Copied</div><script>const copyText=${jsonForHtml(checklist)};const workflow=${platformId === "n8n" ? jsonForHtml(n8nWorkflow(item)) : "null"};function notify(message){const toast=document.getElementById('toast');toast.textContent=message;toast.classList.add('show');setTimeout(()=>toast.classList.remove('show'),1300)}async function copy(value){await navigator.clipboard.writeText(value);notify('Copied')}document.querySelectorAll('#copy-build,#copy-build-2').forEach(button=>button.addEventListener('click',()=>copy(copyText)));document.querySelectorAll('[data-copy=request]').forEach(button=>button.addEventListener('click',()=>copy(document.getElementById('request-code').innerText)));document.querySelectorAll('[data-copy=callback]').forEach(button=>button.addEventListener('click',()=>copy(document.getElementById('callback-code').innerText)));function download(){const url=URL.createObjectURL(new Blob([JSON.stringify(workflow,null,2)+'\\n'],{type:'application/json'}));const link=document.createElement('a');link.href=url;link.download='n8n-${esc(item.id)}-approval-starter.json';document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);notify('Starter downloaded')}document.querySelectorAll('#download,#download-2').forEach(button=>button.addEventListener('click',download));</script></body></html>`;
}

module.exports = { catalog, renderGuide };
