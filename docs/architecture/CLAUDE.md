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

#### 12. AI Control API (NEW)
- 다른 AI(Claude Code 등)가 폴더를 골라 세션을 열고, 템플릿 실행·프롬프트 입력·완료 대기·화면 읽기를 한다
- 사용자는 그 세션을 앱에서 그대로 보고 끼어들 수 있다 — AI 세션은 사이드바 녹색 + 헤더 "AI connected"
- REST(`/v1`) + MCP(`/mcp`), 로컬 전용·토큰 필수·기본 꺼짐. 계약: [`control-api.md`](control-api.md)

#### 14. 관련 세션 (Related sessions)
- 세션 헤더(단일 화면 오른쪽 「Related」, 분할 칸 헤더의 아이콘)에서 그 세션과 관련된 세션을 모달로 본다 — 0개여도 버튼은 보인다(손으로 추가하는 곳이라서)
- 자동 등록: 에이전트가 `X-Caller-Session` 을 붙여 세션을 **열 때**(`opened`)와 다른 세션을 **처음 읽거나 입력할 때**(`connected`). 터미널 출력(링크 글자)으로는 등록하지 않는다
- 손으로 추가·빼기. 뺀 쌍은 표시(`dismissed`)를 남겨 에이전트의 다음 호출이 다시 넣지 않게 하고, 손으로 다시 넣으면 풀린다
- 모달 탭 줄(Relations / Recent / All) — 지금은 **Relations 만** 동작하고 나머지는 흐리게 둔다(이후 단계에서 채움). Relations 는 `sessionTreeFor`(`relatedSessions.ts`)가 `from` 을 부모로 삼아(`opened`·`connected` 둘 다) 위(나를 연 쪽, 여러 겹 · 뿌리가 맨 위)·옆(같은 부모가 연 형제)·아래(내가 연 것, 손자까지 들여쓰기)를 한 나무로 그린다. 방향 없는 `manual` 은 나무 밖 「Added by hand」. 고리는 한 번 놓은 세션을 건너뛰어 끊고(아래 → 위 → 옆 순으로 놓음), 깊이는 `MAX_TREE_DEPTH = 6`. 중간 세션이 닫히면 그 아래는 안 보인다(알려진 한계). 구역 속성 `data-related-tree="up|side|down|manual"` 에 옛 묶음 이름 `data-related-group="toHere|side|fromHere|manual"` 을 함께 둔다 — T35 가 그걸로 본다. 줄 끝 「#」는 세션 ID 복사
- 모달(묶음 이름은 위와 같음): 「Opened from this session」 / 「Opened this session」 / 「Added by hand」 · 상태(Working/Waiting for you/Idle — main 의 화면 사본 기준) · 마지막 줄(길면 **앞을** 잘라 끝 — 보통 지금 폴더 — 이 보인다) · 메모 · 이름이 `대화:` 로 시작하면 「Talk」 배지. 누르면 사이드바 클릭과 같게 이동. 「Open side by side」는 **지금 세션을 첫 칸**에 두고 고른 세션(최대 3)을 뒤에 — 세션 링크와 같은 경로
- 어느 쪽이든 세션이 닫히면(API·사이드바·워크스페이스 삭제) 그 관계는 저장소에서도 지워진다. 시작 때 없는 세션을 가리키는 관계를 정리한다
- 코드: `src/main/SessionRelations.ts`(저장) · `ControlApiService`(자동 등록·`peekSessions`) · `src/renderer/src/utils/relatedSessions.ts`(묶음·나무 계산) · `components/RelatedSessions/`(`RelationTree.tsx` = 관계 탭)

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
          memo?: string,              // Session memo text
          cliSessionId?: string,      // Claude: --session-id we injected · Codex: id found in its rollout (CodexSessionLocator)
          cliToolName?: string,       // 'claude' (resume: <cmd> --resume <id>) · 'codex' (resume: <cmd> resume <id>)
          cliCommand?: string,        // What started it (`cldy`) — resume repeats this, not `claude`
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
  sessionRelations?: [              // Related sessions — one record per pair, either direction
    { from: string, to: string, kind: 'opened' | 'connected' | 'manual', at: number, dismissed?: boolean }
  ]
}
```

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
- `peek-sessions(ids)` → `SessionPeek[]`: 상태·질문 대기·마지막 줄. 읽기만 한다 — API 읽기와 달리 AI 표시를 붙이지 않는다

#### Communication Patterns
- **Invoke/Handle**: 비동기 요청-응답 패턴 (워크스페이스 CRUD, Git 작업)
- **Send/On**: 단방향 이벤트 스트림 (터미널 입력, 포트 업데이트)
- 터미널 데이터는 모든 BrowserWindow에 브로드캐스트되므로 Renderer에서 ID로 필터링 필요
