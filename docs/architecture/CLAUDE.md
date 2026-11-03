---
description: When changing IPC, storage, or a subsystem and you need the current contract
authority: Feature inventory, data flow, session lifecycle, storage schema, and the IPC channel list
status: active
owner: maintainer
last-reviewed: 2026-08-18
---

# Architecture Reference

Detail that is needed when working **inside** a subsystem, split out of the root
[`CLAUDE.md`](../../CLAUDE.md) so that file stays loadable every session. Invariants and safety
rules stay in the root; this file is the inventory.


## Key Features

#### 1. Workspace Management
- 폴더를 워크스페이스로 추가하고 여러 터미널 세션 관리
- 각 워크스페이스는 독립적인 세션 목록 보유
- 워크스페이스별 Git 브랜치 정보 표시
- 사이드바 헤더: 프로젝트 검색(이름·경로·사이드바 폴더명·워크트리 브랜치, Enter = 첫 결과의 첫 세션 열기, Esc = 닫기),
  전체 접기/복원(폴더 + 세션 목록. 세션은 종료하지 않는다)
- 우클릭 복사: 세션 — Copy Name / Copy Path(세션 시작 디렉토리) / Copy Session ID(Control API 가 쓰는 id),
  워크스페이스 — Copy Name / Copy Path, 워크트리 — Copy Branch / Copy Path

#### 2. Playground
- 임시 작업용 디렉토리 자동 생성 (Downloads 폴더에 timestamp 기반)
- 빠른 실험 및 테스트용 격리된 환경 제공

#### 3. Git Worktree Support (NEW)
- **Worktree를 별도 Workspace로 관리**
  - 부모 workspace 아래 트리 구조로 표시
  - 각 worktree workspace는 여러 터미널 세션 보유 가능
  - 독립적인 작업 환경 제공
- **자동 생성**: 브랜치명 입력 시 자동으로 worktree 생성 및 workspace 추가
- **자동 삭제**: Worktree workspace 삭제 시 `git worktree remove` 실행 및 디렉토리 제거

#### 4. GitHub Integration (NEW)
- **Push to GitHub**: Worktree 브랜치를 GitHub로 직접 푸시
- **Create PR**: Pull Request 생성 (제목, 설명 입력 가능)
- **gh CLI 연동**: GitHub CLI를 통한 인증 및 작업 수행
- **Workflow Status**: GitHub Actions 워크플로우 상태 확인

#### 5. Port Monitoring
- 로컬 개발 서버 포트를 실시간 감지 및 표시 (macOS only)
- 포트 필터링 기능 (최소/최대 포트 설정)

#### 6. Session Persistence
- 모든 터미널 세션을 DOM에 유지하여 탭 전환 시에도 상태 보존
- `display: none` 방식으로 비활성 세션 숨김
- **히스토리는 main 프로세스에 있다** — 렌더러가 죽거나(자동 새로고침) 창을 다시 열어도 미러(`TerminalMirror`, 2000줄)에서
  다시 그리고, `ScrollbackStore` 가 30초마다 디스크에 저장해 강제종료 뒤에도 "Restored from previous session" 줄과 함께
  되살린다 ([`docs/decisions/0008`](../decisions/0008-terminal-history-lives-in-main.md)). 회귀는 `t29-scrollback-survival.spec.ts`

#### 7. Custom Terminal Templates
- 자주 사용하는 명령어를 템플릿으로 저장
- 아이콘, 이름, 설명, 명령어 커스터마이징
- 새 터미널 생성 시 템플릿 선택 가능

#### 8. Official Agent Integration (NEW)
- **공식 훅 기반 상태 감지** — 화면 추측(heuristic) 대신 CLI가 알려주는 이벤트를 사용
  - Claude Code: `SessionStart` / `UserPromptSubmit` / `Stop` / `PermissionRequest` / `Notification` / `SessionEnd`
  - Codex: `agent-turn-complete` (유일한 이벤트 — 턴 **시작**은 입력 가로채기로 보완)
- **Permission Inbox 신호**: 승인 대기 세션은 사이드바에서 앰버 펄스 + OS 알림
- **기존 heuristic은 fallback으로 유지** — 훅 미설치 세션은 이전과 동일하게 동작
- **화면으로 읽는 상태 점(hook 없이, 1.23.0)** — Settings › General 「Show Session Status」(기본 끔). main 의 `SessionScreenStatusPoller` 가 1초마다 미러 화면을 읽어 작업 중(파란 점)·질문 대기(노란 점, 툴팁에 질문 줄)를 정한다. 켜져 있으면 위 두 방식의 사이드바 배지를 대신한다(hook 의 running·awaitingInput 은 판정에 그대로 들어간다)

#### 9. Usage / Rate Limit Tracking (NEW)
- 제공자가 **직접 보고한 값** (추정 아님, `/usage`·`/status`와 일치)
  - Claude Code: statusLine payload의 `rate_limits.five_hour` / `.seven_day`
  - Codex: `~/.codex/sessions/**/rollout-*.jsonl`의 `rate_limits` — **주간 윈도우 기준**
- StatusBar 우측에 표시, 임계값 초과 시 데스크톱 알림 (Settings > Agents에서 % 조절)

#### 10. Diff Review (NEW)
- 헤더 Source Control 옆 버튼 → 중앙 모달
- worktree는 `baseBranch ← 현재 브랜치` 전체 비교 (merge-base 기준이라 **미커밋 변경도 포함**)
- untracked 파일도 표시 (에이전트가 만든 새 파일이 `git diff`에선 안 보이기 때문)
- 라인 선택(shift-click 범위) → 코멘트 → 대상 세션 터미널로 프롬프트 전송

