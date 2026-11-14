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
| When changing where terminal history is kept, how a terminal view attaches to a pty, or when tempted to switch the screen mirror off while the Control API is off | [`docs/decisions/0008-terminal-history-lives-in-main.md`](docs/decisions/0008-terminal-history-lives-in-main.md) |
| When changing how a phone reaches the app (Settings › Phone), who it lets in, or whether a phone may resize a terminal | [`docs/decisions/0009-phone-connection-second-server.md`](docs/decisions/0009-phone-connection-second-server.md) |
| When changing which files a phone may read, the protected list, what a view-only device may open, or how the phone's file panel opens and closes | [`docs/decisions/0010-phone-reads-only-what-the-chat-names.md`](docs/decisions/0010-phone-reads-only-what-the-chat-names.md) |
| When changing how a phone opens an HTML report, what the frame's code can reach, the `/doc/` route, or how a document's comments reach a session | [`docs/decisions/0011-phone-documents-in-a-sandboxed-frame.md`](docs/decisions/0011-phone-documents-in-a-sandboxed-frame.md) |
| When changing what the dictation log keeps, where, for how long, or when tempted to send it anywhere (a report, a phone, the Control API, a server) | [`docs/decisions/0012-dictation-log-stays-on-this-mac.md`](docs/decisions/0012-dictation-log-stays-on-this-mac.md) |
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
   - `CodexSessionLocator.ts`: 공유 10초 감시 · PID 확인 전에는 틱마다 비동기 ps 재확인(최대 15분), 확인 뒤에는 생존만 검사. 새 후보/실패 재시도에만 lsof. PID 생존·실경로·시각·파일 보유로 판정, 모호했던 파일은 자동 제외. UUID resume은 전경 argv·파일·폴더·중복을 확인한 뒤 저장
   - `src/shared/agentCommand.ts`: 저장 원문과 실제 입력 명령을 구분하는 순수 판정. 알려진 옵션 값·준비 구간을 보존하고 불명확하면 원문은 유지·입력만 도구 이름으로. 수동 연결·자동 감지·재시작 직전이 같이 사용
   - `agentConversations.ts`: Mac 세션 메뉴와 Control API/MCP의 대화 목록·연결 공용 판정. 읽기 상한·비밀값 가림·폴더/중복/앞 프로그램 검사, Connect & resume은 저장 후 명령만 입력(Enter 없음), 질문·남은 글은 409. 실행은 사람이 터미널에서 Enter. 재시작은 Enter 유지하되 직전 글 확인·대기 상태로 중복 연결 방지
   - `TerminalMirror.ts`: 모든 터미널 출력을 headless xterm으로 재생 — Control API 가 "사용자가 보는 화면"을 읽고, 새 창·재시작 때 히스토리를 다시 그리는 원본 ([`docs/decisions/0008`](docs/decisions/0008-terminal-history-lives-in-main.md))
   - `ScrollbackStore.ts`: 미러 스냅샷을 30초마다(출력이 있던 세션만) `userData/scrollback/<id>.ans` 에 저장 — 강제종료 뒤 복원용
   - `SessionRelations.ts`: 세션 헤더 「관련 세션」 저장(`sessionRelations`) — API 가 열거나 처음 읽은·입력한 세션, 손으로 추가한 세션. 한 쌍에 한 줄, fork에는 답 위치 `anchor: { turnTs, turnIndex? }`를 함께 저장(옛 관계는 없음). 손으로 빼면 anchor를 지우고, 어느 쪽이든 닫히면 관계도 지운다 ([`docs/architecture/CLAUDE.md`](docs/architecture/CLAUDE.md) 14)
   - `SessionFolders.ts`: All sessions 보기의 세션 폴더 저장(`sessionFolders`) — 소속은 세션의 `sessionFolderId`(세션 하나에 폴더 하나), 폴더를 지워도 세션은 그대로 ([`docs/architecture/CLAUDE.md`](docs/architecture/CLAUDE.md) 14-1)
   - `InboxStore.ts`: 앱 인박스 저장(`inbox`) — 세션이 Control API 로 보낸 「사람 손 필요」 요청(login·review·question·other · 한 줄 · 링크). 같은 안 읽은 요청은 하나로, 최대 200 · 읽은 것 7일 · 세션이 닫히면 지움. 바뀔 때마다 렌더러에 알리고 Dock 배지를 고친다 ([`docs/architecture/control-api.md`](docs/architecture/control-api.md) 「Inbox」)
   - `ChecklistStore.ts`: 헤더 체크리스트 저장(`checklists`) — 제목·프로젝트(워크스페이스)·마감 `YYYY-MM-DD` 하나·항목(한 줄·체크). **세션에 묶이지 않는다**: 총괄·팀장이 Control API(`/v1/checklists` · MCP `checklist_*`)로 만들고, 일은 `send_input` 으로 직접 시키고, 끝낸 세션이 `checklist_check`. 같은 열린 제목은 하나로(빠진 항목만 더함), 최대 100개 × 항목 100(넘치면 거부), 다 끝나도 손으로 지울 때까지 남음, 워크스페이스가 지워지면 프로젝트 연결만 풀림 ([`docs/architecture/control-api.md`](docs/architecture/control-api.md) 「Checklists」)
   - `SessionScreenStatus.ts`: 사이드바 상태 점(Settings › General 「Show Session Status」, 기본 끔) — 1초마다 미러 화면에서 작업 중(`esc to interrupt`)·질문 대기(`AWAITING_INPUT_PATTERNS`, Related·API 와 같은 목록 — 단 작업 중이면 질문으로 안 보고, 입력 상자가 있으면 그 아래만 본다: `TerminalMirror.screenStatus`)를 읽어 **바뀐 세션만** `session-screen-status` 로 보낸다. 출력이 없던 화면은 다시 읽지 않는다. 끄면 타이머·IPC 가 없다. 셸 로그(출력만 있음)는 점이 안 켜진다 — Related 의 「Working」(최근 출력도 셈)과 다른 점
   - `screenLines.ts`: 화면 줄에서 읽을 것 고르기(입력 상자 규칙선, 「마지막 줄」, 일하는 중 `isBusyRow` — 「esc to interrupt」 또는 Claude Code 2.1.318 의 맨 스피너 줄, 미러·Chat·질문 판정이 같이 쓴다) — pty 없이 테스트하려고 `TerminalMirror` 밖에 둔다
   - `TranscriptReader.ts` · `ConversationService.ts` · `promptScreen.ts` · `transcript/`: Chat view — 에이전트 대화 기록 파일을 늘어난 만큼만 읽어 턴으로(해석은 ovis 에서 옮김, MIT), 화면에서 질문 메뉴를 읽어 카드로, 보내기는 Control API 입력 경로(AI 표시 없음). 보내기 직전 같은 메뉴인지 다시 읽는다. 화면은 **미러를 flush 한 뒤에만** 읽고 그 출력 시각까지를 「읽음」으로 둔다(flush 없이 읽으면 그리기 전 화면을 읽고 카드가 남는다 — 2회차에 잡음). 2회차: 모델·추론·문맥(`transcript/metadata.ts`, ovis 이식), 그림·잘린 출력 다시 읽기(`findRecord` — 끝에서 4MB 씩 거꾸로), Stop(일하는 중 화면일 때만 Esc), 대기열 하나씩 Send now·버리기, `/` 명령 목록(`chatCommands.ts`, ovis 명령 표 이식 — 터미널 전용 표시), 붙여넣은 그림 저장(`chatAttachments.ts`, 임시 폴더 ASCII 이름), 백그라운드 셸·에이전트 목록(`transcript/backgroundTasks.ts` · 렌더러 `ChatView/BackgroundTasksChip.tsx`, ovis 이식 MIT — 기록의 `backgroundTaskId`·`<task-notification>`·TaskStop·`subagents/agent-*.meta.json`, 쉬는 중엔 화면 입력 상자 아래 수로 lost 판정) ([`docs/architecture/CLAUDE.md`](docs/architecture/CLAUDE.md) 15)
   - `chatFork.ts`: Chat 「Reply in thread」의 순수 부분 — 새 이름(`· fork`), 시작 명령(Whole: Claude `--resume <id> --fork-session` · Codex `fork <id>`, `agentCommand.ts` 규칙으로 사람 명령 유지), 첫 말(Excerpt 발췌·상한·가림 / Quote). 세션은 `ControlApiService.openFork` 가 연다(AI 표시 없음, Related 「Opened」 + 검증한 답 anchor). 일반 클릭은 Whole 즉시 실행, Shift+클릭은 ForkDialog. `ThreadChip` 상태 점(질문 대기 우선)·목록 선택은 Mac의 오른쪽 `ThreadPanel`을 열며, `ChatThread.forkedAt` 이후 자식 턴만 같은 `ChatView`로 그린다(부모 선택·단축키 유지). 답 아래 칩은 `chatThreads.ts` + `chat-threads` IPC(선택 ChatTransport), 기존 미러 상태·자식 출력 시각으로 표시. `ChatView/threadGroups.ts`는 턴 키별 배열 참조를 유지해 스레드 없는 답의 memo를 지킨다 ([`docs/architecture/CLAUDE.md`](docs/architecture/CLAUDE.md) 15)
   - `ClaudeSessionSync.ts`: Claude 의 실행 중 세션 레지스트리(`~/.claude/sessions/<pid>.json`)를 읽어 저장된 대화 id 를 실제 대화로 맞춤 — Claude 안에서 `/resume` 하면 id 가 바뀐다
   - `FeedbackRelay.ts`: 피드백 위젯의 HTTP 요청을 main 에서 대신 보낸다 — 배포 렌더러는 `file://` 라 `Origin: null` 이 되고 라쏘런이 403 으로 거부한다. 수집 함수 경로만 허용
   - `TerminalEventLog.ts`: 터미널마다 최근 사건(시작·복원·다시 붙음·붙기 시간 초과·Cmd+K·PTY 크기 변경 `80x30→111x43`(창 끌기처럼 몰린 것은 한 줄)·프로그램의 스크롤백 삭제 CSI 3 J·종료 코드·닫힘)과 창 사건(렌더러 크래시·새로고침)을 메모리에만 둔다 — 제보가 「무엇이 먼저 있었나」를 싣는 원본
   - `phone/`: 폰 연결(Settings › Phone, 기본 꺼짐) — `PhoneServer.ts`(127.0.0.1 두 번째 서버, Control API 와 분리, 정해진 경로만) · `phoneAccess.ts`(접근 판정 순수 함수: Tailscale serve 주인 로그인 + tailnet XFF, 아니면 짝지은 기기, Funnel 거절) · `PhoneDevices.ts`(6자리 · 10분 · 5회, 해시만 0600) · `PhonePush.ts`(웹 푸시 — 질문 대기·턴 끝, Mac 앞이면 안 보냄, 세션당 1분) · `phoneApi.ts`(Chat 은 `ConversationService` 를 같은 프로세스에서) · `phoneSockets.ts`(터미널: 스냅샷 → 이어 붙이기, **크기 메시지 거절**) · `tailscaleStatus.ts`(`tailscale status --json` 읽기만) · `phoneDoc.ts`·`phoneDocBridge.ts`(보고서를 분리 칸에서 — 토큰 경로 `/doc/`, 키트의 복사를 부모로 넘기는 스크립트, [`docs/decisions/0011`](docs/decisions/0011-phone-documents-in-a-sandboxed-frame.md)) · `phoneChatSettings.ts`·`PhoneSettingsMenu.tsx`(렌더러 phone/ — 이 폰에만: Return 으로 보내기 · 빠른 답(목록은 /me 의 `quickReplies` = Mac 설정, Mac 에 넣은 문구가 있으면 기본 켬) · 내 마지막 말 고정 · 다른 세션 알림 끄기) · `phoneConnections.ts`(지금 연결된 폰 — 소켓 또는 1분 안 요청, 이름·경로 Tailscale/USB·브라우저·연결 시각 → 설정 «Connected now», 순수) · `phoneFiles.ts`·`phoneFileAccess.ts`(폰이 대화 속 파일을 읽는 길 — 8단계 판정 `openGrantedFile`, 금지 목록은 순수 함수, [`docs/decisions/0010`](docs/decisions/0010-phone-reads-only-what-the-chat-names.md)) · 이름 바꾸기(0a4bdfff — 헤더 제목 누름 → `PhoneRenameBar.tsx`, `POST /api/phone/rename/<id>` 는 drive 만·Control API `renameSession` 그대로라 사이드바가 바로 따라옴, 삭제는 여전히 없음) · 메모(84188aa0 — `phoneApi` `GET /api/phone/memo/<id>`·`PhoneMemoPanel.tsx`: 세션 헤더 📝 → 그 세션 메모 쪽을 읽기만, 줄마다 maskSecrets, 메모가 있는 세션만 목록에 `memoPages`) · `phoneUsage.ts`(사용량 보기 3b4efdfc — 앱 자체 `UsageTracker` 값 + agent-swap 이 있으면 로그인 셸로 `aswap list --json`, 폰이 볼 때만·60초 캐시·한 번에 하나·10초 제한, 이메일은 앞 2글자만, 렌더러 `PhoneUsagePanel.tsx`) · `phoneDock.ts`(Artifact Dock `list` 소켓 읽기 — 받은 순서 그대로, 네 상태, 마지막 목록은 메모리만, `docFor`) · `phoneSetup.ts`(배선·IPC) ([`docs/decisions/0009`](docs/decisions/0009-phone-connection-second-server.md))
   - `Dictation.ts`: Chat 받아쓰기(마이크, macOS) — Swift 헬퍼 `native/dictation`(기기 안 인식만, `scripts/build-dictation.cjs`)를 자식으로 돌려 줄마다 JSON 을 창에 전한다. 한 번에 하나·시작한 창 것·창이 닫히거나 새로 고치면 끔. 권한은 앱 Info.plist(`electron-builder.yml` `extendInfo`)의 설명으로 묻는다 — 없으면 macOS 가 헬퍼를 SIGABRT 로 죽인다(`permission_setup`, 터미널에서 띄운 dev 빌드). 렌더러는 `ChatView/useDictation.ts`(받아 적기만, 보내기는 사람) · ⌘⇧D `toggleDictation`. 글은 받아쓰기 한 번 전체 — 말이 멈추면 인식기 결과가 새 말만 담고 다시 시작해서 헬퍼 `Transcript.swift` 와 main `shared/dictationTranscript.ts` 가 앞 글을 이어 붙인다(같은 규칙, T106 이 한 시험 표로 둘 다 본다)
   - `DictationLog.ts`: 받아쓰기 기록(Settings › Chat view 「Keep dictation log」, 기본 끔 — [`docs/decisions/0012`](docs/decisions/0012-dictation-log-stays-on-this-mac.md)) — `userData/dictation-log/YYYY-MM-DD.jsonl` 에 한 번에 한 줄(받아 적힌 글 `finalText` ↔ 보낸 입력칸 `sentText`·결과·에이전트·언어), 「Also keep audio」면 `audio/<id>.wav`(헬퍼 `--audio-out`). 폴더 0700·파일 0600, `maskSecrets` 로 가린 뒤 씀, 글 30일·소리 7일(시작 + 하루 한 번). 제보·폰·Control API 에 안 실림
   - `feedbackMode.ts`: 렌더러가 알린 「피드백 위젯 켜짐」을 main 이 기억 — 폰 서버가 `/api/phone/me` 로 넘긴다(`phone/phoneFeedback.ts` 가 릴레이·터미널 맥락 경로)
   - `feedbackTerminalContext.ts` / `maskSecrets.ts`: 제보에 실을 터미널 상태와 최근 200줄을 만든다. 줄은 비밀값·홈 폴더·계정 이름을 가린 뒤 나간다. 오른쪽 끝에서 끊긴 키도 가린다 — zsh 는 긴 입력 줄을 스스로 끊어 wrap 표시가 없다

