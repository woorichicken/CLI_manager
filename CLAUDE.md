# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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
   - `components/Settings.tsx`: 설정 화면
   - `hooks/`: **커스텀 훅**
     - `useWorkspaceBranches.ts`: 워크스페이스별 브랜치 정보 관리
     - `useTemplates.ts`: 커스텀 터미널 템플릿 관리
   - `constants/`: **상수 및 유틸리티**
     - `icons.tsx`: 템플릿 아이콘 매핑
     - `styles.ts`: 공통 스타일 상수

3. **Preload** (`src/preload/`)
   - `index.ts`: Main ↔ Renderer IPC 브릿지 (contextBridge)
   - `index.d.ts`: TypeScript 타입 정의

4. **Shared** (`src/shared/`)
   - `types.ts`: Main/Renderer 공통 TypeScript 타입 정의

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

### Key Features

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

#### 8. Session Memo
- 각 터미널 세션마다 독립적인 메모장 제공
- 터미널 우상단 아이콘 클릭으로 빠르게 열기/닫기
- 500ms 디바운스 자동 저장 (electron-store에 세션 데이터와 함께 저장)
- 메모가 있으면 아이콘이 노란색으로 변경되어 내용 존재를 표시
- Escape 키로 즉시 닫기
- 세션 삭제 시 메모도 자동 삭제 (TerminalSession.memo 필드)

### Data Flow

```
User Action (Renderer)
  → IPC Call (Preload)
    → IPC Handler (Main)
      → electron-store (Persistent Storage) / simple-git / gh CLI
        → Response to Renderer
          → UI Update
```

### Terminal Session Lifecycle

1. 사용자가 세션 추가 요청
2. Main process에서 UUID 생성 및 세션 정보 저장
3. Renderer에서 TerminalView 컴포넌트 생성
4. TerminalView가 mount 시 `terminal-create` IPC 호출
5. TerminalManager가 node-pty 프로세스 생성
6. pty 데이터를 `terminal-output-{id}` 채널로 브로드캐스트
7. 해당 TerminalView가 xterm.js에 데이터 렌더링

### Storage Schema (electron-store)

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

### IPC Communication

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

#### Communication Patterns
- **Invoke/Handle**: 비동기 요청-응답 패턴 (워크스페이스 CRUD, Git 작업)
- **Send/On**: 단방향 이벤트 스트림 (터미널 입력, 포트 업데이트)
- 터미널 데이터는 모든 BrowserWindow에 브로드캐스트되므로 Renderer에서 ID로 필터링 필요

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

### Terminal Pipeline Testing

터미널 출력/스크롤/리사이즈 회귀를 잡는 Playwright Electron 테스트.

- **위치**: `tests/terminal/` (T1 데이터유실, T2 스크롤튕김 6종, T3 히스토리보존, T4 리사이즈폭풍)
- **실행**: `pnpm build && pnpm test:term` (빌드된 `out/`을 구동하므로 빌드 필수)
- **격리**: `CLIMANGER_TEST_USERDATA`로 userData를 임시 디렉토리로 분리 — 실사용 설정을 건드리지 않음
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