#### 11. Session Memo
- 각 터미널 세션마다 독립적인 메모장 제공
- 터미널 우상단 아이콘 클릭으로 빠르게 열기/닫기
- 500ms 디바운스 자동 저장 (electron-store에 세션 데이터와 함께 저장)
- 메모가 있으면 아이콘이 노란색으로 변경되어 내용 존재를 표시
- Escape 키로 즉시 닫기
- 세션 삭제 시 메모도 자동 삭제 (TerminalSession.memo 필드)
- **페이지**(1.20, 제보 533a22ba): 머리 줄 「새 페이지」(맨 끝에 빈 쪽) · ‹ ›(양 끝에서 돌아 감) · `n / N` · 쪽 지우기(글이 있는 쪽은 두 번 눌러야). 쪽이 하나면 넘김·지우기 버튼은 숨는다. 복사는 **보고 있는 쪽**만
  - 저장: 1쪽은 그대로 `memo`, 2쪽부터 `memoPages`. 1.19 이전 앱은 `memo` 만 읽고 쓰므로 그 판으로 열어도 1쪽은 그대로 보이고, 옛 판이 1쪽을 고쳐도 `memoPages` 는 남는다(옛 main 은 세션 객체의 모르는 칸을 지우지 않는다). `update-session-memo` 는 네 번째 인자(2쪽부터)를 보낼 때만 `memoPages` 를 바꾼다
  - 예전 한 장 메모의 `-----` 구분선은 자동으로 쪼개지 않는다 — 1쪽에 그대로
  - Related 줄의 메모 미리보기는 모든 쪽에서 첫 줄. Control API 는 `memo`(1쪽)와 `memoPages`(전체, 1쪽부터)를 싣는다

#### 12. AI Control API (NEW)
- 다른 AI(Claude Code 등)가 폴더를 골라 세션을 열고, 템플릿 실행·프롬프트 입력·완료 대기·화면 읽기를 한다
- 사용자는 그 세션을 앱에서 그대로 보고 끼어들 수 있다 — AI 세션은 사이드바 녹색 + 헤더 "AI connected"
- REST(`/v1`) + MCP(`/mcp`), 로컬 전용·토큰 필수·기본 꺼짐. 계약: [`control-api.md`](control-api.md)

#### 14. 관련 세션 (Related sessions)
- 세션 헤더(단일 화면 오른쪽 「Related」, 분할 칸 헤더의 아이콘)에서 그 세션과 관련된 세션을 모달로 본다 — 0개여도 버튼은 보인다(손으로 추가하는 곳이라서)
- 자동 등록: 에이전트가 `X-Caller-Session` 을 붙여 세션을 **열 때**(`opened`)와 다른 세션을 **처음 읽거나 입력할 때**(`connected`). 터미널 출력(링크 글자)으로는 등록하지 않는다
- 손으로 추가·빼기. 뺀 쌍은 표시(`dismissed`)를 남겨 에이전트의 다음 호출이 다시 넣지 않게 하고, 손으로 다시 넣으면 풀린다
- 모달은 **관계만** 보인다(1.20 에서 Recent·All 탭을 뺐다 — 제보 c17aa9c4 · 모든 세션 목록은 사이드바 All sessions 에 있다). 탭 자리에는 Sort 만 남고, 관계가 하나도 없으면 그 줄도 없다. 「Recently viewed」 정렬은 그대로 `getRecentSessions` 를 읽는다. 관계 나무는 `sessionTreeFor`(`relatedSessions.ts`)가 `from` 을 부모로 삼아(`opened`·`connected` 둘 다) 위(나를 연 쪽, 여러 겹 · 뿌리가 맨 위)·옆(같은 부모가 연 형제)·아래(내가 연 것, 손자까지 들여쓰기)를 한 나무로 그린다. 방향 없는 `manual` 은 나무 밖 「Added by hand」. 고리는 한 번 놓은 세션을 건너뛰어 끊고(아래 → 위 → 옆 순으로 놓음), 깊이는 `MAX_TREE_DEPTH = 6`. 중간 세션이 닫히면 그 아래는 안 보인다(알려진 한계). 구역 속성 `data-related-tree="up|side|down|manual"` 에 옛 묶음 이름 `data-related-group="toHere|side|fromHere|manual"` 을 함께 둔다 — T35 가 그걸로 본다. 줄 끝 「#」는 세션 ID 복사
- 모달(묶음 이름은 위와 같음): 「Opened from this session」 / 「Opened this session」 / 「Added by hand」 · 상태(Working/Waiting for you/Idle — main 의 화면 사본 기준) · 마지막 줄(길면 **앞을** 잘라 끝 — 보통 지금 폴더 — 이 보인다) · 메모 · 이름이 `대화:` 로 시작하면 「Talk」 배지. 누르면 사이드바 클릭과 같게 이동. 「Open side by side」는 **지금 세션을 첫 칸**에 두고 고른 세션(최대 3)을 뒤에 — 세션 링크와 같은 경로
- 어느 쪽이든 세션이 닫히면(API·사이드바·워크스페이스 삭제) 그 관계는 저장소에서도 지워진다. 시작 때 없는 세션을 가리키는 관계를 정리한다
- 코드: `src/main/SessionRelations.ts`(저장) · `ControlApiService`(자동 등록·`peekSessions`) · `src/renderer/src/utils/relatedSessions.ts`(묶음·나무 계산) · `components/RelatedSessions/`(`RelationTree.tsx` = 관계 탭)
- **끌어서 넣기**(1.20, 제보 269168e4): 사이드바 세션 줄을 다른 세션 줄 위에 놓으면 둘을 Related 에 넣는다 — 창의 손으로 추가와 같은 `add-session-relation` 이라 × 로 뺀 쌍도 사람이 끌어 넣으면 되살아난다(자동 등록은 여전히 못 살린다). 폴더 보기·All sessions·검색 결과의 줄이 모두 같다(`SessionItem`). 놓을 줄에 초록 테두리 + 「Relate」, 놓은 뒤 사이드바 아래 「Related: A ↔ B」/「Already related: …」. 자기 줄 위에서는 아무것도 안 뜬다. 끄는 id 는 `Sidebar/sessionDrop.tsx` 컨텍스트로 준다 — dragover 는 끌기 데이터를 못 읽는다. Control API 경로는 그대로(928ba6b5)