2. **Renderer Process** (`src/renderer/`)
   - `App.tsx`: 메인 애플리케이션 컴포넌트, 상태 관리
   - `components/Sidebar/`: **리팩토링된 모듈형 사이드바 컴포넌트**
     - `index.tsx`: 메인 Sidebar 컴포넌트 (200줄 이하)
     - `WorkspaceItem.tsx`: 워크스페이스 항목 컴포넌트
     - `WorktreeItem.tsx`: Worktree 워크스페이스 항목 컴포넌트
     - `SessionItem.tsx`: 터미널 세션 항목 컴포넌트
     - `ContextMenus.tsx`: 컨텍스트 메뉴 컴포넌트들
     - `Modals.tsx`: 모달 컴포넌트들
     - `SidebarSearch.tsx`: 프로젝트 검색 입력 + 매칭(`findMatchingProjects`). 검색 중엔 드래그 목록 대신 평평한 결과 목록을 쓴다 — 재정렬 핸들러는 받은 목록 순서를 그대로 저장해서, 걸러진 목록을 주면 행이 빠진다
     - `SidebarMoreMenu.tsx`: 머리 줄 「…」 메뉴 — 전체 접기(`sidebar-collapse-all`)·새 폴더(`sidebar-new-folder`). 인박스 종이 들어가며 버튼 수를 예전과 같게 두려고 접었다(기본 폭 256 에서 제목이 안 잘리게). 메뉴는 보기를 따른다 — All sessions 보기에서는 같은 자리에 세션 폴더용 항목(New Session Folder `sidebar-new-session-folder` · Add Workspace…)이 뜬다(제보 afbc3546 · 078ee766, `folderKind`). 세션 폴더 전체 접기/펼치기는 메뉴가 아니라 All sessions 머리 줄 버튼(`sidebar-collapse-session-folders`, 세션 폴더가 있을 때만 — 폴더 보기의 `+` 자리라 버튼 수가 같다, 제보 09aa3d01). 머리 줄 `+`(Add Workspace, `sidebar-add-workspace`)는 폴더 보기에만 있고 All sessions 에서는 이 메뉴의 「Add Workspace…」(`sidebar-more-add-workspace`)로 간다(제보 d9783659) — `+` 도 보기 전환 버튼 왼쪽이라 빠져도 전환 버튼이 제자리다. 보기 전환 버튼 왼쪽에 둔다 — 버튼 줄이 오른쪽 정렬이라 「…」가 빠져도 전환 버튼이 제자리에 있다(오른쪽에 두면 빠질 때 검색 버튼이 전환 버튼 자리로 밀려 온다)
     - `CopyNotice.tsx`: 메뉴의 Copy 항목이 쓰는 클립보드 복사 + "Copied …" 알림
     - `SessionSelectionBar.tsx`: All sessions 에서 여러 세션 고르기(0d1e3d34) — `useSessionSelection`(고른 순서 · 닫힌 세션은 빠짐 · 보기를 떠나면 비움)과 목록 아래 막대 「N selected · Side by side · Copy IDs · ✕」. 체크 칸은 줄 아이콘 자리(마우스를 올리면, 하나라도 골랐으면 모든 줄) — 줄을 누르면 지금처럼 그 세션으로 간다. Copy IDs = 전체 id 한 줄에 하나(고른 순서), Side by side = 2~4개(`MAX_LINKED_SESSIONS`) `showSessions`. 검색 결과에는 없다
     - `SidebarAllSessions.tsx`: All sessions 보기 — 세션 폴더 줄(접기·개수·우클릭 이름 바꾸기/지우기) 밑에 그 폴더 세션, 그 아래 「No folder」 줄과 나머지. 세션 줄을 폴더 줄·「No folder」 줄에 끌어 놓으면 넣고 뺀다
     - `sessionDrop.tsx`: 세션 줄 끌기 컨텍스트 — 끌고 있는 id(dragover 는 끌기 데이터를 못 읽는다)와 「다른 세션 줄 위에 놓음 = Related 에 넣기」(제보 269168e4), 놓은 뒤 사이드바 아래 알림
     - `SidebarSessionList.tsx`: 세션을 작업 영역 이름(흐리게)과 함께 평평하게 그리는 목록 — 헤더 「All sessions」 토글(`sidebar-view-toggle`, localStorage `sidebar-view-mode`)과 검색의 「Sessions」 묶음이 같이 쓴다. 행은 트리와 같은 `SessionItem`. 순서는 최근 본 순(`getRecentSessions`) 뒤에 안 본 세션을 사이드바 순서로(`utils/sessionNavigation.ts` 의 `orderByRecent`)
     - `SidebarSessionTree.tsx`: All sessions 의 Tree 배치(`all-sessions-layout-tree`, localStorage `sidebar-all-sessions-layout`) — 세션을 연 세션 밑에 들여 쓰고(`data-tree-depth`) 파일 나무처럼 ├ │ └ 안내선으로 잇는다(`treeGuidesFor` — 보이는 줄의 깊이만으로 계산, 접은 가지는 선이 안 내려감, a35f1aa1) 작업 폴더 경로를 앞에서 잘라 보인다(`workspaceLabelFromEnd`). 줄은 **이름이 먼저** — 경로가 먼저 줄고 모자라면 숨으며(접힌 둘째 줄), 그래도 긴 이름은 가운데를 접어 끝 12자를 남긴다(배치 세션 이름은 끝이 다르다). 마우스를 올리면 전체 이름 + 경로 나무는 `sessionForestFor`(`utils/relatedSessions.ts`) — 뿌리마다 Related 창의 `sessionTreeFor` 를 불러 규칙(고리·깊이 상한·뺀 짝·손으로 넣은 짝 제외)이 같다. 나무에 안 드는 세션은 「Not in a tree」. Settings › General 「Show Session Tree」(`showSessionTree`, 기본 켬)를 끄면 전환이 사라지고 List · 손으로 넣은 짝(끌기·Related Add)은 놓은 쪽이 부모이고 최근 손 짝이 연 세션을 이긴다(`splitTreeRelations`) · 순서는 최근 본 순이 아니라 고정(뿌리 사이드바 순·자식 관계 순, 제보 d44191ed) · 자식 있는 줄은 └ 자리 ▸/▾ 로 접고 localStorage `sidebar-session-tree-collapsed` 에 남긴다(dca55fd6) · List·세션 폴더 안은 고정 세션 아래 구분선(`session-list-pinned-divider`, f44ebd21)
   - `components/Feedback/`: feedback-kit 위젯 — `FeedbackGate`(비밀번호 관문·마운트), `FeedbackWidget`(배선, 통과한 뒤에만 lazy import), `FeedbackModeSetting`(Settings > Feedback 토글), `terminalContext`(제보가 어느 터미널 얘기인지 정하고 main 의 터미널 정보를 싣는다). 판정·상수는 `utils/feedbackGate.ts`
   - `components/SessionBreadcrumb.tsx` · `utils/sessionBreadcrumb.ts`: 세션 헤더 `폴더 > 프로젝트 > 세션` 경로(단일 헤더·분할 칸·Grid 창이 같이 쓴다). 폴더가 없거나 Playground 면 그 칸을 뺀다, 워크트리는 부모 폴더를 따른다, 좁으면 폴더·프로젝트부터 줄인다
   - `ChatView/draftStore.ts` · `draftHandoff.ts` · `HandoffNoticeToast.tsx` · `utils/sessionViewSwitch.ts`: Terminal ↔ Chat 전환(헤더 버튼·⌘⇧M·폰 탭)이 쓰던 글을 옮김 — Chat → 입력창(Enter 없음, 글 있으면 덮지 않음), 한 줄 초안 → Chat 칸, 여러 줄·Codex 는 토스트 안내만(main `ConversationService.placeDraftInTerminal`·`takeTerminalDraft`, 4b9cb0c2)
   - `components/ChatView/` · `SessionChatSlot.tsx` · `SessionViewToggle.tsx`: 세션 헤더 「Terminal / Chat」과 Chat view(말풍선·마크다운·코드 색칠·작업 접기·질문 카드·입력칸). `ChatView/` 는 `window.api` 를 부르지 않고 `ChatTransport` 를 props 로 받는다(폰이 같은 부품을 쓴다) — Electron 쪽은 `utils/electronChatTransport.ts`. 2회차(ovis 대비 빠진 것, `gap.md`): 첨부 ＋·붙여넣기·끌어 놓기(제 경로를 `@path`, 미리보기는 data: — 앱 CSP 가 blob: 을 막는다) · 파일 경로 → `ChatFilePreview.tsx`(그림·글은 앱 미리보기, 그 밖은 Mac 기본 앱) · 그림 라이트박스 · 바뀐 줄 · Stop/Esc · 경과 시간 · 흐린 보낸 말풍선 · 대기 하나씩 · 계획 칩 · 모델 칩(바꾸기는 /model, 기본값도 바뀐다는 확인) · 문맥 칩 · `/`·`@` 자동완성 · 터미널 전용 명령 → 「Back to Chat」 띠 · 카드 번호 입력 · 빠른 답·Enter 설정(`ChatViewSettings.tsx`, Settings › Terminal) · 레일 · 앞 턴 더 보기 · 스크롤 자리 기억. 단축키 ⌘⇧M Terminal/Chat · ⌘⇧I 입력칸 · ⌘⇧PgUp/PgDn 한 쪽(터미널이면 `requestTerminalPage` 로 스크롤백) — App 이 `sendChatCommand` 로 그 세션 Chat 에 전한다. 순수 함수는 `ChatView/chatLib.ts`
   - `phone/` + `../phone.html`: 폰 페이지(렌더러 두 번째 Vite 입구, 폰 서버가 낸다 — Electron 안에서 뜨지 않음). 세션 목록(작업 공간·세션 폴더 묶음·상태 점, 만들기·지우기 없음) · 「Chat | Terminal」 · 데스크톱 `ChatView` 에 `phoneChatTransport`(fetch + WS) · `PhoneTerminal`(Mac 칸 수 그대로 축소, 키 바 `keyBar.ts`·iOS 키보드 `viewport.ts` — ovis, MIT) · 짝짓기 · 알림 · `PhoneDockPanel.tsx`(☰ → Dock, 대화 위 패널, 받은 순서 그대로 · `phone-dock.css`) · `PhoneFilePanel.tsx`(대화 속 경로·도구 ↗·첨부 칩 → 대화 위 패널: 사진·글·`.md`·받기 — 입력 가능 기기만, 뒤로 가기로 닫힘, 줄 수는 `phone-file.css`). 링크 목록은 `ChatView/chatMentions.ts`(화면과 같은 함수, main 이 판정에 씀). `components/PhoneSettings.tsx`(설정 Phone) · `PhoneBadge.tsx`(사이드바 아래 「Phone on · n connected」 + 끄기) · 문서 보기 `PhoneDocPanel.tsx`·`PhoneDocFrame.tsx`·`DocSendSheet.tsx`(코멘트는 시트에서 Send 를 눌러야 세션으로)·`docMessages.ts`(칸의 말·보낼 글·저장, 순수)
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
     - `useSidebarCollapseAll.ts`: 사이드바 전체 접기 — 접기 직전 펼침 상태를 기억했다가 다음 누름에 그대로 복원
     - `useSessionScreenStatus.ts`: 사이드바 상태 점의 모듈 저장소(`useSyncExternalStore`) — 줄마다 자기 항목만 고르므로 점 하나가 바뀌면 그 줄만 다시 그린다(App 상태에 두면 App 과 모든 줄이 다시 그려진다). 설정이 켜져 있으면 옛 배지(Settings › Hooks 의 화면 추측·hook)를 대신한다
     - `useSessionFolders.ts`: All sessions 세션 폴더 목록과 동작(만들기·이름·지우기·펼침·세션 넣고 빼기) — 화면을 먼저 바꾸고 뒤에서 저장
   - `utils/reviewPrompt.ts`: diff 라인 선택 → 에이전트 프롬프트 조립
   - `utils/shortcutHints.ts`: 단축키 표시(`formatBinding` — Settings 와 같은 순서 ⌘⌥N, 다른 OS 는 Ctrl+Alt+N)와 툴팁 문구 `useShortcutHint()`(`hint('New page', 'memoNewPage')` → 「New page (⌘⌥N)」). App 이 Settings › Keyboard 바인딩을 모듈 저장소에 넣어 바꾼 키가 툴팁에도 나온다(제보 386b0c76). 기본값과 저장된 키를 합치는 건 `effectiveShortcuts`(`shared/types.ts`) — **새 판에 더한 기본 키가 사람이 이미 다른 동작에 지정한 키와 같으면 그 기본값을 비운다**(`code: ''`, Settings 에 「Not set」 — 2회차 ⌘⇧M 이 T62 의 메모 키를 빼앗던 것). `KeyboardSettings`·메인 헤더·메모·사이드바·Related 버튼이 쓴다 — **단축키가 있는 버튼을 새로 만들면 title 을 이 함수로** 쓴다(시험 선택자는 `title^=` 앞부분 일치)
   - `utils/platform.ts`: 앱 단축키 수식키 판정 — macOS 는 Cmd 만, 그 외는 Ctrl. macOS 의 Ctrl 은 터미널 몫이라 단축키로 받지 않는다 (`useKeyboardShortcuts`·`KeyboardSettings` 가 사용)
   - `components/RelatedSessions/` · `utils/relatedSessions.ts`: 세션 헤더 「Related」 버튼과 모달 — 세 묶음(연 세션·이 세션을 연 세션·손으로 추가), 상태·마지막 줄·메모, 「대화:」 세션 배지. 이동·나란히 열기는 세션 링크와 같은 `showSessions`(App.tsx)
   - `components/Inbox/` · `hooks/useInbox.ts`: 인박스 — 사이드바 머리 줄 맨 앞 종(안 읽은 수, 사이드바를 접으면 메인 헤더에), 목록 팝오버(누르면 그 세션 — `showSessions`, 링크는 `terminalLinks.ts` 판정 — 둘 다 읽음으로 바꾸지 않는다), 세션 행 주황 점(`InboxDot`). 읽음은 줄의 ✓(`inbox-mark-read`)·「Mark all read」·API `POST /v1/inbox/:id/read` 뿐 — 세션을 열거나 봐도 안 읽은 채(제보 b165acc4). 두 줄을 넘는 요청은 줄에 마우스를 올리거나 포커스하면 전부 보인다(8bf5e3f9)
   - `components/Checklists/` · `hooks/useChecklists.ts` · `utils/dueDate.ts`: 헤더 체크리스트 — 메인 헤더 오른쪽 버튼 줄 맨 앞 칩(마지막에 본 체크리스트 — 다른 프로젝트의 세션으로 옮기면 그 프로젝트의 첫 체크리스트로 바뀌고, 그 프로젝트에 없으면 그대로(9ddedfe3) · 끝낸 수/전체 · 마감, 분할 보기에도 남음, 640px 아래는 아이콘+수만)과 인박스처럼 portal 로 뜨는 패널(‹ ›·← → 넘김, 제목 더블클릭 이름 바꾸기, 프로젝트 선택, 마감(고른 날짜는 0.6초 뒤 저장), 진행 막대, 항목 체크·이름·×, Add an item…, + New checklist(지금 세션의 프로젝트로), Delete 두 번, 「by <만든 세션>」을 누르면 그 세션으로 — 41323382). 칩의 마감·Done 배지는 테두리 없는 9px(제목보다 한 단계 아래 — 63947391). ⌘⇧J(`toggleChecklists`). 마지막에 본 것은 localStorage `checklists-last-viewed`
   - `components/SessionNavButtons.tsx` · `hooks/useSessionHistory.ts`: 세션 헤더의 ‹ ›(보여 준 세션을 브라우저처럼 뒤로/앞으로 — 메모리에만, 닫힌 세션은 건너뜀)와 상위 세션 바로가기(이 세션을 연 세션이 하나일 때만)
   - `utils/terminalLinks.ts` · `components/TerminalLinkSchemesSetting.tsx`: 터미널 링크를 OS 로 넘겨도 되는지 판정 — 기본 허용(http·https·file·에디터) + 사용자가 Settings > Terminal 「App Links in Terminal」에 넣은 앱 스킴(`obsidian` 등, 기본 비어 있음). 그 스킴은 일반 텍스트(`obsidian://…`, 한글 그대로)도 링크로 잡는다. `javascript`·`data`·`climanager` 같은 예약 스킴은 넣을 수 없다
   - `utils/terminalPathSelection.ts`: 터미널 선택 → 경로 후보(소프트 줄바꿈 + Claude Code 식 들여쓴 이어짐 줄 잇기 — 윗줄이 cols−6 이상 칠해졌거나 아랫줄 첫 낱말이 안 들어가고, 아랫줄이 불릿·기호로 시작하지 않을 때. 공백 없는 선택은 앞뒤로 넓히고 `Bash(B=/…;` 같은 덩어리에서 경로 모양만 꺼낸다)·복사용 이은 경로. Finder/에디터 열기(우클릭·⌘⇧O/E)는 후보를 디스크에 있는 것까지 차례로, ⌘C 는 이은 결과가 공백 없는 한 덩어리일 때만 바꾼다(제보 09eff960 · 06db516a · 85703148). xterm 자체 copy 처리기가 textarea 에서 덮어써 copy 처리는 `stopPropagation` 이 필요하다
   - `utils/sessionLink.ts`: 세션 링크 `climanager://session/<id 또는 앞 8자>[,…]` — 터미널에서 누르면 그 세션으로(여럿이면 분할 화면, 최대 4). 화면 전환만 한다(터미널 출력은 믿을 수 없는 글). 에이전트는 터미널에 **앞 8자**로 찍는다 — Claude Code 는 화면보다 긴 낱말을 들여쓰기로 끊어 링크를 깨뜨린다
   - `constants/`: **상수 및 유틸리티**
     - `icons.tsx`: 템플릿 아이콘 매핑
     - `styles.ts`: 공통 스타일 상수

3. **Preload** (`src/preload/`)
   - `index.ts`: Main ↔ Renderer IPC 브릿지 (contextBridge)
   - `index.d.ts`: TypeScript 타입 정의

4. **Shared** (`src/shared/`)
   - `types.ts`: Main/Renderer 공통 TypeScript 타입 정의
   - `terminalResize.ts`: `resizeKeepingBottom` — 높이만 바뀌는 resize 를 「화면 아래 기준」으로(줄 때 위 줄이 스크롤백으로, 늘 때 스크롤백에서 되돌림). 렌더러 xterm(`TerminalView`)과 main 미러(`TerminalMirror`)가 **같이** import 한다 — 두 사본이 다르게 줄이면 복원 히스토리가 사용자가 본 것과 달라진다(아래 렌더링 불변식 7)

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

### Feedback Widget

- **피드백 위젯 — 부착 타입 `dev+url`**: `pnpm dev`(localhost)에선 항상, 배포 앱은 Settings > Feedback 에서 비밀번호를 넣은 Mac 에서만 뜬다. 판정 `src/renderer/src/utils/feedbackGate.ts`. 수집처: 라쏘런 프로젝트 `3fa1c5e0-971e-45df-a514-675b18af0085`(CLI Manager 사이트), 소스 `climanager-app`(허용 호스트 `desktop.climanager.solhun.com` — 실제 사이트가 아니라 main 릴레이가 붙이는 Origin). URL·KEY 는 빌드 변수 `VITE_DP_FEEDBACK_URL`/`VITE_DP_FEEDBACK_KEY`(`.env.local`, 커밋 금지)
- 전송은 렌더러가 아니라 main(`FeedbackRelay.ts`)이 한다. 제보의 `url` 도 `https://desktop.climanager.solhun.com/` 로 바꿔 싣는다 — 실제 주소는 `file://…/app.asar/…` 라 서버가 400 으로 거부하고 설치 경로까지 샌다
- **모든 제보에 터미널 정보가 기본으로 실린다**(체크박스 없음 — 2026-10-18 사용자 결정). 대상 터미널은 지목한 요소가 든 터미널(또는 사이드바 세션 행) → 마지막으로 포커스된 보이는 터미널 → 하나뿐인 보이는 터미널 순이고, 여럿 보이는데 고른 게 없으면 싣지 않는다(추측하지 않는다). 숨긴 터미널은 `visibility: hidden` 이라 크기로는 못 가른다
  - 사건은 제보의 `logs` 로 가서 라쏘런 「앱 로그」에 뜬다(`[terminal] scrollback-erased` 등). 상태·최근 줄은 `context.extra.terminal` → 서버 `meta.extra.extra.terminal`(「기타」 카드에 JSON 으로 보인다)
  - 최근 줄은 비밀값을 가리지만 **스크린샷은 가리지 않는다** — 화면에 보이는 그대로 간다
