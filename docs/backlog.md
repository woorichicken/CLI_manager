---
description: When picking up deferred work, or when parking something found mid-task
authority: Work observed in this repository and consciously not done yet
status: active
owner: maintainer
last-reviewed: 2026-09-30
---

# Backlog

Work that was **seen in this repository**, with evidence, and deliberately left undone. Not a
roadmap and not a wishlist: every entry names a path and a trigger that makes it actionable.

Any session may append to `## Open` without running a curation skill — the session that found the
problem is the one holding the evidence. Appending sessions do not reorder or remove other entries.

Remove an entry in the same change that resolves it. If resolving it produced a durable rule, that
rule goes to [`decisions/`](decisions/) or a scoped `CLAUDE.md`, never back into this file.

## Open

### xterm 리사이즈 — 창이 커질 때 커서가 맨 아래면 스크롤백 줄이 화면으로 내려와 Claude 리페인트에 지워진다
- Discovered: 2026-10-13, T29 에 「에이전트 리페인트 뒤에도 구분선이 남는가」 검사를 넣다가.
- Evidence: 30줄 → 43줄 맞춤 리사이즈가 지우기와 겹치자, 스크롤백 맨 아래였던 구분선(305행, 화면 시작 306)이 화면으로 내려와
  지워졌다. xterm 은 행이 늘 때 커서가 맨 아래면 스크롤백에서 줄을 끌어내리고, Claude 는 다시 그릴 때 화면 줄을 전부 지운다.
  이번 변경 전에도 있던 동작이다 — 그때는 Claude 자신의 이전 출력이 같은 식으로 사라졌다. 미러도 같은 리사이즈를 거치므로 두 사본은 같이 잃는다.
