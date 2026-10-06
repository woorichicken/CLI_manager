# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Which document to read when

<!-- docs-index:start -->
| 언제 읽나 | 문서 |
| --- | --- |
| 새 기능 개발용 브랜치 생성 및 작업 시작 | [`.claude/commands/new-feature.md`](.claude/commands/new-feature.md) |
| 릴리즈 — 빌드·공증·GitHub 게시·R2·웹사이트·changelog | [`.claude/commands/release.md`](.claude/commands/release.md) |
| Upload CLI Manager release DMG files to Cloudflare R2. Use when the user asks to upload a release to R2, publish DMG files, or refresh the website download links. Normally invoked through scripts/post-release.cjs rather than directly. | [`.claude/skills/upload-to-r2/SKILL.md`](.claude/skills/upload-to-r2/SKILL.md) |
| When changing IPC, storage, or a subsystem and you need the current contract | [`docs/architecture/CLAUDE.md`](docs/architecture/CLAUDE.md) |
| When calling, extending, or debugging the AI Control API (REST under /v1, MCP at /mcp) that lets an AI open and drive sessions | [`docs/architecture/control-api.md`](docs/architecture/control-api.md) |
| When picking up deferred work, or when parking something found mid-task | [`docs/backlog.md`](docs/backlog.md) |
| When writing, moving, or retiring a document in this repository | [`docs/CLAUDE.md`](docs/CLAUDE.md) |
| When changing how agent hook events reach the app, or when tempted to replace the spool with a local server | [`docs/decisions/0001-hook-delivery-via-file-spool.md`](docs/decisions/0001-hook-delivery-via-file-spool.md) |
| When editing a config file the user owns, or when a shared entry point already has a value | [`docs/decisions/0002-wrap-not-replace-user-config.md`](docs/decisions/0002-wrap-not-replace-user-config.md) |
| When tempted to delete the screen-hash status detection now that official hooks exist | [`docs/decisions/0003-keep-heuristic-as-fallback.md`](docs/decisions/0003-keep-heuristic-as-fallback.md) |
| When changing how or how often the app checks for updates | [`docs/decisions/0004-periodic-update-check.md`](docs/decisions/0004-periodic-update-check.md) |
| When changing how an external AI drives sessions (Control API), or when a local listening port looks like it contradicts decision 0001 | [`docs/decisions/0005-ai-control-api-local-http.md`](docs/decisions/0005-ai-control-api-local-http.md) |
| When changing which sessions the Control API may touch, what the AI mark means, or when the mirror is attached | [`docs/decisions/0006-control-api-reaches-every-session.md`](docs/decisions/0006-control-api-reaches-every-session.md) |
| When changing how the Control API registers, files or unregisters workspaces, or when tempted to let it remove one the user added | [`docs/decisions/0007-api-cleans-up-only-its-own-registrations.md`](docs/decisions/0007-api-cleans-up-only-its-own-registrations.md) |
| When a design choice looks arbitrary and you are about to change it | [`docs/decisions/CLAUDE.md`](docs/decisions/CLAUDE.md) |
| When touching an area that misbehaves, or when triaging a report against known-wrong behavior | [`docs/found-defects.md`](docs/found-defects.md) |
| When adding or debugging an integration with an external AI CLI (hooks, status line, usage data) | [`docs/integrations/CLAUDE.md`](docs/integrations/CLAUDE.md) |
| When a document contradicts the code and you need to know whether it was ever true | [`docs/legacy/CLAUDE.md`](docs/legacy/CLAUDE.md) |
| Before building, publishing, or distributing a release — anything with an effect outside this machine | [`docs/operations/CLAUDE.md`](docs/operations/CLAUDE.md) |
| Before running, adding, or removing a script in scripts/ | [`scripts/CLAUDE.md`](scripts/CLAUDE.md) |
<!-- docs-index:end -->

작업 중 발견했지만 이번 범위가 아닌 항목은 [`docs/backlog.md`](docs/backlog.md) `## Open`에 추가한다.
작업 중 발견했지만 지금 고치지 않는 **결함**은 [`docs/found-defects.md`](docs/found-defects.md)에 적는다.

## Repository Operations Standard