- **폰 화면(phone.html)에도 같은 위젯이 뜬다** — 조건은 Mac 과 같다(그 Mac 이 피드백 모드 켜짐 · 개발 빌드는 항상). 폰은 스스로 판정하지 않는다(`adb reverse` 면 폰 주소도 localhost): 렌더러가 켜짐을 `feedback-mode` IPC 로 알리고(`src/main/feedbackMode.ts`) `/api/phone/me` 의 `feedback` 플래그(drive 기기에만)로 판정, 꺼져 있으면 위젯 청크를 안 받는다. 보내기는 `POST /api/phone/feedback/relay` → 기존 `relayFeedbackRequest`(15MB 상한, watch 403, 꺼짐 403), 보던 세션의 터미널 줄은 `GET /api/phone/feedback/terminal`(`src/main/phone/phoneFeedback.ts`). 키트의 떠 있는 버튼은 CSS 로 숨기고(오른쪽 아래 = Chat 보내기·키 바) ☰ 서랍 머리 「Feedback」 버튼이 서랍을 닫고 **요소 지목**을 시작한다(키트 기본 — 탭이 click 으로 가서 지목된다, 갤럭시 실측 11-05). 지목 중에는 ☰ 탭도 지목이라 「화면 전체」·「지목 끄기」는 오른쪽 아래 독 메뉴에 있다. 키트 리포트 모달은 100vh(키보드에 안 줄어드는 큰 뷰포트)라 보내기가 키보드 뒤로 숨어서 `phone.css` 가 보이는 높이(`--phone-visible-height`, `viewport.ts`)로 줄이고 버튼 줄을 아래 고정한다. 제보 `url` 은 `…/phone?screen=list|session`, `extra` 는 `surface: 'phone'`·appVersion·`phoneDevice`(짝지은 이름 — Tailscale 로그인 이메일은 안 실음)·`phoneSessionId`·`phoneView`·`terminal`(source `viewing`)
- 비밀번호·릴리즈 빌드·검증 절차는 [`docs/operations/CLAUDE.md`](docs/operations/CLAUDE.md) 「Feedback widget」

### GitHub Integration

- **gh CLI 필요**: GitHub 기능 사용을 위해 gh CLI 설치 및 인증 필요
- **Push**: `git push origin <branch> --set-upstream` 실행
- **PR 생성**: `gh pr create` 명령어 사용, 자동으로 브랜치 푸시
- **인증**: `gh auth status`로 인증 상태 확인, `gh auth login --web`으로 로그인

### Build Configuration

- `electron-vite`는 Main/Preload/Renderer를 별도로 번들링. 설정 파일은 **`electron.vite.config.ts`**(점) — 옆의 `electron-vite.config.ts`(하이픈)는 이름이 달라 한 번도 읽히지 않았다(없는 `@vitejs/plugin-react` 를 부른다). 렌더러 입구는 둘(`index.html` · `phone.html`)이고 `manifest: true` — 폰 서버가 manifest 로 폰이 싣는 청크만 낸다
- main 이 쓰는 npm 패키지를 `dependencies` 에 넣으면 번들에서 빠지고(외부화) 배포 앱에는 없다(`electron-builder.yml` 이 node_modules 를 allowlist 로만 싣는다). 번들에 넣을 것(`ws`·`web-push`)은 `devDependencies` 에 둔다 — 렌더러의 react 와 같은 규칙
- **번들한 패키지의 선택 의존성은 Vite 가 빈 객체로 바꾼다** — `try { require('bufferutil') }` 가 실패하지 않아 대체 코드로 안 간다. `ws` 는 32바이트 이상 클라이언트 프레임에서 없는 `unmask` 를 불러 main 이 멈췄다(T76) → `electron.vite.config.ts` main `define` 으로 ws 자신의 끄기 스위치(`WS_NO_BUFFER_UTIL`)를 박았다. 새 패키지를 번들하면 `out/main/index.js` 에서 `__viteOptionalPeerDep_` 를 찾아본다
- Renderer는 Vite + React HMR 지원
- Main/Preload는 CommonJS 모듈 시스템 사용 (`type: "commonjs"`)

### Terminal Rendering Invariants (회귀 주의)

CLI TUI(Claude Code, Codex)의 화면 갱신 패턴 때문에 도입된 동작들. 변경 시 반드시 `pnpm test:term`으로 검증할 것.

1. **`scrollOnEraseInDisplay: true`** (TerminalView.tsx, xterm 6.0+)
   - CLI가 전체 클리어(CSI 2J)할 때 viewport 내용을 지우는 대신 scrollback으로 보존
   - 이 옵션이 없으면 클리어마다 화면에 보이던 대화 내용이 영구 파괴됨
2. **숨김 터미널 resize 보류 — xterm 도 PTY 크기에 묶어 둔다** (applyTerminalDimensions)
   - `visible`이 아닌 터미널은 PTY resize를 보내지 않고, **xterm resize 도 하지 않는다**(Grid 창의 `disablePtyResize` 만 예외)
   - PTY resize = SIGWINCH = CLI 전체 리페인트 → 터미널 N개면 창 드래그 1번에 N개 세션의 scrollback이 리페인트 잔여물로 오염됨
   - 숨긴 xterm 만 크기를 바꾸면 프로그램은 옛 크기로 그리는데 화면은 새 크기로 접어 쓴다 — 그 잔해가 보인 뒤에도 스크롤백에 남고, main 의 미러(PTY 크기)와 달라진다(제보 325d9a7d 에서 화면 ↔ 미러가 달랐다)
   - visible 전환 시 visibility effect가 `lastPtySizeRef`를 비워 최신 크기를 xterm·PTY 에 정확히 1회 적용
   - **숨긴 채 만들어지는 터미널도 상자에 맞춘 크기로 PTY 를 띄운다.** 숨김은 `visibility: hidden` 이라 상자 크기가 이미 있다. 예전엔 80×30 으로 띄워 복원된·API 가 연 Claude 가 대화 전체를 80칸으로 그렸고, 처음 볼 때의 resize 에 Claude Code 는 **화면에 보이는 줄만** 새 폭으로 다시 그려서 80칸 사본이 그 위 스크롤백에 남고 경계에서 줄이 빠지거나 겹쳤다(제보 f77530f2 · 325d9a7d — 좁은 사본의 가장 긴 줄이 정확히 80). 회귀는 `t41-hidden-terminal-size.spec.ts`
3. **출력 IPC 배칭** (TerminalManager.enqueueOutput)
   - pty 청크를 4ms 윈도우로 병합 후 renderer로 전송 (TUI 1프레임 = 1메시지)
4. **터미널 데이터 리스너는 effect cleanup에서 해제** (dataCleanup)
   - 과거에 Promise 콜백 반환값으로 잘못 등록되어 리스너 누수 있었음
5. **워크스페이스별 터미널 목록에는 안정적인 key가 있어야 한다** (App.tsx)
   - 목록이 `workspaces.map(...)` → `sessions.map(...)` 중첩 배열이라, 바깥에 key가 없으면 React가
     **index로** 짝을 맞춘다. 워크트리 sync·워크스페이스 삭제로 배열이 줄면 그 뒤 전부가 언마운트
     → 재마운트된다. PTY는 살아남지만(`TerminalManager`가 기존 id를 건너뜀) xterm 버퍼가 통째로
     날아가 "터미널이 리셋됐다"로 보인다. 회귀는 `t12-workspace-list-remount.spec.ts`가 잡는다
     (지금은 6번 덕에 히스토리를 다시 그리지만, 재마운트는 여전히 터미널마다 스냅샷 왕복이다)
6. **뷰는 붙을 때 히스토리를 받고, 확인한 뒤에야 실시간 출력을 받는다** (TerminalManager.attachView)
   - `terminal-create` → `{ existed, snapshot, snapshotSize, attachToken }`. main 은 그 터미널 출력을 보류하고, 미러를 write 콜백 안에서
     직렬화한다(보류 직전까지의 출력만 정확히 담김). 뷰가 스냅샷을 쓰고 리스너를 단 뒤 `terminal-attached` 를 보내면 보류분을 보낸다.
     터미널당 한 번에 하나만 붙고, 확인이 안 오면 3초 뒤 푼다. 순서를 바꾸면 출력이 빠지거나 두 번 찍힌다
   - `existed: true` 인 뷰는 시작·resume 명령을 **절대 다시 입력하지 않는다**. 렌더러가 죽거나 창을 다시 열면 PTY 는 살아 있는데,
     2026-10-12 에 다시 열린 창이 살아 있는 Claude 4개에 `cldy --resume <id>` 를 입력해 다음 프롬프트와 함께 전송됐다
   - 렌더러가 죽으면(`render-process-gone`) 1분 3회까지 자동 새로고침한다. 회귀는 `t29-scrollback-survival.spec.ts`
   - 복원한 히스토리는 새 프로그램이 뜨기 **전에 스크롤백으로 올린다**(구분선까지). Claude 는 다시 그릴 때 화면의 모든 줄을
     지운다 — 실제 `claude --resume` 에서 화면에 남아 있던 복원 줄과 구분선이 첫 리페인트에 지워졌다. 미러도 렌더러처럼
     `scrollOnEraseInDisplay: true` 여야 이 이동과 CLI 의 전체 클리어가 두 쪽에서 같게 처리된다. 스냅샷은 찍힌 크기와 함께
     가고 뷰는 그 크기로 맞춘 뒤 쓴다 — 줄 수가 다르면 스크롤백 줄이 화면으로 내려와 같은 식으로 지워진다

7. **높이 변경은 화면 아래 기준 — 렌더러·미러가 같은 함수로** (`src/shared/terminalResize.ts`)
   - Claude Code 는 SIGWINCH 에 화면 맨 위(`CSI H`)로 가서 화면 줄 전부를 자기 출력의 끝(`rows-1` 줄, 마지막 줄은 비움)으로 다시 쓴다. 스크롤백은 안 건드린다.
     xterm.js 기본 resize 는 커서가 맨 아래가 아니면 아래 줄을 버리고(줄 때)·빈 줄을 붙여서(늘 때) 다시 그린 화면이 엉뚱한 줄에 덮인다 — 답 첫 줄 사라짐·배너 중복(T86 녹화 재생)
   - 커서 아래에 내용(입력 상자·footer)이 있을 때만, 마지막 내용 줄(빈 줄 하나는 남김)을 커서로 보고 resize 한다(xterm 내부 `_core.buffer.y` — 이스케이프로 옮기면 아직 안 읽은 출력 뒤로 줄을 선다). 늘 때는 화면이 찼을 때(맨 아래 빈 줄 2 이하)만 스크롤백에서 되돌린다 — 짧은 프로그램 위의 복원 구분선을 끌어내려 지우지 않게
   - 폭 변경·대체 화면·스크롤 영역·커서 아래가 빈 셸은 xterm 그대로. 폭 변경의 옛 폭 사본은 Claude 몫이라 고치지 않는다(T86 e1 = 옛 동작과 같음)
   - 창 크기 변경 한 번 = PTY resize 한 번(`TerminalResizeManager` — rows 만 바뀌면 즉시, 폭이 바뀌면 100ms 뒤 rows·cols 함께). 회귀는 T86(유닛)·T87(앱)

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
2. **API가 켜져 있으면 모든 세션에 닿는다. `aiControl`은 권한이 아니라 표시다** — 처음 읽기·입력·대기·포커스 때 붙고, "Disconnect AI"는 표시를 떼고 걸려 있던 `wait`를 409로 끊는다. 접근을 끝내는 수단은 API를 끄는 것. 미러는 API 와 상관없이 **모든 터미널에 pty 생성 시점부터** 붙는다 — 첫 접근 때 붙이면 빈 화면이 되고, 리페인트로 채우면 렌더링 불변식 2번을 깬다. API 를 꺼도 미러를 떼지 않는다: 히스토리 원본이다 ([`docs/decisions/0006`](docs/decisions/0006-control-api-reaches-every-session.md), [`0008`](docs/decisions/0008-terminal-history-lives-in-main.md))
3. **화면에 질문이 떠 있으면 텍스트 입력 거부(409)** — Enter가 강조된 선택지를 고른다. 실측: Claude Code 폴더 신뢰 대화상자에서 "No, exit"가 선택돼 종료됐다
4. **첫 프롬프트는 "명령이 자식 프로세스로 떴고, 그 뒤 2초 조용"일 때만** — 무음만 보면 느린 셸 프로필에서 프롬프트가 셸로 선입력된다
5. **`@xterm/headless`는 파일 경로로 import해 번들에 넣는다** — `electron-builder.yml`은 node_modules를 allowlist로만 싣기 때문에 런타임 require는 배포 앱을 시작 시 죽인다
6. **테스트는 `CLIMANAGER_HOME`을 반드시 격리** — 없으면 서버가 시작을 거부한다(실사용 토큰 파일 보호)
7. **API는 자기가 등록한 워크스페이스만 해제한다** — `Workspace.aiRegistration`이 없으면 사용자 것(구버전 store 포함)이라 `403`. 폴더 지정·`ephemeral`은 새로 등록할 때만 적용하고 기존 워크스페이스는 옮기지 않는다. 디스크의 파일은 절대 지우지 않는다 ([`docs/decisions/0007`](docs/decisions/0007-api-cleans-up-only-its-own-registrations.md))

### CI