#### 14-1. 세션 폴더 (All sessions 보기)
- 1.20(제보 078ee766): 세션은 워크스페이스 소속을 그대로 두고 **세션 폴더 하나**에 더 들어갈 수 있다. 세션 폴더는 All sessions 보기에만 보인다 — 폴더(접기·개수) 먼저, 그 안은 목록과 같은 순서(고정 → 최근 본 순), 그 아래 「No folder」와 나머지
- 만들기: All 보기 「…」 → New Session Folder(`sidebar-new-session-folder`). 같은 메뉴의 Collapse/Expand All(`sidebar-collapse-session-folders`)은 세션 폴더가 있을 때만. 폴더 보기의 「…」(워크스페이스 폴더)와 같은 자리 — 메뉴가 보기를 따른다(afbc3546)
- 넣기·빼기: 세션 줄을 폴더 줄에 끌어 놓기 / 「No folder」 줄에 놓기. 세션 줄 위에 놓으면 폴더가 아니라 관계(위 14). 이름 바꾸기·지우기는 폴더 줄 우클릭(워크스페이스 폴더와 같은 `FolderContextMenu`). 지워도 세션은 그대로 — 「No folder」로
- 없는 폴더를 가리키는 `sessionFolderId` 는 폴더 없음으로 읽는다(옛 판·다른 창에서 지운 경우). 1.19 이전 앱은 두 칸 모두 모른다 — 세션은 예전처럼 평평하게
- 코드: `src/main/SessionFolders.ts`(저장 · T57) · `hooks/useSessionFolders.ts`(렌더러 상태 — 바로 바꾸고 뒤에서 저장) · `Sidebar/SidebarAllSessions.tsx`(목록·폴더 줄·놓기)

#### 15. Chat view (Terminal / Chat)
- 세션 헤더의 「Terminal / Chat」(단일 화면 오른쪽 줄 맨 앞, 분할 칸 헤더 아이콘) — Claude Code·Codex 세션(`cliToolName` 이 claude·codex)에만.
  세션마다 기억한다(localStorage `session-view-modes`, Chat 만 저장). 터미널은 밑에 그대로 살아 있다 — Chat 은 그 위에 덮는 층이라
  PTY 크기·리페인트가 없다(렌더링 불변식 2 그대로)
- **읽기**: 에이전트의 대화 기록 파일 — Claude `<CLAUDE_CONFIG_DIR|~/.claude>/projects/<cwd 슬러그>/<cliSessionId>.jsonl`(없으면 projects 전체에서 찾음),
  Codex `<CODEX_HOME|~/.codex>/sessions/YYYY/MM/DD/rollout-…-<id>[_<segment>].jsonl`. `TranscriptReader` 가 늘어난 바이트만 읽고(첫 읽기는 끝 16MB —
  241MB 기록 42ms 실측), 해석은 ovis 에서 옮긴 `src/main/transcript/`(Claude·Codex 파서, MIT — `THIRD_PARTY_NOTICES.md`)
- **화면 쪽**: 「일하는 중」(`esc to interrupt`)과 질문 메뉴는 기록이 아니라 살아 있는 화면(미러)에서 `promptScreen.readPrompt` 로 읽는다 —
  보기·강조된 보기·설명·「Type something.」. 카드 답은 화살표 + Enter(직접 입력은 그 줄로 가서 글 + Enter). **보내기 직전 화면을 다시 읽어
  같은 메뉴(질문·보기·강조 위치·맥락 = `signature`)가 아니면 보내지 않는다**(`prompt_changed`). Codex 메뉴·다중 선택은 실제 화면 사본이 없어
  「Answer in Terminal」만
- **보내기**: Control API 의 입력 경로(`ControlApiService.typeForChat` = `typeAndSubmit`, AI 표시 없음) — 질문 대기면 거부, 터미널 입력줄(입력 상자)에
  글이 있으면 거부(사람·AI·Chat 글이 섞이지 않게), 일하는 중이면 main 의 대기열에 두고 턴이 끝나 1.5초 조용하면 보낸다
- `ConversationService` 는 Chat 이 열린 세션(또는 대기열이 있는 세션)만 0.7초마다 본다 — 기록 stat + 출력이 있었을 때만 화면 읽기. 바뀌면
  `conversation-changed` 로 알리고 화면이 다시 가져간다
- **폰과의 약속**: `ChatView/` 는 `window.api` 를 부르지 않는다 — `ChatTransport`(`src/shared/conversation.ts`: 가져오기 · 구독 · 보내기 · 대기 취소 ·
  카드 답)를 props 로 받는다. Electron 은 `utils/electronChatTransport.ts`(IPC), 폰 페이지는 같은 묶음을 HTTP·WebSocket 으로 채워 같은 부품을 쓴다.
  데이터(`ConversationSnapshot`)는 main 에서 한 번만 만든다