- Standard: `curate-repository-ops@da56dfe`
- Last audited: `2026-08-18`
- Local deviations:
  - `docs/design/` 없음 — 디자인 토큰 체계가 아직 없어 가이드를 쓰면 그 문서가 곧 거짓이 된다.
    [`docs/backlog.md`](docs/backlog.md)에 트리거와 함께 등록했다.
  - `docs/migrations/` 없음 — electron-store 기반이라 스키마 마이그레이션 절차가 존재하지 않는다.
  - `.claude/skills/*/SKILL.md`의 `description`은 라우팅 문구 규칙(독자 상황)을 따르지 않는다.
    그 필드는 Claude Code의 **스킬 활성화 트리거**라 계약이 다르고, 인덱스 가독성 때문에 고치면
    스킬이 덜 뜬다. 인덱스에는 그대로 실린다.
  - 루트가 250줄 신호를 넘는다(현재 313줄). 남은 내용은 회귀 방지 불변식(터미널 렌더링 / 에이전트
    훅), 코드 스타일, 문제 해결 절차라 **매 세션 로드되어야 의미가 있다.** 참조성 내용(기능 목록,
    IPC 채널, 저장 스키마)은 `docs/architecture/CLAUDE.md`로 이미 분리했다.

## Project Overview

CLImanger는 Electron 기반 터미널 관리 애플리케이션입니다. 여러 워크스페이스와 터미널 세션을 관리하고, **Git worktree를 별도 워크스페이스로 관리**하며, **GitHub 연동 기능**과 로컬 포트 모니터링 기능을 제공합니다.

## Tech Stack

- **Framework**: Electron + React
- **Build Tool**: electron-vite
- **UI**: TailwindCSS + framer-motion
- **Terminal**: xterm.js + node-pty
- **Storage**: electron-store
- **Git**: simple-git
- **GitHub**: gh CLI
- **Package Manager**: pnpm

## Development Commands

```bash
# 개발 서버 시작 (HMR 지원)
pnpm dev

# 프로덕션 빌드
pnpm build

# 빌드된 앱 미리보기
pnpm preview
# 또는
pnpm start

# 타입 체크
pnpm typecheck

# 터미널 파이프라인 테스트 (Playwright + Electron, 빌드 후 실행)
pnpm build && pnpm test:term
# 수정 전후 비교용 라벨 부여: METRICS_LABEL=<label> pnpm test:term
```

## Architecture

### Process Structure (Electron Multi-Process)

1. **Main Process** (`src/main/`)
   - `index.ts`: 앱 초기화, IPC 핸들러, 워크스페이스/세션 관리
   - `TerminalManager.ts`: node-pty를 사용한 터미널 프로세스 생성/관리
   - `PortManager.ts`: macOS `lsof` 명령어로 localhost 포트 모니터링 (5초마다)
   - `HookInstaller.ts`: 공식 CLI 훅 설치/제거 (`~/.claude/settings.json`, `~/.codex/config.toml` 래핑)
   - `hookScripts.ts`: 훅 브리지 sh 스크립트 템플릿 + delegate 치환
   - `AgentHookBridge.ts`: 훅 스풀 디렉토리 감시 → 정규화된 `AgentEvent` 방출
   - `AgentStatusResolver.ts`: 이벤트/OSC/heuristic 우선순위 판정 → 터미널 상태 확정
   - `UsageTracker.ts`: Claude(statusLine) · Codex(rollout jsonl) rate limit 추적 + 임계값 알림
   - `diffParser.ts`: `git diff` plumbing 출력 파서 (numstat/name-status/unified)
   - `ControlApiServer.ts` / `ControlApiService.ts` / `controlApiMcp.ts`: AI Control API — 로컬 HTTP(REST+MCP)로 AI가 세션을 열고 조작 ([`docs/architecture/control-api.md`](docs/architecture/control-api.md))
   - `CodexSessionLocator.ts`: Codex 가 고른 대화 id 를 rollout 파일에서 찾아 재시작 때 `resume` 하게 함
   - `TerminalMirror.ts`: AI 세션 출력을 headless xterm으로 재생해 "사용자가 보는 화면"을 읽게 함

