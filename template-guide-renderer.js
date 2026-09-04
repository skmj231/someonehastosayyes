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

const WHY_IT_MATTERS = {
  "zapier-winston-content": "A clean AI score is not the same as editorial approval. Let Winston flag risk, then let an editor decide whether the article should represent your company.",
  "ai-email": "An AI draft can sound confident while using the wrong customer detail or promise. Review the final message before it reaches the customer.",
  refund: "A refund is easy to automate and difficult to undo. Confirm the amount, reason, and order before money moves.",
  "content-publish": "A draft can be corrected. A published mistake can be indexed, shared, and attributed to your company before anyone notices.",
  "crm-bulk-change": "One incorrect filter can rewrite thousands of customer records. Confirm the operation and record count before the update starts.",
  "pipeline-digest": "Leaders act on the numbers they receive. Check stale deals, owners, and totals before an automated digest shapes the next decision.",
  "meeting-followup": "A recap becomes the shared memory of the meeting. Confirm commitments and owners before attendees receive it.",
  "sales-quote": "A wrong discount or term becomes a customer expectation. Review the commercial details before the quote leaves your company.",
  "candidate-progress": "AI screening can assist a recruiter but should not quietly change a person's opportunity. Let the recruiter make the stage decision.",
  "account-provisioning": "Access mistakes often survive long after onboarding. Confirm the role, systems, and permission level before any employee account is created.",
  "order-fulfillment": "Once an order leaves the warehouse, fixing the destination or items becomes expensive. Check the order before release.",
  "payment-receipt": "A receipt is a financial record sent to a customer. Confirm the payment, recipient, and invoice before sending it.",
  "performance-review": "An AI-generated review can influence compensation and careers. Keep the draft private until the manager owns the final wording.",
  "reddit-outreach": "Public outreach without context can look intrusive and damage trust. Review the thread and message before contacting the person.",
  "lead-qualification": "A score can route the wrong person or waste a sales rep's attention. Confirm the evidence before creating the lead.",
  "support-response": "A fast but incorrect answer creates a second support problem. Check the diagnosis, facts, and tone before replying.",
  "health-escalation": "Automated risk signals can be noisy. Let the account owner confirm the evidence before escalating the customer.",
  "email-triage": "Classification is reversible; replying, archiving, or creating work may not be. Confirm the proposed action before it runs.",
  "ticket-backlog-digest": "A digest changes staffing and priority decisions. Check SLA breaches and workload numbers before posting it.",
  "review-reply": "A public reply represents the business indefinitely. Confirm the facts and tone before it appears under the review.",
  "action-items": "Incorrect owners and due dates create silent work debt. Confirm the task list before it is added to everyone's system.",
  "order-calendar": "A wrong date can block capacity or trigger missed delivery expectations. Confirm the order details before creating the event.",
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

function minimalSteps(item, platform) {
  if (item.id === "zapier-winston-content") return [
    ["Check the draft", "In your existing Zap, run the Winston AI and plagiarism checks when an article is ready.", "The Zap has a draft URL and both review scores."],
    ["Send the approval request", "Add API by Zapier → API Request and set Method to POST. Send the title, draft URL, scores, approver email, and your private Catch Hook URL to https://someonehastosayyes.com/v1/approvals.", "The approver receives an email and the step returns an approval id."],
    ["Verify the decision", "Approve one test request and test the Catch Hook. Add API by Zapier → API Request, set Method to GET, and use the captured id. Add Filter by Zapier: approved is true.", "Approved passes the Filter; rejected does not."],
    ["Connect publishing", "Place the CMS publish action after the Filter. Test approve, reject, and timeout_minutes: 1 before using a live article.", "Only an approved request publishes the article."],
  ];
  if (platform === "n8n") return [
    ["Import the starter", "Import the JSON, add an HTTP Header Auth credential, and replace the Manual Trigger with your own trigger.", "The workflow runs with a harmless test record."],
    ["Send the approval request", `Map the approver email and the review details shown below. Keep ${item.connect} disconnected.`, "The approver receives an email and n8n receives an approval id."],
    ["Verify the decision", "Approve one test request, capture the callback, map its id into the disabled GET node, and enable that node.", "The verified GET response contains approved = true."],
    ["Connect the final action", `Test approve, reject, and timeout_minutes: 1. Then connect ${item.connect} only to approved = true.`, "Only approval reaches the protected action."],
  ];
  if (platform === "make") return [
    ["Create the callback scenario", "In a new scenario, add Webhooks → Custom webhook. Copy its private URL and select Run once.", "Make is waiting for one sample callback."],
    ["Send the approval request", `In your existing scenario, add HTTP v4 → Make a request. POST the approver email, callback URL, and review details to https://someonehastosayyes.com/v1/approvals. Keep ${item.connect} disconnected.`, "The approver receives an email and the module returns an approval id."],
    ["Verify the decision", "Approve one test request to capture the webhook bundle. Use its id in an authenticated GET request, then add a route filter: approved is true.", "Approved follows the route; rejected does not."],
    ["Connect the final action", `Place ${item.connect} after the approved route. Test approve, reject, and timeout_minutes: 1 before using live data.`, "Only approval reaches the protected action."],
  ];
  return [
    ["Create the callback Zap", "Create a new Zap with Webhooks by Zapier → Catch Hook. Copy the URL Zapier gives you. Do this first because your existing Zap needs that URL.", "You have one private Catch Hook URL."],
    ["Send the approval request", `In your existing Zap, add API by Zapier → API Request and set Method to POST. Use https://someonehastosayyes.com/v1/approvals and map the approver email, callback_url, and the review details below. Keep ${item.connect} disconnected.`, "The approver receives an email and the step returns an approval id."],
    ["Verify the decision", "Approve one test request and test the Catch Hook. Add API by Zapier → API Request, set Method to GET, and use https://someonehastosayyes.com/v1/approvals/{id} with id from the captured sample. Add Filter by Zapier: approved is true.", "Approved passes the Filter; rejected does not."],
    ["Connect the final action", `Place ${item.connect} after the Filter. Test approve, reject, and timeout_minutes: 1 before using live data.`, "Only approval reaches the protected action."],
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
  const css = `:root{--ink:#171914;--muted:#666b62;--line:#dfe2da;--paper:#f7f8f4;--white:#fff;--signal:#e5ed4d;--soft:#f0f2eb;--mono:ui-monospace,SFMono-Regular,Menlo,monospace;--sans:Inter,ui-sans-serif,system-ui,sans-serif}*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.55 var(--sans)}a{color:inherit}.shell{width:min(940px,calc(100% - 40px));margin:auto}.nav{height:68px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line)}.brand{font-weight:850;text-decoration:none}.back{color:var(--muted);font-size:13px;text-decoration:none}.hero{padding:54px 0 42px}.eyebrow{margin:0 0 13px;color:#697000;font:11px var(--mono);letter-spacing:.055em;text-transform:uppercase}.hero h1{max-width:860px;margin:0;font-size:clamp(40px,6vw,66px);font-weight:680;line-height:.98;letter-spacing:-.052em}.lead{max-width:700px;margin:18px 0 0;color:var(--muted);font-size:19px}.status{display:flex;flex-wrap:wrap;gap:0;margin:22px 0 0;color:var(--muted);font:11px var(--mono)}.chip{padding:0}.chip+.chip:before{content:'·';margin:0 9px;color:#a2a69d}.chip.pending{color:#806b00}.actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:24px}.button{display:inline-flex;min-height:44px;align-items:center;justify-content:center;padding:0 15px;border:1px solid var(--ink);background:var(--white);font:800 13px var(--sans);text-decoration:none;cursor:pointer}.button.primary{background:var(--ink);color:var(--white)}.button.signal{background:var(--signal);border-color:#adb62f}.section{padding:46px 0}.section-head{display:grid;grid-template-columns:minmax(220px,.58fr) minmax(0,1fr);gap:44px;margin-bottom:24px}.section h2{margin:0;font-size:clamp(28px,4vw,42px);line-height:1;letter-spacing:-.04em}.section-head p{max-width:620px;margin:0;color:var(--muted)}.answer{display:grid;grid-template-columns:repeat(3,1fr);gap:34px}.answer div{padding:0 0 0 14px;border-left:2px solid var(--line)}.answer div:nth-child(2){border-color:var(--signal)}.answer span,.label{display:block;margin-bottom:5px;color:var(--muted);font:10px var(--mono);letter-spacing:.04em;text-transform:uppercase}.answer strong{font-size:14px}.flow{display:flex;align-items:center;gap:15px;overflow:auto;padding:8px 0}.flow-node{display:grid;gap:3px;min-width:max-content}.flow-index{color:#989d94;font:9px var(--mono)}.flow-node strong{font:750 13px var(--sans)}.flow-node.approval strong{background:linear-gradient(transparent 55%,var(--signal) 55%)}.flow-arrow{color:#949990;font-size:22px;line-height:1}.field-list{display:flex;flex-wrap:wrap;gap:8px 24px;margin:0;padding:0;list-style:none}.field-list li{padding:0;font:12px var(--mono)}.field-list li:before{content:'•';margin-right:8px;color:#879000}.steps{margin:0;padding:0;list-style:none;border-top:1px solid var(--ink);counter-reset:step}.steps li{counter-increment:step;display:grid;grid-template-columns:42px minmax(0,1fr);gap:14px;padding:19px 0;border-bottom:1px solid var(--line)}.steps li:before{content:'0' counter(step);padding-top:3px;color:#697000;font:11px var(--mono)}.steps h3{margin:0 0 3px;font-size:17px}.steps p{margin:0;color:var(--muted)}.mapping{width:100%;border-collapse:collapse;background:transparent}.mapping th,.mapping td{padding:13px 4px;border:0;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}.mapping th{font:10px var(--mono);text-transform:uppercase}.mapping td:first-child{font:12px var(--mono);white-space:nowrap}.tests{display:grid;grid-template-columns:repeat(3,1fr);gap:34px}.test{padding:0 0 0 14px;border-left:2px solid var(--line)}.test b{display:block;margin-bottom:5px}.test p{margin:0;color:var(--muted);font-size:13px}.check{margin:0;padding-left:20px}.check li{margin:9px 0}.technical{display:grid;grid-template-columns:1fr 1fr;gap:10px}.codebox{min-width:0;border:1px solid var(--line);background:#f1f3ed}.codebar{display:flex;justify-content:space-between;padding:9px 11px;border-bottom:1px solid var(--line);font:10px var(--mono)}.codebar button{border:0;background:var(--ink);color:#fff;padding:5px 8px;cursor:pointer}.codebox pre{overflow:auto;margin:0;padding:13px;font:11px/1.55 var(--mono);white-space:pre-wrap;word-break:break-word}.faq{margin:0}.faq div{padding:17px 0;border-top:1px solid var(--line)}.faq dt{font-weight:800}.faq dd{margin:4px 0 0;color:var(--muted)}.related{display:flex;flex-wrap:wrap;gap:18px;margin-top:22px}.related a{padding:0;font-weight:750;text-underline-offset:3px}.footer{padding:42px 0 70px;color:var(--muted);font-size:12px}.toast{position:fixed;right:18px;bottom:18px;padding:10px 13px;background:var(--ink);color:#fff;opacity:0;transform:translateY(8px);transition:.16s;pointer-events:none}.toast.show{opacity:1;transform:none}@media(max-width:760px){.hero{padding-top:38px}.section-head{grid-template-columns:1fr;gap:10px}.answer,.tests,.technical{grid-template-columns:1fr;gap:20px}.flow{align-items:flex-start;flex-direction:column;gap:7px}.flow-arrow{margin-left:8px;transform:rotate(90deg)}.actions{display:grid}.button{width:100%}.mapping{display:block;overflow:auto}.steps li{grid-template-columns:32px minmax(0,1fr)}}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} | someonehastosayyes</title><meta name="description" content="${esc(item.description)} Build this approval workflow in ${esc(platform.label)} with exact steps, fields, callback handling, and tests."><link rel="canonical" href="${esc(canonical)}"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(item.description)}"><meta property="og:url" content="${esc(canonical)}"><meta property="og:type" content="article"><script type="application/ld+json">${jsonForHtml(schema)}</script><style>${css}</style></head><body><header class="shell nav"><a class="brand" href="/">someonehastosayyes</a><a class="back" href="/relay/templates">Back to templates</a></header><main><section class="shell hero"><p class="eyebrow">${esc(platform.label)} · ${esc(item.category)} · setup guide</p><h1>${esc(title)}</h1><p class="lead">${esc(item.description)}</p><div class="status"><span class="chip">${esc(platform.workload)}</span><span class="chip pending">First-pass QA complete · E2E pending</span></div><div class="actions"><a class="button primary" href="#build">View setup steps</a><a class="button signal" href="/?tool=${esc(platformId)}&source=template-guide#request">Get SHSY API key</a></div></section><section class="section"><div class="shell"><div class="section-head"><h2>Quick answer</h2><p>Add SHSY at the decision boundary. The workflow may prepare the action before approval, but it must not run the protected action until the verified decision is approved.</p></div><div class="answer"><div><span>Start after</span><strong>${esc(item.flow[0])}</strong></div><div><span>Pause before</span><strong>${esc(item.flow[4])}</strong></div><div><span>On reject or timeout</span><strong>Stop the action</strong></div></div></div></section><section class="section"><div class="shell"><div class="section-head"><h2>Workflow</h2><p>The approval request contains only what the approver needs to make this decision.</p></div><div class="flow">${item.flow.map((step, index) => `<div class="flow-node ${index === 1 ? "approval" : ""}"><span class="flow-index">0${index + 1}</span><strong>${esc(step)}</strong></div>${index < item.flow.length - 1 ? '<span class="flow-arrow" aria-hidden="true">→</span>' : ""}`).join("")}</div></div></section><section class="section"><div class="shell"><div class="section-head"><h2>Show the approver</h2><p>Map these fields from your existing workflow. Links are better than copying large or sensitive records into the request.</p></div><ul class="field-list">${fields.map((field) => `<li>${esc(field)}</li>`).join("")}</ul></div></section><section class="section" id="build"><div class="shell"><div class="section-head"><h2>Build in ${esc(platform.label)}</h2><p>${esc(platform.workload)}. Store the key in ${esc(platform.credential)}.</p></div><ol class="steps">${steps.map(([name, text]) => `<li><div><h3>${esc(name)}</h3><p>${esc(text)}</p></div></li>`).join("")}</ol><div class="actions">${platformId === "n8n" ? '<button class="button primary" id="download">Download n8n starter</button>' : `<button class="button primary" id="copy-build">Copy ${esc(platform.label)} setup steps</button>`}</div></div></section><section class="section"><div class="shell"><div class="section-head"><h2>Request fields</h2><p>Use these exact SHSY fields. Map platform field paths only after ${esc(platform.capture)} contains a real callback.</p></div><table class="mapping"><thead><tr><th>Field</th><th>What to map</th><th>Why</th></tr></thead><tbody><tr><td>question</td><td>One decision in plain language</td><td>What the approver sees first</td></tr><tr><td>context.action</td><td>${esc(item.protected)}</td><td>Stable action identifier</td></tr><tr><td>context.details</td><td>${esc(fields.join(", "))}</td><td>Evidence needed to decide</td></tr><tr><td>to</td><td>Approver email</td><td>Who owns the decision</td></tr><tr><td>callback_url</td><td>Private ${esc(platform.label)} callback URL</td><td>Where SHSY sends the result</td></tr><tr><td>timeout_minutes</td><td>1 for QA, ${esc(item.timeout.replace(" minutes, then reject", ""))} for this production example</td><td>How long the request stays open</td></tr><tr><td>default_on_timeout</td><td>rejected</td><td>Safe default when nobody answers</td></tr></tbody></table></div></section><section class="section"><div class="shell"><div class="section-head"><h2>Test before connecting</h2><p>Use a harmless test record. Keep ${esc(item.connect)} disconnected until all three cases pass.</p></div><div class="tests"><div class="test"><b>Approve</b><p>Authenticated GET returns approved = true. Only this path may reach ${esc(item.flow[4].toLowerCase())}.</p></div><div class="test"><b>Reject</b><p>The protected action does not run. Keep the decision for audit or notify the workflow owner.</p></div><div class="test"><b>No answer</b><p>Use timeout_minutes: 1. The request expires and follows the rejected path.</p></div></div></div></section><section class="section"><div class="shell"><div class="section-head"><h2>Go-live check</h2><p>The workflow is ready only after these checks pass in the connected account.</p></div><ul class="check"><li>The SHSY key is stored in ${esc(platform.credential)}, not in shared workflow text.</li><li>The callback URL is private and was populated from a real callback sample.</li><li>The workflow authenticates GET /v1/approvals/{id} before branching.</li><li>Only approved = true reaches ${esc(item.connect)}.</li><li>Reject and timeout leave the protected action untouched.</li></ul></div></section><section class="section"><div class="shell"><div class="section-head"><h2>Technical reference</h2><p>The callback is a notification. Use its id to retrieve the final decision with your SHSY credential.</p></div><div class="technical"><div class="codebox"><div class="codebar"><span>POST /v1/approvals</span><button data-copy="request">Copy</button></div><pre id="request-code">Authorization: Bearer $SHSY_API_KEY\nIdempotency-Key: &lt;unique run id&gt;\nContent-Type: application/json\n\n${esc(JSON.stringify(requestBody, null, 2))}</pre></div><div class="codebox"><div class="codebar"><span>CALLBACK BODY</span><button data-copy="callback">Copy</button></div><pre id="callback-code">${esc(JSON.stringify(callbackBody, null, 2))}\n\nHeaders:\nx-approval-signature\nx-approval-key-id\nx-approval-id</pre></div></div></div></section><section class="section"><div class="shell"><div class="section-head"><h2>Common questions</h2><p>Short answers for building and reviewing this workflow.</p></div><dl class="faq">${faq.map(([q, a]) => `<div><dt>${esc(q)}</dt><dd>${esc(a)}</dd></div>`).join("")}</dl>${relatedPlatforms ? `<div class="related">${relatedPlatforms}</div>` : ""}</div></section></main><footer class="footer"><div class="shell">someonehastosayyes · approval infrastructure for automated actions</div></footer><div class="toast" id="toast" role="status" aria-live="polite">Copied</div><script>const copyText=${jsonForHtml(checklist)};const workflow=${platformId === "n8n" ? jsonForHtml(n8nWorkflow(item)) : "null"};function notify(message){const toast=document.getElementById('toast');toast.textContent=message;toast.classList.add('show');setTimeout(()=>toast.classList.remove('show'),1300)}async function copy(value){await navigator.clipboard.writeText(value);notify('Copied')}document.querySelectorAll('#copy-build').forEach(button=>button.addEventListener('click',()=>copy(copyText)));document.querySelectorAll('[data-copy=request]').forEach(button=>button.addEventListener('click',()=>copy(document.getElementById('request-code').innerText)));document.querySelectorAll('[data-copy=callback]').forEach(button=>button.addEventListener('click',()=>copy(document.getElementById('callback-code').innerText)));function download(){const url=URL.createObjectURL(new Blob([JSON.stringify(workflow,null,2)+'\\n'],{type:'application/json'}));const link=document.createElement('a');link.href=url;link.download='n8n-${esc(item.id)}-approval-starter.json';document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);notify('Starter downloaded')}document.querySelectorAll('#download').forEach(button=>button.addEventListener('click',download));</script></body></html>`;
}

function renderGuideV2({ templateId, requestedPlatform, baseUrl }) {
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
  const noCodeAnswer = {
    n8n: `This guide does not use an n8n Code node. You import one starter and configure the credential, callback mapping, verification request, and final action.`,
    make: `This guide does not use a custom code module. You configure two scenarios, a webhook, two HTTP requests, and one router filter.`,
    zapier: `This guide does not use a custom code step. You configure two Zaps, a Catch Hook, two API requests, and one Filter.`,
  }[platformId];
  const faq = [
    [`Where does the approval go?`, `After ${item.flow[0].toLowerCase()} and before ${item.flow[4].toLowerCase()}.`],
    [`Do I need to write code?`, noCodeAnswer],
    [`Does this require Slack?`, `No. This guide uses email approval. Slack is optional and is not required for the callback.`],
    [`Can I trust the callback by itself?`, `No. Capture its id, then authenticate GET /v1/approvals/{id} and branch on that verified response.`],
    [`Has this passed account-connected E2E testing?`, `Not yet. The structure has passed first-pass QA. This page will say E2E verified only after a real account test passes.`],
  ];
  const relatedPlatforms = supported.filter((id) => id !== platformId).map((id) => `<a href="${esc(item.guide || `/templates/${item.id}`)}?platform=${id}">${esc(PLATFORM[id].label)} version</a>`).join("");
  const css = `
    :root{--ink:#171914;--muted:#696e65;--line:#dfe2da;--paper:#f7f8f4;--white:#fff;--signal:#e5ed4d;--mono:ui-monospace,SFMono-Regular,Menlo,monospace;--sans:Inter,ui-sans-serif,system-ui,sans-serif}
    *{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.6 var(--sans)}a{color:inherit}.shell{width:min(820px,calc(100% - 40px));margin:auto}.wide{width:min(980px,calc(100% - 40px));margin:auto}
    .nav{height:66px;display:flex;align-items:center;justify-content:space-between}.brand{font-weight:850;text-decoration:none}.back{color:var(--muted);font-size:13px;text-decoration:none}
    .hero{padding:68px 0 74px}.eyebrow,.section-index{color:#6d7500;font:10px var(--mono);letter-spacing:.07em;text-transform:uppercase}.eyebrow{margin:0 0 15px}.hero h1{max-width:800px;margin:0;font-size:clamp(42px,6vw,66px);font-weight:680;line-height:.98;letter-spacing:-.052em}.lead{max-width:650px;margin:19px 0 0;color:var(--muted);font-size:19px}.meta{margin-top:22px;color:var(--muted);font:11px/1.6 var(--mono)}.meta span+span:before{content:'·';margin:0 9px;color:#a6aaa1}.pending{color:#806b00}.actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:25px}.button{display:inline-flex;min-height:44px;align-items:center;justify-content:center;padding:0 15px;border:1px solid var(--ink);background:transparent;font:800 13px var(--sans);text-decoration:none;cursor:pointer}.button.primary{background:var(--ink);color:#fff}.button.signal{background:var(--signal);border-color:#aeb72f}
    .section{padding:64px 0}.section-index{display:block;margin-bottom:11px}.section h2{margin:0;font-size:clamp(30px,4vw,42px);line-height:1.04;letter-spacing:-.042em}.intro{max-width:650px;margin:13px 0 0;color:var(--muted);font-size:16px}.decision{margin:28px 0 0;font-size:18px}.decision strong{background:linear-gradient(transparent 58%,var(--signal) 58%)}.safe-stop{margin:15px 0 0;color:var(--muted);font-size:13px}
    .flow{display:flex;align-items:center;gap:15px;margin-top:34px;overflow:auto;padding:5px 0}.flow-node{display:grid;gap:3px;min-width:max-content}.flow-index{color:#989d94;font:9px var(--mono)}.flow-node strong{font:750 13px var(--sans)}.flow-node.approval strong{background:linear-gradient(transparent 55%,var(--signal) 55%)}.flow-arrow{color:#949990;font-size:22px;line-height:1}
    .workload{display:grid;grid-template-columns:150px minmax(0,1fr);gap:8px 24px;margin:27px 0 30px;padding:0}.workload dt{color:var(--muted);font:10px var(--mono);text-transform:uppercase}.workload dd{margin:0}
    .steps{margin:0;padding:0;list-style:none;counter-reset:step}.steps li{counter-increment:step;display:grid;grid-template-columns:38px minmax(0,1fr);gap:15px;padding:19px 0;border-top:1px solid var(--line)}.steps li:before{content:'0' counter(step);padding-top:3px;color:#7c8378;font:10px var(--mono)}.steps h3{margin:0 0 3px;font-size:17px}.steps p{margin:0;color:var(--muted)}
    .review-fields{margin:27px 0 0;font-size:16px;line-height:1.9}.review-fields b{font-weight:760}.review-fields span:not(:last-child):after{content:' · ';color:#a2a69d}
    .mapping{width:100%;margin-top:30px;border-collapse:collapse}.mapping th,.mapping td{padding:13px 4px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}.mapping th{color:var(--muted);font:10px var(--mono);text-transform:uppercase}.mapping td:first-child{font:12px var(--mono);white-space:nowrap}
    .tests{margin-top:28px}.test{display:grid;grid-template-columns:110px minmax(0,1fr);gap:18px;padding:15px 0;border-top:1px solid var(--line)}.test b{display:flex;align-items:center;gap:9px}.test b:before{width:7px;height:7px;border-radius:50%;background:#9da199;content:''}.test.approve b:before{background:#43a047}.test.reject b:before{background:#d94b3d}.test p{margin:0;color:var(--muted)}.check{margin:31px 0 0;padding:0;list-style:none}.check li{position:relative;margin:11px 0;padding-left:23px}.check li:before{position:absolute;left:0;color:#6d7500;content:'✓';font-weight:900}
    .details{margin-top:28px;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}.details summary{padding:17px 0;font-weight:800;cursor:pointer}.technical{display:grid;grid-template-columns:1fr 1fr;gap:10px;padding:0 0 18px}.codebox{min-width:0;background:#eef0ea}.codebar{display:flex;justify-content:space-between;padding:9px 11px;font:10px var(--mono)}.codebar button{border:0;background:var(--ink);color:#fff;padding:5px 8px;cursor:pointer}.codebox pre{overflow:auto;margin:0;padding:13px;font:11px/1.55 var(--mono);white-space:pre-wrap;word-break:break-word}
    .faq{margin:27px 0 0}.faq div{padding:17px 0;border-top:1px solid var(--line)}.faq dt{font-weight:800}.faq dd{margin:4px 0 0;color:var(--muted)}.related{display:flex;flex-wrap:wrap;gap:18px;margin-top:23px}.related a{font-weight:750;text-underline-offset:3px}.footer{padding:48px 0 70px;color:var(--muted);font-size:12px}.toast{position:fixed;right:18px;bottom:18px;padding:10px 13px;background:var(--ink);color:#fff;opacity:0;transform:translateY(8px);transition:.16s;pointer-events:none}.toast.show{opacity:1;transform:none}
    @media(max-width:760px){.hero{padding:46px 0 56px}.section{padding:50px 0}.meta span{display:block}.meta span+span:before{content:'';margin:0}.actions{display:grid}.button{width:100%}.flow{align-items:flex-start;flex-direction:column;gap:7px}.flow-arrow{margin-left:8px;transform:rotate(90deg)}.workload{grid-template-columns:1fr;gap:2px}.workload dd{margin-bottom:12px}.mapping{display:block;overflow:auto}.test{grid-template-columns:1fr;gap:4px}.technical{grid-template-columns:1fr}}
  `;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} | someonehastosayyes</title>
<meta name="description" content="${esc(item.description)} Build this approval workflow in ${esc(platform.label)} with exact steps, fields, callback handling, and tests.">
<link rel="canonical" href="${esc(canonical)}"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(item.description)}"><meta property="og:url" content="${esc(canonical)}"><meta property="og:type" content="article">
<script type="application/ld+json">${jsonForHtml(schema)}</script><style>${css}</style></head>
<body><header class="wide nav"><a class="brand" href="/">someonehastosayyes</a><a class="back" href="/relay/templates">Back to templates</a></header>
<main><section class="shell hero"><p class="eyebrow">${esc(platform.label)} · ${esc(item.category)} · setup guide</p><h1>${esc(title)}</h1><p class="lead">${esc(item.description)}</p><p class="meta"><span>${esc(platform.workload)}</span><span class="pending">First-pass QA complete · E2E pending</span></p><div class="actions"><a class="button primary" href="#build">View setup steps</a><a class="button signal" href="/?tool=${esc(platformId)}&source=template-guide#request">Get SHSY API key</a></div></section>

<section class="section" id="placement"><div class="shell"><span class="section-index">01 · Placement</span><h2>Where approval goes</h2><p class="intro">Let the automation prepare the work. Pause immediately before the action that affects a customer, account, payment, or published record.</p><p class="decision">For this template, add approval after <strong>${esc(item.flow[0])}</strong> and before <strong>${esc(item.flow[4])}</strong>.</p><div class="flow">${item.flow.map((step, index) => `<div class="flow-node ${index === 1 ? "approval" : ""}"><span class="flow-index">0${index + 1}</span><strong>${esc(step)}</strong></div>${index < item.flow.length - 1 ? '<span class="flow-arrow" aria-hidden="true">→</span>' : ""}`).join("")}</div><p class="safe-stop">If the request is rejected or nobody answers, stop before ${esc(item.flow[4].toLowerCase())}.</p></div></section>

<section class="section" id="build"><div class="shell"><span class="section-index">02 · Setup</span><h2>Build it in ${esc(platform.label)}</h2><p class="intro">Use your existing trigger and destination app. Add only the approval request, callback, verification, and approved route.</p><dl class="workload"><dt>You will build</dt><dd>${esc(platform.workload)}</dd><dt>Store the key in</dt><dd>${esc(platform.credential)}</dd><dt>Keep disconnected</dt><dd>${esc(item.connect)}</dd></dl><ol class="steps">${steps.map(([name, text]) => `<li><div><h3>${esc(name)}</h3><p>${esc(text)}</p></div></li>`).join("")}</ol><div class="actions">${platformId === "n8n" ? '<button class="button primary" id="download">Download n8n starter</button>' : `<button class="button primary" id="copy-build">Copy ${esc(platform.label)} setup steps</button>`}</div></div></section>

<section class="section" id="mapping"><div class="shell"><span class="section-index">03 · Mapping</span><h2>Send enough context to decide</h2><p class="intro">The approver should understand the action without opening five other tools. Send only the necessary facts and use links for full records.</p><p class="review-fields"><b>For this template:</b> ${fields.map((field) => `<span>${esc(field)}</span>`).join("")}</p><table class="mapping"><thead><tr><th>SHSY field</th><th>What to map</th></tr></thead><tbody><tr><td>question</td><td>One decision in plain language</td></tr><tr><td>context.action</td><td>${esc(item.protected)}</td></tr><tr><td>context.details</td><td>${esc(fields.join(", "))}</td></tr><tr><td>to</td><td>The email of the person who owns this decision</td></tr><tr><td>callback_url</td><td>Your private ${esc(platform.label)} callback URL</td></tr><tr><td>timeout_minutes</td><td>1 while testing, then ${esc(item.timeout.replace(" minutes, then reject", ""))} for this example</td></tr><tr><td>default_on_timeout</td><td>rejected</td></tr></tbody></table></div></section>

<section class="section" id="testing"><div class="shell"><span class="section-index">04 · Verification</span><h2>Test it, then turn it on</h2><p class="intro">Use one harmless record. Do not connect ${esc(item.connect)} until every result follows the expected path.</p><div class="tests"><div class="test approve"><b>Approve</b><p>Authenticated GET returns approved = true. Only this result may reach ${esc(item.flow[4].toLowerCase())}.</p></div><div class="test reject"><b>Reject</b><p>The protected action does not run. Keep the result for audit or notify the workflow owner.</p></div><div class="test"><b>No answer</b><p>Set timeout_minutes to 1. The request expires and follows the rejected path.</p></div></div><ul class="check"><li>The SHSY key is stored in ${esc(platform.credential)}.</li><li>The callback mapping comes from a real sample captured in ${esc(platform.capture)}.</li><li>The workflow authenticates GET /v1/approvals/{id} before branching.</li><li>Only approved = true reaches ${esc(item.connect)}.</li><li>Reject and timeout leave the protected action untouched.</li></ul></div></section>

<section class="section" id="reference"><div class="shell"><span class="section-index">05 · Reference</span><h2>Exact request and response</h2><p class="intro">You do not need this section to understand the workflow. Use it when configuring HTTP fields or checking a callback.</p><details class="details"><summary>Open technical reference</summary><div class="technical"><div class="codebox"><div class="codebar"><span>POST /v1/approvals</span><button data-copy="request">Copy</button></div><pre id="request-code">Authorization: Bearer $SHSY_API_KEY\nIdempotency-Key: &lt;unique run id&gt;\nContent-Type: application/json\n\n${esc(JSON.stringify(requestBody, null, 2))}</pre></div><div class="codebox"><div class="codebar"><span>CALLBACK BODY</span><button data-copy="callback">Copy</button></div><pre id="callback-code">${esc(JSON.stringify(callbackBody, null, 2))}\n\nHeaders:\nx-approval-signature\nx-approval-key-id\nx-approval-id</pre></div></div></details></div></section>

<section class="section"><div class="shell"><span class="section-index">06 · Questions</span><h2>Common questions</h2><dl class="faq">${faq.map(([question, answer]) => `<div><dt>${esc(question)}</dt><dd>${esc(answer)}</dd></div>`).join("")}</dl>${relatedPlatforms ? `<div class="related">${relatedPlatforms}</div>` : ""}</div></section></main>
<footer class="footer"><div class="wide">someonehastosayyes · approval infrastructure for automated actions</div></footer><div class="toast" id="toast" role="status" aria-live="polite">Copied</div>
<script>const copyText=${jsonForHtml(checklist)};const workflow=${platformId === "n8n" ? jsonForHtml(n8nWorkflow(item)) : "null"};function notify(message){const toast=document.getElementById('toast');toast.textContent=message;toast.classList.add('show');setTimeout(()=>toast.classList.remove('show'),1300)}async function copy(value){await navigator.clipboard.writeText(value);notify('Copied')}document.querySelectorAll('#copy-build').forEach(button=>button.addEventListener('click',()=>copy(copyText)));document.querySelectorAll('[data-copy=request]').forEach(button=>button.addEventListener('click',()=>copy(document.getElementById('request-code').innerText)));document.querySelectorAll('[data-copy=callback]').forEach(button=>button.addEventListener('click',()=>copy(document.getElementById('callback-code').innerText)));function download(){const url=URL.createObjectURL(new Blob([JSON.stringify(workflow,null,2)+'\\n'],{type:'application/json'}));const link=document.createElement('a');link.href=url;link.download='n8n-${esc(item.id)}-approval-starter.json';document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);notify('Starter downloaded')}document.querySelectorAll('#download').forEach(button=>button.addEventListener('click',download));</script></body></html>`;
}

function renderGuideV3({ templateId, requestedPlatform, baseUrl }) {
  const item = catalog.find((entry) => entry.id === templateId);
  if (!item) return null;
  const supported = item.guide ? ["zapier"] : ["n8n", "make", "zapier"];
  const platformId = supported.includes(requestedPlatform) ? requestedPlatform : supported[0];
  const platform = PLATFORM[platformId];
  const subject = subjectFor(item);
  const title = `Add ${subject.toLowerCase()} approval to ${platform.label}`;
  const canonical = `${baseUrl}${item.guide || `/templates/${item.id}`}?platform=${platformId}`;
  const fields = REVIEW_FIELDS[item.id] || [];
  const steps = minimalSteps(item, platformId);
  const requestBody = {
    question: `Approve this ${item.protected} action?`,
    context: { action: item.protected, details: `Map: ${fields.join(", ")}` },
    channel: "email", to: "YOUR_APPROVER_EMAIL",
    callback_url: "YOUR_PRIVATE_CALLBACK_URL",
    timeout_minutes: Number.parseInt(item.timeout, 10), default_on_timeout: "rejected",
  };
  const callbackBody = {
    id: "<approval id>", status: "approved | rejected | expired", approved: true,
    decided_by: "<approver>", decided_at: "<ISO timestamp>", comment: null,
    source: "email", question: "<approval question>", context: {},
  };
  const assistantPrompt = `I am adding ${subject.toLowerCase()} approval to an existing ${platform.label} workflow with someonehastosayyes (SHSY).

