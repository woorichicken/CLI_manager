---
description: When picking up deferred work, or when parking something found mid-task
authority: Work observed in this repository and consciously not done yet
status: active
owner: maintainer
last-reviewed: 2026-08-16
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

## Blocked

없음.
