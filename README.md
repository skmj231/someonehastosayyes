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
| resumeUrl 일회용 | 첫 결정만 기록. 콜백은 같은 승인 ID로 재시도하고 404/409/410이면 "이미 소비됨"으로 보고 중단 |
| 메일 보안 스캐너가 링크를 미리 열어 자동 승인됨 | GET은 절대 결정하지 않음. 결정은 POST만 |
| 타임아웃이 뭔지 모른다 | 요청마다 `timeout_minutes` + `default_on_timeout` 명시. 기본 24시간, 기본값 거절 |
| 콜백이 유실된다 | 최대 10회 재시도(약 46시간), Ed25519 서명, 전달 이력 API |

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
Idempotency-Key: <YOUR_WORKFLOW_EXECUTION_ID>
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

`Idempotency-Key`는 선택 사항이지만 운영 환경에서는 권장합니다. 네트워크 오류로 같은 생성 요청을 다시 보내도 같은 승인 건을 반환하므로, 승인 메시지가 두 개 생기지 않습니다.

`context`에는 승인 화면에 꼭 필요한 최소 정보만 넣으세요(최대 20KB). 주문 원문, 고객 파일, 전체 업무 데이터는 n8n/Make에 두고 `order_id` 같은 참조값만 보내는 방식을 권장합니다.

Slack·이메일 발송은 먼저 SQLite 영속 큐에 기록됩니다. 외부 서비스가 일시적으로 실패하면 응답은 `202`와 `notification.state: "retrying"`을 반환하고 약 2일 동안 백오프로 자동 재시도합니다. 서버가 재시작돼도 이어지며, Resend `Idempotency-Key`와 Slack `client_msg_id`로 중복 발송을 막습니다.

### 상태 조회 (폴링)

응답의 `callback` 필드로 "내가 승인 눌렀는데 자동화가 실행됐나?"에 답합니다: `waiting_for_decision` → `delivered` | `retrying` | `endpoint_gone` | `failed`.

```http
GET /v1/approvals/{id}
```

### 취소

```http
POST /v1/approvals/{id}/cancel
```

취소도 `status: "canceled"`, `approved: false`인 최종 콜백을 보내므로 기다리던 워크플로가 멈춘 채 남지 않습니다.

### 콜백 페이로드 (결정되면 `callback_url`로 POST)

```json
{
  "id": "apr_9f2c...",
  "status": "approved",
  "approved": true,
  "decided_by": "민수",
  "decided_at": "2026-08-25T05:32:10.000Z",
  "comment": null,
  "source": "slack",           // slack | web | timeout | api
  "question": "...",
  "context": { ... }
}
```

헤더 `x-approval-signature`: 본문의 Ed25519 서명. `x-approval-key-id`: 공개키 ID. `x-approval-id`: 승인 ID. 공개키는 `/.well-known/approval-signing-key`, 검증 도우미는 `POST /v1/verify`에서 제공합니다.

### 통계

```http
GET /v1/stats
```
키별 상태 카운트와 콜백 성공 건수. 첫 주 신호 측정용.

### 전달 이력

```http
GET /v1/approvals/{id}/deliveries
```

Slack·이메일 알림의 성공, 실패, 재시도 이력:

```http
GET /v1/approvals/{id}/notifications
```

### 보관과 삭제

- 대기 건: 결정·취소·타임아웃까지(최대 90일)
- 결정된 운영 기록: 90일
- 콜백·알림의 상세 시도 기록: 30일
- 서명된 결정 영수증: 1년

현재 정책과 환경별 설정값은 `GET /v1/retention`에서 확인합니다. 결정된 한 건과 영수증을 즉시 지우려면 `DELETE /v1/approvals/{id}`를 사용합니다. 키에 속한 모든 데이터를 지우려면 `DELETE /v1/data`에 `{"confirm":"DELETE ALL DATA"}`를 보냅니다. 대기 중인 건은 기다리는 자동화를 보호하기 위해 먼저 결정하거나 취소해야 합니다.

## n8n 레시피 (슬랙 Send-and-Wait 대체)

`examples/n8n-approval-demo.json`을 n8n에 Import 하고 URL·키·채널 ID만 바꾸면 됩니다. 수동 구성은:

1. **HTTP Request** 노드
   - POST `https://approve.yourdomain.com/v1/approvals`
   - Header `Authorization: Bearer <key>`
   - Header `Idempotency-Key: {{ $execution.id }}` (실행 재시도 때 승인 중복 생성 방지)
   - Body(JSON): `question`, `context`, `channel: "slack"`, `to`, 그리고
     `"callback_url": "{{ $execution.resumeUrl }}"`
2. **Wait** 노드 — Resume: *On Webhook Call*, HTTP Method: POST
3. Wait 노드 출력의 `body.approved`로 IF 분기

`$execution.resumeUrl`은 Wait 노드보다 앞에서도 참조 가능합니다. 타임아웃은 우리가 처리하므로 Wait 노드의 Limit Wait Time은 우리 `timeout_minutes`보다 조금 길게 잡으세요(예: 우리 24h, n8n 25h).