2. **Renderer Process** (`src/renderer/`)
   - `App.tsx`: 메인 애플리케이션 컴포넌트, 상태 관리
   - `components/Sidebar/`: **리팩토링된 모듈형 사이드바 컴포넌트**
     - `index.tsx`: 메인 Sidebar 컴포넌트 (200줄 이하)
     - `WorkspaceItem.tsx`: 워크스페이스 항목 컴포넌트
     - `WorktreeItem.tsx`: Worktree 워크스페이스 항목 컴포넌트
     - `SessionItem.tsx`: 터미널 세션 항목 컴포넌트
     - `ContextMenus.tsx`: 컨텍스트 메뉴 컴포넌트들
     - `Modals.tsx`: 모달 컴포넌트들
   - `components/TerminalView.tsx`: xterm.js 터미널 인스턴스
   - `components/StatusBar.tsx`: 포트 모니터링 정보 표시
   - `components/GitPanel.tsx`: Git 상태 관리 패널
   - `components/DiffModal/`: Diff 리뷰 모달 (라인 인용 → 에이전트 터미널 전송)
   - `components/UsageIndicator.tsx`: StatusBar 사용량 표시
   - `components/AgentIntegrationSettings.tsx`: Settings > Agents 패널
   - `components/Settings.tsx`: 설정 화면
   - `hooks/`: **커스텀 훅**
     - `useWorkspaceBranches.ts`: 워크스페이스별 브랜치 정보 관리
     - `useTemplates.ts`: 커스텀 터미널 템플릿 관리
   - `utils/reviewPrompt.ts`: diff 라인 선택 → 에이전트 프롬프트 조립
   - `utils/platform.ts`: 앱 단축키 수식키 판정 — macOS 는 Cmd 만, 그 외는 Ctrl. macOS 의 Ctrl 은 터미널 몫이라 단축키로 받지 않는다 (`useKeyboardShortcuts`·`KeyboardSettings` 가 사용)
   - `constants/`: **상수 및 유틸리티**
     - `icons.tsx`: 템플릿 아이콘 매핑
     - `styles.ts`: 공통 스타일 상수

3. **Preload** (`src/preload/`)
   - `index.ts`: Main ↔ Renderer IPC 브릿지 (contextBridge)
   - `index.d.ts`: TypeScript 타입 정의

4. **Shared** (`src/shared/`)
   - `types.ts`: Main/Renderer 공통 TypeScript 타입 정의

### 상세 레퍼런스

기능 목록, 데이터 흐름, 세션 라이프사이클, 저장 스키마, IPC 채널 전체 목록은
[`docs/architecture/CLAUDE.md`](docs/architecture/CLAUDE.md)에 있다. 서브시스템을 만질 때 읽는다.

### Code Organization & Best Practices

#### 컴포넌트 분리 원칙

1. **단일 책임 원칙**: 각 컴포넌트는 하나의 명확한 역할만 수행
   - `SessionItem`: 터미널 세션 렌더링 및 상호작용
   - `WorkspaceItem`: 워크스페이스와 자식 요소 관리
   - `WorktreeItem`: Worktree 전용 렌더링 로직

2. **로직 분리**: 커스텀 훅으로 비즈니스 로직 추출
   - `useWorkspaceBranches`: 브랜치 정보 로딩 및 상태 관리
   - `useTemplates`: 템플릿 로딩 및 설정 변경 감지

3. **재사용성**: 공통 로직은 유틸리티로 분리
   - `getTemplateIcon`: 아이콘 이름 → React 컴포넌트 매핑
   - `NOTIFICATION_COLORS`: 알림 상태별 색상 상수

#### 리팩토링 결과

- **Sidebar.tsx**: 820줄 → 200줄 이하 (75% 감소)
- **컴포넌트 수**: 1개 → 7개 모듈로 분리
- **재사용성**: 중복 코드 제거, 유지보수성 향상
- **타입 안전성**: TypeScript 타입 정의 개선

## Important Notes

### macOS-Specific Features

- **Port Monitoring**: `lsof` 명령어는 macOS/Linux 전용이므로 Windows에서는 동작하지 않습니다
- **Vibrancy Effect**: macOS 전용 투명 유리 효과 UI 사용
- **Default Shell**: macOS는 `zsh`, Windows는 `powershell.exe` 사용

### External Command Execution (PATH Issue)

Finder/Spotlight에서 앱 실행 시 터미널 PATH를 상속받지 못하는 문제가 있습니다.
`code`, `gh`, `git` 등 외부 명령어 실행 시 반드시 **로그인 쉘**을 통해 실행해야 합니다.

```typescript
// ❌ 잘못된 방법 - Finder에서 실행 시 PATH 못 찾음
exec('code .')

// ✅ 올바른 방법 - 로그인 쉘로 ~/.zshrc 로드 후 실행
exec('/bin/zsh -l -c "code ."')
```

`execWithShell()` 헬퍼 함수가 이를 자동으로 처리합니다 (`src/main/index.ts`).

### Terminal Management

- 모든 터미널 세션은 React 컴포넌트가 unmount되어도 node-pty 프로세스는 유지됩니다
- 세션 전환 시 `display: none`으로 숨기기만 하여 터미널 상태 보존
- 터미널 크기 조정은 FitAddon을 사용하여 자동으로 처리

### Git Worktree

