# someonehastosayyes — 승인 링크 API

워크플로(n8n, Make, LangGraph, 아무거나)가 사람에게 "이거 해도 돼요?" 묻고 답을 받아오는 단계를 API 하나로 제공합니다.

지금 해결하는 문제 딱 두 개:

1. **n8n 슬랙 승인 버튼이 깨지는 문제** — 404, 스피너 멈춤, 버튼 갱신 안 됨, 새 탭 열림, 셀프호스팅 UUID, 일회용 resumeUrl 중복 호출
2. **Make.com에 승인 단계가 없는 문제** — 엔터프라이즈 전용·초대제라서 무료/프로 플랜은 시나리오 두 개로 우회해야 함

## 어떻게 다른가

| 문제 | 우리 처리 |
|---|---|
| 슬랙 앱 설정이 어렵다 | 앱은 우리가 호스팅. 봇 토큰 하나만 넣으면 됨 |
| 버튼 누르면 404 | 3초 안에 200 응답하고 메시지를 제자리에서 교체 |
| 버튼이 갱신 안 됨 | "○○님이 14:32 승인"으로 즉시 교체, 두 번째 클릭도 에러 없이 현재 상태 표시 |
| 새 탭 열림 | 슬랙은 버튼으로 끝. 이메일은 페이지에서 POST 버튼 |
| resumeUrl 일회용 | 결정 1건당 콜백 1번. 404/409 받으면 "이미 소비됨"으로 보고 재시도 안 함 |
| 메일 보안 스캐너가 링크를 미리 열어 자동 승인됨 | GET은 절대 결정하지 않음. 결정은 POST만 |
| 타임아웃이 뭔지 모른다 | 요청마다 `timeout_minutes` + `default_on_timeout` 명시. 기본 24시간, 기본값 거절 |
| 콜백이 유실된다 | 5회 재시도(0s, 2s, 10s, 1m, 5m), 서명 헤더, 전달 이력 API |

## 파일

- `server.js` — 서비스 전체 (API, 승인 페이지, 슬랙, 이메일, 랜딩, 관리자)
- `landing.html` — 랜딩 페이지. 실제 승인 링크를 만들어 보는 데모와 키 요청 폼
- `test.js`, `test2.js` — 자동 테스트
- `DEPLOY.md` — Railway/Fly 배포, 슬랙 앱 설정, 키 발급
- `examples/` — n8n 워크플로(JSON), Make 레시피, 커뮤니티 답글 초안, 컨택 키트

## 실행

```bash
npm install
cp .env.example .env   # 값 채우기
node server.js
```

VPS(1~2만원/월)나 Railway/Fly 무료 구간. SQLite 파일 하나라 백업은 파일 복사.

## API

### 승인 요청 만들기

```http
POST /v1/approvals
Authorization: Bearer <API_KEY>
Content-Type: application/json

{
  "question": "주문 A-1 환불 35만원 승인할까요?",
  "context": { "order": "A-1", "amount": 350000, "reason": "파손" },
  "approve_label": "환불 승인",
  "reject_label": "거절",
  "channel": "slack",            // link | email | slack
  "to": "C0123ABCD",             // slack: 채널/유저 ID, email: 주소, link: 생략
  "callback_url": "https://n8n.example.com/webhook-waiting/abc",
  "timeout_minutes": 1440,
  "default_on_timeout": "rejected"   // approved | rejected | timed_out
}
```

응답:

```json
{
  "id": "apr_9f2c...",
  "status": "pending",
  "approve_url": "https://approve.yourdomain.com/a/<token>",
  "timeout_at": "2026-08-26T09:00:00.000Z",
  ...
}
```

`channel: "link"`면 아무것도 발송하지 않고 `approve_url`만 줍니다. 이 링크를 카톡·문자·기존 슬랙 노드 등 원하는 곳에 직접 보내면 됩니다. **가장 빨리 시작하는 방법.**

### 상태 조회 (폴링)

응답의 `callback` 필드로 "내가 승인 눌렀는데 자동화가 실행됐나?"에 답합니다: `waiting_for_decision` → `delivered` | `retrying` | `already_consumed` | `failed`.

```http
GET /v1/approvals/{id}
```

### 취소

```http
POST /v1/approvals/{id}/cancel
```

### 콜백 페이로드 (결정되면 `callback_url`로 POST)

