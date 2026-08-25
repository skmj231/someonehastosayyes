# 컨택 키트 — 첫 10명

## 원칙 셋
1. 문제 해결이 먼저, 링크는 마지막 한 줄. 제품명·가격·"베타" 언급 없음
2. 키는 손으로 발급. 발급하면서 반드시 한 가지를 묻는다: "이 승인이 뭘 지키나요?"
3. 성공 기준은 "써봤다"가 아니라 **낯선 사람의 워크플로에서 승인 1건이 처리되고 콜백이 delivered** 된 것

## 오늘 답글 달 곳 (순서대로, 30분 간격)
| # | 스레드 | 초안 |
|---|---|---|
| 1 | n8n · Slack button 404, node stuck (2026-04) | community-replies.md #1 |
| 2 | Make · Creating an approval step | community-replies.md #4 |
| 3 | n8n · button cannot be updated after interaction | #2 |
| 4 | n8n · how long does waiting last, 50–100/week | #3 |
| 5 | n8n · self-hosted UUID suffix breaks Slack | #5 |

답글 붙이기 전 체크: 링크가 랜딩(`/`)으로 가는가 · 워크플로 JSON의 URL/키/채널이 `YOUR-…` 자리표시자인가 · 30초 영상이 첨부됐는가

## 답글 다음 날 올릴 글 (커뮤니티가 아니라 게시판)
r/n8n, r/automation, Make 커뮤니티 Showcase. 제목은 문제로:
> "Why the Slack approve button returns 404 in n8n (and a small relay that fixes it)"
본문은 답글 #1의 원인 설명 + 워크플로 JSON + 영상. 마지막 줄에 링크.

## DM · 이메일 템플릿

### A. 키 요청이 들어왔을 때 (랜딩 폼 또는 DM)
> Subject: your someonehastosayyes key
>
> Here's your key: `ah_…`
> Connect Slack (30 s, one click): `https://<host>/slack/install?key=ah_…`
> n8n: import `n8n-approval-demo.json`, swap the URL/key/channel. Make: two HTTP modules, recipe attached.
>
> One question so I can make sure it fits: what does the approval in your workflow protect — refunds, outbound email, deletes, something else?
>
> If anything doesn't resume, send me the approval id (`apr_…`) and I'll look at the delivery log on my side.

### B. 연결했는데 콜백이 안 왔다고 할 때
> Got it. Two things to check on your side while I look at `apr_…`:
> 1. In n8n the Wait node must be *Resume: On Webhook Call*, HTTP method POST, and `callback_url` must be `{{ $execution.resumeUrl }}` (the expression, not the literal text).
> 2. In Make, the custom webhook needs to have been "determined" once — run a test approval first.
> On my side `GET /v1/approvals/apr_…/deliveries` shows every attempt and status code; I'll send you what it says.

### C. 24시간 뒤 팔로업 (키 받고 연결 안 한 사람)
> Quick one — did the key work, or did something get in the way? If it's the Slack connect step or the Wait node setup, a screenshot is enough and I'll tell you exactly what to change. No pressure either way.

### D. 승인 1건이 실제로 처리된 사람에게 (가장 중요한 메시지)
> Saw an approval go through on your key — thanks for trying it for real. Could I ask 15 minutes this week? I want to hear how the approval step looked before, and what would make you keep this in the workflow. In return I'll fix whatever you hit first.

## 첫 통화에서 물을 것 (15분, 이 순서)
1. 이 승인이 지키는 게 뭔가요? (돈, 고객 메일, 삭제, 외부 발송)
2. 전에는 어떻게 했나요? 마지막으로 깨진 게 언제인가요?
3. 하루/주에 승인이 몇 건인가요? 같은 질문이 반복되나요?
4. 승인자는 누구고 슬랙을 보나요? 안 보면 어디를 보나요?
5. 지금 안 되는 게 있다면 하나만 꼽으면?
6. (마지막에만) 이게 계속 돌아간다면 월 얼마면 당연히 낼 것 같나요?

## 추적표 (구글시트 열 그대로)
| 날짜 | 이름/핸들 | 출처 스레드 | 도구 | 키 발급 | 슬랙 연결 | 첫 요청 | 첫 승인 처리 | 콜백 delivered | 통화 | 메모 |

`/v1/stats`(키별)와 `/admin/key-requests`로 채운다. 하루 한 번, 자기 전에.

## 이번 주 신호 기준
- 링크 클릭·키 요청: 관심. 숫자 세지 않아도 됨
- 자기 워크플로 연결(첫 요청 생김): 강한 관심. 24시간 안에 팔로업
- **낯선 사람 워크플로에서 승인 1건 + delivered: 사업 신호. 이게 1건이면 다음 질문은 "얼마 받나"**
- 5명이 키를 받고 0명이 연결하면: 연결 과정이 문제. 제품 말고 온보딩을 고침