- **Workspace 구조**: Worktree는 별도의 workspace로 생성되며 `parentWorkspaceId`로 부모 workspace와 연결
- **디렉토리 구조**: `{workspace-path}/../{workspace-name}-worktrees/{branch-name}` 형식
- **자동 정리**: Worktree workspace 삭제 시 `git worktree remove --force` 실행
- **다중 세션**: 각 worktree workspace는 여러 터미널 세션을 가질 수 있음
- **브랜치 제한**: 브랜치가 이미 존재하면 worktree 생성 실패

### GitHub Integration

- **gh CLI 필요**: GitHub 기능 사용을 위해 gh CLI 설치 및 인증 필요
- **Push**: `git push origin <branch> --set-upstream` 실행
- **PR 생성**: `gh pr create` 명령어 사용, 자동으로 브랜치 푸시
- **인증**: `gh auth status`로 인증 상태 확인, `gh auth login --web`으로 로그인

### Build Configuration

- `electron-vite`는 Main/Preload/Renderer를 별도로 번들링
- Renderer는 Vite + React HMR 지원
- Main/Preload는 CommonJS 모듈 시스템 사용 (`type: "commonjs"`)

### Terminal Rendering Invariants (회귀 주의)

CLI TUI(Claude Code, Codex)의 화면 갱신 패턴 때문에 도입된 동작들. 변경 시 반드시 `pnpm test:term`으로 검증할 것.

1. **`scrollOnEraseInDisplay: true`** (TerminalView.tsx, xterm 6.0+)
   - CLI가 전체 클리어(CSI 2J)할 때 viewport 내용을 지우는 대신 scrollback으로 보존
   - 이 옵션이 없으면 클리어마다 화면에 보이던 대화 내용이 영구 파괴됨
2. **숨김 터미널 PTY resize 보류** (applyTerminalDimensions)
   - `visible`이 아닌 터미널은 PTY resize를 보내지 않음 (xterm resize만 수행)
   - PTY resize = SIGWINCH = CLI 전체 리페인트 → 터미널 N개면 창 드래그 1번에 N개 세션의 scrollback이 리페인트 잔여물로 오염됨
   - visible 전환 시 visibility effect가 `lastPtySizeRef`를 비워 최신 크기를 정확히 1회 적용
3. **출력 IPC 배칭** (TerminalManager.enqueueOutput)
   - pty 청크를 4ms 윈도우로 병합 후 renderer로 전송 (TUI 1프레임 = 1메시지)
4. **터미널 데이터 리스너는 effect cleanup에서 해제** (dataCleanup)
   - 과거에 Promise 콜백 반환값으로 잘못 등록되어 리스너 누수 있었음
5. **워크스페이스별 터미널 목록에는 안정적인 key가 있어야 한다** (App.tsx)
   - 목록이 `workspaces.map(...)` → `sessions.map(...)` 중첩 배열이라, 바깥에 key가 없으면 React가
     **index로** 짝을 맞춘다. 워크트리 sync·워크스페이스 삭제로 배열이 줄면 그 뒤 전부가 언마운트
     → 재마운트된다. PTY는 살아남지만(`TerminalManager`가 기존 id를 건너뜀) xterm 버퍼가 통째로
     날아가 "터미널이 리셋됐다"로 보인다. 회귀는 `t12-workspace-list-remount.spec.ts`가 잡는다

### Agent Hook Invariants (회귀 주의)

사용자가 소유한 설정 파일을 편집하는 유일한 코드이므로, 변경 시 반드시 `t8-hook-install.spec.ts`를 돌릴 것.

1. **HTTP가 아니라 파일 스풀** (`~/.climanager/events/`)
   - HTTP 훅은 앱이 꺼져 있으면 **매 턴마다** 연결 타임아웃만큼 CLI를 붙잡는다. 파일 쓰기는 앱 상태와 무관하게 즉시 성공. (Orca도 같은 이유로 파일 방식)
2. **훅 스크립트는 POSIX sh + 항상 `exit 0`**
   - node 의존 금지(Finder 실행 시 PATH 문제), JSON 파싱 금지(앱이 담당). 브리지가 깨져도 에이전트는 멈추면 안 된다.
3. **기존 설정은 삭제가 아니라 래핑(chain)**
   - statusLine·notify에 이미 값이 있으면 캡처해서 우리 스크립트가 대신 호출. 재설치 시 **자기 자신을 chain하지 않도록** 마커로 판별 (무한 재귀 방지).
4. **스풀 파일은 mtime 순으로 처리**
   - mktemp 이름은 랜덤이라 순서가 없다. `turn-start`↔`turn-end`가 뒤집히면 상태가 반대로 판정됨.
