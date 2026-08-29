# Make.com recipe — an approval step on any plan

Make's native Human-in-the-loop app is Enterprise-only and invite-only. This gives you the same thing with two HTTP modules.

## Scenario A — the workflow that needs approval
1. …your trigger and steps…
2. Add **HTTP › Make a request** from the **plus attached to the previous module**.
   - Do not use the loose app picker at the bottom of the canvas. It can create an unconnected module that looks finished but never runs.
   - Before testing, make sure a visible connection line reaches the HTTP module.
3. Configure the request:
   - URL: `https://<host>/v1/approvals`  Method: POST
   - Headers: `Authorization: Bearer YOUR_KEY`, `Content-Type: application/json`
   - Body (JSON):
     ```json
     {
       "question": "Refund order {{1.order_id}} for ${{1.amount}}?",
       "context": { "order_id": "{{1.order_id}}", "amount": {{1.amount}}, "customer": "{{1.email}}" },
       "channel": "email", "to": "manager@company.com",
       "callback_url": "https://hook.make.com/YOUR-SCENARIO-B-WEBHOOK",
       "timeout_minutes": 1440, "default_on_timeout": "rejected"
     }
     ```
4. End. The scenario finishes here — no waiting, no operations consumed while the human thinks.

Put everything Scenario B will need into `context`. It comes back untouched in the callback.

## Scenario B — resumes when the human decides
1. Start a new scenario with the **large plus in the center of the empty canvas**, then choose **Webhooks › Custom webhook**. It must be the first module, not a loose module beside the starting point.
2. Copy its URL into Scenario A as `callback_url`.
3. Click **Run once**, create one test approval, and decide it so Make learns the callback fields.
4. Save the scenario, choose **Immediately as data arrives**, and turn the scenario **on**. A successful one-time test does not activate future callbacks by itself.
5. Add a **Router**
   - Route 1 filter: `approved` equals `true` → do the refund / send the email / whatever was gated
   - Route 2: `approved` equals `false` → log it, notify the requester, nothing else
6. Use `context.order_id` etc. from the webhook payload.

### A 20-second connection check
- Scenario A shows a connection line into the HTTP module.
- Scenario A's HTTP run returns status code `201` and an approval `id`.
- Scenario B is on and says **Immediately as data arrives**.
- Approve, reject, and timeout each create a new Scenario B history row.

## What you get that the two-scenario workaround doesn't
- A real approval page (no Google Form). Opening the link never decides; only pressing does — so email security scanners can't approve on the manager's behalf.
- A deadline and a default. If nobody presses in 24 h, Scenario B still fires with `approved: false`.
- Who pressed and when, in the payload.
- One recorded decision. Callback retries keep the same approval ID, so Scenario B can deduplicate safely if a response is lost.

## Callback payload Scenario B receives
```json
{ "id": "apr_…", "status": "approved", "approved": true,
  "decided_by": "Kim", "decided_at": "2026-08-25T05:32:10.000Z", "comment": null,
  "source": "web", "question": "Refund order A-1 for $380?", "context": { "order_id": "A-1", … } }
```