## Make.com 레시피 (승인 단계 없는 플랜용)

시나리오 A (본 흐름):
1. **HTTP > Make a request** — POST `/v1/approvals`, `callback_url`에 시나리오 B의 Custom Webhook URL, `context`에는 후속 데이터를 찾을 ID와 승인에 필요한 최소 정보
2. 끝. (시나리오는 여기서 끝나도 됨 — 대기 비용 0)

시나리오 B (재개):
1. **Webhooks > Custom webhook** — 우리 콜백을 받음
2. **Router** — `approved = true`면 실행, 아니면 로그
3. `context`에 넣어둔 데이터로 후속 작업

Make의 두-시나리오 우회를 없애진 않지만, 승인 페이지·발송·타임아웃·기록을 안 만들어도 됩니다.

## 슬랙 (사용자당 클릭 한 번)

앱은 우리가 하나 소유하고, 사용자는 키 발급 때 받은 `slack_install_url`을 눌러 자기 워크스페이스에 설치합니다. 링크에는 API 키 대신 30일 뒤 만료되는 별도 설치 토큰만 들어갑니다. 새 링크가 필요하면 API 키로 `POST /v1/slack/install-link`를 호출합니다. 설치 뒤 그 키로 보내는 `channel: "slack"` 요청은 그 사람 워크스페이스로 갑니다. 앱 자체 설정은 `DEPLOY.md`.

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
npm run test:key-review   # 이메일 인증 → 제한된 실제 키 자동 발급 → 기본 한도 확인
npm run test:reliability   # 중복 생성·동시 클릭·재시도·취소·서명·보안 경계, 약 2초
npm run test:recovery      # 이메일·Slack 장애/재시작/중복 방지와 보관·삭제
npm run test:callback-restart # 콜백 전송 직전·전송 중 재시작 복구
npm run test:tenant-isolation # 고객 내용이 운영자 Slack으로 유출되지 않는지 확인
npm run test:key-migration # 기존 평문 키를 해시 키 구조로 안전하게 이전
npm run test:load          # 500건 생성/조회, 멱등성 경쟁, 속도 제한
```

## 관리자

랜딩의 `Ready to install`에서 이메일을 확인하면 작은 한도가 붙은 **실제 API 키**가 바로 발급됩니다. 별도 가짜 sandbox는 없습니다. 기본값은 분당 10건, 월 승인 50건, 월 승인 이메일 30건, 동시 대기 10건, 콜백 도메인 3개이며 환경변수로 조정할 수 있습니다. 키 원문은 발급 화면에서만 보이고 DB에는 해시만 남습니다.

더 큰 한도나 권한은 별도 access request로 받고, 관리자가 Identity confidence / Intended use / Requested blast radius / Behavioral history 네 축을 보고 `APPROVE`, `APPROVE_WITH_LIMITS`, `REQUEST_INFO`, `DENY` 중 하나로 결정합니다. 근거와 결과는 감사 기록에 남습니다.

운영 화면은 `/admin`, `/admin/key-requests`, `/admin/accounts`, `/admin/traffic`, `/admin/reliability`, `/admin/incidents`, `/admin/costs`로 나뉩니다. 키는 한도·권한 수정, 제한, 정지, 복구, 교체, 폐기가 가능하고 hard delete는 노출하지 않습니다. 잘못 발급한 키는 `ISSUED_BY_MISTAKE` 사유로 폐기합니다.

위험 감시는 요청·이메일·대기·오류·잘못된 요청·새 콜백 도메인·다중 IP·한도 우회·비용 증가 등을 최근 평소 사용량과 함께 봅니다. 상태는 `NORMAL → WATCH → THROTTLED → SUSPENDED → REVOKED`이며, 비싼 이메일 기능부터 줄이고 이미 결정된 콜백은 최대한 보존합니다. HIGH/CRITICAL 사건만 운영자 Slack으로 즉시 알리고, 상세 내용과 조치는 Admin incident를 기준으로 합니다.

비용 화면은 요청 시점의 Estimated Cost와 관리자가 입력한 provider Actual/Reconciled Cost를 분리합니다. 청구서 자동 수집이나 공급자 API 주기 조회는 운영비와 복잡도를 늘리므로 현재는 연결하지 않습니다. 실제 청구액은 `/admin/costs/reconcile`에 수동 입력합니다.

`POST /admin/keys` 직접 발급은 기본적으로 닫혀 있습니다. 복구나 로컬 개발에서 정말 필요할 때만 `ALLOW_DIRECT_ADMIN_KEYS=true`를 명시합니다.

## 아직 안 하는 것 (일부러)

- 그룹 라우팅·승격, 중복 제거, 묶음 발송 — 첫 10팀이 실제로 겪는지 확인 후
- 공급자 청구서 자동 수집 — 추정 비용은 실시간 계산하고 실제 청구액은 수동 대조
- 카카오 채널 — 대행사 등록 비용 확인 후