- Why deferred: 히스토리 복원과 별개인 xterm·Claude 상호작용이고, 실제 복원 흐름(리사이즈가 리페인트보다 먼저 끝남)에서는 재현되지 않았다.
- Trigger: 창 크기를 키운 뒤 대화 몇 줄이 사라졌다는 제보가 나올 때.
- Trigger hit: 2026-10-25 fb-1025 — 제보 f2a636b9(오랜만에 돌아오면 마지막 표 앞이 잘림, 1.17.0). 제보에 실린 미러 줄에도 같은 줄이 빠져 있고(124→125행) 스크롤백 삭제(CSI 3 J) 사건은 0 — 렌더러만의 문제가 아니다. 이 항목과 idle 압축 때 다시 그리기 둘 중 무엇인지는 크기 변경 사건이 없어 못 갈랐다 → PR #59 가 제보에 `resized` 사건을 싣는다. 고칠 방향은 아래 「높이만 바뀌는 resize」 공용 모듈 컨펌과 같이 정한다.
- Fix direction: 행이 늘 때 스크롤백을 끌어내리지 않게 xterm 리사이즈 전에 빈 줄로 커서를 올려 두는 식의 보정 — 먼저 실제 Claude 로 재현을 잰다.
- Trigger hit 2 (크기 변경 **없이**): 2026-10-29 fb-1028 — 제보 477ecebd(1.21.0). 「(페이지 검사」 줄 뒤 약 10줄(표 머리·첫 줄)이 빠졌고 미러 줄에도 똑같이 없다.
  그 세션의 사건 기록은 `restored`·`started` 뿐(`resized` 0 · `scrollback-erased` 0 — PR #59 뒤라 크기 변경이 있었으면 남는다). 빠진 줄은 그 답이 화면 맨 위에 있던
  부분이고 바로 뒤에 Claude Code 의 「Compacted while idle」이 찍혀 있다 → 이 경우는 이 항목(리사이즈)이 아니라 **Claude Code 가 쉬는 동안 압축하며 다시 그릴 때**로 본다(재현 못 함 — 압축을 일부러 일으키기 어렵다).
  제보는 needs_review 로 「idleCompaction 끄기」(사용자 Claude 설정)를 추천했다. f2a636b9 도 「오랜만에 돌아오면」이라 같은 원인일 수 있다 — 그러면 아래 보정은 둘 중 리사이즈 쪽만 덮는다.
- Owner: 없음

### `electron-vite.config.ts` — 이 설정 파일은 읽히지 않는다
- Discovered: 2026-10-13, StrictMode 확인용 개발 번들을 만들다가.
- Evidence: electron-vite 는 `electron.vite.config.*` 를 찾는다. 같은 내용으로 `--config` 를 주면 `Cannot find package '@vitejs/plugin-react'` 로
  죽는다 — 그 플러그인은 설치돼 있지 않다(`ls node_modules/@vitejs` 없음). 지금 빌드는 기본 설정(esbuild JSX)으로 돌고 `@renderer` alias 도 없다.
- Why deferred: 빌드는 정상이고, 이름을 바꾸면 플러그인 설치·alias 사용처 확인까지 따라오는 별개 변경이다.
- Trigger: 빌드 설정(alias·React 플러그인·Fast Refresh)을 실제로 바꾸려 할 때 — 그 전에 이 파일이 읽히는지부터 고친다.
- Owner: 없음

### `src/renderer/src/App.tsx` — 렌더러가 새로 뜨면 보고 있던 세션이 선택돼 있지 않다
- Discovered: 2026-10-13, 크래시 자동 복구(0008)를 캡처하다가. 새로고침 뒤 화면이 「please select a terminal」로 시작했다.
- Evidence: 기록은 미러에서 복원되지만 활성 세션은 렌더러 상태라 사라진다. 사용자는 사이드바를 한 번 눌러야 한다.
- Why deferred: 히스토리 유실 수정과 별개 UX 이고, 앱 첫 실행 때도 같은 동작이다(어디로 복귀할지 정해야 함).
- Trigger: 크래시 복구·창 재오픈에서 「마지막으로 보던 세션으로」 요청이 나올 때.
- Owner: 없음

### `src/renderer/src/components/TerminalView.tsx` — 렌더러 xterm 스크롤백 10,000줄이 세션 수만큼 메모리를 잡는다
- Discovered: 2026-10-13, 「용량 때문에 화면이 하얘진다」 제보로 히스토리 유실을 고치다가(0008).
- Evidence: xterm 줄 버퍼는 폭에 비례한다 — headless 실측 200열 2,000줄 = arrayBuffers 4.7MB, 그러니 렌더러의 `scrollback: 10000` 은
  가득 차면 터미널당 약 24MB(200열). 실사용 세션 44개가 다 차면 1GB 근처다. 실행 중 앱의 렌더러는 새로 뜬 지 40분에 RSS 321MB
  (`ps -axo rss,etime,command`). 하얀 화면의 원인이 OOM 인지는 **확인 못 했다** — 그때는 크래시 사유를 남기는 코드가 없었다.
- Why deferred: 히스토리 유실 수정과 별개 결정이다(보관 줄 수를 줄이면 사용자가 위로 스크롤할 수 있는 양이 준다).
- Trigger: 하얀 화면이 다시 나올 때 — 이제 main 로그에 `[renderer] gone: <reason>` 이 남으니 `oom` 인지부터 본다.
- Fix direction: main 미러가 2,000줄을 들고 있으니 렌더러 스크롤백을 줄여도 새 창·재시작 복원은 그대로다. 줄이기 전에 세션 수별 렌더러 RSS 를 잰다.
- Owner: 없음

### `scripts/post-release.cjs` — README 의 다운로드 링크는 릴리즈 때 갱신하지 않는다
- Discovered: 2026-10-12, 레딧·쓰레드 공유 준비 중. README 「Download」 표가 R2 의 `cli-manager-1.5.0-*.dmg` 를 직접 가리키고 있었다(최신 v1.13.0).
- Evidence: `post-release.cjs` 의 `SITE_LINK_FILES` 는 웹사이트 파일 3개뿐이다 — 사이트는 1.13.0 으로 맞는데 README 는 4월 이후 그대로였다.
  이번엔 표를 `releases/latest` + 파일 이름 안내로 바꿔서 버전이 박히지 않게 했다(문서만).
- Why deferred: 직접 다운로드 링크를 README 에 다시 두려면 릴리즈 스크립트 코드 변경이 필요하다.
- Trigger: README 에 버전별 직접 링크를 다시 넣고 싶을 때 — 그때 `post-release.cjs` 가 README 도 갱신·검증하게 한다.
- Owner: 없음

### `src/main` 세션 복원 — 앱 재시작 때 세션을 전부 한꺼번에 띄워 머신이 멈추고 MCP 가 빠진다
- Discovered: 2026-10-10 10:09 앱 재시작. 복원된 Claude 세션 35개의 시작 시각이 전부 1분 안(`ps -axo etime,comm | awk '$2=="claude"'` → 3:22 26개 · 3:23 9개).
- Evidence: 1분 부하 **362**(10코어, `uptime`) → 4분 뒤 160. 복원된 세션 하나에서 MCP 6개(context7·hyperbrowser·slack·sentry·chrome-devtools·unsplash)가
  `connection timed out after 30000ms` 로 빠졌다. MCP 프로세스 139개 — 세션 31개 기준 예상치(약 380)의 1/3 → 다른 세션들도 MCP 없이 떠 있었을 가능성이 크다(세션별 확인은 안 함).
  함께 확인된 것: kill 로 닫은 세션 4개가 이 재시작 때 그대로 되살아났다 — 탭이 남아 있으면 복원 대상이다(`clim close` 로 닫으면 안 돌아온다).
- Why deferred: 리소스 점검 세션(workspace-sweep) 중 발견. 앱 코드 변경은 범위 밖.
- Trigger: 다음에 세션 복원 코드를 만지거나, 재시작 직후 부하·MCP 누락 제보가 다시 나올 때.
- Fix direction: 복원을 몇 개씩 나눠 띄운다(예: 4개씩, 앞 묶음의 에이전트가 프롬프트를 띄운 뒤 다음). 오래 쉰 세션은 탭만 복원하고 프로세스는 첫 포커스 때 띄우는 선택지.
- Owner: 없음

### `tests/terminal/t26-session-navigation.spec.ts` — 「split view 삭제」가 셸 자식 대기 뒤에도 간헐로 남는다
- Discovered: 2026-10-27 v1.21.0 릴리스 빌드 1회차 사전 점검 — `t26-session-navigation.spec.ts:187` 「deleting a session shown in split view removes its pane」이 `deleteFromSidebar` 의 `expect(row).toHaveCount(0, { timeout: 10_000 })` 에서 실패(Received 1, 24회 확인). 302 passed · 1 failed(12.3m), 게시 없음. 부하 1분 값 38(배치 밖 헤드리스 크롬 4개). 단독 `--repeat-each=3` 3/3, 2회차 빌드 303 passed 로 공개. 로그 `/tmp/climanager-release-121-build-try1.log` → 전체 `/var/folders/cx/yf5b5yt170q7jsdn4xz6pfhr0000gn/T/release-tests-1793070940740.log` · `/tmp/climanager-release-121-t26split.log`.
- 앞 이력: 10-09 v1.13.0 · 10-25 1.18.0(T40) · 10-26 1.19.0(T40) 에 같은 사이드바 삭제 버튼에서 났다. 원인 경로(코드로 확인): `App.tsx` `handleRemoveSession` 이 `hasRunningProcess` 참이면 네이티브 확인 상자를 띄운다 — 숨긴 시험 창에서는 아무도 답하지 않는다. 2026-10-26 PR #62 가 클릭 전에 `hasRunningProcess === false` 를 기다리게 했고 day-1027 #69 가 이 줄을 닫았지만, **대기를 지난 뒤에도 줄이 남았다** — 대기와 클릭 사이에 자식이 생겼는지, 클릭이 hover 전환 중에 빗나갔는지는 아직 모른다.
- 「Ctrl keys」(같은 파일)는 PR #66 뒤 1.21.0 사전 점검 두 번 모두 통과 — 그 줄의 트리거대로 지웠다.
- Trigger: 사전 점검·묶음 실행에서 사이드바 삭제 시험이 다시 실패할 때.
- Fix direction: 실패 때 화면(확인 상자 여부)과 `hasRunningProcess` 값을 남긴다 → 원인이 상자면 시험 모드에서 확인을 건너뛰는 길, 빗나간 클릭이면 「hover → 버튼 보임 대기 → 클릭 → 행 사라짐」 재시도. 여러 시험(T26·T40·T45·T52)의 사이드바 삭제를 공용 도우미로 묶는 것은 사람 컨펌.
- Owner: 없음

### CI `Terminal + agent tests` — 앱을 띄우는 테스트가 CI 에서 전부 3분 타임아웃
- Discovered: 2026-10-06, simple-git 4 업그레이드 PR CI
- Why deferred: 로컬에서는 전체 123건이 통과한다(2026-10-06 릴리즈 preflight). CI 러너 환경 문제라 별도 조사가 필요하다.
- Trigger: CI 를 다시 머지 게이트로 쓰려 할 때. 그 전까지 CI 초록은 typecheck·build·audit 까지만 뜻한다.
- Evidence: run 37429282637 — 유닛(`loop-counter`) 8건만 통과, 그 뒤 t1·t4·t5·t6·t7 이 각각 3.0m 로 실패하다 job `timeout-minutes: 25` 로 취소.
  2026-10-03 main(v1.12.2 전후) 두 run 도 같은 단계에서 cancelled — simple-git 변경 이전부터다.
  2026-10-17 main(v1.14.0) run 39038509159 와 2026-10-21 PR #34 재실행 run 39451565054 도 같은 모양 — t1·t31·t4·t5 가 각 3.0m 실패 후 25분에 취소.
  설치 단계의 `@vscode/ripgrep` 403 은 PR #35 가 고쳤다 — 그 뒤 CI 를 막는 건 이 항목뿐이다.
- Fix direction: 실패 아티팩트(스크린샷·main 로그)를 받아 앱 구동 단계에서 막히는지 본다. node-pty 를 Electron ABI 로 다시 빌드하는 `electron-builder install-app-deps` 단계가 CI 에 있는지부터 확인.
- Owner: 없음

### `src/renderer/src/components/TerminalView.tsx` — macOS 에서 Option 이 Meta 로 동작하지 않는다
- Discovered: 2026-10-06, 단축키·터미널 키 충돌 점검 중
- Why deferred: Ctrl 충돌 수정과 별개 동작이고, 켜면 Option 으로 특수문자(₩·€ 등)를 치던 사용자의 입력이 바뀐다.
- Trigger: Option+B/F(단어 이동)·Option+Enter 가 안 된다는 제보, 또는 터미널 키 설정을 추가할 때.
- Evidence: `src/` 에 `macOptionIsMeta` 설정이 없다(grep 0건). xterm 기본값은 false 라 Option+B 는 `∫` 를 보낸다.
- Fix direction: Settings > Keyboard 에 "Use Option as Meta" 토글을 두고 xterm 옵션에 연결한다.
- Owner: 없음

### `src/main/AgentStatusResolver.ts` — Codex 세션의 "실행 중"은 훅이 아니라 입력 가로채기에 의존한다
- Discovered: 2026-08-16, 공식 훅 통합 구현 중
- Why deferred: Codex CLI가 제공하는 이벤트가 `agent-turn-complete` **하나뿐**이라 턴 시작 신호가
  존재하지 않는다. 우리 코드로 메울 수 없고 Codex 쪽 기능 추가가 필요하다.
- Trigger: Codex CLI가 turn-start 계열 이벤트(또는 범용 hook 시스템)를 추가하면. 추적 대상:
  `github.com/openai/codex` discussions #2150 (Hook 기능 요청)
- Evidence: `AgentStatusResolver.ts`의 `EVENT_STATUS`에 Codex는 `turn-end`만 매핑된다.
  `src/main/hookScripts.ts`의 `CODEX_NOTIFY_SCRIPT` 주석 참고. 현재는 사용자가 Enter를 치는 순간을
  `CLISessionTracker`가 잡아 running으로 간주한다 — 사용자가 CLI Manager 밖에서 Codex를 조작하면
  (예: 다른 터미널에서 붙임) running이 안 잡힌다.
- Owner: 없음 (외부 의존)

### `src/renderer/src/components/` — 디자인 토큰/컴포넌트 가이드가 없다
- Discovered: 2026-08-16, 저장소 ops 부트스트랩 중 구조 감사가 검출
- Why deferred: 이번 요청은 문서 구조 정리였고, 디자인 가이드를 쓰려면 실제 토큰 체계를 먼저
  정해야 한다. 없는 체계를 문서로 만들어내면 그 문서가 곧 거짓이 된다.
- Trigger: 테마 커스터마이징(root `CLAUDE.md`의 Future Improvements)에 착수하거나, 컴포넌트가
  20개를 더 넘어 색·간격이 갈리기 시작할 때
- Evidence: `audit-repository.mjs`가 component/token 파일 27개를 검출했고 인덱스된 디자인 가이드
  없음. 현재 디자인 규칙은 `.claude/rules/tip-box-style.md` 한 건뿐이고 나머지는 컴포넌트마다
  하드코딩된 Tailwind 클래스다 — 패널 배경 `bg-[#1e1e20]` 하나만 해도 9개 파일에 흩어져 있다.
- Owner: Human Review (디자인 방향 결정 필요)

### `src/main/AgentStatusResolver.ts` — OSC title 계층이 인터페이스만 있고 구현이 없다
- Discovered: 2026-08-16, 공식 훅 통합 구현 중
- Why deferred: 훅 경로를 먼저 완성하는 게 우선이었다. `'osc'`는 우선순위 표에 자리만 잡아둔 상태.
- Trigger: 훅을 켜지 않은 사용자에게서 상태 오판 제보가 들어오면. OSC는 설치 없이 정확도가
  올라가는 유일한 구간이라 그때 가치가 가장 크다.
- Reference: Orca에 구현이 있다 — `orca-ref/src/shared/osc-title-extraction.ts`(전역 정규식 대신
  경계 있는 수동 파서, `MAX_OSC_TITLE_CHARS=1024`)와 `agent-title-status.ts`(제목 변화 →
  working/idle 전이 추적, 스피너 글리프 제거로 "종료했는데 계속 working" 방지). 다만 에이전트별
  제목 패턴이 제각각이라 표면적이 크다.
- Evidence: `AgentStatusResolver.ts`의 `SOURCE_RANK`에 `osc: 2` 자리가 있으나 이 소스로
  `applyObservedStatus`를 호출하는 코드가 없다 — `grep -rn "'osc'" src/`의 결과는
  `src/shared/types.ts`의 타입 선언과 주석 2줄뿐이다.

### `src/main/TerminalManager.ts` + `AgentStatusResolver.ts` — pane 단위 식별자가 없어 이벤트를 cwd로 추측한다
- Discovered: 2026-08-16, Orca 소스 대조 중
- Why deferred: 이미 배포·테스트된 경로를 바꾸는 설계 변경이고, 이번 요청은 참고 조사였다.
- Trigger: 같은 디렉토리에서 에이전트를 2개 이상 돌리는 사용 패턴이 늘어 상태가 안 잡힌다는
  제보가 나오면. 또는 권한 프롬프트를 앱에서 승인하는 기능(훅 **응답**이 필요)을 만들 때.
- Evidence: Orca는 pty에 `ORCA_AGENT_HOOK_PORT`/`ORCA_AGENT_HOOK_TOKEN`/`ORCA_PANE_KEY`를 주입하고
  훅 스크립트가 그 셋이 없으면 즉시 `exit 0` 한다(`orca-ref/src/main/*/hook-service.ts`). paneKey가
  요청에 실려 오므로 매칭 추측이 아예 없다. CLImanger도 `TerminalManager`가 모든 pty를 직접
  띄우므로 전제 조건은 이미 충족한다. 현재는 `AgentStatusResolver.findTerminal`이 cwd가 모호하면
  판정을 포기한다(`t9-agent-modules.spec.ts`의 "a genuinely ambiguous cwd is not guessed at").
- Owner: Human Review (설계 변경 승인 필요)

### `.env.release` — 배포 자격증명이 이 머신에만 있고 백업이 없다
- Discovered: 2026-08-18, 배포 자산 정리 중
- Why deferred: 어디에 백업할지(1Password / 다른 안전한 곳)는 소유자 결정이고, 이번 요청 범위 밖.
- Trigger: 머신 교체·재설치·디스크 장애 전에. 또는 다른 사람이 릴리즈를 돌려야 할 때.
- Evidence: `.env.release`(권한 600, gitignored)에 R2 키 4개가 있고 이 파일이 유일한 사본이다.
  잃으면 Cloudflare에서 키를 재발급해야 하며, 재발급 전까지 `post-release.cjs`가 preflight에서
  막힌다(`R2 credentials missing`).
- Owner: Human Review

### `scripts/sync-node-pty-prebuilds.cjs` — 새 클론·워크트리에서 앱 구동 테스트가 전부 죽는다
- Discovered: 2026-09-11, 워크트리에서 t12~t14를 붙이며
- Why deferred: 이번 범위(사용자 보고 4건) 밖이고, 고치는 방법이 두 갈래라 선택이 필요하다 —
  postinstall이 `electron-builder install-app-deps`를 직접 부르게 할지(설치가 매번 느려진다),
  아니면 SKIP을 경고로 올리고 문서로 안내할지.
- Trigger: 새 머신·새 워크트리에서 `pnpm test:term`을 돌려야 할 때. 또는 CI가 캐시 없이 도는 날.
- Evidence: `pnpm install --frozen-lockfile` 직후 Electron이 뜨자마자 죽는다 —
  `Cannot find module '../build/Debug/pty.node'` (node-pty가 Node ABI로 빌드돼 있다). postinstall은
  `[node-pty] SKIP: missing prebuilds dir .../prebuilds/darwin-arm64`만 남기고 성공으로 끝난다
  (node-pty@1.0.0에는 그 디렉토리가 아예 없다). 해결: `pnpm exec electron-builder install-app-deps`
  (electronVersion=39.8.10, arm64, 약 30초). 현재는 루트 `CLAUDE.md`의 실행 절차에만 적어뒀다.
- Owner: Maintainer

### `src/main/index.ts` — worktree sync가 심링크 경로를 다른 경로로 읽어 워크스페이스를 자기 자신의 워크트리로 등록한다
- Discovered: 2026-09-11, T12를 쓰다가 시딩한 워크스페이스가 이유 없이 하나 늘어서
- Why deferred: 제품 결함이지만 이번 보고 4건과 무관하고, 고치려면 `realpath` 도입이 기존 등록
  경로 비교 전반에 영향을 준다(이미 저장된 워크스페이스 경로도 같이 정규화해야 하는지 판단 필요).
- Trigger: 사용자가 심링크 아래(`/tmp`, 일부 홈 구성) 워크스페이스를 등록했을 때. 또는 워크트리
  목록에 "내가 만든 적 없는 워크트리"가 생겼다는 제보가 오면.
- Evidence: `syncWorktreeWorkspaces()`는 `path.resolve()`로만 비교하는데(`index.ts:440` 부근)
  `git worktree list --porcelain`은 realpath를 돌려준다. macOS에서 `/var/folders/...`(mkdtemp)로
  등록한 워크스페이스를 git이 `/private/var/folders/...`로 보고해 `item.path === parentResolvedPath`
  가 false가 되고, 그 부모 자신이 discovered 목록에 남아 새 워크트리 워크스페이스로 import된다.
  실측: 워크스페이스 3개를 시드했는데 `getWorkspaces()`가 4개를 돌려줬다(home 포함 시 4→5).
- Owner: Maintainer

### `src/main/TerminalManager.ts` — pty가 앱의 환경변수를 통째로 물려받아 에이전트 세션 마커까지 새어 들어간다
- Discovered: 2026-09-22, AI Control API를 실제 Claude Code로 검증하다가
- Why deferred: 이번 범위(AI Control API) 밖이고, 어떤 변수를 걸러야 하는지(CLAUDE_CODE_* 전체인지
  일부인지)는 Claude Code 쪽 의미를 확인해야 정할 수 있다. Finder에서 띄운 배포 앱에는 해당 변수가
  없으므로 일반 사용자는 영향이 없다.
- Trigger: 에이전트 세션 안에서 앱을 띄우는 개발·테스트 흐름(`pnpm dev`를 Claude Code 터미널에서
  실행, Playwright를 에이전트가 실행)에서 내부 Claude Code 세션이 이상하게 동작한다는 제보가 나오면.
- Evidence: Claude Code 세션이 실행한 Playwright → Electron → pty 안의 `claude`가
  `⚠ Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker`를 띄웠다.
  `createTerminal()`이 `env: { ...process.env, ... }`로 앱 환경을 그대로 넘긴다.
- Owner: Maintainer

### `src/main/ControlApiServer.ts` — MCP 없이 쓰려면 사용자가 curl 을 직접 조립해야 한다
- Discovered: 2026-09-23, Control API 를 스킬로 감싸면서
- Why deferred: 제품에 CLI 를 붙이려면 배포 형태(앱 번들 안의 bin? npx? Homebrew?)와 PATH
  등록 방식을 정해야 하고, 그건 이번 범위 밖이다. 지금은 REST 예제와 유지 관리자의 로컬
  스킬 스크립트(의존성 없는 Node 단일 파일)로 충분하다.
- Trigger: MCP 를 안 쓰는 사용자가 "명령줄에서 쓰고 싶다"고 하거나, 앱과 함께 배포할 CLI 가
  필요해질 때. 참고 구현: `~/skills/macbook-cc/climanager-session/scripts/clim.mjs`
  (발견 파일에서 url·token 을 읽고 REST 만 호출, 종료 코드로 질문 대기/회수/시간 초과 구분).
- Evidence: `docs/architecture/control-api.md`「MCP 없이 쓰기」의 curl 예제는 토큰을 발견
  파일에서 꺼내는 준비 과정을 매번 요구한다.
### `.github/workflows/ci.yml` — main CI가 2026-08-18 이후 한 번도 끝까지 가지 못했다
- Discovered: 2026-09-12, v1.8.0 배포 후 CI 결과를 확인하다가
- Why deferred: 원인이 macOS 러너에서의 테스트 소요 시간인지 특정 스펙의 행(hang)인지 가르려면
  CI 로그를 스펙 단위로 봐야 하고, 이번 범위 밖이다.
- Trigger: CI를 머지·릴리즈 판단 근거로 쓰기 전. 지금은 "CI 통과"라는 신호가 존재하지 않는다.
- Evidence: `timeout-minutes: 25`. run 34663545892(8ce09a1)의 verify 잡이 01:01:50 → 01:27:09에
  `Terminal + agent tests` 단계에서 cancelled. b15daa3·6ac2a85·94f17f4도 cancelled, 591ff51은 failure.
  로컬에서는 같은 스위트가 수 분(86건)에 끝난다. `concurrency: cancel-in-progress: true`도 있어
  연속 push 시 앞 실행이 취소되는 것과 타임아웃 취소가 목록에서 구분되지 않는다.
- Owner: Maintainer

### `scripts/release.cjs` — 프리플라이트 테스트가 간헐적으로 실패하는데 원인을 못 잡았다
- Discovered: 2026-09-23, v1.9.0 배포 중 두 번
- Why deferred: 실패가 재현되지 않았고(직접 돌린 전체 스위트는 87건 통과), 배포를 멈추고 추적할
  단계가 아니었다. 같은 날 게이트가 실패 내역을 남기도록 고쳤으니(5e3edff) 다음에 재현되면
  어느 스펙인지 바로 나온다.
- Trigger: 다음 릴리즈에서 또 실패하면 그때 남는 `/tmp/release-tests-*.log` 로 스펙을 특정한다.
- Evidence: `--check` 1회차와 `--build` 1회차가 `tests failed` 로 멈췄고, 사이에 돌린
  `pnpm test:term` 은 87 passed (3.7m). 세 번째 `--check` 도 87 passed.
- Owner: Maintainer

### `.github/workflows/ci.yml` — 설치 단계 403 은 지나갔고, 지금은 터미널 테스트 시간 초과로 취소된다
- Discovered: 2026-10-01, PR #16 의 CI 를 확인하다가
- Why deferred: 접근 규칙 변경과 무관하고, 위 "main CI 가 끝까지 가지 못했다" 항목과 원인이 같은지부터 갈라야 한다.
- Trigger: CI 를 머지 판단 근거로 쓰기 전
- Evidence: run 36729620173 의 verify 잡이 59초 만에 `Install dependencies` 에서 끝났다.
  `.../node_modules/@vscode/ripgrep postinstall: Failed` → `ELIFECYCLE Command failed with exit code 1`.
  스택이 HTTP 응답 처리(`ClientRequest`·`TLSSocket`)라 바이너리 다운로드 실패로 보인다(GitHub API 요청 한도 가능성 — 미확인).
  같은 날 main 의 실행도 failure 다.
  2026-09-30 PR #15 에서도 같은 단계 실패 — 로그상 응답이 **`Request failed: 403`**(재시도 5회). 열린 dependabot PR
  `bump @vscode/ripgrep from 1.17.0 to 1.18.0` 이 다운로드 경로를 바꿨는지 먼저 본다(미확인).
  **2026-10-01 갱신(PR #18·#19)**: 설치 단계는 **통과**했다(403 재현 안 됨 — 간헐적이었던 것으로 보인다).
  대신 위 "main CI 가 끝까지 가지 못했다" 항목과 같은 모양으로 끝난다: `loop-counter` 8건(Electron 없음)만 통과하고
  앱을 띄우는 T1·T4·T5·T6·T7 이 각 1~3분 시간 초과로 연속 ✘ → job 25분 제한에서 cancelled
  (run 36819460593·36819462264). main 의 run 36803562450(10-01 01:57)·36734434387(09-30)도 같은 단계·같은 순서로
  cancelled. 그래서 두 PR 은 근거 코멘트를 남기고 머지했고, 릴리즈는 로컬 `pnpm test:term` 전체를 게이트로 썼다.
  가설(미확인): 설치 로그에 node-pty 가 Node ABI 로 빌드된다(`SOLINK_MODULE(target) Release/pty.node`) — 로컬 새 워크트리에서
  `electron-builder install-app-deps` 없이 앱 구동 테스트가 전부 죽는 것과 같은 원인일 수 있다. CI 에 그 단계를 넣고 1회 돌려 가른다.
  덧붙여 앱이 안 뜨는 테스트가 3분씩 기다려 25분을 다 쓰므로, 첫 구동 실패에서 빨리 끝내는 장치가 있으면 원인이 로그에 바로 남는다.
  **2026-10-09 갱신(PR #26)**: 403 이 다시 났다 — run 37801999243 이 `Install dependencies` 에서
  `@vscode/ripgrep postinstall: Error: Request failed: 403`(재시도 반복)으로 실패, 그 뒤 단계는 전부 skipped.
- Owner: Maintainer

### 개선안 — 여러 AI 세션의 상태 변화를 한 번에 기다리는 `watch`
- Discovered: 2026-09-29, 저녁 매니저 세션이 세션 5~6개를 동시에 관리하며
- Why deferred: 이번엔 외부 스크립트(상태를 20초마다 폴링하고 busy→idle 전환만 알림)로 대신했다.
- Trigger: Control API 개선 작업 착수 시
- Evidence: `wait` 는 세션 하나만 기다린다. 여러 개를 폴링하면 (1) 감시를 다시 거는 사이에 끝난 세션을 놓쳤고
  (2) 백그라운드 셸을 기다리며 잠깐 쉬는 세션을 완료로 잘못 알렸다(화면의 `shell still running` 으로 구분).
  제안: `GET /v1/events` 또는 `POST /v1/wait-any` — busy→idle·질문 대기 전환을 이벤트로, 백그라운드 셸 대기는 제외.
- Owner: 없음

### `src/main/ControlApiService.ts` — 사용자와 AI 가 같은 세션에 동시에 입력하면 글자가 섞인다
- Discovered: 2026-09-30, Control API 가 모든 세션에 닿도록 바꾸면서
  ([`decisions/0006`](decisions/0006-control-api-reaches-every-session.md))
- Why deferred: 접근 규칙을 바꾸는 작업의 범위 밖이고, 막는 방식(사용자 타이핑 중 API 입력 거부 vs 대기열)이
  사람 결정이다.
- Trigger: AI 가 사용자 세션에 입력한 글자가 사용자 입력과 섞였다는 보고가 나올 때
- Evidence: `typeAndSubmit()` 은 화면에 질문이 있는지만 보고 `terminals.writeInput()` 을 부른다. 사용자 키 입력도 같은
  pty 로 바로 간다. 중재하는 코드가 없다.
- Owner: Human Review

### `src/main/ControlApiService.ts` — API 를 켠 채로 특정 세션만 AI 에게서 잠글 방법이 없다
- Discovered: 2026-09-30, 같은 작업
- Why deferred: 0006 에서 "켜져 있으면 전부 열림"으로 정했다. Disconnect AI 는 걸려 있던 `wait` 만 끊는다.
- Trigger: 사용자가 API 를 끄지 않고 세션 하나를 AI 로부터 지키고 싶다고 할 때
- Evidence: `connect()` 가 표시 없는 세션을 첫 접근에서 다시 표시한다. 0006 의 Reversal 에 설계(세션별 차단 +
  "Connect to AI")를 적어 뒀다.
- Owner: Human Review

### `src/main/index.ts` — 앱을 재시작하면 AI 세션의 돌던 작업과 화면이 사라진다
- Discovered: 2026-09-30, "노트북이 꺼지면 연결이 끊긴다"를 조사하며
- Why deferred: 이번 범위는 잠자기까지였다(잠자기는 `t20-control-api-sleep.spec.ts` 로 고정).
- Trigger: 재시작 후 AI 가 세션을 이어받아야 할 때
- Evidence: 재시작 후 `aiControl` 과 세션 id 는 남지만 pty 는 새로 뜨고 미러는 비어 있다. AI 는 빈 화면을 idle 로 읽을 수
  있다. 제안: 세션 응답에 "재시작됨" 표시, AI 세션은 `--resume` 으로 다시 띄우기. `clearAllCliSessionIds()`
  (`src/main/index.ts` 849행 부근)는 정의만 있고 호출처가 없어 대화 id 는 종료 때 지워지지 않는다.
- Update 2026-10-13: 화면은 이제 돌아온다 — 미러가 디스크 히스토리로 시작해서 AI 가 빈 화면 대신 복원본과 "Restored from previous session" 줄을 읽는다(0008). 돌던 작업이 멈추는 건 그대로다.
- Owner: 없음

### 개선안 — Control API 로 세션 메모 쓰기
- Discovered: 2026-09-29, API 응답에 `memo`(읽기 전용)를 추가하면서
- Why deferred: 쓰기는 AI 가 사용자가 적은 메모를 바꾸게 되는 일이라 허용 여부가 사람 결정이다.
- Trigger: AI 가 작업 인계 노트·진행 상황을 메모에 남기게 하고 싶을 때
- Evidence: 2026-10-26 fb-1026b(PR #62)로 메모가 여러 쪽이 됐다 — 1쪽 `memo`, 2쪽부터 `memoPages`. **읽기는 2026-10-27 day-1027(PR #67)에 넣었다** — API 세션 응답 `memoPages` 는 1쪽부터 모든 쪽(저장소 배열과 뜻이 다르다, `docs/architecture/control-api.md`). 남은 것은 쓰기뿐이다.
- 2026-10-27 사람 답: 「쓰기는 보류하고 싶어. 읽기 관련해서는 좋아.」 — 쓰기는 다시 물을 때까지 그대로 둔다.
- Evidence: 읽기는 `describe()` 가 `session.memo` 를 돌려준다. 쓰기 경로는 renderer IPC `update-session-memo`
  (`src/main/index.ts` 1385행 부근)뿐이다. 열 때 고를 것: 덮어쓰기 vs 덧붙이기, 사용자가 메모를 편집 중일 때의 충돌,
  `aiControl` 세션만 허용(기존 경계 유지).
- Owner: Human Review

### `src/renderer/src/utils/terminalResizeManager.ts` — 보이는 터미널의 창 크기 변경이 PTY resize 를 두 번 보낸다
- Discovered: 2026-10-23 day-1023, 터미널 표 잘림(f77530f2 · 982d348d) 원인 추적.
- Evidence: 창 크기를 바꾸면 rows 는 즉시, cols 는 100ms 뒤에 따로 PTY 로 간다 → Claude Code 가 두 번 다시 그리고, 다시 그릴 때마다 화면 줄만 지우고 새로 써서 스크롤백에 경계가 두 번 생길 수 있다(Claude 의 다시 그리기 방식은 `docs/integrations/CLAUDE.md`, PR #47).
- Why deferred: 이번 수정(PR #47)은 숨긴 터미널의 첫 크기를 맞춘 것이고, 보이는 터미널의 resize 묶기는 별개 동작 변경이다.
- Trigger: 창 크기·분할 크기를 바꾼 뒤 Claude 표가 잘리거나 겹친다는 제보가 다시 올 때.
- Fix direction: rows·cols 를 한 번의 PTY resize 로 묶는다. 묶은 뒤 T4(리사이즈 폭풍)·T38(스트리밍 중 리사이즈)·T41 을 돌린다.
- Owner: 없음

### 렌더러·미러 공용 — 높이만 바뀌는 resize 를 「화면 아래 기준」으로 맞출지 (모듈화 사람 컨펌)
- Discovered: 2026-10-23 day-1023, 982d348d 재현. 시제품 `~/Downloads/_batches/day-1023/review/climanager/terminal/evidence/anchor-replay.cjs`.
- Evidence: 실제 Claude 녹화 재생에서 높이만 바뀐 resize 3건이 xterm 기본 동작으로는 답 첫 줄 사라짐·배너 중복을 냈고, 「화면 아래 기준」으로 맞추면 0건이었다(폭+높이 표 이상 1→0, resize 없는 녹화는 동일).
- Why deferred: 렌더러(`TerminalView.tsx`)와 main 미러(`TerminalMirror.ts`)가 같은 로직을 써야 해서 `src/shared` 새 파일이 필요하다 — 새 공용 모듈은 사람 컨펌 뒤에 만든다.
- Trigger: 사람이 공용 모듈을 승인할 때(day-1023 팀장 보고 「정할 것」).
- Fix direction: `src/shared` 에 resize 보정 함수 하나 + 두 곳에서 import. T29·T38·T41 과 함께 녹화 재생 시험을 붙인다.
- Owner: Human Review

### 숨긴 세션의 시작 크기 — PR #47 뒤에 남은 것 (위 「높이만 바뀌는 resize」와 한 묶음)
- Discovered: 2026-10-23 day-1023, PR #47 총괄 독립 리뷰.
- Evidence: #47 은 숨긴 채 만든 세션도 상자 크기로 PTY 를 띄운다. 그래도 남는 경우가 셋이다.
  ① 숨긴 세션은 **보이기 전에 잰 크기**를 그대로 쓴다 — 앱 시작 중 사이드바·글꼴 로딩으로 상자가 최종 크기와 다르거나, 숨긴 동안 창 크기를 바꾸면 처음 볼 때 resize 가 한 번 일어난다(옛 코드보다 확률은 낮다).
  ② 분할 화면에서 숨긴 세션은 **전체 폭**으로 재서 시작하고, 칸에 처음 보일 때 resize 된다(옛 코드와 같음).
  ③ 시험 공백: T41 은 20×5 가드(`MIN_HIDDEN_FIT_COLS`·`MIN_HIDDEN_FIT_ROWS`) · 분할 칸 · 이미 살아 있는 PTY 에 다시 붙는 경로(`existed: true`) · 실제 Claude 를 덮지 않는다.
- Why deferred: #47 이 가장 흔한 원인(80×30 시작)을 없앴고, 남은 셋은 처음 볼 때 resize 를 0 으로 만드는 일이라 위 「높이만 바뀌는 resize」 보정(공용 모듈, 사람 컨펌)과 같이 풀어야 덜 겹친다.
- Trigger: 사람이 높이 보정 공용 모듈을 승인할 때, 또는 #47 뒤에도 재시작·분할 화면에서 표 잘림 제보가 올 때.
- Fix direction: 보이기 직전에 한 번 더 재서 다르면 그때 PTY 를 맞추고(보이기 전이라 잔해가 화면에 안 남음), 분할 칸은 칸 상자로 잰다. T41 에 가드·분할·`existed` 경우를 더하고, 실제 Claude 녹화 재생을 고정 입력으로 쓴다.
- Owner: Human Review

### `tests/terminal/helpers.ts` — `closeApp` 이 닫기 실패를 삼키고 시험 앱을 남긴다
- Discovered: 2026-10-23 day-1023, 렌더링 묶음 실행 중 T1 시험 앱이 CPU 100% 로 7분 남아 playwright 가 멈췄다(재현 안 됨, `kill -9` 로 정리).
- Evidence: `closeApp()` 은 `app.close()` 의 예외를 무시하고 userData 만 지운다 — 프로세스가 살아 있는지 보지 않는다.
- Why deferred: 재현이 안 됐고 시험 하네스 변경이다.
- Trigger: 시험 묶음이 끝나지 않거나 남은 Electron 프로세스가 다시 보일 때.
- Fix direction: 닫기 실패·시간 초과 때 `app.process()` 의 pid 를 죽이고, 남은 프로세스를 로그로 남긴다.
- Owner: 없음

### `tests/terminal/helpers.ts` — 첫 시드 작업 영역이 닫힌 폴더 안이면 앱 구동이 30초 시간 초과
- Discovered: 2026-10-23 day-1023, T45 를 쓰다가(4건 시간 초과).
- Evidence: `launchAppWithWorkspaces` 가 첫 작업 영역 이름이 보일 때까지 기다리는데, 닫힌 폴더 안이면 이름이 안 그려진다. 시드 순서를 바꿔 피했다(T45 주석). 워크트리 시드를 저장소 루트 경로로 주면 시작 때 워크트리 스캔이 지운다는 것도 같은 날 나왔다(T13 패턴).
- Why deferred: 피하는 길이 있고 하네스 변경이다.
- Trigger: 폴더를 닫은 상태를 시드하는 시험을 또 쓸 때.
- Fix direction: 「사이드바가 그려졌다」를 첫 이름 대신 사이드바 루트 요소로 기다린다.
- Owner: 없음

### `scripts/mock-cli/record-claude.cjs` — 녹화 Claude 가 폴더 신뢰 질문에서 꺼지고, 부른 세션에 훅이 붙을 수 있다
- Discovered: 2026-10-23 day-1023, 터미널 잘림 녹화.
- Evidence: cwd 가 HOME 이라 신뢰 질문이 뜨고 기본 선택 「No, exit」로 바로 끝난다. 또 `CLIMANAGER_SESSION_ID` 를 물려받아 녹화 Claude 의 훅이 부른 앱 세션에 붙을 수 있다. 둘 다 처리한 녹화기: `~/Downloads/_batches/day-1023/review/climanager/terminal/evidence/record.cjs`.
- Why deferred: 녹화는 그 날 scratch 녹화기로 했다.
- Trigger: 다음에 실제 CLI 를 녹화할 때.
- Fix direction: 임시 폴더를 cwd 로 쓰고(신뢰는 그 폴더에서 Yes), 자식 환경에서 `CLIMANAGER_SESSION_ID` 를 지운다.
- Owner: 없음

### 링크 허용 규칙이 두 곳에 있다 — 터미널 `ALLOWED_LINK_PROTOCOLS` 와 메모의 http(s) 정규식 (모듈화 사람 컨펌)
- Discovered: 2026-10-23 day-1023, 메모 링크(PR #45).
- Evidence: `src/renderer/src/components/TerminalView.tsx:66` 의 `ALLOWED_LINK_PROTOCOLS` 는 컴포넌트 안에 있어 메모가 못 쓰고, `SessionMemo.tsx` 는 http(s)만 따로 고른다(터미널 허용의 부분집합이라 지금은 안전).
  - 2026-10-24 night-1023: 터미널 판정은 PR #50 이 `src/renderer/src/utils/terminalLinks.ts`(기본 허용 + Settings 의 앱 스킴 · 예약 스킴)로 옮겼다. **트리거가 걸렸다** — 인박스(PR #54)가 링크를 여는 세 번째 곳이다. 렌더러는 `terminalLinks.ts` 를 그대로 쓰지만, API(main) 쪽 예약 스킴 5개(`javascript`·`data`·`vbscript`·`blob`·`about`)는 그 파일의 `RESERVED_SCHEMES` 와 같은 내용을 따로 들고 있다. 메모는 여전히 http(s) 정규식.
- Why deferred: 공용으로 빼면 새 공용 모듈이다 — 사람 컨펌 뒤에 한다(night-1023 팀장 보고 「정할 것」에 올림).
- Trigger: 링크를 여는 곳이 세 번째로 생기거나, 허용 규칙을 바꿀 때. — **걸림(인박스)**. 지금은 사람 컨펌 대기.
- Fix direction: `utils/` 에 허용 판정 함수 하나를 두고 터미널·메모가 같이 쓴다.
- Owner: Human Review

### 분할 화면 칸 헤더에는 ‹ › 와 상위 세션 바로가기가 없다
- Discovered: 2026-10-23 day-1023, PR #46(38121cd5 · 1ae4d3c8).
- Evidence: 단일 화면 헤더(`App.tsx`)에만 넣었다. `SplitTerminalHeader.tsx` 는 칸이 좁아 Related 버튼만 있다.
- Why deferred: 제보는 단일 화면 헤더를 가리켰고, 분할 칸은 공간이 없다.
- Trigger: 분할 화면에서도 쓰고 싶다는 제보가 올 때.
- Fix direction: 칸 헤더에는 아이콘만(↰) 넣고, ‹ › 는 활성 칸 기준으로 단일 헤더 자리에 둔다.
- Owner: 없음

### `src/main/screenLines.ts` — Related 줄의 recap 은 Claude Code 의 `※ recap:` 표기에 기댄다
- Discovered: 2026-10-23 day-1023, PR #46(9f4f923e).
- Evidence: `recapOf()` 는 `※ recap:` 로 시작하는 줄 + 들여쓴 이어짐 줄을 읽고 「(disable recaps in /config)」를 뗀다. 형식은 이 맥의 스크롤백 스냅샷에서 확인했고 시험(T34·T50)은 그 모양을 흉내 낸 가짜 화면이다 — 실제 Claude 로 돌린 시험은 없다.
- Why deferred: 지금 형식으로는 맞는다.
- Trigger: Claude Code 업데이트 뒤 Related 줄이 비거나 recap 이 안 보인다는 제보가 올 때.
- Fix direction: 실제 Claude 녹화(`scripts/mock-cli/record-claude.cjs`)에서 recap 줄을 뽑아 T34 고정 입력으로 쓴다.
- Owner: 없음

### `scripts/post-release.cjs` — 링크 커밋을 웹사이트 **주 체크아웃**(`~/Downloads/solhun-web-page`)에 만든다
- Discovered: 2026-10-01, v1.11.0 배포 중(뒤처짐 부분은 2026-10-24 night-1023 preflight 검사로 닫음 — `checkWebsiteUpToDate`).
- Why deferred: 지금은 preflight 가 「깨끗함 · main · origin 과 같음」을 먼저 확인하므로 커밋은 안전하게 들어간다.
- Trigger: 웹사이트 저장소를 다른 세션이 동시에 만지는 날, 또는 주 체크아웃을 main 그대로 두는 규칙을 이 스크립트에도 맞출 때.
- Evidence: `SITE_DIR = ~/Downloads/solhun-web-page` 에서 `git add`·`commit`·`push origin main` 을 한다 — 주 체크아웃은 main 그대로 두고 커밋하지 않는 운영 규칙과 충돌(2026-09-30 확인).
- Fix direction: 임시 워크트리(`git worktree add … origin/main`)에서 링크를 고치고 커밋·push 한 뒤 워크트리를 지운다.
- Owner: Maintainer

### 사이드바로 세션을 닫을 때 Related 짝을 넘길 길이 없다(API 는 1.21 `handTo` 로 된다)
- Discovered: 2026-10-26, 사람 질문 「새 총괄을 만들 때를 대비해 Related 를 옮기는 게 있나」에 답하다가.
- 2026-10-27 day-1027(PR #67): `SessionRelations.inherit(from, to)` + `DELETE /v1/sessions/:id?handTo=<id>` + MCP `close_session` 의 `hand_to` + 스킬 `clim close <옛> --hand-to <새>`(스킬은 1.21.0 공개 뒤 원본에 반영). 자기 자신 · 이미 있는 짝 · 사람이 뺀 짝은 건너뛴다. 총괄 교대는 이것으로 된다.
- 남은 것: 사람이 사이드바에서 닫을 때(`forgetSession`)는 여전히 짝이 전부 사라진다 — 화면에서 「넘기기」 대상을 고르는 흐름이 없다(day-1027 범위 밖으로 정함).
- Why deferred: 사람 결정(2026-10-27 지시문 「화면의 「넘기기」 고르기는 범위 밖」).
- Trigger: 사람이 손으로 닫은 세션의 Related 가 사라졌다는 말이 나올 때.
- Fix direction: 닫기 확인 상자(또는 Related 창)에 「Hand relations to…」 세션 고르기 → 같은 `inherit`. 반나절.
- Owner: 없음

## Blocked

없음.
