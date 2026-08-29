# 커뮤니티 답글 초안 (문제 해결 먼저, 링크는 마지막 한 줄)

원칙: 그 사람 문제의 원인을 먼저 설명하고, 재현 → 해결 워크플로를 준다. 제품명·가격·"우리 서비스" 표현 금지. 링크는 마지막 한 문장.

---

## 1) n8n: "Slack button → 'This app responded with Status Code 404', node stuck on spinner"
https://community.n8n.io/t/human-in-the-loop-with-slack/284892

> Ran into the same thing. What's happening: Slack expects a 200 within 3 seconds on the Interactivity Request URL, and the URL n8n gives you for the Wait node is single-use — the second delivery (Slack retries on slow responses) hits an already-consumed resume URL and gets a 404, which Slack then shows on the button.
>
> Two things fixed it for me: (1) answer Slack immediately with `replace_original`, and (2) put a tiny relay in between that records only the first click and calls the resume URL with a stable approval ID, retrying transient failures but not 404 (which means the one-time endpoint is gone).
>
> I wrapped that into a small open-source relay so I didn't have to rebuild it per workflow. Attached is an importable workflow: HTTP Request → Wait (on webhook) → IF. `callback_url` is just `{{ $execution.resumeUrl }}`.
>
> [workflow JSON]
>
> If you'd rather not self-host it, there's a hosted instance here: <link>. Happy to help debug your specific setup either way.

---

## 2) n8n: "Approve/Disapprove button cannot be updated after interaction"
https://community.n8n.io/t/human-in-the-loop-slack-cannot-update-approve-disapprove-button-after-interaction/119544

> The Send-and-Wait node posts the message but n8n doesn't hold the `channel`+`ts` to call `chat.update` later, so the buttons stay live forever. You need something that (a) stores the message ts at post time and (b) on click responds with `replace_original: true` and a block that says who decided and when — and does the same on timeout.
>
> I built exactly that as a small relay after hitting this. On click the message becomes "✅ Approved · steve · 14:32", and a second click shows the current state instead of erroring. Importable workflow below.
>
> [workflow JSON] · hosted: <link>

---

## 3) n8n: "How long does Waiting last? 50–100 approvals/week to different employees, 1–2 days to respond"
https://community.n8n.io/t/human-in-the-loop-time-to-disconnect/120118

> Two separate limits to think about: n8n's Wait node (set Limit Wait Time, or it waits "indefinitely" which in practice means until the execution is pruned) and the *decision* timeout — what happens if nobody answers. For 50–100/week I'd move the timeout out of n8n: create the approval with an explicit `timeout_minutes` and `default_on_timeout` (I default to rejected for anything touching money), and let the relay call the resume URL either with the human's answer or the timeout default. Then set n8n's Wait limit slightly longer than that.
>
> Workflow I use for this: [workflow JSON]. No hard limit on concurrent pending approvals on the relay side. Hosted: <link>.

---

## 4) Make: "Creating an approval step (email) — best option seems to be a separate scenario with a webhook"
https://community.make.com/t/creating-an-approval-step/53163

> That's still the right shape on non-Enterprise plans (the native Human-in-the-loop app is Enterprise + invite-only). What I'd avoid is building the approval page, the expiry, and the "did they already click?" handling yourself — I got bitten by email security scanners pre-opening the approve link and auto-approving.
>
> What works: Scenario A → HTTP module POSTs the question + a `callback_url` (your Scenario B custom webhook) + `timeout_minutes`. The person gets an email with one button; the page decides only on POST (so link scanners can't approve). When they decide (or it expires), Scenario B's webhook fires with `{approved: true/false, decided_by, ...}` and you route from there.
>
> I open-sourced the small relay that does this: <link>. Two HTTP modules, no waiting cost in Make.

---

## 5) n8n self-hosted: "webhook URL gets a random UUID appended, breaks Slack response"
https://community.n8n.io/t/human-in-the-loop-slack-send-wait-node-broken-on-self-hosted-n8n-server/135013

> That suffix is the per-execution resume token — it's correct, but it means the Slack Request URL can't be a fixed value, which is why the Send-and-Wait approach fights self-hosting. Cleaner: point Slack Interactivity at one fixed URL (a relay), and have the relay call the per-execution resume URL. Workflow + relay: <link>.

---

## 측정 (답글 단 뒤 24시간)
- 링크 클릭 → /health 확인
- API 키 요청 DM → 수동 발급 (API_KEYS에 추가 후 재시작)
- 자기 워크플로 연결 → /v1/stats 에서 pending 증가
- 실제 승인 1건 처리 → /v1/stats 의 callbacks_delivered ≥ 1  ← 이게 사업 신호
