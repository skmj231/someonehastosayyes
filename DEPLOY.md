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
| API_KEYS | 본인용 키 1개 (나머지는 /admin/keys로 발급) |
| SIGNING_SECRET | 아무 긴 문자열 |
| ADMIN_SECRET | 아무 긴 문자열. /admin/* 호출용 |
| DB_PATH | /data/someonehastosayyes.db |
| RESEND_API_KEY, EMAIL_FROM | 이메일 채널 쓸 때 |
| SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, SLACK_SIGNING_SECRET | 슬랙 채널 쓸 때 (아래) |

## 슬랙 앱 (한 번, 우리가 소유. 사용자는 "Add to Slack"만 누름)
1. api.slack.com/apps → Create New App → From scratch
2. OAuth & Permissions → Redirect URLs: `https://<도메인>/slack/oauth/callback` → Bot Token Scopes: `chat:write`, `chat:write.public`
3. Interactivity & Shortcuts → On → Request URL: `https://<도메인>/slack/interactions`
4. Basic Information → Client ID, Client Secret, Signing Secret 을 환경변수에
5. (선택) Manage Distribution → Activate Public Distribution — 다른 워크스페이스가 설치하려면 필요

사용자에게 주는 설치 링크: `https://<도메인>/slack/install?key=<그 사람 키>`
설치되면 그 키로 보내는 슬랙 요청이 그 사람 워크스페이스로 갑니다.

## 키 발급 (재시작 없이)
```bash
curl -X POST https://<도메인>/admin/keys -H "x-admin-secret: $ADMIN_SECRET" \
  -H "content-type: application/json" -d '{"label":"steve — n8n 404 thread"}'
# → { key, slack_install_url }
```
랜딩 폼으로 들어온 요청 보기:
```bash
curl https://<도메인>/admin/key-requests -H "x-admin-secret: $ADMIN_SECRET"
```

## 배포 후 확인 (5분)
1. `/` 열어서 "Create approval" → 링크 열어 Approve → 스탬프 뜨는지
2. 본인 키로 슬랙 설치 링크 → 본인 채널에 `channel: slack` 요청 → 버튼 → 제자리 갱신
3. n8n에 `examples/n8n-approval-demo.json` 임포트 → 실행 → 슬랙 승인 → 재개
