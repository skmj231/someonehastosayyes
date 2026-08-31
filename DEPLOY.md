# 배포 (30분)

## 가장 빠른 길: Railway
1. 이 폴더를 깃허브 저장소로 올림 (`node_modules`, `*.db` 제외)
2. railway.app → New Project → Deploy from GitHub repo
3. Variables 탭에 아래 입력. `BASE_URL`은 Railway가 준 도메인(Settings → Networking → Generate Domain) 그대로.
4. Volumes → Add Volume → mount path `/data` (DB가 재배포 때 안 날아가게)
5. `https://<도메인>/health` 가 `{"ok":true}` 면 끝

## 환경변수
| 이름 | 값 |
|---|---|
| BASE_URL | https://<도메인> (끝에 / 없이) |
| API_KEYS | 선택. 기존 운영 키나 비상 키. 새 사용자 키는 이메일 확인 후 자동 발급 |
| SIGNING_SECRET | 32자 이상의 무작위 문자열 |
| ADMIN_SECRET | 24자 이상의 무작위 문자열. /admin/* 호출용 |
| DB_PATH | /data/someonehastosayyes.db |
| NODE_ENV | production |
| RESEND_API_KEY, EMAIL_FROM | 이메일 채널 쓸 때 |
| SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, SLACK_SIGNING_SECRET | 슬랙 채널 쓸 때 (아래) |
| NOTIFY_SLACK_CHANNEL | HIGH/CRITICAL 운영 알림을 받을 Slack 채널 ID |
| NOTIFY_SLACK_KEY | 위 채널에 연결된 키. 비우면 API_KEYS의 첫 번째 키 사용 |
| INITIAL_RPM_LIMIT | 이메일 확인 후 자동 발급 키의 분당 요청. 기본 10 |
| INITIAL_APPROVALS_MONTH | 자동 발급 키의 월 승인. 기본 50 |
| INITIAL_EMAILS_MONTH | 자동 발급 키의 월 이메일. 기본 30 |
| INITIAL_PENDING_LIMIT | 자동 발급 키의 동시 대기. 기본 10 |
| INITIAL_CALLBACK_DOMAINS | 자동 발급 키의 콜백 도메인 수. 기본 3 |
| GLOBAL_DAILY_COST_GUARD_USD | 전체 추정 일 비용 보호선. 기본 $25 |
| NEW_ACCOUNT_DAILY_COST_GUARD_USD | 최근 인증 계정 묶음의 추정 일 비용 보호선. 기본 $5 |

관리형 서비스는 안전을 위해 HTTPS 공개 콜백만 허용합니다. 사내망에서 직접 self-host하며 로컬 n8n 주소로 콜백해야 할 때만 `ALLOW_PRIVATE_CALLBACKS=true`를 명시적으로 설정하세요.

## 슬랙 앱 (한 번, 우리가 소유. 사용자는 "Add to Slack"만 누름)
1. api.slack.com/apps → Create New App → From scratch
2. OAuth & Permissions → Redirect URLs: `https://<도메인>/slack/oauth/callback` → Bot Token Scopes: `chat:write`, `chat:write.public`
3. Interactivity & Shortcuts → On → Request URL: `https://<도메인>/slack/interactions`
4. Basic Information → Client ID, Client Secret, Signing Secret 을 환경변수에
5. (선택) Manage Distribution → Activate Public Distribution — 다른 워크스페이스가 설치하려면 필요

키 발급 응답의 `slack_install_url`을 사용자에게 줍니다. 이 주소에는 API 키가 아니라 30일 뒤 만료되는 별도 설치 토큰만 들어갑니다.
설치되면 그 키로 보내는 슬랙 요청이 그 사람 워크스페이스로 갑니다.

## 키 발급
1. 사용자가 랜딩 폼을 제출합니다.
2. 사용자가 이메일의 확인 링크를 엽니다. 링크를 여는 GET만으로는 발급되지 않아 메일 보안 스캐너에도 안전합니다.
3. 사용자가 확인 버튼을 누르면 작은 한도가 붙은 실제 키가 즉시 한 번만 표시됩니다.
4. 더 큰 사용량이나 권한은 access request로 보내고 `/admin/key-requests`에서 검토합니다.
5. 운영자는 네 가지 위험 축과 근거를 남기고 승인·조건부 승인·추가 정보 요청·거절 중 하나를 선택합니다.

직접 발급 API는 기본적으로 닫혀 있습니다. 로컬 복구 작업에만 `ALLOW_DIRECT_ADMIN_KEYS=true`를 잠시 설정하고, 끝나면 제거하세요.

## 비용 확인

`/admin/costs`는 요청과 발송이 일어날 때 Estimated Cost를 바로 계산합니다. 공급자 청구서/API 자동 수집은 별도 조회 비용과 장애 지점을 만들기 때문에 연결하지 않습니다. 실제 청구액이 나오면 관리자 reconciliation API로 입력해 Estimated와 Actual을 나란히 비교합니다.

## 배포 후 확인 (5분)
1. `/` 열어서 "Create approval" → 링크 열어 Approve → 스탬프 뜨는지
2. 본인 키로 슬랙 설치 링크 → 본인 채널에 `channel: slack` 요청 → 버튼 → 제자리 갱신
3. n8n에 `examples/n8n-approval-demo.json` 임포트 → 실행 → 슬랙 승인 → 재개
4. `/admin`에서 트래픽·신뢰성·사건·비용 화면이 열리는지 확인
5. 테스트 명령 전체 통과 확인: `npm test`, `npm run test:key-review`, `npm run test:reliability`, `npm run test:recovery`, `npm run test:callback-restart`, `npm run test:tenant-isolation`, `npm run test:key-migration`, `npm run test:load`