`.github/workflows/ci.yml`이 모든 push/PR에서 typecheck → build → 시크릿 스캔 → 위생 검사 →
테스트를 돌린다. macOS 러너를 쓴다(node-pty 네이티브 빌드 + 실제 Electron 구동이 필요).
설치 뒤 `electron-builder install-app-deps` 단계를 빼지 않는다 — 없으면 node-pty 가 Node ABI(127)로 남아
main 이 로드 중 죽고 앱 구동 시험마다 `electron.launch` 가 180초를 기다려 job 이 25분에 취소된다(08-16 부터 11-11 PR #117 까지 한 번도 끝까지 못 갔다).

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
| 화면 미러 — **항상 모든 터미널** (히스토리 원본, 0008) | 5~7µs/청크 · 23~28MB/s · 실제 Claude 세션(평균 0.5KB/s)에서 **CPU 0.002%**, 피크(4KB/s) 0.015% | 2000줄 가득일 때 힙 0.86MB + 줄 버퍼 — **RSS 80열 약 2.5MB · 200열 약 8MB**(2026-10-13 재측정. 예전 0.86MB 는 힙만 센 값) |
| 히스토리 디스크 저장 (`ScrollbackStore`) | 가득 찬 200열 미러 직렬화 **약 14ms · 370KB**, 쓰기 0.4ms | 출력이 있던 세션만 30초마다 → 바쁜 세션당 CPU 약 0.05%, 쓰기 약 44MB/h |
| 재시작 때 히스토리 복원 | 세션 40개 × 2000줄: 터미널 등록 **+0.6초**, 메인 RSS **+221MB**(세션당 약 5.5MB, 80열) | 미러가 2000줄을 채웠을 때의 정상 비용을 앞당긴 것. 줄이려면 `MIRROR_SCROLLBACK` |
| 대화 id 동기화 (`ClaudeSessionSync`) | 10초마다 레지스트리 목록+stat 약 1ms. `ps` 37ms 는 **새 Claude 프로세스가 보일 때만** | |
| `wait` 폴링 | 30~60µs/회 · 200ms 간격 → 대기 중인 세션당 **0.03%** | 대기 요청이 떠 있는 동안만 |
| 사이드바 상태 점 — 새 방식(`SessionScreenStatusPoller`, 켰을 때만) | 미러 46개 1회 판정 **중앙 0.17~0.24ms · 최대 0.53ms**(1초마다) · 턴이 오갈 때 IPC 56/분 · 줄 렌더 96/분 · App 렌더 **0** | 끄면 타이머·broadcast 0. 2026-10-29 T68(세션 41 · 부하 churn) |
| 사이드바 상태 배지 — Settings › Hooks 화면 추측(렌더러) | 같은 부하에서 IPC 98/분 × 2방향 · App 렌더 **166/분** · 사이드바 줄 렌더 **7,636/분** · 쉬는 Claude 30개 전부 앰버 「Ready」 | 상태가 바뀔 때마다 App 상태(`sessionStatuses`)를 갈아 앱 전체가 다시 그려진다. CPU 차이는 이 부하에서 작다(렌더러 1.26% vs 0.95%) |

포트 모니터가 터미널 검사보다 **수백 배** 비싸다. 그래서 끄는 스위치는 그쪽에 있고
(Settings > Port Monitoring), pid→cwd 캐시로 반복 호출을 없앴다.

재측정: `node --expose-gc scripts/bench-control-api.mjs [녹화본]` (Control API 세 항목).
합성 출력은 실제보다 싸게 나온다 — 녹화본(`scripts/mock-cli/recordings/*.jsonl`)을 주고 잰다.
한 번만 재면 머신 부하에 10배까지 흔들린다(실측) — 스크립트가 5회 중앙값·최솟값을 낸다.

성능 작업을 하기 전에 반드시 다시 재라 — `pollStatus`는 `currentTool !== 'cc'`면 즉시
반환하므로, Claude Code로 인식되지 않는 입력으로 벤치마크하면 **90배 낮은 가짜 수치**가 나온다.

### Terminal Pipeline Testing

터미널 출력/스크롤/리사이즈 회귀를 잡는 Playwright Electron 테스트.

- **위치**: `tests/terminal/` — 261건 (2026-10-24 `--list`)
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
    첫 줄(`session_meta`: id·cwd·시작 시각)과 전경 프로세스로 대화를 찾는다. 같은 폴더 시작이 10초 이내면 비우며, 한 번 모호했던 파일은 한쪽이 끝나도 자동 연결하지 않는다. 다른 폴더·−2초/+30초 창 밖·이미 저장된 id 제외, ps/lsof 파서·실패 재시도·붙여넣은 UUID 후보·돌연변이 5종 검출도 확인
  - T26 탭 이동·닫기·삭제 — Cmd+[ ] 와 Cmd+W, 사이드바 삭제가 모두 **사이드바 순서**를 따르고(드래그 뒤 포함),
    삭제된 세션으로 가지 않는지, 활성 탭 삭제 시 이웃 탭이 보이는지, 분할 화면에서 Cmd+` 가 커서를 옮기고
    Cmd+W 가 활성 칸을 닫는지, Cmd+Shift+[ ] 가 고정·폴더 순서로 워크스페이스를 도는지, 이름 변경 입력·Cmd+T 직후의
    Cmd+W 가 `preventDefault` 되는지(안 되면 앱 메뉴 Close Window 가 받아 **메인 창이 닫힌다** — 네이티브 메뉴는 헤드리스로 못 눌러서 이 플래그로 대신 본다). 판정은 보이는 터미널
    (`visibility`)과 `.xterm.focus`. `activeWorkspace` 상태는 선택 시점 스냅샷이라 탭 순서 계산에 쓰지 않는다.
    macOS 에서 Ctrl+W/R/K/B/P/T/[/]/J 가 단축키가 아니라 PTY 로 가는지도 본다 — 셸을 `stty -icanon` + `cat -v`
    로 두고 `^W^R…` 가 찍히는지로 판정한다(예전엔 `mod` 가 Ctrl 도 받아 Ctrl+W 가 탭을 닫았다)
  - T27 git 동작 — Git 패널이 쓰는 simple-git 핸들러 전부(상태·스테이징·커밋·로그·push/pull·브랜치·머지/중단·
    리셋·워크트리 추가/동기화)를 실제 저장소 + 로컬 bare 원격으로 돌리고, 결과를 `git` 명령으로 다시 확인한다.
    simple-git 메이저 업그레이드 때 돌린다(v4 는 import·옵션 파싱·git 에 넘기는 환경변수가 바뀌었다)
  - T18 폴더 정렬 — 사이드바 폴더를 드래그 핸들로 옮기면 순서가 config.json 까지 저장되고,
    드래그가 펼침 클릭으로 오인되지 않는지
  - T28 사이드바 전체 접기·검색·복사 — 전체 접기가 폴더(config.json)와 세션 목록(DOM)을 모두 접고 세션은 죽이지
    않는지, 다음 누름이 접기 전 상태를 그대로 복원하는지(닫혀 있던 폴더는 닫힌 채), 프로젝트 검색이 이름·폴더명·경로로
    찾고 Enter 가 첫 결과의 세션을 여는지, Copy Name/Path/Session ID 가 실제 시스템 클립보드에 들어가는지(main 의
    `clipboard` 로 읽고, 테스트 전 내용을 되돌려 놓는다)
  - T29 히스토리 생존 — 렌더러 크래시(자동 새로고침)·창 재오픈·강제종료(SIGKILL 후 재실행) 각각에서 마커 300줄이 그대로인지,
    살아 있는 PTY 에 resume 명령을 다시 입력하지 않는지(`resume-count` 파일), 재시작 때 "Restored from previous session" 줄이
    복원본과 새 출력 사이에 오는지, Cmd+K 가 히스토리도 지우는지, 세션 삭제가 히스토리 파일을 지우는지. 크래시 뒤 Playwright 는
    그 페이지를 계속 죽은 것으로 취급해서 새로고침된 렌더러는 main 의 `executeJavaScript` 로 확인한다
  - T30 대화 id 동기화 — 셸의 자식 `sleep` 을 Claude 대역으로 두고 레지스트리 파일을 써서, 저장된 id 가 셸에 가장 가까운
    Claude 의 대화로 바뀌는지(한 단계 깊은 프로세스는 짐), 시작 명령(`cldy` 같은 alias)은 유지되는지, 앱 터미널 밖 프로세스는 무시하는지
  - T31 피드백 관문 — 배포와 같은 `file://` 렌더러에서 기본 잠김(버튼·위젯 청크 요청 0), 틀린 비밀번호, 기억된 해제 → 위젯 마운트 → Turn Off,
    진짜 비밀번호(`~/.config/climanager-app-feedback-password` 있을 때만), 릴레이가 수집 함수 밖 URL·메서드를 거부하는지. 청크는 Playwright
    request 이벤트로 본다 — `file://` 에선 Resource Timing 이 아무것도 기록하지 않아 「안 불렀다」가 늘 참이 된다. `FEEDBACK_LIVE=1` 이면 실제 UI 로 라쏘런에 1건 보낸다
  - T32 제보의 터미널 정보 — 실제 pty 에서 Cmd+K → `printf '\033[3J'` → 가짜 키 출력(한 벌은 `$COLUMNS-5` 칸 뒤라 줄 경계에 걸린다) 후 main IPC 답이 키 앞뒤 조각·계정 이름·홈 경로 없이 오고 사건이
    순서대로인지, `exit 3` 의 종료 코드, 보이는 세션의 창 크기 변경이 `resized <전>→<후>` 로 남는지(유닛: 같은 크기 다시 보냄은 무시 · 몰린 크기 변경은 처음→끝 한 줄), 렌더러 크래시 → `renderer-gone`·`reattached`, 그리고 실제 위젯에서 터미널을 지목해 보낸 **페이로드**(main 의 `fetch` 를 바꿔 밖으로 안 나간다)가
    `source: picked`·사건 로그를 싣는지. 지목은 `page.mouse` 로 한다 — 지목 오버레이가 덮여 locator 클릭은 거부된다. 지목 메모의 완료 표시는 「보냈습니다」가 아니라
    `status` 「주석 1: …」의 「완료」다. 가짜 키는 실행 중에 조각을 이어 만든다 — 시크릿 스캔이 테스트 파일도 본다. `FEEDBACK_LIVE=1` 이면 라쏘런에 1건 보낸다
  - T34 관련 세션 유닛 — Electron 없이. 저장(가짜 store 위 재시작 복원, fork anchor 선택 필드·옛 저장값·뺌/닫힘 제거)·첫 접촉만 기록·손으로 뺀 쌍이 API 로 되살아나지 않음·닫힘 제거·시작 정리,
    렌더러 묶음 계산·개수, 「마지막 줄」(입력 상자 위, 그림 문자만인 줄 건너뜀)
  - T35 관련 세션 — 마스터가 `X-Caller-Session` 으로 연 세션·처음 입력한 세션이 헤더 개수·모달 묶음에 오는지(헤더 없는 호출은 아님), 상태(질문 대기/작업 중)·
    마지막 줄(줄바꿈된 긴 프롬프트도 통째로)·메모·「Talk」 배지, 손으로 추가→이동→지금 세션을 첫 칸으로 셋 나란히(넷째 체크 막힘)→빼기(다음 API 호출이 되살리지 않음), API 로 닫기·재시작 뒤 복원·
    사이드바 삭제가 바로 목록과 config.json 에서 지우는지. `RELATED_SESSIONS_SHOTS=<폴더>` 면 캡처를 거기 남긴다
  - T36 밤 제보 묶음(2026-10-22) — 사이드바 헤더와 메인 헤더의 아래 경계가 같은 줄인지(박스 비교), 설정 「Show Playground」를 끄면 사이드바 Playground 구역이 사라지는지(T13 과 같은 UI 왕복),
    Cmd+Shift+L(`toggleRelated`)이 활성 탭의 Related 대화상자를 열고 닫는지. 창 끌기 영역(`app-region`)은 Playwright 가 못 봐서 CSS 만 바꿨고 테스트가 없다 — 실제 앱에서 제보 위젯으로 헤더 줄을 눌러 본다
  - T37 헤더 브레드크럼 — 경로 계산(폴더 없음·삭제된 폴더·Playground·워크트리) 단위 시험 + 실제 헤더 DOM(`data-crumb`), 긴 이름의 분할 칸에서 세션 이름이 안 잘리는지
  - T38 스트리밍 중 리사이즈 — 출력이 흐르는 동안 창 크기가 바뀌어도 멈춘 뒤 줄 수가 상자에 맞는지(1.15.0 의 하단 잘림 회귀, 옛 TerminalView 에서 43줄 ↔ 56줄로 실패)
  - T39 세션 나무 유닛 — Electron 없이. `sessionTreeFor`: 같은 부모가 연 형제가 옆에 오는지, 고리(A→B→C→A)에서 세션이 한 번씩만 나오고 끝나는지, 지운 쌍·손으로 넣은 쌍이 나무에서 빠지는지, · 손 짝 부모·부모 둘(최근 손 짝 승)·Also related·고리 판정(`wouldMakeLoop`)·되돌려 끌기(`handParentsInTheWay`)·숲 순서 고정(fb-1028) · 안내선 `treeGuidesFor`(├/└·지나가는 │·접은 가지·뿌리만)
    부모가 둘일 때 위 둘·옆 중복 없음, 중간 세션이 닫히면 그 아래가 끊기는지, 깊이 번호와 상한(`MAX_TREE_DEPTH`)
  - T40 세션 나무 화면 — 시드한 `sessionRelations`(총괄→팀장 셋→작업→보조)로 Related 창의 위·옆·아래 줄이 DOM(`data-related-tree`)에 맞게 오는지, 옆 줄을 눌러 그 세션으로 가는지, 마지막 줄(프롬프트·경로)이 길면 앞이 잘려 끝이 보이는지,
    390 폭에서 가장 깊고 이름이 긴 줄이 모달 안에 들어오는지. `RELATED_SESSIONS_SHOTS=<폴더>` 면 `tree-1280.png`·`tree-390.png` 를 남긴다. 관계는 `helpers.ts` 의 `config` 옵션으로 config.json 에 직접 심는다
  - T39 나무 순서(49825c14) — `sessionTreeFor` 의 order: Recently viewed(본 순 → 안 본 것은 최신순)·Oldest·Name 이 같은 층 순서만 바꾸고 자식은 부모 밑(깊이 2)에 남는지
  - T39 최근 본(P2) — `RecentSessions`(가짜 store): 20개 상한(`RECENT_SESSIONS_MAX`)·같은 id 는 맨 앞 하나·재시작(새 인스턴스) 뒤 순서 유지·`prune`·맨 앞 id 를 다시 넣으면 쓰지 않음·`forget`
  - T40 최근 본·관계만(c17aa9c4) — 세션 셋을 차례로 본 뒤 사이드바 All sessions 가 역순이고 config.json `recentSessions` 에 남는지, 앱 재시작 뒤 같은 순서인지, 삭제한 세션이 빠지는지. Related 창에 탭 줄·Recent·All 목록이 없고(옛 코드에서 실패) Sort 만 남는지, 관계 줄 # 가 시스템 클립보드에 세션 id 를 넣는지(시험 뒤 원래 값 복원)
  - T41 숨김 터미널 크기 — 숨긴 세션 B 의 전경 프로그램이 자기 tty 크기를 시작 때와 SIGWINCH 마다 파일에 적는다. B 의 PTY 가 보이는 터미널과 같은 크기로 시작하는지, 처음 볼 때 SIGWINCH 가 0번인지, 숨긴 동안 B 의 xterm 크기 = PTY 크기인지, 앱 시작 뒤 **첫** 창 크기 변경이 보이는 터미널에 반영되는지(ResizeObserver 의 첫 콜백이 초기화 전에 와서 버려지고 그다음 실제 변경이 「기준값」으로 삼켜졌다). 옛 TerminalView 에서 80×30 ↔ 103×43 · 80×24 ↔ 80×30 · 43줄 그대로로 3건 실패. 판정 프로그램은 `trap … WINCH` 셸 루프가 아니라 node 다 — SIGWINCH 는 전경 프로세스 그룹(`sleep`)으로 가서 셸 트랩은 resize 를 놓친다(헛통과)
  - T54 줌은 보이는 터미널만(f800638c) — Cmd+- 세 번(main 의 `before-input-event` 를 거치게 `webContents.sendInputEvent` 로 — Playwright `page.keyboard` 는 그 처리기에 안 닿는다)에 숨긴 세션 4개가 글꼴을 안 바꾸고(`__termDebug.fontSize`) SIGWINCH 0, 보일 때 새 글꼴로 PTY resize 정확히 1번인지. 옛 TerminalView 에서 「숨긴 세션 글꼴 14 → 11」로 실패한다. 글꼴을 바꾸면 xterm 이 셀을 다시 재고 모든 줄을 다시 그린다 — `visibility: hidden` 이어도 줄지 않아 세션 39개에서 한 번 누를 때 렌더러 긴 작업 1,084ms 였다
  - T42 PTY 크기 검사 유닛 — Electron 없이. `terminal-create`·`terminal-resize` 가 렌더러 값을 그대로 node-pty 에 넘기지 않게 하는 `clampPtySize`(TerminalManager.ts): 정수로 내림 · 하한 2×1 · 상한 1000×500 · 숫자가 아니면 80×30. TerminalManager 는 불러올 때 Electron ABI 의 node-pty 를 require 하므로 시험은 그 require 만 빈 객체로 바꿔 불러온다
  - T45 사이드바 All sessions — 토글이 닫힌 폴더·워크트리까지 모든 세션을 평평하게 보이는지(DOM), 줄 라벨이 작업 영역 이름인지, 클릭·우클릭이 트리와 같은지, 최근 본 순서, 재시작 뒤에도 유지되는지, 포인터가 올라간 채 검색이 목록을 대신했다 돌아오면 최신 순서로 다시 읽는지, 우클릭 「Pin to Top」이 그 세션을 맨 위에 두고 config.json 에 `isPinned` 로 남는지(Unpin 이면 빠짐), 목록에서 보던 세션을 닫으면 같은 작업 영역 이웃이 아니라 그 전에 본 세션(다른 작업 영역이어도)으로 가는지, 「…」 메뉴가 보기를 따르는지 — All 보기에서는 New Session Folder 와 Add Workspace…(누르면 main 의 폴더 선택 창까지 — `dialog.showOpenDialog` 를 바꿔 센다)만이고 머리 줄 `+` 는 없음(워크스페이스 폴더 항목·세션 폴더 없을 때의 Collapse All 없음), 폴더 보기로 돌아오면 Collapse All·New Folder(보기 전환 버튼 x 좌표가 두 보기에서 같은지). 워크트리 시드는 평범한 폴더 경로여야 한다(저장소 루트면 시작 때 워크트리 스캔이 지운다)
  - T69 All sessions 여러 개 고르기(0d1e3d34) — List: 체크 칸은 마우스를 올려야 보이고, 셋 체크 → 「3 selected」·보던 세션 그대로·모든 줄에 칸, Copy IDs → 시스템 클립보드가 고른 순서 id 셋(줄바꿈), 줄 이름을 누르면 그 세션으로 가고 선택은 남음, Side by side → 셋이 분할 화면, 다섯이면 Side by side 꺼짐·Copy IDs 는 다섯, 체크 해제·Esc 로 비움 · Tree 에서도 같은 칸·막대·복사·✕. 클립보드는 시험 뒤 되돌린다. 옛 코드엔 체크 칸이 없어 실패
  - T70 체크리스트 유닛 — Electron 없이. `checkChecklistInput`·`checkItemTexts`(한 줄 접기·200자·실제 날짜만·null 은 마감 지움)·헤더 순서(열린 것 마감 순 → 날짜 없는 것 만든 순 → 다 끝난 것 최근 순, 빈 것은 열림)·같은 열린 제목 재사용(빠진 항목만, 새 마감·프로젝트로 바꿈, 다 끝난 뒤엔 새로)·항목(끝에 추가·중복 건너뜀·체크해도 자리 그대로·첫 체크 시각 유지·이름·지우기·변화 없으면 안 씀)·id/제목 참조와 같은 제목 둘이면 ambiguous·워크스페이스 제거/시작 정리(연결만 풀림)·상한(거부, 잘라내지 않음)·마감 표시(`describeDue` — 기대값은 `toLocaleDateString` 으로 계산)
  - T71 헤더 체크리스트 — 총괄 세션이 REST 로 만들기(201 · 반복 200 · 400·404, 세션에 AI 표시 안 붙음), 헤더 칩(끝낸 수·마감 톤), MCP 로 더 급한 둘째를 만들어도 칩이 보던 것을 지키는지, ⌘⇧J → 패널(추가 칸 포커스·`2 / 2`·항목·만든 세션·프로젝트), 패널 체크(자리 그대로)·다른 세션 MCP `checklist_check`(번호)·없는 번호/제목은 isError, 항목 추가·이름·지우기, 제목 이름 바꾸기 → 칩, 마감 바꾸기/지우기(Enter 없이 저장), 프로젝트 선택, ‹ › 와 ← 넘김, Esc 가 닫고 터미널로 포커스, 「by 세션」 클릭 → 패널 닫힘·그 세션 화면, 칩 마감 배지 테두리 0·9px, 바깥 클릭으로 닫힘, 메모가 열려 있어도 패널이 위, 분할 보기에서도 칩, 세션을 닫아도 체크리스트 그대로(`createdByName` null), 패널에서 새로 만들기(지금 프로젝트·client app), 두 번 눌러 삭제, 390 폭(칩 제목 숨김·패널 창 안) · API 가 등록한 워크스페이스가 지워지면 연결만 풀림, 재시작 뒤 config.json `checklists` 와 마지막에 본 체크리스트 · 프로젝트 따라가기(다른 프로젝트 세션 → 그 체크리스트, 같은 프로젝트 안에서 고른 것 유지, 체크리스트 없는 프로젝트는 그대로, 390). `CHECKLIST_SHOTS=<폴더>` 면 1280·분할·390 캡처. 옛 코드에는 `checklist-chip` 이 없어 실패
  - T72 폴더 복사·단축키 툴팁(fb-1031) — 88d69c82: All sessions 세션 폴더 우클릭 「Copy Session IDs」가 시스템 클립보드에 그 폴더 줄 순서의 id(줄바꿈)·알림 「Copied 3 session IDs」, 「Copy Name」은 폴더 이름, 빈 폴더는 꺼짐 · 386b0c76: Settings·Close Sidebar·Related·메모 토글·새 쪽·복사 버튼 title 에 단축키, Settings 에서 바꾼 새 쪽 키(⌘⇧M)가 기본 ⌘⌥N 대신 나온다. `T72_SHOTS=<dir>` 로 폴더 메뉴 캡처와 `titles.json`(검사 전에 써서 옛 코드의 before 도 같은 실행에서). 옛 코드엔 복사 항목·단축키 문구가 없어 실패
  - T46 사이드바 세션 검색 — 세션 이름으로 찾고(닫힌 폴더 안도), 「Sessions」 묶음이 프로젝트 묶음 뒤에 오고, Enter 가 프로젝트가 있으면 기존 동작·없으면 첫 세션을 여는지
  - T47 세션 순서 유닛 — Electron 없이. `sessionsInSidebarOrder`·`orderByRecent`·`orderForAllSessions`(고정 먼저 · 사이드바 순)·`mostRecentOtherSession`·`findMatchingSessions`
  - T50 Related 창·헤더(day-1023) — 입력 상자가 있는 「Claude」 화면(셸 스크립트가 그린 가짜)이 Related 줄에 `※ recap` 을 통째로(「(disable recaps in /config)」 없이) 보이고 recap 이 없으면 줄이 없는지, Related 창 Sort(Newest first·Oldest first·Name·Recently viewed — 화면 시험은 Newest·Name·Oldest, Recently viewed 는 T39 유닛)가 같은 층 순서만 바꾸고 다시 열어도 기억되는지,
    헤더 상위 세션 바로가기(부모가 하나일 때만)·‹ › 뒤로/앞으로(다른 길로 옮기면 앞으로가 사라짐), Related 「New session」으로 다른 프로젝트·템플릿·이름을 골라 만들면 그 세션이 보이고 「Added by hand」에 들어가는지, 390 폭에서 폼이 창 안에 드는지. `RELATED_SESSIONS_SHOTS=<폴더>` 면 캡처를 남긴다
  - T51 앱 링크 스킴 — 스킴 정규화·예약어 거부·허용 판정 유닛, 실제 WebLinksAddon 으로 일반 텍스트 감지(한글 경로·`obsidian:///절대경로`·줄바꿈·닮은꼴 무시), 그리고 실제 앱에서 Settings > Terminal 로 `obsidian` 을 넣고 빼며 일반 텍스트·OSC 8 링크가 `shell.openExternal` 에 닿는지/막히는지(main 에서 가로챔)
  - T52 인박스 — API 로 보낸 요청이 종 숫자·행 점·Dock 배지(`app.dock.getBadge()`)에 오는지, 팝오버 항목·링크를 누르거나 사이드바로 그 세션에 들어가도(창 포커스 왕복 포함) 안 읽은 채로 남고 줄의 ✓ 만 그 요청 하나를 읽는지(팝오버·보던 세션 그대로), 긴 요청이 두 줄로 잘렸다가 마우스를 올리면 전부 보이는지(`scrollHeight <= clientHeight`), 같은 요청 두 번 → 1개, `javascript:` 링크·세션 없음(400)·없는 세션(404), 링크 누르면 `shell.openExternal`(main 에서 가로챔)·허용 밖 스킴은 안 열림, Mark all read, `POST /v1/inbox/:id/read`, MCP `inbox_notify`·`inbox_list`, 사이드바를 접으면 헤더 종, 세션을 닫으면(API·사이드바) 지워짐, 재시작 뒤 안 읽은 것 남음, 기본 폭에서 머리 줄 제목(Workspaces·All sessions)이 안 잘리는지(`scrollWidth <= clientWidth`)와 「…」 메뉴의 새 폴더가 config.json 까지 가는지. `INBOX_SHOTS=<폴더>` 면 1280·390 캡처를 남긴다(첫 두 장은 인박스 호출 전이라 옛 코드에서도 찍힌다)
  - T53 인박스 저장 유닛 — Electron 없이. `checkInboxInput`(종류 기본값·한 줄 접기·200자 자르기·예약 스킴·2000자), 같은 안 읽은 요청 하나로·읽은 뒤엔 새로, 200 상한(읽은 것부터), 시작 정리(없는 세션·7일 지난 읽은 것), `forget`
  - T33 세션 링크 — Electron 없이 도는 순수 유닛. 감지는 터미널이 싣는 것과 같은 WebLinksAddon 을 headless xterm 버퍼에 붙여 본다(자동 줄바꿈은 한 링크, Claude Code 식 들여쓴 줄바꿈은 앞부분만). 해석: 짧은 id·전체 id·닫힌 세션·겹치는 짧은 id·4개 상한
  - T48 메모 링크·페이지 유닛 — Electron 없이. `splitMemoLinks`(http(s)만 링크, 문장부호·짝 없는 닫는 괄호 제외, 글자 보존)·`shortenUrl`(호스트 + …/마지막 조각, 40자) · `memoPagesOf`(1쪽 = `memo`, `-----` 은 쪼개지 않음)·`turnMemoPage`(양 끝에서 돌아 감)·`deleteMemoPage`(지운 자리의 다음 쪽, 마지막 한 쪽은 비움)
  - T56 메모 페이지(533a22ba) — 예전 한 장 메모(`--------` 줄 포함)가 1쪽 그대로 열리고 넘김 버튼이 없는지, 새 페이지 → `2 / 2`·빈 textarea·포커스, ‹ › 가 양 끝에서 돌아 가는지, 복사가 보고 있는 쪽만, 1쪽을 고치면 config.json `memo` 만 바뀌고 `memoPages` 는 그대로인지, 글 있는 쪽은 두 번 눌러야 지워지는지(빈 쪽은 한 번), 저장된 `memoPages` 가 쪽으로 열리는지, 2쪽 없이 1쪽만 보내는 저장(1.19 이전 앱)이 `memoPages` 를 지우지 않는지. 옛 코드에서는 「새 페이지」 버튼이 없어 실패한다
  - T49 메모 링크 — 포커스 밖 메모가 읽기 보기로 바뀌어 링크가 짧게(툴팁에 전체 URL) 보이고, 누르면 `shell.openExternal`(main 에서 가로챔)에 전체 URL 이 가는지, 링크 아닌 곳을 누르면 textarea 로 돌아가는지, 저장된 메모(config.json)는 입력한 글 그대로인지, 빈 메모는 textarea 그대로인지, 끌어 선택한 뒤의 클릭·링크 위 Enter 가 편집으로 바꾸지 않는지, 머리 줄 복사 버튼이 메모 전체(줄바꿈·전체 URL)를 시스템 클립보드에 넣고 편집·읽기 보기를 그대로 두는지(빈 메모는 비활성)
  - T57 세션 폴더 유닛 — Electron 없이. `SessionFolders`(가짜 store): 빈 이름 거부·앞뒤 공백 정리·펼친 채 저장·목록이 아닌 저장값은 빈 목록, 세션 하나에 폴더 하나(옮기면 바뀜 · `null` 은 뺌 · 없는 폴더/세션은 안 씀), 폴더를 지우면 그 소속만 지우고 세션·다른 폴더는 그대로, 펼침 한 번에 쓰기
  - T58 세션 폴더 화면(078ee766 · 09aa3d01) — All 보기 「…」 → New Session Folder → 폴더 줄·`(0)`·「Drag sessions here」·config.json, 세션 줄을 **실제 마우스로** 폴더 줄에 끌면 줄이 `data-drop-state=over` 로 밝아지고 놓으면 들어가는지(개수 `(1)` · `sessionFolderId` · 워크스페이스 이름표·폴더 보기의 줄은 그대로), 「No folder」에 놓으면 빠지는지, 폴더 줄 눌러 접기·머리 줄 전체 접기/펼치기 버튼(`sidebar-collapse-session-folders`, 「…」 메뉴엔 없음, 기본 폭에서 제목 안 잘림·보기 전환 버튼 x 그대로, 09aa3d01), 우클릭 이름 바꾸기·지우기(세션은 남고 소속만 지워짐), 없는 폴더를 가리키는 세션은 폴더 없음으로. 옛 코드는 All 보기에 「…」가 없어 실패
  - T59 끌어서 관계(269168e4) — **실제 마우스로** 세션 줄을 다른 줄에 끌면 「Relate」 표시 → 놓으면 사이드바 알림 「Related: B ↔ A」 · config.json `sessionRelations` 에 `manual`, 그 세션 Related 창의 「Added by hand」에 보이는지, × 로 뺀 뒤 다시 끌면 되살아나는지(`dismissed` 풀림), 한 번 더 끌면 「Already related」·기록 하나, 자기 줄 위는 표시 없음·기록 없음, 폴더 보기에서 워크스페이스를 건너 끌어도 같은지. 옛 코드는 「Relate」 표시가 없어 실패
  - T60 Control API 세션 폴더 — REST·MCP 로 목록(저장 순서·ISO 시각)·만들기(같은 이름 → `created:false`, 201/200)·이름(409 `name_taken`)·넣기·빼기(AI 표시 안 붙음)·지우기(세션 남음, `releasedSessions`)·열 때 `sessionFolder`·같은 이름 둘이면 409 `ambiguous_folder`, 세션 응답 `sessionFolder`. 사이드바 All 보기의 폴더 줄·개수가 **새로 고침 없이** 바뀌는지(DOM)와 config.json. 옛 코드에서 실패
  - T61 Control API 관계·넘기기 — `GET /v1/sessions/:id/relations` 의 kind·방향·뺀 짝 숨김, `DELETE …?handTo=`(넘긴 수, 이미 아는 짝·뺀 짝 건너뜀, 없는 세션 404·같은 세션 400 에 아무것도 안 닫힘), MCP `hand_to`·`list_session_relations`, `memoPages`(늘 1쪽 이상). 유닛은 T34 `inherit`·T57 `resolve`/`createOrGet`/`sessionIdsIn`. 옛 코드에서 실패
  - T55 경로 열기 단축키(7d7abfff) — Cmd+Shift+O(`revealInFinder`)·Cmd+Shift+E(`openInEditor`)가 터미널에서 고른 경로(우클릭 메뉴와 같은 `file:line` 처리)를, 고른 게 없으면 세션 폴더를 여는지. 판정은 끝단 — main 의 `shell.showItemInFolder` 를 바꿔 기록하고, 에디터는 `$PWD` 와 인자를 적는 스크립트. 선택은 실제 더블클릭으로 하고 `__termDebug.selection` 으로 확인한다. 단축키는 App 이 맞추고, 선택은 그 세션의 TerminalView 가 창 이벤트(`requestOpenTerminalPath`)로 받아 읽는다
  - T62 메모 쪽 단축키(day-1027) — ⌥⌘N 새 쪽(닫힌 메모를 열고)·⌥⌘←/→ 넘김(메모에 타자 중에도, 돌아 감)·⌥⌘C 이 쪽 복사(main `clipboard` 로 확인 후 되돌림)·⌥⌘⌫ 지우기(글 있으면 두 번 — 버튼과 같은 `data-state=confirm`, 한 쪽뿐이면 아무 일 없음), config.json `memo`/`memoPages` 로 판정. Settings 에 넣은 바인딩(⌘⇧M)이 기본 키를 대신하는지. 옛 코드에서는 ⌥⌘N 에 메모가 안 열려 실패
  - T63 All sessions 나무(day-1027) — 시드 관계(총괄→팀장 둘·대화, 팀장→작업→보조)로 Tree 줄 순서·깊이(`data-tree-depth`), 손으로 넣은 짝·뺀 짝은 「Not in a tree」, 긴 작업 폴더 경로가 잘리되 마지막 글자가 칸 안(Range 좌표), 줄 누르면 그 세션 터미널이 보이는지, 앞이 같은 긴 이름 셋(깊이 1~3)이 기본 폭에서 끝 글자까지 보이고 이름이 잘리면 경로는 숨는지(옛 판에서 「이름이 잘렸는데 경로가 보임」으로 실패), Settings 「Show Session Tree」 끄면 나무·전환이 사라지고 List, 다시 켜면 고른 Tree 로. 나무 계산은 T39 「session forest」 유닛 5건(뿌리 순서·고리·부모 둘·깊이 상한 뒤 새 나무·본 순서)
  - T64 경로 선택(fb-1028) — 유닛: 실제 `@xterm/headless` 버퍼에 제보 3건의 실제 Claude Code 줄(110·118칸 — 산문은 cols 에서, 도구 출력·`Bash(` 줄은 cols−5 에서 끊긴다)을 써 넣고 가운데 낱말·앞부분·여러 줄 조각 선택의 첫 후보가 이은 전체 경로인지, 불릿 5종·표·짧은 줄은 잇지 않는지. E2E: `printf` 로 같은 모양을 찍고 실제 마우스 드래그 → ⌘⇧O 가 main `shell.showItemInFolder`(바꿔 기록)에 전체 경로를, 에디터 스크립트에 전체 경로를 넘기는지, 이은 경로 ⌘C 는 한 줄·일반 여러 줄 복사는 그대로(main `clipboard`, 시험 뒤 복원)
  - T65 사이드바 트리(fb-1028) — 실제 마우스로 끌어 넣은 세션이 놓은 줄 밑 자식(`data-tree-depth`)·Related 창 Above/Below/Also related(by hand 표지)인지, 연 세션보다 손 짝이 이기는지, 자기 자식 밑으로 끌면 거절 알림·저장 없음, 연 세션 위로 되돌려 끌면 막던 손 짝만 dismissed, 줄을 눌러도 Tree 순서가 그대로인지(옛 코드: 최근 본 순으로 흔들림), ▸/▾ 접기·+N·활성 세션 조상 표시·재시작 뒤 유지(localStorage `sidebar-session-tree-collapsed`), List·세션 폴더 안 고정 구분선(`session-list-pinned-divider`, Tree 에는 없음), 사이드바 우클릭 메뉴가 바깥 누름·Esc·터미널 클릭·다른 줄 우클릭에 닫히는지(세션·세션 폴더·워크스페이스·워크스페이스 폴더 — 540ceb60), 실제 배치 이름 깊이 3에서 칸 안. 안내선(a35f1aa1) — 줄마다 ├/└·지나가는 │·아래로 내려가는 선(`data-tree-connector`·`data-tree-through`·`data-tree-opens-down`)과 세로 조각이 **같은 x 에서 위 줄 조각에 닿는지**·팔이 이름 앞에서 끝나는지(좌표, 1280·390), 접으면 선이 안 내려가는지. `T65_SHOTS=<폴더>` 면 1280·390 캡처
  - T66 상태 점 유닛 — Electron 없이. 실제 `TerminalMirror`(가짜 TerminalManager)로 권한 질문 · **실제 Claude Code 2.1.312 AskUserQuestion 화면**(질문 줄은 「Esc to cancel」 꼬리가 아니라 「어떤 색이 좋아?」) · 실제 권한 질문 화면 · 보기 설명이 「?」로 끝나도 질문 줄 · 「?」로 안 끝나는 질문 · 작업 중/쉼 · **에이전트 출력에 대화상자 문구가 있어도(시험 픽스처) 작업 중이면 working, 입력 상자 위면 질문 아님**(총괄 10-29 관찰 — API 의 `showsAwaitingInput` 은 일부러 그대로 true), 그리고 폴러: 바뀐 것만 보냄 · 출력이 없으면 다시 안 읽음(읽기 횟수) · hook running/awaitingInput · 끝난·닫힌 세션 · start/stop 메시지
  - T67 상태 점 화면(d499aed0 · 1dbd271b) — 사람 설정(Settings › Hooks 끔)으로 모의 에이전트 넷: 작업 중 = 파란 점 · 질문 = 노란 점 + 툴팁 「Waiting for you — Do you want to proceed?」 · 쉬는 에이전트·로그 찍는 셸·보고 있는 세션 = 점 없음, 자기 프롬프트에 「Esc to cancel」을 찍은 에이전트 = 일하는 동안 파랑·끝나면 점 없음, 답하면 점이 사라지고, Settings 에서 끄면 점이 없어지고 main 판정 횟수(`__sessionScreenStatusTicks`)가 멈추는지, 처음부터 끔(기본)이면 판정 0. 옛 코드에는 `data-session-status` 가 없어 실패
  - T68 상태 점 비용(opt-in `STATUS_PERF=1`, 약 9분) — 세션 41개(작업 4 · 질문 2 · 쉬는 Claude 30 · 셸 로그 4)에서 끔 / Settings › Hooks 화면 추측 / 새 점 을 같은 부하로: main·렌더러 CPU(`app.getAppMetrics`), 상태 IPC/분(양방향), main 판정 ms, React commit·App·사이드바 줄 렌더/분(DevTools 훅 — 줄은 props 로 찾는다, 빌드가 이름을 줄인다). 부하 둘: steady(상태가 안 바뀜) · churn(5초마다 2.5초 턴 — 바뀔 때의 비용). 결과 `tests/terminal/results/<label>/t68-*.json`. `STATUS_PERF_ONLY=heuristic-churn,screen-churn` 로 골라 돌린다
  - T73 Chat view 유닛 — Electron 없이. 2회차: 모델·추론·문맥 읽기(Claude·Codex), 그림·잘린 출력 다시 읽기(조각 경계를 넘게 `findChunkBytes` 를 줄여), Stop·대기열 하나씩(가짜 미러), `/` 명령 목록(스킬·명령 파일·`user-invocable: false` 제외·터미널 전용·Codex `$`), 붙여넣은 그림 저장(NFD 한글 이름 → ASCII), 입력칸 순수 함수, `effectiveShortcuts`. 합성 대화 기록(`fixtures/transcripts`, `make-fixtures.py` — 실제 기록은 커밋 금지) 10종 + Codex 1종을 ovis 에서 옮긴 파서로: 입력한 프롬프트·마지막 답이 파일에서 코드로 뽑은 값과 같은지, 다시 보낸 글·압축·/clear·하위 에이전트·그림·거절·대기 입력·진행 중. `TranscriptReader`(슬러그·찾기·이어 읽기·찢어진 줄·줄어든 파일·첫 읽기 한도·Codex 조각). `promptScreen` 은 실제 Claude Code 2.1.312 화면 사본(`fixtures/prompts`)으로 보기·강조·맥락·키 순서·서명, 일하는 중/입력 상자 위 문구는 메뉴 아님, Codex·다중 선택은 터미널 전용
  - T74 Chat view — `chat-mock.cjs`(Claude/Codex 모양 화면 + 기록 파일 쓰기, 질문 화면은 2.1.312 배치)를 세션의 `cliCommand` 로 심어 앱 시작 resume 이 모의 에이전트를 띄운다. 전환(에이전트 세션만·세션마다 기억)·읽기(표·코드 색칠·접힌 작업)·보내기(터미널 `ANSWER[n]`·기록·Chat)·일하는 중 대기열·터미널 입력줄 글 있으면 거부·질문 카드(옛 서명은 `prompt_changed` 로 거부·보기·직접 입력)·Codex(읽기·보내기·카드는 「Answer in Terminal」)·390 폭. `CHAT_VIEW_SHOTS=<폴더>` 면 1280·390 캡처. 옛 코드에서는 `view-toggle` 이 없어 실패. **T74 r2**(2회차): 단축키(⌘⇧M·⌘⇧I·PgUp·⌘⇧PgUp)·툴팁, 앞 턴 더 보기·레일·접기·스크롤 자리 기억·그림(기록에서 다시 읽어 data: 비교)·라이트박스·전체 출력·diff·파일 미리보기(답 속·도구 줄 ↗)·답 복사, 빠른 답, Stop·Esc·경과 시간, Send now(모의가 `HELD:`)·버리기·고치기, 계획 칩, 모델 칩·바꾸기 확인(취소면 아무것도 안 침)·`/model sonnet` 뒤 칩·문맥 Compact·피커는 터미널 + Back to Chat, `/`·`@` 완성·`/config`·Keep Terminal, 첨부 3길(기록의 프롬프트로 확인 — 터미널은 긴 줄을 접는다)·미리보기 그려짐, 카드 번호 → 답 뒤 카드 사라짐, Enter 설정, 흐린 말풍선·5초 시계(`--user-delay-ms`), Codex 모델·문맥 %·피커, 390. `CHAT_VIEW_SHOTS` 면 기능마다 1280·390(`shotBoth` — 사이드바는 JS 클릭, 팝오버가 안 닫히게). 옛 코드(fcd61ad)에선 툴팁에 단축키가 없고 ⌘⇧M 이 아무 일도 안 해 실패
  - T75 폰 유닛 — Electron 없이. 접근 판정 표(주인·남·머리말 없음·XFF 없음/LAN/목록·Mac 주인 모름·짝지은 기기 치기/보기·꺼짐·Funnel·loopback 아님)·Host/Origin·`tailscale status` 주인(태그 노드는 없음)·짝짓기(6자리·해시만 0600·재시작·5회·10분·끊기)·알림(질문·끝난 턴·1분·Mac 사용 중·셸 없음·시험·기기 끊기)·키 바 순서/시퀀스/Ctrl+글자·카드 글 가리기(서명 유지)
  - T76 폰 — 앱 + 폰(앱 안 390×844 창, 따로 쿠키 — Playwright 브라우저는 CI 에 없다). 기본 꺼짐 → 설정 스위치(serve 명령·QR·배지) · HTTP 접근(머리말 없음/남 401 · Funnel 403 · Host 421 · 남의 Origin POST 403 · `/v1`·`/mcp` 없음 · 데스크톱 청크 404) · 폰에서 짝짓기(틀린 코드) · 목록 = Mac 사이드바 All sessions 순서(데스크톱 DOM 과 줄마다 비교 · 최근 본 세션이 올라가면 폰도 · 폴더 머리글 · 고정 아래 줄) · Chat 보내기(Mac 터미널 `ANSWER`·`phone-input`) · 카드 답 · Terminal(Mac 크기·축소·키 바·입력줄·^C) · 크기 메시지 2건 거절 · **폰이 붙었다 떠나도 Mac PTY 크기 같고 `resized` 0건** · 보기 전용 기기 403 · 알림(질문 1건 · 1분 안 두 번째 없음 · Mac 사용 중 없음 · 시험) · 알림 주소 → 그 세션 Chat · 기기 끊기 → 짝짓기 화면 · 배지 ✕ → 확인 모달(취소·Esc·바깥은 그대로, 3회차 A) → 끄기 → 소켓 끊김·접속 거부 · 비밀 파일 0600. `PHONE_SHOTS=<폴더>` 면 리뷰 캡처
  - T77 폰 글씨 크기 — 103칸을 채우는 Claude 모양 화면(`fixtures/phone-screen/claude-screen.cjs`, 한글 포함·크기 바뀌면 다시 그림)을 Mac 103×43 으로, 폰은 기기 배율 3(CDP 기기 지표)·주인 머리말(창의 모든 요청에 serve 머리말). 세 모드 (a) 세로 폭 맞춤 (b) 세로 100% + 가로 밀기 (c) 가로 폭 맞춤의 글자 px·칸 px·보이는 칸/줄 수를 재고, 확대 기억(다시 열어도 · 다른 기기는 기본) · 그동안 Mac PTY 크기 그대로(`resized` 0). `PHONE_SHOTS` 면 1170×2532 캡처·글자 조각·`t77-measure.json`(+ 가로에서 목록을 서랍에 넣은 목업 1장)
  - T78 폰 품질(3회차) — 터치 폰(CDP 터치·`pointer: coarse`): Chat 이 열려도 키보드 안 띄움 · Return 은 줄바꿈 · 보내기 버튼 · `/` 를 치면 내 스킬 목록(`chat-complete`) · 다른 세션 질문 → 앱 안 알약(droplet)·☰ 배지 · 키 바 길게 누르면 반복 · 「화면 폭으로 감싸기」 · 서버 껐다 켜기 → 「Reconnecting…」·입력칸 유지 · 그동안 Mac PTY 크기 그대로. `PHONE_SHOTS` 면 캡처
  - T79 폰 보안 유닛(11-05 교차 검수 F01·F02·F05–F08·F21–F23) — Electron 없이 실제 PhoneServer+ws: 철회한 기기의 열린 소켓 입력·본문을 다 받은 뒤 권한 재확인(401 revoked)·철회 저장 실패는 숨기지 않음·51번째 기기 퇴출도 철회 통지·SKILL.md 는 일반 파일만 앞 16KB(FIFO·/dev/zero)·push 10초 시간 제한·카드 서명은 SHA-256·Codex `$` 경로 5곳·`sw.js` 가 Git 에 있음(`.gitignore` `*.js` 예외)
  - T80 ovis 원본 시험 이식 — ovis(3e51902) 시험 38파일에서 우리가 옮긴 모듈 몫 383건(`tests/terminal/ovis-port/*.ts`, fixture `tests/fixtures/ovis/` + `SOURCE.md`). 우리가 일부러 바꾼 동작은 `test.fixme`+근거, 아직 안 고친 차이는 `test.fail(true, 'ovis-port bug: …')`(고치면 「통과해서 실패」로 알려 준다). 성능 8건은 `OVIS_PERF=1` 일 때만
  - T81 폰·Chat 화면 고침(11-05 F13–F20·실기기 G1–G4·G7–G9) — 터치 폰 CDP 390×844·배율 3, 실제 앱+폰 서버 E2E 13건: 끊긴 동안 Send 막고 초안 유지 · 세션을 옮기면 Type·Ctrl·초안 안 따라감 · 암호 프롬프트는 password 칸 · 첫 /me 실패 뒤 재시도 · drop 한 번 · 대기열 Edit 는 철회 확인 뒤 · 카드 번호+보내기 = 보기 고름 · 새 세션 빈 상태 문구 · 한글 고정폭 글꼴(`CLIM Phone Mono`, 나눔고딕코딩 OFL 부분 글꼴 — 한글/라틴 2:1) · 첨부 말풍선은 칩 · 보기 전용 안내 · 2차 검수 N01(Edit 응답 전 세션 이동 → 그 세션 초안으로, 철회 응답을 붙잡는 `hold`)·N02(암호 프롬프트가 바뀌면 지움)
  - T82 Chat 기록·대기열 고침 유닛(11-05 F03·F04·F09–F12·F18 · ovis 대조 가1·다1) — 대기열을 에이전트·보낸 기기에 묶음(철회·폰 끔이면 그 기기 것 지움)·질문 카드 키를 세션마다 한 줄로·미제출을 sent 로 안 봄·Claude 되감기 가지·Codex history_base·파일 교체(inode)·하위 에이전트 XML 엔티티
  - T84 폰 피드백 유닛 — Electron 없이 실제 PhoneServer: `/me` 의 `feedback` 플래그(drive·켜짐일 때만, watch·꺼짐·배선 없음엔 없음)·폰 판정은 `/me` 로만(localhost 여도 꺼짐)·릴레이 인증 없음 401·watch 403·꺼짐 403 `feedback_off`·수집 함수 밖 URL/메서드 400·15MB 초과 413·남의 Origin 403·본문 받는 중 철회 401·정상은 그대로 릴레이(폰 쿠키는 안 넘어감)·터미널 맥락 경로(401·403·세션 없음은 null)·제보 url `…/phone?screen=`·extra(Tailscale 로그인 없음)·`FeedbackModeState`
  - T85 폰 피드백 — 앱 + 터치 폰(CDP 390×844·배율 3, 주인 머리말): 꺼진 Mac 이면 버튼·위젯 청크 없음, Mac 에서 켜면 ☰ → Feedback 이 서랍을 닫고 지목 독 → 터미널을 CDP 터치로 탭 → 주석 시트 → Enter 가 요소(`element`) 실린 제보, 독 메뉴 「화면 전체」 → 모달(캡처) → 높이 416(키보드)에서 보내기가 화면 안·눌림 → 보내기가 main 릴레이까지(main `fetch` 를 바꿔 밖으로 안 나감): url·extra·보던 세션 줄·스크린샷·로그인/쿠키/키 없음, Mac 에서 끄면 `/me`·릴레이 403·버튼 사라짐, 키트 떠 있는 버튼이 키 바·Send 를 안 가림. `PHONE_SHOTS` 면 제보 스크린샷 저장
  - T83 2차 교차 검수 남은 것 유닛(11-05 round2) — F02 철회가 서비스의 await(전경 읽기·lane·대기열·카드 키 사이) 중에 와도 안 침(`ChatSender.allowed` 를 키 직전에) · F03 대기 글은 쓴 대화(cliSessionId)에 묶임(/resume 이면 버림 · Send now 는 `conversation_changed`) · F04 카드 Enter 는 의도한 보기가 강조돼 있을 때만(raw ↓ 끼어들면 prompt_changed) · F21 푸시는 요청 전체 마감(fetch + AbortSignal.timeout — 헤더·본문을 조금씩 보내는 자체 서명 TLS 서버로)
  - T86 높이 resize 유닛(11-05 resize-anchor) — Electron 없이. 실제 `claude` 2.1.309 녹화(`fixtures/resize-recordings/`, 홈 이름을 같은 길이로 가림 — `make-fixtures.cjs`)를 headless xterm 에 재생: 대조군(plain `term.resize`)은 e6 36행 답 첫 줄 0·50행 배너/프롬프트 2·e4 표 끊김을 그대로 보이고, `resizeKeepingBottom` 은 높이마다 답·배너·프롬프트 1·표 이상 0, 폭만 바뀌는 e1 은 옛 동작과 같은 버퍼. 합성: 짧은 프로그램 위 복원 구분선이 늘린 뒤에도 남음, 마지막 줄을 비우는 Claude 식 화면(스트리밍 뒤 빈 줄 둘 포함)에서 줄이 안 빠지고 안 겹침, 커서가 제 줄에, 셸 프롬프트·대체 화면·스크롤 영역은 plain 과 같음, `TerminalMirror` 로 재생해도 같은 버퍼
  - T87 높이 resize 앱(11-05) — `fixtures/inline-tui.cjs`(Claude 처럼 SIGWINCH 에 화면 맨 위부터 `rows-1` 줄을 다시 쓰는 모의 TUI)를 띄우고 창 높이를 줄였다 늘림: 렌더러 버퍼와 미러(`feedbackTerminalContext` 의 줄) 모두 `tui line N` 이 한 번씩, 창 한 번에 rows·cols 가 같이 바뀌어도 PTY resize 1번(rows 만이면 즉시 1번). 옛 빌드(617467c)에서 줄 3개 사라짐·PTY resize 2번으로 실패
  - T88 입력 상자 읽기(11-05 phone-fixes A · edge-audit 1·2·3·14 · C-1) — Electron 없이. ovis `server/claude-input.ts`(MIT) 기준: `/rename` 한 세션의 이름 붙은 윗선(`──── 이름 ─`, `BOX_LABELED_RULE_RE` — 박스 읽기에만, 대화상자 윗경계는 실선 그대로) · 아래 선만 보이면 `clipped` → Claude 만 `input_busy` · IDE 알약 `[⧉ …]` 은 빈 상자 · 추천 첫 글자 반전 커서(뒤에 회색이면 추천, 아니면 친 글) · ━ 선과 8칸 이상 · NO_COLOR 팁 `Try "…"`(색 없는 화면에서 상자 한 줄 전체일 때만). 「지우고 보내기」: `input_busy` 거절에 한 줄 초안(`draft`, 배시 `!`·붙여넣기 자리표시·두 줄·clipped 는 없음), `clearDraft` 가 지금 상자 글과 같을 때만 Ctrl+K·Ctrl+U 후 전송, 다르면 아무것도 안 지움, 안 비면 거절. 옛 코드에서 실패 먼저 확인(각 묶음)
  - T89 연결된 폰 유닛(11-05 C-2) — Electron 없이. `PhoneConnections`: 요청 → 이름·경로·브라우저·연결 시각, 창 안 재요청은 처음 시각 유지, 1분 지나면 빠지고 다시 오면 새로, 열린 소켓은 창을 넘어 유지(`live`)·닫히면 창 다시, 오래된 순, `forget`(끊은 기기 즉시). `describeBrowser` UA 표(Chrome·Samsung Internet·Safari·CriOS·Firefox·Edge·Electron · Android/iPhone/iPad/Mac)
  - T90 폰 C-1·C-2(11-05) — 앱 + 폰. C-2: 설정 › Phone 이 열린 채 주인 폰(serve 머리말·Android Chrome UA)과 USB 폰(127.0.0.1, 코드로 짝지음)을 열면 «Connected now (2)» 줄 둘(`data-kind`·`data-route` tailscale/local·브라우저), 배지 2, 짝 끊으면 바로 1. C-1: chat-mock `--name`(이름 붙은 윗선) Claude 의 Mac 입력창에 글을 남기고 폰 Chat 보내기 → 「Text left…」에 그 글 → Clear and send… → 확인(이때까지 Mac 글 그대로) → 모의가 `ANSWER[1]: <폰 글>` 만 받음. `T90_SHOTS`·`T90_LABEL` 이면 검사 전에 캡처(옛 빌드: 폰 글이 Mac 초안 뒤에 붙어 「left at the machello…」로 나감)
  - T91 폰 2회차 유닛(11-05) — Electron 없이. `claudeSkillUsage`(chatCommands.ts): `~/.claude.json`(CLAUDE_CONFIG_DIR 면 그 안)의 `skillUsage.usageCount` 만, 0·문자·배열·깨진 JSON 은 빈 값, 목록이 Claude 명령에 `uses` 를 붙임 · `rankCommands`(chatLib.ts): 일치 먼저 → Claude 사용 수 + 이 Chat 에서 고른 수 → 내 것 먼저 → 이름. 옛 코드에서 6건 실패 · 0aab59f7: 인자 없이 보낸 스킬 메아리(Claude 2.1.318 은 `<command-args>` 를 아예 안 적는다)·빈 인자·인자 있음이 모두 사람 줄 「/이름 [인자]」(`claudeCommandEcho` 인자 선택) — 옛 정규식에서 실패
  - T92 폰 2회차(11-05 제보 9건) — 앱 + 터치 폰(CDP 390). 서랍 배경 불투명(rgb(15,15,20))·스크림 오른쪽 끝을 눌러 닫았다 열어도 목록 scrollTop 유지(스크림 가운데는 서랍 밑이라 세션이 열린다) · chat-mock `TABLE` 5칸 표가 넘쳐 가로 스크롤·칸 6.5em 이상·「lightsoft」 한 줄 · `/` 메뉴 첫 줄이 Claude skillUsage 41 의 스킬 · 입력칸 `/스킬` 이면 `data-command`·연파랑 · 폰 ⚙(Return 으로 보내기·빠른 답 = Mac 설정 목록, 새로 고침 뒤에도) · 5초 넘게 숨었다 보이면 「Refreshing…」·Chat 소켓 새로(짧게는 없음) · 폰에서 `/progress-report`(인자 없음·있음)를 보내면 폰·Mac Chat 둘 다 그 줄이 남음(chat-mock `/이름` = 2.1.318 스킬 메아리). `T92_SHOTS`·`T92_LABEL` 이면 검사 전에 캡처. 옛 코드에서 4건 실패
  - T93 Terminal ↔ Chat 이 쓰던 글을 옮김(11-05 4b9cb0c2) — 앱 + 터치 폰. chat-mock Claude 세션에서 Chat 칸의 글 → 헤더 Terminal 버튼 → 입력창에 그 글(Enter 없음, ANSWER 없음)·Chat 칸 비움, ⌘⇧M 로 돌아오면 한 줄 초안이 Chat 칸으로·입력창 비움(왕복 두 번) · 입력창에 다른 글이 있으면 덮지 않고 토스트(`draft-handoff-notice`) · 여러 줄 초안은 터미널에 남고 토스트 · Codex 는 아무것도 안 옮기고 토스트 · 폰 Chat | Terminal 탭으로 같은 왕복. 유닛은 T88 「the draft follows the view」 8건(붙여넣기 한 덩어리·질문 화면 거절·Codex unsupported). 옛 코드에서 3건 실패
  - T94 3회차 유닛(11-05 phone-fixes r3) — Electron 없이. 4359b4ee·cb052f3b: Claude Code 2.1.318 은 일하는 동안 「esc to interrupt」를 안 찍는다(실제 녹화 41.8초에 0회) — 스피너 줄 `✳ Galloping… (8s · ↓ 527 tokens)`·`✻ Deciphering… (running … hooks…)` 도 일하는 중(`screenLines.isBusyRow`), 끝난 줄 `✻ Cogitated for 11s` 는 아님 · 미러 `showsBusy`·`screenStatus`·Chat `working`·Stop(Esc)·질문 카드 판정 · c21d4b5a·574c78e4: 공백 뒤 `/` 도 스킬 메뉴(`inline` — 내장 명령 빼고, Codex 는 `$` 만), 경로(`src/a`·`~/x`)는 아님 · b2020233: `splitSessionLinks`·`codeIsSessionLink` · 1b92a570: 폰 `searchLines`(이름·워크스페이스·폴더, 낱말 모두, 대소문자 무시). 옛 코드에서 5건 실패
  - T95 3회차 앱(11-05) — A: 사이드바 「Phone on」 ✕ → 확인 모달(취소에 포커스, Enter·Esc·바깥 = 취소, 「Turn off」 만 끔, 0대/1대 문구) · chat-mock `--spinner 318` 세션에서 Chat 「Claude is working…」·Stop · 「1번 /cl」 → 스킬 메뉴(`/clear` 없음)·고르면 `1번 /climanager-session ` · chat-mock `LINK <id>` 답의 세션 링크 둘(코드·글) → 누르면 그 세션 터미널 · 폰 목록 🔍 검색(한 건·없음·닫으면 전체·Return = 첫 결과) · 폰 Chat 의 세션 링크 탭 → 그 세션 화면. `T95_SHOTS`·`T95_LABEL` 이면 검사 전에 캡처. 옛 코드에서 5건 모두 실패
  - T96 fb-1106 작은 설정·제보 — 유닛: `commandPieces`(스킬만 파랗게, `/` 메뉴와 같은 규칙: 메시지 맨 앞만 내장 명령·중간은 스킬·모르는 이름은 글)·`foldUserMessage`·`screenAgentMode`(입력 상자 아래 줄만)·기록의 모드(`foldMetadata`)·`checklistForAgent`. 앱: 입력칸 파란 글씨(맨 앞·가운데·둘째 줄, 글자 뒤 그림 칸과 높이·스크롤 일치) · 긴 말풍선 「… +N lines」 · 모드 칩 · 내 마지막 말 위 고정 · Chat 설정 스위치 · 파일 경로를 끄면 `shell.openPath`(main 에서 가로챔) · Related Below 먼저 · 체크리스트 Copy for agent(시스템 클립보드, 시험 뒤 복원) · 터치 폰(CDP 390): Terminal 아래 붙음(확대하면 위 잘림 없음) · 다른 세션 알림 끄기(점은 남음)·빠른 답 기본 켬·작업 중에도·내 마지막 말·새로 고침 뒤 유지 · Tailscale 꺼짐(BackendState≠Running)이 사이드바 배지 「Phone on · Tailscale off」·Settings › Phone 경고로, 다시 켜면 둘 다 사라짐(켜져 있는 동안 1분마다 다시 읽음, Settings 열 때 바로) · `.html` 은 기본 브라우저로·`:줄` 이면 미리보기 + Browser 버튼(90043d9d — main `shell.openPath` 가로챔)·느린 Mac 안내(연결·첫 읽기 4초, Electron `webRequest.onBeforeRequest` 콜백을 6초 늦춰 재현) · 빠른 답은 한 번에 하나(b17fa869 — 보내기 응답을 4초 늦춰 칩을 연달아 누름: 옛 코드 5번 전송 → 1번, 누른 칩에 `data-sending`)·Chat | Terminal 같은 폭(21f4d88a, 옛 코드 21px 차이) · 세션 메모(84188aa0 — 메모 있는 세션만 📝, 3쪽 넘김·돌아 감·빈 쪽 문구·링크 짧게/전체 href·키 가림·채팅 위에 그려짐(`elementFromPoint` — 채팅 z-45 아래 깔려도 toBeVisible 은 통과했다)·없는 세션 404) · 이름 바꾸기(0a4bdfff — 취소는 그대로, 저장 → 폰 헤더·Mac 사이드바(새로 고침 없이)·저장소·목록, 바가 채팅 위, 빈 이름 400·없는 세션 404·서버 유닛: 보기 전용 기기 메모 200·이름 403, 깨진 `%` 404). `T96_SHOTS`·`T96_LABEL` 이면 검사 전에 캡처, `T96_BEFORE=1` 이면 캡처만(옛 코드의 before)
  - T103 대화 연결 유닛 — 합성 Claude/Codex 파일, source·sidecar 제외·첫 말 가림·30개/90일/2,000 머리 상한·실경로·오류 코드·명령 우선순위·위험한 argv 거절. T25는 공유 타이머·16분 지연·늦게 뜨는 프로세스 재확인·소유 파일 우선·모호함·시작 기록 정리·npm/네이티브 이름·OSC/DCS 분할 응답·명시적 resume 회귀
  - T104 대화 연결 앱 — 메뉴 → 저장 cliSessionId/cliToolName/cliCommand → Enter 없는 명령·터미널 포커스/안내 → 사람 Enter → Chat → 실제 앱 재시작 resume 1회(렌더러 reload는 0회). Claude·파일 보유 Codex·미보유 Codex·다른 프로그램, REST/MCP 오류. D104_SHOTS=1·D104_SHOTS_DIR이면 상태별 캡처
  - T97 폰 파일 유닛(0010) — Electron 없이 실제 fs·PhoneServer·짝지은 기기·가짜 HOME: 금지·허용 표 · 모든 거절 코드 · 링크(`report.png → ~/.ssh/id_rsa`·폴더 링크·밖으로)·`..`·`~/.SSH`·NFD 한글·FIFO·`/dev/zero`·권한 없음 · 경계값 500,000/10,000,000/500MiB(희소 파일) · NUL·종류 · 마스킹 뒤 줄 수 같음·개인 키 블록 · raw 머리말·HTML·SVG·한글 파일명 · `Sec-Fetch-Site`·쿠키 없음·Funnel·보기 전용 · 철회가 받기를 끊음 · 로그에 경로 없음 · `mentionedPaths`(모든 블록·도구·알림·요약·칩·한도·합성 Claude·Codex 기록)·전체 출력의 경로 · `openGrantedFile` 을 다른 경로가 쓰는 계약. 옛 코드에는 모듈이 없어 실패
  - T98 폰 파일 패널 앱(0010) — 앱 + 터치 폰(CDP 390×844·배율 3, 주인 머리말), 대화 기록을 심는다: 화면의 `chat-file-link`·`chat-tool-open`·`chat-attachment-chip` 전부 서버가 허락(**동등성**)·안 나온 경로·다른 세션은 `not_mentioned` · 사진 `naturalWidth` · `:42` 줄 표시·화면 안 · ← 와 뒤로 가기 · 닫으면 같은 DOM 노드·`scrollTop`·입력 글 · 주소에 경로 없음 · `.md` Rendered/Source · HTML 은 코드 · 받기 머리말 · 없는 파일·금지 화면 · 왼쪽 끝 스와이프가 서랍을 안 엶 · 세션 이동이 닫음 · Mac 꺼짐 → Retry · 보기 전용은 링크 없음·403 · Mac `resized` 그대로·기록에 경로 없음. `T98_SHOTS`·`T98_LABEL` 이면 검사 전에 캡처. 옛 코드에서 5건 모두 실패
  - T99 폰 Dock 유닛 — Electron 없이 실제 유닉스 소켓: 시간순이 아닌 응답도 받은 순서 그대로 · 절대 경로가 응답에 없음(키는 해시, 옛 설계대로면 `file:/Users/…` 가 나가 실패) · 보낸 바이트가 고정 요청뿐 · 네 상태(`chrome_off` 는 파일 없음·남은 소켓 파일, `outdated` 는 2.5초에 끊고 30초 재접속 0회, `error` 는 깨진 JSON·2MB 초과) · 마지막 목록과 시각 유지 · 동시 5요청 = 접속 1회 · 제목 300자·묶음 500행·이상한 행만 버림 · 링크는 https claude.ai/claude.site 만 · `docFor` 거절(지워짐·`.env`·`%2F..` 오르기·목록에 없는 키) · 실제 소켓 차단 · 관문(401·Funnel 403·421·보기 전용 200·POST 404)
  - T100 폰 Dock — 앱 + 터치 폰(CDP 390) + 가짜 `dock.sock`: ☰ → 패널 · 시간순 아닌 응답이 그 순서 그대로 · 묶음·고정·Deleted·세션 이름·닫힌 세션·링크 · 조작 버튼 없음 · ✕/뒤로 닫으면 같은 DOM 노드·`scrollTop`·입력 글 · 세션 이름 → 그 세션, 뒤로 → 패널 안 다시 열림 · 왼쪽 스와이프 꺼짐 · 폴링 중 스크롤 유지 · 상태 띠 · 닫으면 소켓 접속 멈춤 · Dock 없으면 줄 없음 · 넓은 화면(목록 옆·Dock 두 번 눌러도 ✕ 한 번) · 읽는 중 끊긴 기기의 401 에 페이지가 안 죽음 · Mac `resized` 0. `T100_SHOTS`·`T100_LABEL` 이면 검사 전에 캡처. 옛 코드는 `phone-dock-entry` 가 없어 실패. 확장 쪽 순서·읽기 전용은 artifact-dock `tests/dock-list.e2e.mjs`(실제 Chromium)
  - T101 폰 문서 유닛(결정 0011) — Electron 없이 실제 PhoneServer·fs: 토큰 주소·제목·`~` 폴더·대상 세션, 파일 경로와 같은 거절(`not_mentioned`·`protected`·`not_html`·`view_only`·Origin `null`), 64MiB 경계, GET 은 토큰을 안 냄, 정확한 CSP(`sandbox`·토큰 폴더·`connect-src 'none'`), `.env`·`.json`·숨김·`..`·링크 탈출·큰 파일 404, 공용 폴더 문서는 옆 파일 없음, Funnel·Host, 철회가 토큰과 흐르던 바이트를 끊음, 끄면 토큰 사라짐, 토큰 수명·개수, 브리지 위치(BOM·주석 속 `<head>`·head 없음)·문자셋·ASCII, 칸 메시지 표, 보낼 글(토큰 제거·50,000자), 보내기 응답 표, 폰 저장 상한·50문서
  - T105 Dock 행 → 문서(합침) — 유닛(실제 PhoneServer): 키만으로 열림·응답에 Mac 경로 없음·`rawUrl` 도 키·키 옆 `path` 무시·받는 세션·없는 키/링크 행 404·보기 전용은 행을 찾기 전에 403·금지/밖/심볼릭 링크/비HTML/다른 사이트는 그대로 거절·받기·세션 없는 행은 로그 없음. 앱: ☰ → Dock → 문서 → 코멘트 → Send 가 행의 세션 기록에 도착(요청 본문에 경로 없음) · ← 와 뒤로 가 Dock·대화로 · 세션 없는 행은 시트에서 고름·세션 안 연 목록에서도 · 지워진 행·링크 행 · 보기 전용 기기는 목록만. `T105_SHOTS`·`T105_LABEL` 이면 캡처
  - T102 폰 문서(결정 0011) — 앱 + 터치 폰. 칸 속성·origin `null`·옆 사진·← 한 번·뒤로·대화 그대로·`:줄` 은 코드 보기·`resized` 0 · 탐침 페이지: 칸의 fetch·no-cors POST·beacon·XHR·소켓·폼·이미지 핑·팝업이 **main `webRequest` 에 하나도 안 잡힘**(대조군은 잡힘)·`phone-input` 0·토큰 주소를 맨 위에 열어도 origin `null` · 실제 키트 4종(`tests/fixtures/phone-doc`, 각 스크립트 산출물): 코멘트 → 시트 → Send 전 무변화 → Send → 대화 기록, 글 바꿔치기 무시·600ms·`inert`·저장·재오픈 값·`confirm`·토큰이 글에 안 섞임·`<dialog>` 닫기 · 거절: `input_busy` 두 번 눌러 지우기·질문 → Open chat·대기열·에이전트 종료 → 세션 고르기 · 키보드(실기기에서 찾음 — 폰 페이지는 키보드만큼 줄어 칸이 `resize` 를 받는다): before-after 입력칸이 그대로·포커스 유지·막대에 안 가림·내려가면 막대 복귀, 폭이 바뀌는 `resize` 는 페이지에 감 · 링크 시트·옆 문서·못 불러온 수·글꼴·`<html lang>`. `T102_SHOTS`·`T102_LABEL` 이면 검사 전에 캡처. `T102_WEBKIT_CORE=<playwright-core>` 면 WebKit 도(자식 프로세스 `fixtures/t102-webkit.cjs`). 칸 안 탭은 `Input.synthesizeTapGesture` — 칸은 자기 프로세스라 `dispatchTouchEvent` 로는 click 이 안 생긴다(실측)
  - T106 받아쓰기 유닛 — 말이 멈춘 뒤에도 앞 글이 남는지(`fixtures/dictation-transcript-cases.json` 13건을 main 함수와 빌드된 헬퍼 `accumulate` 둘 다로, 가짜 헬퍼 `pause` 모드로 서비스까지 — 옛 코드에서 8건 실패) · 글자 놓는 자리(커서·선택·띄어쓰기, partial 은 앞 partial 을 바꿈)·헬퍼 줄/상태 읽기·`DictationService` + 가짜 헬퍼(`fixtures/fake-dictation.cjs`): 순서·stop → final·cancel 뒤 무음·하나만·다른 창은 못 멈춤·SIGABRT → `permission_setup`·맥 아님/헬퍼 없음 · 빌드된 진짜 헬퍼의 `status`(묻지 않음)·universal
  - T107 받아쓰기 앱 — 가짜 헬퍼(`CLIMANAGER_DICTATION_HELPER`, 패키지 앱에선 무시): 마이크 → 읽기 전용·커서 뒤에 글자 · Enter 가 멈추고 보내지 않음(`ANSWER` 없음) · 다음 Enter 가 보냄 · ⌘⇧D 시작/멈춤·Terminal 보기에선 무반응 · 듣는 중 세션 이동 → 그 실행 끝·다른 칸에 글자 안 감 · 마이크 꺼짐 안내 · 기기 안 인식 불가면 버튼 없음. `T107_SHOTS`·`T107_LABEL`
  - T110 Chat 빈 곳 3회차 유닛(chat-gap-r3-1109) — Electron 없이. 「Collapse work」(`workBlockStartsOpen`: 켜면 일하는 덩어리도 접힘·질문 대기만 열림, 끄면 ovis 규칙) · Codex `exec` 줄 요약(`execSummary`: `cmd:"…"` 첫 명령 +N · 도구 이름 · 첫 줄, 패치는 그대로 파일) · `turn_aborted` → 「Stopped」 표지 · Chat 보내기는 `TerminalMirror.asksQuestion`(입력 상자 위 출력의 「Yes, proceed」는 질문 아님 — API `showsAwaitingInput` 은 그대로 true) · 대화 파일 없는 Codex 는 `not-found` + 보내기 됨. 옛 코드에서 12건 실패
  - T111 Chat 빈 곳 3회차 앱 — 시드한 Claude/Codex 기록 + chat-mock: 고정 마지막 말 펼침(4줄)·이동(12줄) · 파일 링크에서 끌면 선택·미리보기 안 뜸 · `.md` 미리보기 Preview/Source · PLAN 일하는 중 덩어리 접힘·설정 끄면 열림 · 답 속 「Yes, proceed」 뒤 Chat 보내기 · 390 번호 안내 · Codex exec 줄 명령 · Esc 뒤 「Stopped」 · 터미널에서 친 `codex`(가짜) 첫 말 전 Chat 버튼과 첫 말 보내기. 옛 빌드에서 판정 10곳 실패(soft — 끝까지 돌아 before 캡처를 남김). `T111_SHOTS`·`T111_LABEL`
  - T112 Chat 빈 곳 4회차 유닛 — Electron 없이. Q-5 MCP 확인(elicitation, 필드 없음): 실제 2.1.319 화면 사본(`fixtures/prompts/claude-2.1.319-mcp-elicitation*.txt`, 시험용 MCP 서버로 뜸)·제보 58814f80 화면·좁은 폭 → Accept·Decline·Cancel 카드, 키는 실측(Accept=Enter · Decline=↓ Enter · Cancel=Esc, ↑/↓ 는 둘을 돈다) · Q-7 Codex request_user_input: 실제 0.166 사본(`codex-0.166-question-*.txt`, `--enable default_mode_request_user_input`) → 질문·「Question n of m」·보기·설명, 「None of the above」 = Tab → 글 → Enter(기록 `user_note:` 로 확인), 힌트의 「esc to interrupt」는 일하는 중 아님(`isBusyRow`) · 답한 뒤 카드가 남던 경쟁 둘(같은 ms 두 조각 — `outputCount` · 뷰가 먼저 읽은 메뉴를 폴링이 못 봄 — 읽을 때마다 `noteState`). 옛 코드에서 실패 확인
  - T113 Chat 빈 곳 4회차 앱 — chat-mock `MCPOK`·`ASKCX`(실측 화면을 본뜸): 카드에서 Decline·Cancel·Accept → 모의가 `CHOSE: decline|cancel|accept`, 카드가 사라짐 · Codex 질문 1(Blue) → 질문 2 직접 입력 → `CHOSE: ask color=Blue; size=None of the above (note: Medium please)`. 옛 빌드 판정 7곳 실패(soft). `T113_SHOTS`·`T113_LABEL`
  - T114 받아쓰기 기록 유닛 — Electron 없이 `DictationLog` 에 임시 폴더·고정 시계: 꺼짐이면 무엇을 해도 폴더 없음 · 한 줄 모양(sent·cancelled·discarded·edited-away·empty·failed, 보고가 끝보다 먼저 와도 한 번) · 다른 창 보고 무시 · 가림(키·비밀번호·홈 폴더) · 쓰기 직전 끄면 아무것도 안 남김(소리도) · 소리는 「Also keep audio」만·0600 · 보관(글 30일 경계·소리 7일·폴더 안 만듦) · Delete all · `DictationService` + 가짜 헬퍼(`pause`·`--audio-out` → RIFF/WAVE)
  - T115 받아쓰기 기록 앱 — Settings › Terminal › Chat view 「Keep dictation log」 켜고 Save(소리 스위치는 기록 전엔 꺼짐) → 가짜 헬퍼 `pause` 로 받아 적고 고쳐 보냄 → `userData/dictation-log/<날>.jsonl` 한 줄(final 전체 ↔ sent·agent·locale, 0700/0600) · Esc → cancelled · 칸 비움 → edited-away · 끔(기본) → 폴더 없음 · 소리 켬 → wav(0600) · Open log folder(main `shell.openPath` 가로챔) · Delete all 두 번 → 폴더 없음 → 「Nothing kept yet」. `T115_SHOTS`·`T115_LABEL`. 옛 코드에서는 스위치가 없어 실패
  - T116 Chat Fork 유닛 — Electron 없이. 시작 명령(`chatFork.forkCommand`): Claude `--resume <id> --fork-session` · Codex `fork <id>` · 저장된 alias(`cldy`)·옵션·준비 줄(`glm-on && cldy`) 유지 · 옛 resume·`--session-id` 대상 제거 · 읽을 수 없는 명령(`-p "…"`·`$(…)`)은 에이전트 이름만 · UUID 아닌 id 거절 · 이름 「· fork」 자르기. 첫 말(`forkFirstMessage`): Whole 은 말 그대로(따옴표·줄바꿈·`$(…)`) 또는 없음 · Quote 는 최종 답만(작업·도구 출력 없음) · Excerpt 는 이 답까지 최근 턴(이후 턴 없음)·6턴·턴당/합 상한·「(cut)」·비밀값 가림. `ConversationService.fork`: 실제 TranscriptReader 로 그 턴 확인(다른 시각·사람 턴·없는 자리 = `turn_changed`), 대화 없음·세션 없음 거절, `openFork` 에 넘기는 값(명시한 답·기본 마지막 답의 anchor), Codex 실제 rollout 으로 `fork <id>` + `watchCodex`. 옛 코드에서는 모듈이 없어 실패
  - T117 Chat threads 앱 — chat-mock(`--show-args`·`--fresh-transcript`): 일반 클릭 → 모달 없이 Whole(`ARGS: --resume <id> --fork-session`, 첫 말 없음), 부모 기록·초안·포커스 유지, 알림 Show · 답 anchor 저장·칩 「1 thread」 → 오른쪽 스레드 칸(부모 헤더·사이드바·Chat 유지, 평문 첫 문단 인용(표 기호 없음)·빈 상태), `--copy-transcript`로 실제처럼 부모 기록을 복사해도 칸에는 fork 시각 이후 턴만 · 자식 전송·ANSWER·부모 ⌘⇧I · 「2 threads」 목록/칩 상태 점, Open as session 이동·세션별 칸 기억·✕/유휴 Esc·자식 닫힘 제거, 작업 중 Esc는 자식 Stop·칸 유지·자동완성 Esc는 목록만 닫힘, 390 폭 겹침 칸 창 안 · Shift+클릭 → 기존 Excerpt 모달(취소·첫 말·390) · 폰 터치는 기존 모달 유지(칩 없음) · REST/MCP fork는 기본 마지막 답 anchor·칩, AI 표시·기존 거절 유지. `T117_SHOTS`·`T117_LABEL`. 새 anchor 시험은 origin/main에서 실패(T34/T116). `t127-chat-threads-unit`은 관계 방향·anchor 없음·닫힘·상태·활동 시각, 틱당 저장소 읽기 횟수(부모 여러 개는 각 한 번, anchor 자식 없으면 0회), 30초 활동 시각 알림 비교를 검증한다. `t127-chat-thread-props-unit`은 턴별 배열 참조 유지·스레드 없는 턴의 안정적인 prop·전역 index/옛 anchor 호환을 검증한다. `t127-thread-panel-unit`은 Claude·Codex 복사 기록의 fork 시각 필터(시각 없음/오류는 숨김), 긴 스레드의 이전 답 불러오기, 중복/빈 시각의 인용 대상, 상태 점 우선순위와 인용의 Markdown 제거·표/코드 처리·3줄/240자 제한을 검증한다.
  - T118 폰 Chat 읽기 측정(opt-in `PHONE_READ_PERF=1`, fb-1110) — 실제 앱 + 폰 화면(CDP 390·CPU 4배)에서 Mac 속도·Wi-Fi·LTE 중계 세 조건으로 대화 요청(서버+전송)·바이트(본문/전송)·렌더(페이지 안 rAF)·요청 수를 잰다. `PHONE_READ_TRANSCRIPT=<jsonl>`(실제 크기 익명 사본 — 글자만 바꾼 같은 모양), 결과 `tests/terminal/results/<PHONE_READ_LABEL>/t118-phone-read.json`
  - T119 폰 Chat 읽기 유닛(fb-1110) — 구독 전 GET 의 읽기를 버리지 않음(두 번째 읽기·헛 「changed」 없음, 그 사이 바뀐 것은 한 번 알림, 아무도 안 오면 `idleKeepMs` 뒤 놓음) · 8KB 넘는 JSON 은 gzip 을 받는 쪽에 gzip(작은 것·안 받는 쪽은 그대로). 옛 코드에서 4건 실패
  - T120 2.1.322 질문 카드(fb-1110 4f10a0fc) — 실제 2.1.322 AskUserQuestion 화면 사본(미리보기 칸·2문항·`│` 막대 여러 줄 질문, 중립 내용 `fixtures/prompts/claude-2.1.322-ask-preview-*`)을 `claude` 라는 이름의 실행 파일로 띄우고 Chat 카드의 질문 전체·보기(미리보기 글 없음)를 본다. 창 1800 폭 — 사본(115칸)보다 좁으면 줄이 접힌다. `T120_SHOTS`·`T120_LABEL`. 옛 파서에서 질문이 키 안내 줄이라 실패
  - T121 턴 끝·recap·백그라운드 유닛(fb-1110 a0ba98c4) — `system/turn_duration` 이 답에 `done`(끝난 시각·걸린 ms), `system/away_summary` 가 `recap` 으로 붙는지(사이 notice 는 건너뜀, 사람 프롬프트 뒤의 늦은 기록은 안 붙음, 숫자·글 없으면 뺌) · `screenBackground` 가 입력 상자 아래 줄의 `· 1 shell · ← 1 agent`(복수형·한쪽만)를 세고 상자 위 글·상자 없는 화면은 null
  - T122 턴 끝·recap·백그라운드 화면(fb-1110 a0ba98c4) — 기록(답 + turn_duration + away_summary)과 Claude 화면 사본(`claude` 실행 파일, T120 방식)으로 Chat 답 아래 「Took 29s · done …」(시각은 지역 설정 — 기대값도 창 안 `toLocaleTimeString`)·「※ recap …」, 입력칸 줄 칩 「1 shell · 1 agent」, 답 속 표는 표 그대로. `T122_SHOTS`·`T122_LABEL`. 옛 코드에서 실패
  - T123 폰 첫 쪽(fb-1110 3회차) — 질문·답 45쌍(90턴) 기록으로 폰(390) Chat 이 `?limit=20` 으로 최근 20턴만 그리고 「Showing the last 20 of 90 turns.」, 맨 위에서 「Show earlier」마다 20턴씩 위에 붙고 읽던 턴이 같은 줄(±2px — Safari 는 스크롤 앵커가 없어 손으로 지킨다), 끝까지 펴면 90턴이 한 번씩 순서대로·안내 없음, 같은 세션 Mac Chat 은 그대로 90턴(200 창). `T123_SHOTS`·`T123_LABEL`. 옛 코드에서 실패(20 기대 ↔ 90)
  - T124 백그라운드 목록 유닛(fb-1110 a0ba98c4 4회차) — Electron 없이. ovis 시험의 기록 모양 그대로(`refs/ovis` server/claude-subagents.test.ts, MIT): 하위 에이전트 짝 파일(`subagents/agent-<id>.meta.json`·`.jsonl`) → 실행 중·제목·종류, 알림은 세 가지 기록에 실려도 한 번·failed/killed, 셸 알림은 에이전트 것 아님, 알림 뒤 파일이 이어지면 다시 실행 중, 동기 호출은 tool_result 로 끝·`Async agent launched` 는 답 아님, TaskStop · 백그라운드 `Bash`(`backgroundTaskId`) → 설명 또는 명령, 알림·TaskStop 답·KillShell `shell_id` 로 끝, 시작보다 앞선 끝은 옛 명령 것, 자라는 파일 이어 읽기·바뀐 파일 다시 읽기, 첫 읽기 창(16MB) 밖은 못 찾음, 끝난 것 하루·10개 · `settleBackground`(쉬는 중이면 화면 수보다 많은 실행 중은 오래된 것부터 lost, 일하는 중엔 기록 그대로, 화면 수가 더 많으면 moreRunning)
  - T125 백그라운드 목록 앱(fb-1110 a0ba98c4 4회차) — 셸 둘(하나 끝남)·하위 에이전트 하나 기록 + Claude 화면 사본(`show-screen.cjs` 는 파일이 바뀌면 다시 그림)으로 Mac Chat 칩 「1 shell · 1 agent」 → 목록(실행 중 오래된 순, 종류·경과, 「1 recently ended」 접힘 → 펼침), 열린 채 셸 알림을 쓰면 3초 안에 끝난 쪽으로·칩 「1 agent」, Esc 로 닫고 다시 열면 접힌 채, 폰(390) Chat 에서 같은 목록·화면 안. `T125_SHOTS`·`T125_LABEL`. 옛 코드에서 실패(목록 패널 없음)
  - T126 폰 사용량(3b4efdfc) — 유닛: `aswap list --json` 읽기(별칭·이메일 가림·lastGoodUsage·오류/다른 schema/글자 → 없음·Codex epoch 초), 60초 캐시·한 번에 하나·실패도 캐시, 로그인 셸 실행기의 없는 명령·10초 제한(가짜 셸 스크립트), 앱 값 변환, 「in 2h 12m」. 앱: 가짜 agent-swap(`CLIMANAGER_AGENT_SWAP_FAKE` — 테스트 모드에서만, 셸 대역 스크립트, 계정은 합성) · ☰ → Usage → 계정 둘·막대 %·소진 예상·이메일 이름 안 나감·채팅 위(`elementFromPoint`)·390 안·↻ 를 눌러도 1분 안엔 aswap 1번·열기 전엔 0번. 테스트 모드는 가짜가 없으면 aswap 을 부르지 않는다(사용자 계정 보호). `T126_SHOTS`·`T126_LABEL`. 옛 코드엔 Usage 줄이 없어 실패
  - T127 자율 크론(Autocron) 유닛 — Electron 없이. 크론 식 읽기(필드·범위·단계·목록·별칭·일요일 7·「절대 안 맞음」 거부)·다음 실행(요일·둘 다 정한 날 규칙·월/년 넘김)·놓친 것 판정(제때 · 깨어나면 한 번 · 시간 한도 넘어 expired · skip · notify · 주말 세 번이 한 번으로)·입력 검사(모드별 필수·missed 범위·편집 병합·모드 바꾸면 다른 모드 칸 지움)·책갈피(켜거나 일정 바꾸면 지금부터)·기록 500개 상한·가짜 실행기로 새 세션·붙기·실패 기록. 기대 시각은 `new Date(y, m, d, h, min)` 로 만든다
  - T128 자율 크론 앱 — 실제 앱 + `agent-mock` 템플릿: 한 시간 전 시각이 지난 채 시작하면 「6시간 안 한 번」은 세션이 열려 프롬프트에 답하고 「30분 안」은 missed 기록만 · 루프 창 Autocron 탭에서 폼으로 만들기(틀린 일정 미리보기 경고)·지금 실행·실행 줄·세션 열기 · `/v1/crons` 목록·400·201·pause → 창에 Resume·404·삭제
  - T129 자율 크론 더 많은 경우 — Electron 없이. 다음 실행을 따로 짠 「1분씩 걷기」 검사기와 대조(시드 고정 무작위 일정 · 시간대 7곳 · 시계 바뀌는 밤 근처, 30분 서머타임·자정 변경·+5:45·+12:45 포함) · 바뀌는 밤 말로(02:30 건너뜀·01:30 두 번·없는 자정) · 크론 식 받는 것/거절하는 것 표 · 놓친 것 판정 경계(유예 딱 2분·한도 딱 60분 vs +1ms·책갈피가 미래) · 입력 한도·형식 · 작업 100개 상한·편집 · 겹친 tick·겹친 지금 실행·던진 오류·도는 중 삭제(주인 없는 실행 기록 안 남김) · 붙기 큐가 실패 뒤에도 이어짐 · 실제 HTTP `/v1/crons`(인증·bad_json·한글/슬래시/% 이름·pause 두 번·크론 없는 빌드 404)
  - T130 자율 크론 붙기 실제 루프 — 실제 셸·`agent-mock` 이 도는 루프 터미널: 셸만 있으면 거절 · 프롬프트에서 기다리면 글+Enter 가 들어가 한 번 답 · 질문이 떠 있으면 거절하고 「1. Yes」를 누르지 않음 · 답한 뒤 다시 들어감 · 에이전트가 끝나면 다시 거절. 보호 장치를 끈 빌드에서 실패(11-14 확인). 터미널 글은 `termText(page, id)` 전체로 읽는다 — 줄 수를 주면 48줄 화면의 빈 아래쪽만 온다
  - T132 자율 크론 리뷰 수정 유닛(11-14) — Electron 없이. 같은 이름 거절(대소문자·앞뒤 공백 무시, 만들기·이름 바꾸기, 옛 중복은 이름으로 안 잡힘) · API 가 만든 작업은 API 가 꺼지면 안 돎(창 작업은 돎, 이유 표시, 다시 켜도 밀린 것 안 함, 지금 실행도 막힘) · 붙기는 `typeIntoLoop` 결과(초안 있음·Enter 뒤에도 남음·터미널 없음)를 이유와 함께 실패로 · 창 로드 실패·시간 초과가 기다림을 끝내 다음 tick 이 돈다
  - T133 자율 크론 리뷰 수정 앱(11-14) — API 를 끈 채 시작하면 API 가 만든 작업은 안 돌고 Autocron 탭에 이유·만든 쪽이 보임(창 작업은 따라잡음) · `agent-mock --box --drop-enters 1` 루프에서 먹힌 Enter 를 다시 눌러 한 번 답 · 사람이 입력칸에 쓰다 둔 글이 있으면 아무것도 안 넣고 실패. 옛 코드에서 두 시험 다 실패, 초안 검사를 뺀 빌드에서 둘째 시험 실패(11-14 확인)
  - T141 백로그 작은 결함(fb-1114b) — Electron 없이. Control API 경로 조각의 깨진 `%`(`/v1/sessions/%E0%A4%A`)가 500 이 아니라 400 `bad_path`(토큰 검사는 그 앞) · 폰 페이지 `notranslate`(Chrome 번역 풍선) · `closeApp` 이 닫히지 않는 시험 앱을 시간 초과 뒤 SIGKILL(폴더도 지움)·스스로 닫히면 안 죽임. 옛 코드에서 3건 실패. T1 은 명령 줄에 없는 `SEQ-DONE-2-…`(셸이 계산)를 기다린다
  - `loop-counter.spec.ts` — Electron 없이 도는 순수 유닛
- **실행**: `pnpm build && pnpm test:term` (빌드된 `out/`을 구동하므로 빌드 필수)
  - 범위·옵션 지정은 `pnpm exec playwright test tests/terminal/<spec>.spec.ts --workers=1`로 한다.
    `pnpm test:term -- ... --grep ...`의 `--` 뒤는 이 환경에서 파일 패턴으로 읽혀 범위가 넓어질 수 있다.
  - **새 클론·워크트리에서는 먼저 `pnpm exec electron-builder install-app-deps`**. `pnpm install`이
    깔아주는 node-pty는 Node ABI용이라 Electron이 못 읽는다(`Cannot find module
    '../build/Debug/pty.node'`로 모든 앱 구동 테스트가 죽는다). postinstall 스크립트는 이 경우를
    덮지 못하고 SKIP 로그만 남긴다 — [`docs/backlog.md`](docs/backlog.md) 참고.
- **Headless 기본**: 테스트 창은 화면에 표시되지 않음 (`CLIMANGER_TEST_HEADLESS=1` 자동 설정, hidden window + backgroundThrottling 해제). 눈으로 보면서 디버깅하려면 `CLIMANGER_TEST_HEADED=1 pnpm test:term`
- **언어**: `CLIMANGER_TEST_LANG=ko-KR` 이면 앱 창을 그 언어로 띄운다(Playwright `locale` — `LANG`·`--lang`·`-AppleLanguages` 로는 안 바뀐다, 11-11 실측). 시각·숫자 문구를 검사하는 시험은 기대값을 창 안 `toLocale*` 로 만들고 이 값으로 한 번 더 돌린다(T122 가 v1.32 사전 점검에서 「오전 12:29」로 실패)
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