5. **heuristic은 제거하지 않는다**
   - `AgentStatusResolver`가 우선순위(hook > osc > heuristic)로 조정. 훅 미설치 세션은 기존 동작 유지.
6. **Codex 윈도우는 `window_minutes`로 판별**
   - `primary`/`secondary` 슬롯 위치는 플랜마다 다르다(주간이 primary인 계정 실측). 이름으로 가정 금지.

### AI Control API Invariants (회귀 주의)

AI가 셸에 명령을 입력할 수 있는 유일한 경로. 변경 시 반드시 `t15-control-api.spec.ts`를 돌릴 것
(워크스페이스 등록·해제를 만지면 `t21-control-api-workspaces.spec.ts`도).
근거는 [`docs/decisions/0005-ai-control-api-local-http.md`](docs/decisions/0005-ai-control-api-local-http.md).

1. **기본 꺼짐 + 127.0.0.1 + 토큰 + Host/Origin 검사** — 하나라도 빼면 웹페이지·다른 머신이 셸을 조작할 수 있다
2. **API가 켜져 있으면 모든 세션에 닿는다. `aiControl`은 권한이 아니라 표시다** — 처음 읽기·입력·대기·포커스 때 붙고, "Disconnect AI"는 표시를 떼고 걸려 있던 `wait`를 409로 끊는다. 접근을 끝내는 수단은 API를 끄는 것. 미러는 API가 켜진 동안 **모든 터미널에 pty 생성 시점부터** 붙는다 — 첫 접근 때 붙이면 빈 화면이 되고, 리페인트로 채우면 렌더링 불변식 2번을 깬다 ([`docs/decisions/0006`](docs/decisions/0006-control-api-reaches-every-session.md))
3. **화면에 질문이 떠 있으면 텍스트 입력 거부(409)** — Enter가 강조된 선택지를 고른다. 실측: Claude Code 폴더 신뢰 대화상자에서 "No, exit"가 선택돼 종료됐다
4. **첫 프롬프트는 "명령이 자식 프로세스로 떴고, 그 뒤 2초 조용"일 때만** — 무음만 보면 느린 셸 프로필에서 프롬프트가 셸로 선입력된다
5. **`@xterm/headless`는 파일 경로로 import해 번들에 넣는다** — `electron-builder.yml`은 node_modules를 allowlist로만 싣기 때문에 런타임 require는 배포 앱을 시작 시 죽인다
6. **테스트는 `CLIMANAGER_HOME`을 반드시 격리** — 없으면 서버가 시작을 거부한다(실사용 토큰 파일 보호)
7. **API는 자기가 등록한 워크스페이스만 해제한다** — `Workspace.aiRegistration`이 없으면 사용자 것(구버전 store 포함)이라 `403`. 폴더 지정·`ephemeral`은 새로 등록할 때만 적용하고 기존 워크스페이스는 옮기지 않는다. 디스크의 파일은 절대 지우지 않는다 ([`docs/decisions/0007`](docs/decisions/0007-api-cleans-up-only-its-own-registrations.md))

### CI

`.github/workflows/ci.yml`이 모든 push/PR에서 typecheck → build → 시크릿 스캔 → 위생 검사 →
테스트를 돌린다. macOS 러너를 쓴다(node-pty 네이티브 빌드 + 실제 Electron 구동이 필요).

`t2`·`t3`는 gitignore된 녹화 fixture에 의존해 CI에서 제외돼 있다 —
[`docs/found-defects.md`](docs/found-defects.md) 참고. 스위트가 green인 척하지 않으려고
명시적으로 뺐다.

릴리즈는 로컬 스크립트로만 한다 — 태그로 도는 게시 워크플로는 서명 시크릿이 없어 공증본을
덮어쓸 수 있어 v1.9.0 이후 삭제했다
([`.claude/rules/deploy-workflow.md`](.claude/rules/deploy-workflow.md)).

### 성능: 무엇이 실제로 비싼가 (2026-08-17 실측)

"터미널 상태 검사가 무거울 것"이라는 직관은 틀렸다. 실측값:

