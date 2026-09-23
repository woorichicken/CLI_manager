---
description: When picking up deferred work, or when parking something found mid-task
authority: Work observed in this repository and consciously not done yet
status: active
owner: maintainer
last-reviewed: 2026-08-18
---

# Backlog

Work that was **seen in this repository**, with evidence, and deliberately left undone. Not a
roadmap and not a wishlist: every entry names a path and a trigger that makes it actionable.

Any session may append to `## Open` without running a curation skill — the session that found the
problem is the one holding the evidence. Appending sessions do not reorder or remove other entries.

Remove an entry in the same change that resolves it. If resolving it produced a durable rule, that
rule goes to [`decisions/`](decisions/) or a scoped `CLAUDE.md`, never back into this file.

## Open

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
- Owner: Maintainer

## Blocked

없음.