- **2회차(ovis 대비 빠진 것 — 배치 폴더 `gap.md` 107줄 전수)**:
  - 파일: ＋ · 붙여넣기 · 끌어 놓기 → 메시지에 `@path`(공백이면 `@"…"`). 같은 Mac 이라 제 경로를 그대로, 경로 없는 붙여넣기만 `os.tmpdir()/climanager-chat/<날짜>/<시각>-<난수>.<확장자>`.
    답·도구 줄의 경로(ovis `filePaths` 이식 — `:12`·`#L12`, 상대 경로는 세션 폴더 기준) → 앱 미리보기, PDF·영상 등은 `shell.openPath`.
    그림(프롬프트·도구 결과)은 `TranscriptReader.image(ref)` 가 기록에서 그 줄을 다시 읽어 data: URL — 끝에서 거꾸로 찾는다(`findRecord`). 잘린 출력도 같은 길(`toolOutput`)
  - 작업 상태: Stop = Esc 를 **화면이 일하는 중일 때만** 보낸다(쉬는 중 Esc 는 메뉴·입력칸에 떨어진다). 대기열은 id 를 가진 줄 — 하나씩 Send now(바로 친다,
    읽는 때는 에이전트가 정함)·버리기. 치는 중(`sending`)에 온 보내기도 대기열 뒤로(두 보내기가 동시에 치지 않게)
  - 모델: `transcript/metadata.ts`(ovis conversation-metadata 이식) — Claude 답의 `message.model`·`effort`·usage, /model 답(「Set model to `Sonnet 5`」),
    Codex `turn_context`·`token_count`(창 크기 → %). 바꾸기는 에이전트의 `/model` 뿐: Claude 는 그 선택을 새 세션 기본값(settings.json)으로도 저장하므로
    칩은 반드시 확인을 거친다. 인자 없는 `/model`·`/config` 처럼 터미널만 그리는 명령(`chatCommands.ts` 의 `terminal`)은 보낸 뒤 터미널 + 「Back to Chat」 띠
  - 화면 읽기: `refreshScreen` 하나 — 미러를 flush 한 뒤 읽고 그 출력 시각까지만 「읽음」. (flush 없이 읽던 1회차는 그리기 전 화면을 읽어 답한 뒤에도
    카드가 남거나, 새 질문 카드가 안 뜰 수 있었다)
  - 단축키: `toggleChatView` ⌘⇧M · `focusChatInput` ⌘⇧I · `scrollPaneUp/Down` ⌘⇧PgUp/PgDn(그룹 「Chat View」). 입력칸 안에서도 먹도록 입력 칸 건너뛰기
    앞에서 맞춘다. 저장된 키와 겹치는 새 기본값은 `effectiveShortcuts` 가 비운다
- 아직 안 하는 것: 수식·Mermaid, 하위 에이전트 상세·BG, 가상 목록, Claude 회색 제안(Tab), 취소된 보내기 되돌리기, 답 댓글, 터미널 선택 인용,
  Codex·다중 선택 카드 버튼(실제 화면 사본이 없다) — 이유와 크기는 `gap.md` 「다음 판」
- 회귀: `t73-chat-view-unit.spec.ts`(해석·리더·메뉴 판정, Electron 없이) · `t74-chat-view.spec.ts`(앱 — `scripts/mock-cli/chat-mock.cjs` 가 화면과
  기록 파일을 함께 만든다)

#### 16. Phone connection (Settings › Phone)
- 근거: [`../decisions/0009-phone-connection-second-server.md`](../decisions/0009-phone-connection-second-server.md). 기본 꺼짐 — 켜면 main 안
  두 번째 서버(`src/main/phone/PhoneServer.ts`)가 `127.0.0.1:47830`(`settings.phone.port`, 시험은 0)에만 듣는다. Control API 와 포트·경로·토큰이 다르다
- **길**: 사람이 `tailscale serve --bg --https=443 http://127.0.0.1:<port>` 를 돌린다(설정이 명령과 되돌리는 `tailscale serve --https=443 off` 를 보여
  준다 — 앱은 돌리지 않는다). 폰 주소는 `https://<MagicDNS>/`(QR). Funnel 머리말이 있으면 거절
- **누가**(`phoneAccess.ts`, 순수 함수 — T75 표): `Tailscale-User-Login` = 이 Mac 의 로그인(`tailscale status --json`, 5분 캐시, 읽기만) 이고
  `X-Forwarded-For` 가 tailnet 주소면 주인(치기). 그 밖은 짝지은 기기 쿠키(`climanager_phone`, HttpOnly·SameSite=Strict)만 —
  `PhoneDevices`: 6자리 · 10분 · 5회 틀리면 폐기 · 「can type / view only」 · 해시만 `userData/phone/devices.json`(0600). Host 는 loopback·`*.ts.net`·
  tailnet 주소만(421), 바꾸는 요청·소켓은 Origin 이 같은 곳만(403)