My current workflow:
[Describe the trigger, current steps, and the final action here]

Reference guide:
${canonical}

The action that must wait for approval:
${item.flow[4]}

The approver needs to see:
${fields.join(", ")}

Treat this SHSY setup as the source of truth:
- Use two Zaps: the existing request Zap and a second callback Zap.
- The callback Zap starts with Webhooks by Zapier → Catch Hook.
- The request Zap uses API by Zapier → API Request with Method POST and URL ${baseUrl}/v1/approvals.
- The POST request uses Authorization: Bearer <stored SHSY API key> and a unique Idempotency-Key.
- Its body contains question, context, channel: email, to, callback_url, timeout_minutes, and default_on_timeout: rejected.
- The callback contains top-level id, status, approved, decided_by, decided_at, comment, source, question, and context.
- After capturing one real callback, use its id in an authenticated GET to ${baseUrl}/v1/approvals/{id}.
- Continue only when the verified GET response has top-level approved = true.

How to help me:
1. Ask no more than three questions for information genuinely missing from my workflow. Do not ask again for details already provided.
2. Use the exact app and event names shown in Zapier. Do not assume SHSY has a native Zapier app.
3. Do not invent callback field paths. Explain how to capture one real sample before mapping id.
4. Never ask me to paste an API key, private Catch Hook URL, employee data, or other sensitive values. Use field names and redacted examples.
5. Give me four short sections: prerequisites, request Zap, callback Zap, and three tests.
6. For every step, show: where to click, what to enter, and what I should see when it works.
7. Include approve, reject, and timeout_minutes: 1 tests. Keep the protected action disconnected until all three pass.
8. Mark account-dependent or untested claims as unverified instead of guessing.