| 작업 | 비용 | 비고 |
|---|---|---|
| heuristic 폴링 (`pollStatus`) | 4.5µs/회 · 터미널 24개에서 **CPU 0.02%** | 꺼도 체감 없음 |
| 출력 처리 (`processWithStatus`) | 5.7µs/청크 · 60청크/초에서 **CPU 0.03%** | |
| **포트 모니터** | 5초마다 `lsof` 1회(50ms) **+ 리스닝 포트마다 1회**(30ms) | 포트 11개면 **CPU 약 7%** |
| 터미널 이벤트 emit (Control API **꺼짐**) | 0.2~0.4µs/청크 · 리스너 0 | 꺼져 있으면 이게 비용의 전부 |
| 화면 미러 — 켜져 있으면 **모든 터미널** (Control API 켜짐) | 5~7µs/청크 · 23~28MB/s · 실제 Claude 세션(평균 0.5KB/s)에서 **CPU 0.002%**, 피크(4KB/s) 0.015% | 세션당 메모리 **0.86MB**(스크롤백 2000줄 가득) |
| `wait` 폴링 | 30~60µs/회 · 200ms 간격 → 대기 중인 세션당 **0.03%** | 대기 요청이 떠 있는 동안만 |

포트 모니터가 터미널 검사보다 **수백 배** 비싸다. 그래서 끄는 스위치는 그쪽에 있고
(Settings > Port Monitoring), pid→cwd 캐시로 반복 호출을 없앴다.

재측정: `node --expose-gc scripts/bench-control-api.mjs [녹화본]` (Control API 세 항목).
합성 출력은 실제보다 싸게 나온다 — 녹화본(`scripts/mock-cli/recordings/*.jsonl`)을 주고 잰다.
한 번만 재면 머신 부하에 10배까지 흔들린다(실측) — 스크립트가 5회 중앙값·최솟값을 낸다.

성능 작업을 하기 전에 반드시 다시 재라 — `pollStatus`는 `currentTool !== 'cc'`면 즉시
반환하므로, Claude Code로 인식되지 않는 입력으로 벤치마크하면 **90배 낮은 가짜 수치**가 나온다.

### Terminal Pipeline Testing

터미널 출력/스크롤/리사이즈 회귀를 잡는 Playwright Electron 테스트.