- **경로**(`shared/phone.ts` `PHONE_API`): `GET /api/phone/me` · `POST /api/phone/pair` · `GET /api/phone/sessions`(세션 한 줄 목록 + 세션 폴더 이름 +
  상태 점·질문 줄) · `/api/phone/chat/<id>/<conversation|send|answer|interrupt|cancel-queued|discard-queued|send-queued-now|attach|image|tool-output|commands>`
  · WS `/api/phone/chat/<id>/events`(revision) · WS `/api/phone/terminal?session=<id>` · `POST /api/phone/push/<subscribe|unsubscribe|test>`.
  만들기·지우기·이름 바꾸기·크기 바꾸기 경로는 없다. 치는 경로는 `drive` 만, 그리고 세션 사건 기록에 `phone-input`(무엇을 했는지만, 글은 안 남김)
- **Chat**: 같은 프로세스에서 `ConversationService` 를 부른다(IPC 핸들러와 같은 함수). 질문 카드 글(화면에서 읽은 것)은 `maskSecretLines` 를 거친다.
  변경 알림은 `ConversationService.onChange` → `phoneConversationListeners`
- **Terminal**: `TerminalManager.attachRemote` — 있는 pty 에만 붙고(만들지 않음) 불변식 6 순서(flush → hold → 스냅샷 → 그 뒤 출력)를 따르되 서버가
  바로 확인하고 순서를 스스로 지킨다(폰 네트워크가 Mac 출력을 붙잡지 않게). 소켓은 `input` 만 받는다 — 크기 메시지는 `resize_not_allowed`.
  Mac 창이 크기를 바꾸면 `size` 로 알려 폰이 같은 칸 수로 다시 그린다. 폰은 Mac 칸 수로 그리고 폭에 맞춰 줄여 보인다(확대·가로 밀기)
- **알림**(`PhonePush.ts`, `web-push`): 폰 서버가 켜져 있는 동안 자기 `SessionScreenStatusPoller` 를 돌려 에이전트 세션의 질문 대기·5초 넘게 일한 턴의
  끝을 웹 푸시로. Mac 앞에서 앱을 쓰는 중(보이는·포커스된 창 + 2분 안 입력)이면 안 보냄, 세션당 1분에 한 번, 시험 알림은 늘. VAPID 키·구독은
  `userData/phone/{vapid,push}.json`(0600), 404/410 이면 구독을 지운다. 누르면 `/?session=<id>&view=chat`
- **폰 페이지**: 렌더러 두 번째 Vite 입구 `src/renderer/phone.html` → `src/renderer/src/phone/`(목록·서랍(768px 아래)·「Chat | Terminal」·키 바·입력줄·
  짝짓기·알림). Chat 은 데스크톱 `ChatView` 에 `phoneChatTransport`(fetch + WS)를 준다. 서버는 `out/renderer/.vite/manifest.json` 으로 phone.html 이
  싣는 청크만 낸다(데스크톱 입구·피드백 위젯 청크는 404). 매니페스트·서비스 워커·아이콘은 `src/renderer/public/phone/`
- 끄기: 설정 스위치 · 사이드바 「Phone on · n connected」의 ✕ · 앱 종료 → 서버 닫힘 + 모든 소켓 끊김. 기기 끊기는 그 기기 소켓·알림까지
- **세션 목록 순서 = Mac 사이드바 「All sessions」(List) 위→아래**(2회차). 따로 정렬하지 않는다 — main(`phoneSetup.listSessions`)이 사이드바의
  함수를 그대로 부른다: 사이드바가 세션을 그리는 순서(`sessionsInSidebarOrder` — 렌더러가 `sidebar-session-order` 로 알려 준 id 순서, 작업 공간
  끌어 옮기기는 렌더러에만 있으므로) → 고정 먼저·최근 본 순(`orderForAllSessions` + `RecentSessions`) → 세션 폴더 먼저(`groupBySessionFolder`,
  `SidebarAllSessions` 도 같은 함수). 폰(`sessionListLines.ts`)은 받은 순서를 그대로 그리고 Mac 처럼 폴더 머리글·고정 아래 줄만 끼운다. 렌더러 보고가
  오기 전에는 불러오는 순서(`workspacesInLoadOrder` — `get-workspaces` 와 같은 함수)
- **터미널 확대**: −/+/핀치로 고른 배율은 그 폰의 `localStorage`(`phone-terminal-zoom`)에 남는다(기기마다 따로). 없으면 폭 맞춤(기본). 좁은 화면에서
  고른 배율이 돌린 화면의 폭 맞춤보다 작으면 폭 맞춤으로 보인다
- 회귀: `t75-phone-unit.spec.ts`(접근 표·짝짓기·알림 규칙·키 바·카드 가리기·목록 순서) · `t76-phone.spec.ts`(앱 + 폰 창 — 가짜 Tailscale 상태 파일
  `CLIMANAGER_PHONE_TAILSCALE_STATUS`, 알림은 `CLIMANAGER_PHONE_PUSH_LOG`, 둘 다 시험 userData 일 때만 읽는다) · `t77-phone-text-size.spec.ts`
  (글씨 크기 세 모드 측정·확대 기억·Mac PTY 크기 그대로)

#### 13. CLI 세션 재개 (resume)
- 에이전트를 띄울 때 `--session-id`를 주입해 두고, 다음 실행에서 `--resume`로 **대화를 이어붙인다**
- **별칭도 인식한다** — 사용자가 `cldy`로 띄워도 `claude`로 판정한다. 시작 시 `zsh -ic alias`를
  한 번 읽어 매핑을 만든다(`CLISessionTracker.setAliases`). 실측 2026-09-25: 이게 없어서 템플릿으로
  연 세션은 id가 아예 안 붙었고, 재시작하면 **조용히 새 대화로 시작**했다
- **재개는 원본 명령으로** — `cldy --resume <id>`. `claude --resume`로 재조립하면 별칭이 들고 있던
  플래그(bypass 모드·모델 선택)가 사라진다
