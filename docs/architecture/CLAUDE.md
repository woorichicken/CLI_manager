---
description: When changing IPC, storage, or a subsystem and you need the current contract
authority: Feature inventory, data flow, session lifecycle, storage schema, and the IPC channel list
status: active
owner: maintainer
last-reviewed: 2026-08-16
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
5. TerminalManager가 node-pty 프로세스 생성
6. pty 데이터를 `terminal-output-{id}` 채널로 브로드캐스트
7. 해당 TerminalView가 xterm.js에 데이터 렌더링

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
          memo?: string               // Session memo text
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
  settings: UserSettings
}
```

## IPC Communication

#### Workspace Management
- `get-workspaces`: 모든 워크스페이스 조회
- `add-workspace`: 폴더 선택 다이얼로그로 워크스페이스 추가
- `add-worktree-workspace`: Worktree workspace 생성 (NEW)
- `remove-workspace`: 워크스페이스 삭제 (Worktree인 경우 git worktree remove 실행)
- `add-session`: 터미널 세션 추가
- `remove-session`: 터미널 세션 삭제
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

#### Communication Patterns
- **Invoke/Handle**: 비동기 요청-응답 패턴 (워크스페이스 CRUD, Git 작업)
- **Send/On**: 단방향 이벤트 스트림 (터미널 입력, 포트 업데이트)
- 터미널 데이터는 모든 BrowserWindow에 브로드캐스트되므로 Renderer에서 ID로 필터링 필요
