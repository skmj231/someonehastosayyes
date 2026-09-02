window.SHSY_TEMPLATES = [
  {
    "id": "ai-email",
    "title": "Customer email approval",
    "summary": "Pause after the draft. Send the email only after a person says yes.",
    "category": "Communication",
    "platform": "n8n",
    "apps": [
      "n8n",
      "Email"
    ],
    "color": "#ff5a36",
    "tags": [
      "AI",
      "Email",
      "Customer support"
    ],
    "flow": [
      "Draft ready",
      "Request approval",
      "Wait",
      "Yes or no",
      "EMAIL SEND"
    ],
    "protected": "email.send",
    "timeout": "60 minutes, then reject",
    "replace": "API key and approver email",
    "connect": "Gmail or email node",
    "file": "/templates/n8n-ai-email-approval.json",
    "prompt": "Import the n8n workflow from https://someonehastosayyes.com/templates/n8n-ai-email-approval.json. Replace PASTE_YOUR_API_KEY and YOUR_APPROVER_EMAIL. Run one approval and one rejection test. Connect the final action only after both tests work."
  },
  {
    "id": "refund",
    "title": "High-value refund approval",
    "summary": "Hold the refund request. Move the money only after the right person approves the amount.",
    "category": "Finance",
    "platform": "n8n",
    "apps": [
      "n8n",
      "Refund"
    ],
    "color": "#3478ff",
    "actionInk": "#fff",
    "tags": [
      "Refund",
      "Payments",
      "Threshold"
    ],
    "flow": [
      "Refund requested",
      "Request approval",
      "Wait",
      "Yes or no",
      "REFUND API"
    ],
    "protected": "refund.create",
    "timeout": "60 minutes, then reject",
    "replace": "API key and approver email",
    "connect": "Refund API node",
    "file": "/templates/n8n-refund-approval.json",
    "prompt": "Import the n8n workflow from https://someonehastosayyes.com/templates/n8n-refund-approval.json. Replace PASTE_YOUR_API_KEY and YOUR_APPROVER_EMAIL. Run one approval and one rejection test. Connect the final action only after both tests work."
  },
  {
    "id": "content-publish",
    "title": "Content publishing approval",
    "summary": "Keep the content in draft. Publish only after a person says yes.",
    "category": "Communication",
    "platform": "n8n",
    "apps": [
      "n8n",
      "Publish"
    ],
    "color": "#ff3da6",
    "tags": [
      "AI",
      "Content",
      "Publishing"
    ],
    "flow": [
      "Content ready",
      "Request approval",
      "Wait",
      "Yes or no",
      "PUBLISHING"
    ],
    "protected": "content.publish",
    "timeout": "120 minutes, then reject",
    "replace": "API key and approver email",
    "connect": "Publishing node",
    "file": "/templates/n8n-content-publish-approval.json",
    "prompt": "Import the n8n workflow from https://someonehastosayyes.com/templates/n8n-content-publish-approval.json. Replace PASTE_YOUR_API_KEY and YOUR_APPROVER_EMAIL. Run one approval and one rejection test. Connect the final action only after both tests work."
  },
  {
    "id": "crm-bulk-change",
    "title": "Bulk CRM change approval",
    "summary": "Stop the bulk change. Update the CRM only after someone checks the operation and record count.",
    "category": "Operations",
    "platform": "n8n",
    "apps": [
      "n8n",
      "CRM"
    ],
    "color": "#16c784",
    "tags": [
      "CRM",
      "Bulk update",
      "Data"
    ],
    "flow": [
      "Change ready",
      "Request approval",
      "Wait",
      "Yes or no",
      "CRM UPDATE"
    ],
    "protected": "crm.bulk_update",
    "timeout": "60 minutes, then reject",
    "replace": "API key and approver email",
    "connect": "CRM update node",
    "file": "/templates/n8n-crm-bulk-change-approval.json",
    "prompt": "Import the n8n workflow from https://someonehastosayyes.com/templates/n8n-crm-bulk-change-approval.json. Replace PASTE_YOUR_API_KEY and YOUR_APPROVER_EMAIL. Run one approval and one rejection test. Connect the final action only after both tests work."
  },
  {
    "id": "pipeline-digest",
    "title": "Sales pipeline digest approval",
    "summary": "Hold the weekly digest. Post it only after the sales manager checks the numbers and owners.",
    "category": "Sales",
    "platform": "n8n",
    "apps": [
      "n8n",
      "Pipeline"
    ],
    "color": "#7c3cff",
    "actionInk": "#fff",
    "tags": [
      "Sales",
      "Reporting",
      "Slack"
    ],
    "flow": [
      "Digest ready",
      "Request approval",
      "Wait",
      "Yes or no",
      "SLACK POST"
    ],
    "protected": "sales_digest.post",
    "timeout": "120 minutes, then reject",
    "replace": "API key and approver email",
    "connect": "Slack post node",
    "file": "/templates/n8n-pipeline-digest-approval.json",
    "prompt": "Import the n8n workflow from https://someonehastosayyes.com/templates/n8n-pipeline-digest-approval.json. Replace PASTE_YOUR_API_KEY and YOUR_APPROVER_EMAIL. Run one approval and one rejection test. Connect the final action only after both tests work."
  },
  {
    "id": "meeting-followup",
    "title": "Meeting follow-up approval",
    "summary": "Keep the recap unsent. Email attendees only after the meeting owner checks it.",
    "category": "Communication",
    "platform": "n8n",
    "apps": [
      "n8n",
      "Follow-up"
    ],
    "color": "#ffb000",
    "tags": [
      "Meeting",
      "Email",
      "AI"
    ],
    "flow": [
      "Recap ready",
      "Request approval",
      "Wait",
      "Yes or no",
      "EMAIL SEND"
    ],
    "protected": "meeting_recap.send",
    "timeout": "120 minutes, then reject",
    "replace": "API key and approver email",
    "connect": "Gmail or Outlook node",
    "file": "/templates/n8n-meeting-followup-approval.json",
    "prompt": "Import the n8n workflow from https://someonehastosayyes.com/templates/n8n-meeting-followup-approval.json. Replace PASTE_YOUR_API_KEY and YOUR_APPROVER_EMAIL. Run one approval and one rejection test. Connect the final action only after both tests work."
  },
  {
    "id": "sales-quote",
    "title": "Sales quote approval",
    "summary": "Hold the generated quote. Send it only after someone checks pricing, discount, and terms.",
    "category": "Sales",
    "platform": "n8n",
    "apps": [
      "n8n",
      "Quote"
    ],
    "color": "#00a6ff",
    "actionInk": "#fff",
    "tags": [
      "Quote",
      "Pricing",
      "Sales"
    ],
    "flow": [
      "Quote ready",
      "Request approval",
      "Wait",
      "Yes or no",
      "QUOTE SEND"
    ],
    "protected": "sales_quote.send",
    "timeout": "240 minutes, then reject",
    "replace": "API key and approver email",
    "connect": "DocuSign or email node",
    "file": "/templates/n8n-sales-quote-approval.json",
    "prompt": "Import the n8n workflow from https://someonehastosayyes.com/templates/n8n-sales-quote-approval.json. Replace PASTE_YOUR_API_KEY and YOUR_APPROVER_EMAIL. Run one approval and one rejection test. Connect the final action only after both tests work."
  },
  {
    "id": "candidate-progress",
    "title": "Candidate progression approval",
    "summary": "Pause after AI screening. Move the candidate forward only after a recruiter says yes.",
    "category": "People",
    "platform": "n8n",
    "apps": [
      "n8n",
      "Hiring"
    ],
    "color": "#ff7043",
    "tags": [
      "Hiring",
      "ATS",
      "AI"
    ],
    "flow": [
      "Candidate scored",
      "Request approval",
      "Wait",
      "Yes or no",
      "ATS UPDATE"
    ],
    "protected": "candidate.advance",
    "timeout": "1440 minutes, then reject",
    "replace": "API key and approver email",
    "connect": "Greenhouse, Lever, or Ashby node",
    "file": "/templates/n8n-candidate-progress-approval.json",
    "prompt": "Import the n8n workflow from https://someonehastosayyes.com/templates/n8n-candidate-progress-approval.json. Replace PASTE_YOUR_API_KEY and YOUR_APPROVER_EMAIL. Run one approval and one rejection test. Connect the final action only after both tests work."
  },
  {
    "id": "account-provisioning",
    "title": "Employee account provisioning approval",
    "summary": "Stop before access is created. Provision employee accounts only after the owner confirms the role and start date.",
    "category": "People",
    "platform": "n8n",
    "apps": [
      "n8n",
      "Onboard"
    ],
    "color": "#00c2a8",
    "tags": [
      "Onboarding",
      "IT",
      "Access"
    ],
    "flow": [
      "Hire ready",
      "Request approval",
      "Wait",
      "Yes or no",
      "ACCOUNT CREATION"
    ],
    "protected": "employee.provision",
    "timeout": "1440 minutes, then reject",
    "replace": "API key and approver email",
    "connect": "Identity or account provisioning nodes",
    "file": "/templates/n8n-account-provisioning-approval.json",
    "prompt": "Import the n8n workflow from https://someonehastosayyes.com/templates/n8n-account-provisioning-approval.json. Replace PASTE_YOUR_API_KEY and YOUR_APPROVER_EMAIL. Run one approval and one rejection test. Connect the final action only after both tests work."
  },
  {
    "id": "order-fulfillment",
    "title": "Order fulfillment approval",
    "summary": "Hold the order before fulfillment. Release it only after ops checks the order, stock, and destination.",
    "category": "Operations",
    "platform": "n8n",
    "apps": [
      "n8n",
      "Fulfill"
    ],
    "color": "#7dce13",
    "tags": [
      "Order",
      "Fulfillment",
      "Commerce"
    ],
    "flow": [
      "Order ready",
      "Request approval",
      "Wait",
      "Yes or no",
      "FULFILLMENT"
    ],
    "protected": "order.fulfill",
    "timeout": "240 minutes, then reject",
    "replace": "API key and approver email",
    "connect": "Shopify, WooCommerce, or warehouse node",
    "file": "/templates/n8n-order-fulfillment-approval.json",
    "prompt": "Import the n8n workflow from https://someonehastosayyes.com/templates/n8n-order-fulfillment-approval.json. Replace PASTE_YOUR_API_KEY and YOUR_APPROVER_EMAIL. Run one approval and one rejection test. Connect the final action only after both tests work."
  },
  {
    "id": "payment-receipt",
    "title": "Payment receipt approval",
    "summary": "Keep the receipt in draft. Send it only after finance checks the payment and customer details.",
    "category": "Finance",
    "platform": "n8n",
    "apps": [
      "n8n",
      "Receipt"
    ],
    "color": "#6c5ce7",
    "actionInk": "#fff",
    "tags": [
      "Payment",
      "Receipt",
      "Finance"
    ],
    "flow": [
      "Receipt drafted",
      "Request approval",
      "Wait",
      "Yes or no",
      "RECEIPT EMAIL"
    ],
    "protected": "payment_receipt.send",
    "timeout": "120 minutes, then reject",
    "replace": "API key and approver email",
    "connect": "Gmail or Outlook node",
    "file": "/templates/n8n-payment-receipt-approval.json",
    "prompt": "Import the n8n workflow from https://someonehastosayyes.com/templates/n8n-payment-receipt-approval.json. Replace PASTE_YOUR_API_KEY and YOUR_APPROVER_EMAIL. Run one approval and one rejection test. Connect the final action only after both tests work."
  },
  {
    "id": "performance-review",
    "title": "Performance review approval",
    "summary": "Keep the AI draft private. Share the review only after the manager makes the final call.",
    "category": "People",
    "platform": "n8n",
    "apps": [
      "n8n",
      "Review"
    ],
    "color": "#d833ff",
    "actionInk": "#fff",
    "tags": [
      "People",
      "Review",
      "AI"
    ],
    "flow": [
      "Review drafted",
      "Request approval",
      "Wait",
      "Yes or no",
      "REVIEW SHARE"
    ],
    "protected": "performance_review.share",
    "timeout": "2880 minutes, then reject",
    "replace": "API key and approver email",
    "connect": "Document share or email node",
    "file": "/templates/n8n-performance-review-approval.json",
    "prompt": "Import the n8n workflow from https://someonehastosayyes.com/templates/n8n-performance-review-approval.json. Replace PASTE_YOUR_API_KEY and YOUR_APPROVER_EMAIL. Run one approval and one rejection test. Connect the final action only after both tests work."
  },
  {
    "id": "reddit-outreach",
    "title": "Reddit lead outreach approval",
    "summary": "Hold the drafted response. Create the lead or send outreach only after a rep reviews the context.",
    "category": "Sales",
    "platform": "n8n",
    "apps": [
      "n8n",
      "Outreach"
    ],
    "color": "#ff4747",
    "actionInk": "#fff",
    "tags": [
      "Reddit",
      "Lead",
      "Outreach"
    ],
    "flow": [
      "Reply drafted",
      "Request approval",
      "Wait",
      "Yes or no",
      "CRM CREATE"
    ],
    "protected": "lead_outreach.create",
    "timeout": "120 minutes, then reject",
    "replace": "API key and approver email",
    "connect": "HubSpot, Salesforce, or Attio node",
    "file": "/templates/n8n-reddit-outreach-approval.json",
    "prompt": "Import the n8n workflow from https://someonehastosayyes.com/templates/n8n-reddit-outreach-approval.json. Replace PASTE_YOUR_API_KEY and YOUR_APPROVER_EMAIL. Run one approval and one rejection test. Connect the final action only after both tests work."
  },
  {
    "id": "lead-qualification",
    "title": "Qualified lead routing approval",
    "summary": "Pause after AI scoring. Add the lead to the sales pipeline only after a rep checks the evidence.",
    "category": "Sales",
    "platform": "n8n",
    "apps": [
      "n8n",
      "Lead"
    ],
    "color": "#00b8d9",
    "tags": [
      "Lead",
      "CRM",
      "AI"
    ],
    "flow": [
      "Lead scored",
      "Request approval",
      "Wait",
      "Yes or no",
      "CRM CREATE"
    ],
    "protected": "lead.create",
    "timeout": "120 minutes, then reject",
    "replace": "API key and approver email",
    "connect": "HubSpot, Salesforce, or Pipedrive node",
    "file": "/templates/n8n-lead-qualification-approval.json",
    "prompt": "Import the n8n workflow from https://someonehastosayyes.com/templates/n8n-lead-qualification-approval.json. Replace PASTE_YOUR_API_KEY and YOUR_APPROVER_EMAIL. Run one approval and one rejection test. Connect the final action only after both tests work."
  },
  {
    "id": "support-response",
    "title": "Customer support response approval",
    "summary": "Keep the answer unsent. Reply to the customer only after an agent checks the diagnosis and tone.",
    "category": "Support",
    "platform": "n8n",
    "apps": [
      "n8n",
      "Support"
    ],
    "color": "#f36f21",
    "tags": [
      "Support",
      "Email",
      "AI"
    ],
    "flow": [
      "Response ready",
      "Request approval",
      "Wait",
      "Yes or no",
      "SUPPORT REPLY"
    ],
    "protected": "support_reply.send",
    "timeout": "60 minutes, then reject",
    "replace": "API key and approver email",
    "connect": "Zendesk, Intercom, or email node",
    "file": "/templates/n8n-support-response-approval.json",
    "prompt": "Import the n8n workflow from https://someonehastosayyes.com/templates/n8n-support-response-approval.json. Replace PASTE_YOUR_API_KEY and YOUR_APPROVER_EMAIL. Run one approval and one rejection test. Connect the final action only after both tests work."
  },
  {
    "id": "health-escalation",
    "title": "Customer health escalation approval",
    "summary": "Hold the escalation. Contact the account team only after a CSM confirms the risk signals.",
    "category": "Support",
    "platform": "n8n",
    "apps": [
      "n8n",
      "Escalate"
    ],
    "color": "#ff1f69",
    "actionInk": "#fff",
    "tags": [
      "Customer success",
      "Risk",
      "CRM"
    ],
    "flow": [
      "Risk detected",
      "Request approval",
      "Wait",
      "Yes or no",
      "ESCALATION"
    ],
    "protected": "customer_health.escalate",
    "timeout": "240 minutes, then reject",
    "replace": "API key and approver email",
    "connect": "Slack, email, or CRM task node",
    "file": "/templates/n8n-health-escalation-approval.json",
    "prompt": "Import the n8n workflow from https://someonehastosayyes.com/templates/n8n-health-escalation-approval.json. Replace PASTE_YOUR_API_KEY and YOUR_APPROVER_EMAIL. Run one approval and one rejection test. Connect the final action only after both tests work."
  },
  {
    "id": "email-triage",
    "title": "Email triage action approval",
    "summary": "Pause after AI triage. Reply, archive, or create a task only after a person confirms the action.",
    "category": "Operations",
    "platform": "n8n",
    "apps": [
      "n8n",
      "Triage"
    ],
    "color": "#00a67e",
    "actionInk": "#fff",
    "tags": [
      "Email",
      "Triage",
      "AI"
    ],
    "flow": [
      "Email classified",
      "Request approval",
      "Wait",
      "Yes or no",
      "EMAIL ACTION"
    ],
    "protected": "email_triage.execute",
    "timeout": "60 minutes, then reject",
    "replace": "API key and approver email",
    "connect": "Gmail, Outlook, or task node",
    "file": "/templates/n8n-email-triage-approval.json",
    "prompt": "Import the n8n workflow from https://someonehastosayyes.com/templates/n8n-email-triage-approval.json. Replace PASTE_YOUR_API_KEY and YOUR_APPROVER_EMAIL. Run one approval and one rejection test. Connect the final action only after both tests work."
  },
  {
    "id": "ticket-backlog-digest",
    "title": "Ticket backlog digest approval",
    "summary": "Hold the support digest. Post it only after the support lead checks the SLA and workload numbers.",
    "category": "Support",
    "platform": "n8n",
    "apps": [
      "n8n",
      "Backlog"
    ],
    "color": "#7857ff",
    "actionInk": "#fff",
    "tags": [
      "Support",
      "Reporting",
      "Slack"
    ],
    "flow": [
      "Digest ready",
      "Request approval",
      "Wait",
      "Yes or no",
      "SLACK POST"
    ],
    "protected": "support_digest.post",
    "timeout": "120 minutes, then reject",
    "replace": "API key and approver email",
    "connect": "Slack or Teams node",
    "file": "/templates/n8n-ticket-backlog-digest-approval.json",
    "prompt": "Import the n8n workflow from https://someonehastosayyes.com/templates/n8n-ticket-backlog-digest-approval.json. Replace PASTE_YOUR_API_KEY and YOUR_APPROVER_EMAIL. Run one approval and one rejection test. Connect the final action only after both tests work."
  }
];