- `glm-on && cldy`처럼 앞에 준비 명령이 붙어도 마지막 명령으로 판정한다
- 시작 시 `validateCliSessionIds()`가 Claude 대화 파일이 없는 id를 지운다 — 그래서 대화 기록 저장이
  꺼진 세션은 재개되지 않는다. 회귀는 `t17-session-resume.spec.ts`
- **id 는 Claude 가 실제로 쓰는 대화를 따라간다** — Claude 안에서 `/resume` 하면 새 id 로 옮겨 가고 주입한 id 에는 대화 파일이
  생기지 않는다(2.1.296 실측). 그대로 두면 재시작 때 id 가 지워져 템플릿이 새 대화로 시작한다. `ClaudeSessionSync` 가 10초마다
  `<CLAUDE_CONFIG_DIR|~/.claude>/sessions/<pid>.json` 을 읽어, 셸에 가장 가까운 Claude 프로세스의 `sessionId` 로 저장값을 맞춘다
  (Claude 가 띄운 Claude 는 더 깊어서 무시). 훅 설치와 무관하다. 회귀는 `t30-claude-session-sync.spec.ts`

## Data Flow

```
User Action (Renderer)
  → IPC Call (Preload)
    → IPC Handler (Main)
      → electron-store (Persistent Storage) / simple-git / gh CLI
        → Response to Renderer
          → UI Update
```

## Terminal Session Lifecycle

1. 사용자가 세션 추가 요청
2. Main process에서 UUID 생성 및 세션 정보 저장
3. Renderer에서 TerminalView 컴포넌트 생성
4. TerminalView가 mount 시 `terminal-create` IPC 호출
5. TerminalManager가 node-pty 프로세스 생성 — 이미 살아 있으면 건너뛴다. 새로 띄울 때 디스크 히스토리가 있으면 미러에 먼저 깔고
   구분선까지 스크롤백으로 올려 빈 화면에서 시작한다(Claude 리페인트가 화면 줄을 지우므로)
6. 응답 `{ existed, snapshot, snapshotSize, attachToken }` — 그 사이 출력은 보류된다. 뷰는 `snapshotSize` 로 xterm 을 맞춘 뒤 쓴다. TerminalView 가 snapshot 을 쓰고 리스너를 단 뒤
   `terminal-attached(id, token)` 를 보내면 보류분이 나간다. `existed` 면 시작·resume 명령을 입력하지 않는다
7. pty 데이터를 `terminal-output-{id}` 채널로 브로드캐스트(4ms 배칭)
8. 해당 TerminalView가 xterm.js에 데이터 렌더링

## Storage Schema (electron-store)

```typescript
{
  workspaces: [
    {
      id: string,
      name: string,
      path: string,
      sessions: [
        {
          id: string,
          name: string,
          cwd: string,
          type: 'regular' | 'worktree',
          memo?: string,              // Session memo text — page 1
          memoPages?: string[],       // Memo pages 2..n (older builds ignore it)
          isPinned?: boolean,         // Kept at the top of the sidebar's All sessions list (unpinned = no field)
          cliSessionId?: string,      // Claude: --session-id we injected · Codex: id found in its rollout (CodexSessionLocator)
          cliToolName?: string,       // 'claude' (resume: <cmd> --resume <id>) · 'codex' (resume: <cmd> resume <id>)
          cliCommand?: string,        // What started it (`cldy`) — resume repeats this, not `claude`
          sessionFolderId?: string,   // All sessions view folder it also sits in (SessionFolders); a missing folder = none
          aiControl?: { client: string, since: number }  // Mark: an AI works in this session (Control API)
        }
      ],
      createdAt: number,
      isPlayground?: boolean,
      parentWorkspaceId?: string,  // Worktree인 경우 부모 workspace ID
      branchName?: string          // Worktree의 브랜치명
    }
  ],
  playgroundPath: string,
  customTemplates: TerminalTemplate[],
  settings: UserSettings,           // settings.controlApi = { enabled, port }
  controlApiToken?: string,         // Kept outside settings so a stale save-settings cannot rotate it
  sessionFolders?: [                // All sessions view folders (SessionFolders) — membership is on the session
    { id: string, name: string, isExpanded?: boolean, createdAt: number }
  ],
  sessionRelations?: [              // Related sessions — one record per pair, either direction
    { from: string, to: string, kind: 'opened' | 'connected' | 'manual', at: number, dismissed?: boolean }
  ],
  inbox?: [                         // Inbox — requests sessions sent for the user's hands (InboxStore), newest first
    { id: string, sessionId: string, kind: 'login' | 'review' | 'question' | 'other', text: string, url?: string,
      at: number, createdAt: number, readAt?: number, client: string }
  ],                                // ≤200 · read ones dropped after 7 days (startup) · a closed session takes its own
  checklists?: [                    // Header checklists — belong to no session (ChecklistStore), header order
    { id: string, title: string, workspaceId?: string, due?: 'YYYY-MM-DD',
      items: [{ id: string, text: string, doneAt?: number, createdAt: number }],
      createdAt: number, updatedAt: number, client: string, createdBy?: string }
  ]                                 // ≤100 checklists × ≤100 items, refused beyond · removed only by hand · a removed workspace drops only workspaceId
}
```

폰 연결(`settings.phone = { enabled, port }`)의 비밀은 config.json 이 아니라 `userData/phone/` 에 둔다 — `devices.json`(기기 토큰 해시) ·
`vapid.json`(웹 푸시 키) · `push.json`(구독), 모두 0600.