Assume I can build a basic Zap but cannot write code. Keep the answer practical and concise.`;
  const schema = {
    "@context": "https://schema.org",
    "@graph": [
      { "@type": "TechArticle", headline: title, description: WHY_IT_MATTERS[item.id], mainEntityOfPage: canonical, author: { "@type": "Organization", name: "someonehastosayyes", url: baseUrl }, about: ["human approval", "workflow automation", platform.label, subject] },
      { "@type": "HowTo", name: title, description: item.description, step: steps.map(([name, text], index) => ({ "@type": "HowToStep", position: index + 1, name, text })) },
    ],
  };
  const related = supported.filter((id) => id !== platformId).map((id) => `<a href="${esc(item.guide || `/templates/${item.id}`)}?platform=${id}">${esc(PLATFORM[id].label)} version</a>`).join("");
  const renderedSteps = steps.map(([name, text, result], index) => {
    let tools = "";
    if (index === 1) tools = `<div class="step-tools"><button data-copy-value="${esc(`${baseUrl}/v1/approvals`)}">Copy POST endpoint</button><a href="#approval-request">View approval request fields ↓</a></div>`;
    if (index === 2) tools = `<div class="step-tools"><button data-copy-value="${esc(`${baseUrl}/v1/approvals/{id}`)}">Copy GET endpoint</button><a href="#decision-callback">View decision callback ↓</a></div>`;
    return `<li><div><h3>${esc(name)}</h3><p>${esc(text)}</p>${result ? `<p class="result">${esc(result)}</p>` : ""}${tools}</div></li>`;
  }).join("");
  const css = `
    :root{--ink:#171914;--muted:#696e65;--line:#dfe2da;--paper:#f7f8f4;--signal:#e5ed4d;--mono:ui-monospace,SFMono-Regular,Menlo,monospace;--sans:Inter,ui-sans-serif,system-ui,sans-serif}
    *{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.6 var(--sans)}a{color:inherit}.shell{width:min(780px,calc(100% - 40px));margin:auto}.wide{width:min(980px,calc(100% - 40px));margin:auto}
    .nav{height:66px;display:flex;align-items:center;justify-content:space-between}.brand{font-weight:850;text-decoration:none}.back{color:var(--muted);font-size:13px;text-decoration:none}
    .hero{padding:66px 0 60px}.eyebrow,.label{color:#6d7500;font:10px var(--mono);letter-spacing:.07em;text-transform:uppercase}.eyebrow{margin:0 0 14px}.hero h1{margin:0;font-size:clamp(42px,6vw,64px);font-weight:680;line-height:.98;letter-spacing:-.052em}.why{margin:24px 0 0;font-size:20px;line-height:1.5}.status{margin:17px 0 0;color:#806b00;font:10px var(--mono)}.actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:25px}.button{display:inline-flex;min-height:44px;align-items:center;justify-content:center;padding:0 15px;border:1px solid var(--ink);background:transparent;font:800 13px var(--sans);text-decoration:none;cursor:pointer}.button.primary{background:var(--ink);color:#fff}.button.signal{background:var(--signal);border-color:#aeb72f}
    .section{padding:56px 0}.label{display:block;margin-bottom:10px}.section h2{margin:0;font-size:clamp(30px,4vw,40px);line-height:1.05;letter-spacing:-.04em}.intro{margin:12px 0 0;color:var(--muted);font-size:16px}
    .flow{display:flex;align-items:center;gap:15px;margin-top:30px;overflow:auto;padding:5px 0}.flow-node{display:grid;gap:4px;min-width:max-content}.flow-node span{color:#92978e;font:9px var(--mono)}.flow-node strong{font:760 13px var(--sans)}.flow-node.approval strong{background:linear-gradient(transparent 55%,var(--signal) 55%)}.arrow{color:#949990;font-size:22px}.stop{margin:14px 0 0;color:var(--muted);font-size:13px}
    .needs{margin:24px 0 28px;color:var(--muted)}.needs strong{color:var(--ink)}.steps{margin:0;padding:0;list-style:none;counter-reset:step}.steps li{counter-increment:step;display:grid;grid-template-columns:34px minmax(0,1fr);gap:14px;padding:18px 0;border-top:1px solid var(--line)}.steps li:before{content:'0' counter(step);padding-top:3px;color:#7c8378;font:10px var(--mono)}.steps h3{margin:0 0 3px;font-size:17px}.steps p{margin:0;color:var(--muted)}.steps .result{margin-top:7px;color:var(--ink);font-size:13px}.steps .result:before{content:'Done when: ';color:#6d7500;font-weight:800}.step-tools{display:flex;flex-wrap:wrap;gap:16px;margin-top:9px}.step-tools button,.step-tools a{border:0;padding:0;background:none;color:var(--ink);font:750 12px var(--sans);text-decoration:underline;text-underline-offset:3px;cursor:pointer}.ai-assist{display:flex;align-items:center;justify-content:space-between;gap:22px;padding-top:22px;border-top:1px solid var(--line)}.ai-assist p{margin:0;color:var(--muted)}.ai-assist strong{display:block;color:var(--ink);font-size:15px}.ai-assist .button{flex:0 0 auto}
    .fields{margin:25px 0 0;font-size:16px;line-height:1.9}.fields span:not(:last-child):after{content:' · ';color:#a2a69d}.tests{margin:26px 0 0;padding:0;list-style:none}.tests li{position:relative;margin:12px 0;padding-left:23px}.tests li:before{position:absolute;left:0;color:#6d7500;content:'✓';font-weight:900}
    .details{margin-top:28px;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}.details summary{padding:17px 0;font-weight:800;cursor:pointer}.reference{display:grid;grid-template-columns:1fr 1fr;gap:10px;padding:0 0 18px}.code{min-width:0;background:#eef0ea;scroll-margin-top:24px;transition:background .7s}.code:target{background:#edf3a9}.code header{display:flex;justify-content:space-between;padding:9px 11px;font:10px var(--mono)}.code button{border:0;background:var(--ink);color:#fff;padding:5px 8px;cursor:pointer}.code pre{overflow:auto;margin:0;padding:13px;font:11px/1.55 var(--mono);white-space:pre-wrap;word-break:break-word}.related{display:flex;gap:18px;margin-top:22px}.related a{font-weight:750;text-underline-offset:3px}.footer{padding:42px 0 70px;color:var(--muted);font-size:12px}.toast{position:fixed;right:18px;bottom:18px;padding:10px 13px;background:var(--ink);color:#fff;opacity:0;transform:translateY(8px);transition:.16s;pointer-events:none}.toast.show{opacity:1;transform:none}
    @media(max-width:700px){.hero{padding:44px 0 48px}.section{padding:46px 0}.actions{display:grid}.button{width:100%}.flow{align-items:flex-start;flex-direction:column;gap:7px}.arrow{margin-left:8px;transform:rotate(90deg)}.reference{grid-template-columns:1fr}.ai-assist{align-items:stretch;flex-direction:column}.ai-assist .button{width:100%}}
  `;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} | someonehastosayyes</title><meta name="description" content="${esc(WHY_IT_MATTERS[item.id])}"><link rel="canonical" href="${esc(canonical)}"><script type="application/ld+json">${jsonForHtml(schema)}</script><style>${css}</style></head><body>
  <header class="wide nav"><a class="brand" href="/">someonehastosayyes</a><a class="back" href="/relay/templates">Back to templates</a></header>
  <main><section class="shell hero"><p class="eyebrow">${esc(platform.label)} approval template</p><h1>${esc(title)}</h1><p class="why">${esc(WHY_IT_MATTERS[item.id])}</p><p class="status">First-pass QA complete · Account-connected E2E pending</p><div class="actions"><a class="button primary" href="#setup">See the 4 setup steps</a><a class="button signal" href="/?tool=${esc(platformId)}&source=template-guide#request">Get SHSY API key</a></div></section>
  <section class="section"><div class="shell"><span class="label">Where it goes</span><h2>Pause before ${esc(item.flow[4].toLowerCase())}</h2><p class="intro">The automation can prepare everything first. SHSY asks the approver by email and releases the final action only after a verified yes.</p><div class="flow"><div class="flow-node"><span>01</span><strong>${esc(item.flow[0])}</strong></div><span class="arrow">→</span><div class="flow-node approval"><span>02</span><strong>Approve in SHSY</strong></div><span class="arrow">→</span><div class="flow-node"><span>03</span><strong>${esc(item.flow[4])}</strong></div></div><p class="stop">Rejected or unanswered requests stop here. Slack is not required.</p></div></section>
  <section class="section" id="setup"><div class="shell"><span class="label">Setup</span><h2>Build it in four steps</h2><p class="needs"><strong>You need:</strong> your existing ${esc(platform.label)} workflow, one approver email, one SHSY API key, a harmless test record${platformId === "zapier" ? ", and a paid Zapier plan for API by Zapier" : ""}.</p><ol class="steps">${renderedSteps}</ol><div class="ai-assist"><p><strong>Need help adapting this?</strong>Use ChatGPT, Claude, Gemini, Perplexity, or another assistant with your workflow details.</p><button class="button" id="copy-ai">Copy prompt for AI</button></div>${platformId === "n8n" ? '<div class="actions"><button class="button primary" id="download">Download n8n starter</button></div>' : ""}</div></section>
  <section class="section"><div class="shell"><span class="label">What the approver sees</span><h2>Show only what is needed to decide</h2><p class="fields">${fields.map((field) => `<span>${esc(field)}</span>`).join("")}</p><ul class="tests"><li>Use links instead of copying large or sensitive records.</li><li>Test approve, reject, and a 1-minute timeout.</li><li>Connect ${esc(item.connect)} only after all three tests behave correctly.</li></ul>
  <details class="details" id="field-reference"><summary>Use these fields in ${esc(platform.label)}</summary><div class="reference"><div class="code" id="approval-request"><header><span>APPROVAL REQUEST</span><button data-copy="request">Copy</button></header><pre id="request-code">Authorization: Bearer $SHSY_API_KEY\nIdempotency-Key: &lt;unique run id&gt;\n\n${esc(JSON.stringify(requestBody, null, 2))}</pre></div><div class="code" id="decision-callback"><header><span>DECISION CALLBACK</span><button data-copy="callback">Copy</button></header><pre id="callback-code">${esc(JSON.stringify(callbackBody, null, 2))}\n\nVerify with:\nGET /v1/approvals/{id}</pre></div></div></details>${related ? `<nav class="related" aria-label="Other platform versions">${related}</nav>` : ""}</div></section></main>
  <footer class="footer"><div class="wide">someonehastosayyes · approval infrastructure for automated actions</div></footer><div class="toast" id="toast">Copied</div><script>const workflow=${platformId === "n8n" ? jsonForHtml(n8nWorkflow(item)) : "null"};const assistantPrompt=${jsonForHtml(assistantPrompt)};function notify(message){const toast=document.getElementById('toast');toast.textContent=message;toast.classList.add('show');setTimeout(()=>toast.classList.remove('show'),1300)}async function copy(value){await navigator.clipboard.writeText(value);notify('Copied')}document.getElementById('copy-ai')?.addEventListener('click',()=>copy(assistantPrompt));document.querySelectorAll('[data-copy-value]').forEach(button=>button.addEventListener('click',()=>copy(button.dataset.copyValue)));document.querySelectorAll('.step-tools a').forEach(link=>link.addEventListener('click',()=>{document.getElementById('field-reference').open=true}));document.querySelectorAll('[data-copy=request]').forEach(button=>button.addEventListener('click',()=>copy(document.getElementById('request-code').innerText)));document.querySelectorAll('[data-copy=callback]').forEach(button=>button.addEventListener('click',()=>copy(document.getElementById('callback-code').innerText)));function download(){const url=URL.createObjectURL(new Blob([JSON.stringify(workflow,null,2)+'\\n'],{type:'application/json'}));const link=document.createElement('a');link.href=url;link.download='n8n-${esc(item.id)}-approval-starter.json';document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);notify('Starter downloaded')}document.querySelectorAll('#download').forEach(button=>button.addEventListener('click',download));</script></body></html>`;
}

module.exports = { catalog, renderGuide: renderGuideV3 };