- **위치**: `tests/terminal/` — 122건
  - T1 데이터유실 · T2 스크롤튕김 6종 · T3 히스토리보존 · T4 리사이즈폭풍 · T5 그리드창 · T6 Loop
  - T7 에이전트 통합(앱 구동) · T8 훅 설치 안전성 · T9 모듈 단위 · T10 공개 전 게이트
  - T11 UI 왕복 — 설정 토글을 실제로 클릭해 훅을 켜고 끈다. 모듈 테스트가 다 green인 채로
    남아 있던 Codex notify 삭제 버그를 잡은 유일한 테스트라, 느려도(14초) 유지한다
  - T12 워크스페이스 목록 리마운트 — 목록이 줄어도 뒤쪽 터미널이 다시 마운트되지 않아야 한다.
    판정은 DOM 노드 동일성으로 한다(스크롤백만 보면 타이밍에 속는다)
  - T13 워크트리 숨김 — 설정 토글이 저장값이 아니라 **사이드바**를 바꾸는지
  - T14 터미널 링크 — OSC 8 링크가 `shell.openExternal`까지 도달하는지, 파일경로는 수식키 없이
    클릭했을 때 에디터를 띄우지 **않는지**. 둘 다 끝단(main의 shell / 가짜 에디터 스크립트)에서 본다
  - T15 AI Control API — 모의 에이전트(`agent-mock.cjs`)를 API로 열고·입력·대기·읽기·회수·닫기까지,
    사용자가 연 세션 읽기·입력·이름 변경·닫기, Disconnect AI 가 `wait`를 끊는지와 그 뒤 재접속,
    그리고 토큰/Host/Origin 거부. 판정은 프로그램이 찍은 `ANSWER[n]`·사이드바 DOM·config.json
  - T19 Control API 입력·발견 파일 — 다른 인스턴스 종료가 발견 파일을 지우지 않는지, Codex 폴더
    신뢰 질문, 부하로 먹힌 Enter 재시도, Esc 직후 텍스트, 흐린 추천 문구 분리. 각 결함을
    `agent-mock.cjs` 옵션(`--box`·`--drop-enters`·`--codex-trust`)으로 재현한다
  - T20 잠자기 — 앱 프로세스 트리를 SIGSTOP 으로 8초 얼렸다 깨운다. 걸려 있던 `wait` 가 잠든 시간 때문에
    시간 초과로 돌아오지 않는지, AI 표시가 사이드바·config.json 에 그대로인지
  - T21 Control API 워크스페이스 정리 — 새 등록이 사이드바 폴더(설정 기본값·id·이름·최상위)에 들어가는지
    DOM 으로, AI 등록만 해제(사용자 것 403·세션 있으면 409), ephemeral 이 마지막 세션과 함께(UI 로 닫아도)
    사라지는지, 시작 시 남은 빈 ephemeral 정리, 폴더 설정 변경이 서버를 재시작하지 않는지
  - T22 마스터 세션 — 터미널 안에서 `CLIMANAGER_SESSION_ID` 가 보이는지, 그 값을 `X-Caller-Session` 으로
    붙여 세션을 열면 연 쪽이 장미색·왕관(`data-session-role="master"`)이 되고 열린 쪽에 `openedBy` 가
    남는지(REST·MCP), 헤더 없음·엉터리 id 는 무변화인지, 셸이 끝나면 표시가 풀리는지
  - T23 로딩 화면 — 세션 복원이 끝나면 "Restoring sessions…" 화면이 사라지는지, main 이 업데이트 설치를
    알리면 "Installing update…" 화면이 뜨는지. 세션 167개 재시작은 사이드바까지 5~9초 걸린다(2026-10-01 실측)
  - T24 복원 시 시작 질문 — 복원된(`--resume`) Claude 세션이 신뢰 질문("❯ No, exit")에서 Yes 를 고르고,
    복원된 Codex 세션이 `codex … resume <id>` 로 뜨며 업데이트 제안("› 1. Update now")을 Skip 하는지,
    새로 시작한 세션은 사람에게 남겨 두는지. 모의 대화상자(`agent-mock.cjs --claude-trust`)는 실제 화면을
    본떴지만 **키를 바로 받는다** — 실제 Claude 는 질문을 그린 직후의 키를 무시했다. 그래서 감시자는 화면이
    1.5초 조용해진 뒤 키를 하나씩 보낸다. 이 차이는 실제 Claude 복원으로만 확인된다(2026-10-01)
  - T25 Codex 대화 찾기 — Codex 는 `--session-id` 를 받지 않아, 시작 뒤 `$CODEX_HOME/sessions` 의 rollout
    첫 줄(`session_meta`: id·cwd·시작 시각)로 그 터미널의 대화를 찾는다. 같은 폴더에 둘이면 각자 다른 id 를 받는지
  - T26 탭 이동·닫기·삭제 — Cmd+[ ] 와 Cmd+W, 사이드바 삭제가 모두 **사이드바 순서**를 따르고(드래그 뒤 포함),
    삭제된 세션으로 가지 않는지, 활성 탭 삭제 시 이웃 탭이 보이는지, 분할 화면에서 Cmd+` 가 커서를 옮기고
    Cmd+W 가 활성 칸을 닫는지, Cmd+Shift+[ ] 가 고정·폴더 순서로 워크스페이스를 도는지, 이름 변경 입력·Cmd+T 직후의
    Cmd+W 가 `preventDefault` 되는지(안 되면 앱 메뉴 Close Window 가 받아 **메인 창이 닫힌다** — 네이티브 메뉴는 헤드리스로 못 눌러서 이 플래그로 대신 본다). 판정은 보이는 터미널
    (`visibility`)과 `.xterm.focus`. `activeWorkspace` 상태는 선택 시점 스냅샷이라 탭 순서 계산에 쓰지 않는다.
    macOS 에서 Ctrl+W/R/K/B/P/T/[/]/J 가 단축키가 아니라 PTY 로 가는지도 본다 — 셸을 `stty -icanon` + `cat -v`
    로 두고 `^W^R…` 가 찍히는지로 판정한다(예전엔 `mod` 가 Ctrl 도 받아 Ctrl+W 가 탭을 닫았다)
  - T18 폴더 정렬 — 사이드바 폴더를 드래그 핸들로 옮기면 순서가 config.json 까지 저장되고,
    드래그가 펼침 클릭으로 오인되지 않는지
  - `loop-counter.spec.ts` — Electron 없이 도는 순수 유닛
- **실행**: `pnpm build && pnpm test:term` (빌드된 `out/`을 구동하므로 빌드 필수)
  - **새 클론·워크트리에서는 먼저 `pnpm exec electron-builder install-app-deps`**. `pnpm install`이
    깔아주는 node-pty는 Node ABI용이라 Electron이 못 읽는다(`Cannot find module
    '../build/Debug/pty.node'`로 모든 앱 구동 테스트가 죽는다). postinstall 스크립트는 이 경우를
    덮지 못하고 SKIP 로그만 남긴다 — [`docs/backlog.md`](docs/backlog.md) 참고.
- **Headless 기본**: 테스트 창은 화면에 표시되지 않음 (`CLIMANGER_TEST_HEADLESS=1` 자동 설정, hidden window + backgroundThrottling 해제). 눈으로 보면서 디버깅하려면 `CLIMANGER_TEST_HEADED=1 pnpm test:term`
- **격리**: `CLIMANGER_TEST_USERDATA`로 userData를 임시 디렉토리로 분리 — 실사용 설정을 건드리지 않음
  - 에이전트 통합은 추가로 `CLIMANAGER_HOME`(훅 스풀)·`CODEX_HOME`(사용량)·`HOME`(T8)까지 임시 디렉토리로 돌린다.
  - `hookIntegrationAllowed()`가 테스트 모드에선 설치 자체를 거부하므로 실제 `~/.claude`·`~/.codex`는 절대 수정되지 않는다.
  - **Electron의 `userData`는 `$HOME`을 따르지 않는다**(OS API로 해석). 반면 `os.homedir()`는
    따른다. 그래서 앱 저장소 격리는 `CLIMANGER_TEST_USERDATA`, 설정 파일 격리는 `$HOME`으로
    **각각** 해야 한다. 둘 다 필요한 UI 왕복 테스트(T11)는 `CLIMANAGER_ALLOW_HOOK_INSTALL=1`로
    설치 가드를 되돌린다 — 반드시 가짜 `$HOME`과 함께 쓸 것.
- **계측**: `CLIMANGER_TERM_DEBUG=1`일 때만 `window.__termDebug` 활성화 (`src/renderer/src/utils/terminalDebug.ts`)
- **Mock CLI**: `scripts/mock-cli/`
  - `claude-mock.cjs`: Claude Code 렌더링 패턴 모사 생성기 (fps/히스토리/풀클리어 파라미터)
  - `record-claude.cjs`: 실제 CLI 세션을 pty로 구동·녹화 (`ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron`으로 실행, `--resize-test`로 SIGWINCH 리페인트 캡처)
  - `replay.cjs`: 녹화본(JSONL)을 타이밍대로 재생 — 토큰 소모 없이 실제 바이트 스트림 재현
  - `analyze-recording.cjs`: 녹화본의 ANSI 시퀀스 통계
- **메트릭 비교**: `METRICS_LABEL=<label> pnpm test:term` → `tests/terminal/results/<label>/*.json`

## 문제 해결 접근 방식

- 문제가 보고되면 **바로 코드 수정하지 않는다**
- **ultrathink**를 사용해 깊이 분석한다:
  1. 현재 코드가 어떻게 동작하는지
  2. 왜 문제가 발생하는지 (근본 원인)
  3. 관련된 코드 흐름 전체 파악
  4. 어떤 부분이 영향받는지 (사이드 이펙트)
- 분석 완료 후 수정 방안을 제안하고 **컨펌을 받은 뒤** 코드 수정

## Development Guidelines

### Language Policy

- **Code & UI**: All code, variable names, comments, UI text, error messages, and logs MUST be written in **English**
- **Explanations**: When explaining code or providing guidance, use **Korean** for clarity
- **Documentation**: This CLAUDE.md uses Korean for descriptions, but actual code should remain in English

### 코드 작성 시 주의사항

1. **컴포넌트 크기**: 단일 컴포넌트는 300줄 이하로 유지
2. **커스텀 훅 활용**: 복잡한 로직은 커스텀 훅으로 분리
3. **타입 안전성**: 모든 props와 상태에 명시적 타입 지정
4. **재사용성**: 중복 코드는 유틸리티 함수나 공통 컴포넌트로 추출
5. **주석**: 복잡한 로직에는 JSDoc 주석 추가

### Developer Tools

**Settings > Developer 카테고리 (현재 비활성화)**
- Settings.tsx에서 주석 처리됨
- 필요시 주석 해제하여 활성화:
  ```typescript
  // Developer tools - uncomment to enable
  { id: 'developer' as const, label: 'Developer', icon: <Bug size={16} /> },
  ```

### Git Workflow

1. Feature 브랜치 생성
2. 개발 완료 후 `pnpm build`로 빌드 테스트
3. `pnpm typecheck`로 타입 검증
4. Commit & Push
5. Pull Request 생성

### 디버깅

- **Main Process**: `console.log`는 터미널에 출력
- **Renderer Process**: Chrome DevTools 사용 (F12)
- **IPC 통신**: Main/Renderer 양쪽에서 로그 확인

## Future Improvements

- [ ] Windows/Linux 포트 모니터링 지원
- [ ] 터미널 세션 북마크 기능
- [ ] Worktree 자동 클린업 (병합된 브랜치 자동 삭제)
- [ ] GitHub PR 리뷰 기능
- [ ] 터미널 테마 커스터마이징
- [ ] 다중 창 지원
- [ ] 세션 그룹화 및 태그 기능