디스크에 따로 두는 것: `userData/scrollback/<sessionId>.ans` — 터미널 히스토리 스냅샷(이스케이프 시퀀스, 최대 2000줄).
사이드바 세션이 지워지면 같이 지우고, 시작 때 고아 파일을 정리한다.

## IPC Communication

#### Workspace Management
- `get-workspaces`: 모든 워크스페이스 조회
- `add-workspace`: 폴더 선택 다이얼로그로 워크스페이스 추가
- `add-worktree-workspace`: Worktree workspace 생성 (NEW)
- `remove-workspace`: 워크스페이스 삭제 (Worktree인 경우 git worktree remove 실행)
- `add-session`: 터미널 세션 추가
- `remove-session`: 터미널 세션 삭제
- `toggle-folder-expanded`: 사이드바 폴더 하나 펼침/접힘 전환(저장됨)
- `set-folders-expanded`: 여러 폴더의 펼침 상태를 한 번에 저장 — 전체 접기/복원용
- `update-session-memo`: 세션 메모 저장
- `toggle-pin-session`: 세션 고정(All sessions 맨 위) 켜기/끄기 — 새 값을 돌려준다
- `get-session-folders` · `create-session-folder` · `rename-session-folder` · `remove-session-folder`(세션은 그대로) · `set-session-folders-expanded` · `move-session-to-session-folder`(`null` = 폴더에서 뺌): All sessions 세션 폴더(`SessionFolders`). 창이 바꾼 것은 방송하지 않고 렌더러가 제 사본을 고친다. Control API 가 바꾼 목록은 `session-folders`(main → renderer, 새 목록)로 알린다(`useSessionFolders` 가 구독)

#### Git Operations
- `git-list-branches`: 브랜치 목록 조회
- `git-checkout`: 브랜치 전환
- `git-status`: Git 상태 조회
- `git-commit`, `git-push`, `git-pull`: Git 기본 작업

#### GitHub Operations (NEW)
- `gh-check-auth`: GitHub 인증 상태 확인
- `gh-push-branch`: 브랜치 푸시
- `gh-create-pr-from-worktree`: Worktree에서 PR 생성
- `gh-list-prs`: PR 목록 조회
- `gh-workflow-status`: GitHub Actions 상태 조회

#### Feedback Widget
- `feedback-relay`: 피드백 위젯의 요청을 main 이 `Origin: https://desktop.climanager.solhun.com` 으로 보낸다. `https://*.supabase.co/functions/v1/dp-agentation-ingest/…` 의 GET·POST 만 허용하고, 실패는 던지지 않고 `{ error }` 로 돌려준다(렌더러 쪽이 던져서 위젯 큐가 재시도하게 한다)
- `feedback-terminal-context(sessionId | null)` → `FeedbackTerminalContext`: 창 사건(`appEvents`)과 그 터미널의 상태·사건·최근 200줄(비밀값 가림). 모르는 id·문자열이 아닌 값이면 `terminal: null`. 제보를 보낼 때 위젯이 부르고, 2초 안에 답이 없으면 그 정보 없이 보낸다

#### Agent Integration (NEW)
- `get-hook-state`: 디스크 실측 기반 설치 상태 조회 (의도가 아니라 **실제 상태**)
- `set-hook-integration`: 훅 설치/제거 (끄면 원래 커맨드로 복구)
- `get-agent-status-snapshot` / `agent-status-update`: 터미널 상태 조회·브로드캐스트
- `agent-status-observed`: 렌더러가 관측한 상태 보고 (우선순위 판정은 main이 담당)
- `get-session-screen-statuses` / `session-screen-status` (main → renderer): 화면으로 읽은 사이드바 상태 점. 메시지는 `{ enabled, reset, changes }` — 켜고 끌 때 `reset`, 그 사이엔 바뀐 세션만. 끄면 아무것도 안 온다
- `get-usage-snapshot` / `usage-update` / `usage-threshold`: 사용량 조회·브로드캐스트·임계값 알림
- `set-usage-alerts`: 알림 임계값 저장

#### Diff Review (NEW)
- `git-diff-summary`: 변경 파일 목록 (untracked 포함)
- `git-file-diff`: 단일 파일 unified diff
- `send-text-to-terminal`: 리뷰 코멘트를 세션 터미널에 입력 (**개행 없이** — 제출은 사용자가)

#### AI Control API (NEW)
- `get-control-api-state` / `set-control-api`: 서버 실제 상태 조회 · 켜기/끄기/포트 적용 (즉시 반영)
- `regenerate-control-api-token`: 토큰 재발급 (기존 클라이언트 연결 끊김)
- `control-api-release-session`: 사이드바 "Disconnect AI" — 세션은 유지, API 접근만 회수
- `control-api-session` (main → renderer): API가 세션을 열기/닫기/갱신/포커스했음을 알림

#### Related Sessions
- `get-session-relations` → 보이는 관계(`dismissed` 제외) · `session-relations` (main → renderer): 바뀔 때마다 전체 목록
- `add-session-relation(from, to)` / `remove-session-relation(a, b)`: 손으로 추가·빼기(빼기는 `dismissed` 표시)
- `get-recent-sessions` → 최근 본 세션 id(최신이 앞, 최대 20 — `RECENT_SESSIONS_MAX`) · `push-recent-session(id)`: 렌더러가 보는 세션(분할이면 포커스된 칸)이 바뀔 때 보고. 저장 키 `recentSessions`(config.json). 닫힘·시작 때 정리, 없는 세션은 탭이 숨김
- `sidebar-session-order(ids)`(renderer → main, `send`): 사이드바가 세션을 그리는 순서(`sessionsInSidebarOrder`)의 id. 순서가 바뀔 때만, 주 창만 보낸다. main 은 메모리에만 두고 폰 세션 목록의 첫 단계로 쓴다
- `peek-sessions(ids)` → `SessionPeek[]`: 상태·질문 대기·마지막 줄. 읽기만 한다 — API 읽기와 달리 AI 표시를 붙이지 않는다