```json
{
  "id": "apr_9f2c...",
  "status": "approved",
  "approved": true,
  "decided_by": "민수",
  "decided_at": "2026-08-25T05:32:10.000Z",
  "comment": null,
  "source": "slack",           // slack | web | timeout
  "question": "...",
  "context": { ... }
}
```

헤더 `x-approval-signature`: 본문의 HMAC-SHA256(SIGNING_SECRET). `x-approval-id`: 승인 ID.

### 통계

```http
GET /v1/stats
```
키별 상태 카운트와 콜백 성공 건수. 첫 주 신호 측정용.

### 전달 이력

```http
GET /v1/approvals/{id}/deliveries
```

## n8n 레시피 (슬랙 Send-and-Wait 대체)

`examples/n8n-approval-demo.json`을 n8n에 Import 하고 URL·키·채널 ID만 바꾸면 됩니다. 수동 구성은:

1. **HTTP Request** 노드
   - POST `https://approve.yourdomain.com/v1/approvals`
   - Header `Authorization: Bearer <key>`
   - Body(JSON): `question`, `context`, `channel: "slack"`, `to`, 그리고
     `"callback_url": "{{ $execution.resumeUrl }}"`
2. **Wait** 노드 — Resume: *On Webhook Call*, HTTP Method: POST
3. Wait 노드 출력의 `body.approved`로 IF 분기

`$execution.resumeUrl`은 Wait 노드보다 앞에서도 참조 가능합니다. 타임아웃은 우리가 처리하므로 Wait 노드의 Limit Wait Time은 우리 `timeout_minutes`보다 조금 길게 잡으세요(예: 우리 24h, n8n 25h).

## Make.com 레시피 (승인 단계 없는 플랜용)

시나리오 A (본 흐름):
1. **HTTP > Make a request** — POST `/v1/approvals`, `callback_url`에 시나리오 B의 Custom Webhook URL, `context`에 이어서 처리할 데이터 전부
2. 끝. (시나리오는 여기서 끝나도 됨 — 대기 비용 0)

시나리오 B (재개):
1. **Webhooks > Custom webhook** — 우리 콜백을 받음
2. **Router** — `approved = true`면 실행, 아니면 로그
3. `context`에 넣어둔 데이터로 후속 작업

Make의 두-시나리오 우회를 없애진 않지만, 승인 페이지·발송·타임아웃·기록을 안 만들어도 됩니다.

## 슬랙 (사용자당 클릭 한 번)

앱은 우리가 하나 소유하고, 사용자는 `https://<host>/slack/install?key=<키>`를 눌러 자기 워크스페이스에 설치합니다. 그 뒤 그 키로 보내는 `channel: "slack"` 요청은 그 사람 워크스페이스로 갑니다. 앱 자체 설정은 `DEPLOY.md`.

## (대안) 워크스페이스 하나만 쓸 때

1. api.slack.com/apps → Create New App → From scratch
2. OAuth & Permissions → Bot Token Scopes: `chat:write`, `chat:write.public`
3. Interactivity & Shortcuts → On → Request URL: `https://approve.yourdomain.com/slack/interactions`
4. Install to Workspace → `xoxb-...` 토큰을 `SLACK_BOT_TOKEN`에
5. Basic Information → Signing Secret을 `SLACK_SIGNING_SECRET`에

`to`에는 채널 ID(`C...`) 또는 유저 ID(`U...`). 비공개 채널이면 봇을 초대하세요.

## 이메일 채널

resend.com 가입 → 도메인 인증 → API 키를 `RESEND_API_KEY`에. 메일에는 "열어서 결정하기" 버튼 하나. 페이지에서 승인/거절.

## 테스트

```bash
npm test   # 생성 → GET 비결정 → POST 승인 → 콜백 → 멱등성 → 타임아웃, 약 35초
```

## 관리자

`POST /admin/keys` (헤더 `x-admin-secret`)로 재시작 없이 키 발급. `GET /admin/key-requests`로 랜딩 폼 요청 조회.

## 아직 안 하는 것 (일부러)

- 그룹 라우팅·승격, 중복 제거, 묶음 발송 — 첫 10팀이 실제로 겪는지 확인 후
- 다중 테넌트 대시보드 — API 키별 조회로 충분
- 카카오 채널 — 대행사 등록 비용 확인 후
