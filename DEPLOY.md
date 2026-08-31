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
| API_KEYS | 운영 점검용 비상 키 1개. 사용자 키는 검토 화면에서 발급 |
| SIGNING_SECRET | 32자 이상의 무작위 문자열 |
| ADMIN_SECRET | 24자 이상의 무작위 문자열. /admin/* 호출용 |
| DB_PATH | /data/someonehastosayyes.db |
| NODE_ENV | production |
| RESEND_API_KEY, EMAIL_FROM | 이메일 채널 쓸 때 |
| ADMIN_NOTIFY_EMAIL | 새 키 요청을 즉시 받을 운영자 이메일. 설정하면 접수·이메일 인증 완료 때 알림 |
| SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, SLACK_SIGNING_SECRET | 슬랙 채널 쓸 때 (아래) |
| NOTIFY_SLACK_CHANNEL | 운영자 알림을 받을 Slack 채널 ID. 이메일 알림만 쓰면 생략 |
| NOTIFY_SLACK_KEY | 위 채널에 연결된 키. 비우면 API_KEYS의 첫 번째 키 사용 |
| REVIEW_KEY_RATE_LIMIT | 검토 발급 키의 분당 승인 한도. 기본 60 |
| KEY_MONTHLY_APPROVAL_LIMIT | 키별 월 승인 한도. 기본 1000 |
| KEY_MONTHLY_EMAIL_LIMIT | 키별 월 승인 이메일 한도. 기본 300 |
| KEY_PENDING_LIMIT | 키별 동시 대기 승인 한도. 기본 100 |
| GLOBAL_MONTHLY_APPROVAL_LIMIT | 전체 월 승인 안전 한도. 기본 10000 |
| GLOBAL_DAILY_EMAIL_LIMIT | 전체 일 이메일 안전 한도. 기본 90 |
| GLOBAL_DAILY_KEY_REQUEST_LIMIT | 전체 일 키 요청 안전 한도. 기본 120 |

관리형 서비스는 안전을 위해 HTTPS 공개 콜백만 허용합니다. 사내망에서 직접 self-host하며 로컬 n8n 주소로 콜백해야 할 때만 `ALLOW_PRIVATE_CALLBACKS=true`를 명시적으로 설정하세요.

## 슬랙 앱 (한 번, 우리가 소유. 사용자는 "Add to Slack"만 누름)
1. api.slack.com/apps → Create New App → From scratch
2. OAuth & Permissions → Redirect URLs: `https://<도메인>/slack/oauth/callback` → Bot Token Scopes: `chat:write`, `chat:write.public`
3. Interactivity & Shortcuts → On → Request URL: `https://<도메인>/slack/interactions`
4. Basic Information → Client ID, Client Secret, Signing Secret 을 환경변수에
5. (선택) Manage Distribution → Activate Public Distribution — 다른 워크스페이스가 설치하려면 필요

키 발급 응답의 `slack_install_url`을 사용자에게 줍니다. 이 주소에는 API 키가 아니라 30일 뒤 만료되는 별도 설치 토큰만 들어갑니다.
설치되면 그 키로 보내는 슬랙 요청이 그 사람 워크스페이스로 갑니다.

## 키 발급 (수동 검토)
1. 사용자가 랜딩 폼을 제출합니다.
2. 운영자는 `ADMIN_NOTIFY_EMAIL` 또는 Slack으로 접수 알림을 즉시 받습니다.
3. 사용자가 이메일의 **Verify email** 버튼을 누릅니다. 이메일 보안 스캐너가 링크를 열기만 해서는 인증되지 않습니다.
4. 사용자가 인증을 마치면 운영자에게 검토 가능 알림이 한 번 더 갑니다.
5. 운영자는 `https://<도메인>/admin`을 열고 `ADMIN_SECRET`을 입력합니다.
6. 이메일 인증 여부, 같은 이메일·네트워크 요청, 기존·폐기 키를 확인합니다.
7. **Issue one key** 또는 **Reject**를 누릅니다.
8. 승인되면 사용자는 이메일의 24시간 링크에서 키를 한 번만 확인합니다.

직접 발급 API는 기본적으로 닫혀 있습니다. 로컬 복구 작업에만 `ALLOW_DIRECT_ADMIN_KEYS=true`를 잠시 설정하고, 끝나면 제거하세요.

## 배포 후 확인 (5분)
1. `/` 열어서 "Create approval" → 링크 열어 Approve → 스탬프 뜨는지
2. 본인 키로 슬랙 설치 링크 → 본인 채널에 `channel: slack` 요청 → 버튼 → 제자리 갱신
3. n8n에 `examples/n8n-approval-demo.json` 임포트 → 실행 → 슬랙 승인 → 재개