#### Inbox
- `get-inbox` → `InboxRequest[]`(최신이 앞, 읽은 것 포함) · `inbox` (main → renderer): 바뀔 때마다 전체 목록. main 은 같은 때 Dock 배지(안 읽은 수)를 고친다
- `mark-inbox-read(id)` · `mark-inbox-all-read`: 줄의 ✓ · 「Mark all read」. 세션을 열거나 보는 것으로는 읽지 않는다(1.22.0, 제보 b165acc4 — 그 전에는 `mark-inbox-sessions-read` 로 보이는 세션을 읽었다)
- 코드: `src/main/InboxStore.ts`(저장·검사) · `ControlApiService.notifyInbox`(API) · `hooks/useInbox.ts` · `components/Inbox/`(종·목록·행 점). 계약은 [`control-api.md`](control-api.md) 「Inbox」

#### Checklists
- `get-checklists` → `Checklist[]`(헤더 순서: 열린 것 마감 가까운 순 → 다 끝난 것 최근 순) · `checklists` (main → renderer): 바뀔 때마다 전체 목록
- `create-checklist(title, workspaceId?)` → 새 id 또는 `null` · `update-checklist(id, { title?, due?: string|null, workspaceId?: string|null })` · `remove-checklist(id)` · `add-checklist-item(id, text)` · `update-checklist-item(id, itemId, { text?, done? })` · `remove-checklist-item(id, itemId)` → `boolean`. 검사는 API 와 같은 `checkChecklistInput`·`checkItemTexts`
- 헤더가 보여 줄 체크리스트(마지막에 본 것)는 렌더러 localStorage `checklists-last-viewed` — 세션을 바꿔도 그대로
- 코드: `src/main/ChecklistStore.ts` · `ControlApiService.*Checklist*` · `hooks/useChecklists.ts` · `components/Checklists/`(칩·패널·항목 줄·마감 편집) · `utils/dueDate.ts`(마감 표시). 계약은 [`control-api.md`](control-api.md) 「Checklists」

#### Chat view
- `conversation-get(sessionId, limit?)` → `ConversationSnapshot`(마지막 `limit` 턴 · working · prompt · queued · revision) · `conversation-subscribe` /
  `conversation-unsubscribe(sessionId)`(창이 닫히면 그 창 구독은 풀린다) · `conversation-changed` (main → renderer, `{ sessionId, revision }`)
- `chat-send(sessionId, text)` → `ChatSendResult`(`sent` · `queued` · `rejected` + 이유) · `chat-cancel-queued(sessionId)` ·
  `prompt-answer(sessionId, { signature, optionIndex | customText })` → `PromptAnswerResult`(`answered` · `rejected: prompt_changed …`)
- 2회차: `chat-discard-queued(sessionId, id)` · `chat-send-queued-now(sessionId, id)` → `ChatSendResult` · `chat-interrupt(sessionId)` → `InterruptResult` ·
  `chat-image(sessionId, ref)` → data: URL | null · `chat-tool-output(sessionId, ref)` → string | null · `chat-commands(sessionId)` → `ChatCommand[]` ·
  `chat-save-attachment(name, bytes)` → `AttachResult`(32MB) · `chat-open-path(path)` → `shell.openPath`. `@` 파일 찾기는 기존 `search-files` 를 쓴다
- 코드: `src/main/ConversationService.ts` · `TranscriptReader.ts` · `promptScreen.ts` · `transcript/` · `chatCommands.ts` · `chatAttachments.ts` · 렌더러 `components/ChatView/` · `SessionChatSlot.tsx` ·
  `SessionViewToggle.tsx` · `ChatFilePreview.tsx` · `ChatViewSettings.tsx` · `hooks/useSessionViewMode.ts`(peek 포함) · `utils/electronChatTransport.ts`

#### Phone connection
- `phone-get-state` → `PhoneState`(실제 상태: running·port·Tailscale 로그인·MagicDNS·serve 명령·기기·짝짓기 코드·연결 수·알림 기기 수) ·
  `phone-set-enabled(boolean)`(즉시 적용, `settings.phone` 은 main 이 쥔다 — `save-settings` 가 옛 값으로 덮지 않는다) · `phone-start-pairing('drive'|'watch')` ·
  `phone-cancel-pairing` · `phone-revoke-device(id)` · `phone-revoke-all` → `PhoneState` · `phone-test-push` → `PhoneTestPushResult` ·
  `phone-state-changed` (main → renderer, 0.1초 묶음)
- 코드: `src/main/phone/`(`phoneSetup.ts` 배선·IPC) · 렌더러 `components/PhoneSettings.tsx` · `PhoneBadge.tsx` · `hooks/usePhoneState.ts`

#### Communication Patterns
- **Invoke/Handle**: 비동기 요청-응답 패턴 (워크스페이스 CRUD, Git 작업)
- **Send/On**: 단방향 이벤트 스트림 (터미널 입력, 포트 업데이트)
- 터미널 데이터는 모든 BrowserWindow에 브로드캐스트되므로 Renderer에서 ID로 필터링 필요
