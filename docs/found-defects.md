---
description: When touching an area that misbehaves, or when triaging a report against known-wrong behavior
authority: Defects observed in this repository and deliberately not fixed yet
status: active
owner: maintainer
last-reviewed: 2026-08-18
---

# Found Defects

Things that are **wrong now** and were consciously not fixed in the change that found them.
Postponed *improvements* go to [`backlog.md`](backlog.md) instead — the split matters because these
two are read at different moments.

Remove an entry in the same change that resolves it, and move its lasting part somewhere that
prevents recurrence (a test, a rule, a decision record) before deleting.

| Mark | Meaning |
|---|---|
| 🐛 | Behaves incorrectly now |
| 🧩 | A shared contract cannot express what a caller needs, so the caller worked around it |
| ❓ | Correct behavior was never decided |

---

### 🐛 `tests/terminal/t1-data-loss.spec.ts` — 부하가 높으면 「끝났다」를 입력한 명령 줄에서 읽고 일찍 센다
- Date: 2026-11-10
- Where: `waitForBufferText(…, 'SEQ-DONE-…')`(`tests/terminal/helpers.ts`)는 마지막 80줄에 그 글이 있으면 끝으로 본다. 입력한 명령 `seq 1 300000; echo SEQ-DONE-…` 자체에도 그 글이 있다.
- What: v1.31.0 빌드 전체 실행(부하 평균 21~32)에서 실패. 단독으로 다시 돌린 6터미널 시험도 부하 29~45 에서 두 번 다 `sess-t1-1 should reach 300000`(받은 값 161139 · 140599). 단독 1터미널은 30815 로 한 번 실패한 뒤 다음엔 통과. 6.8~10초 만에 끝나 `seq` 가 다 찍히기 전에 셌다. v1.30.0 이후 터미널 출력 경로 코드는 바뀌지 않았다.
- Surfaced by: `node scripts/release.cjs --version 1.31.0 --build`. 그 릴리즈는 `--skip-tests` 로 나갔다(T22·T26·T35 는 단독 재실행에서 통과).
- Impact: 시험의 헛실패로 보인다. 제품의 출력 유실과 구분이 안 돼, 머신이 바쁠 때 전체 스위트가 빨갛게 된다.
- Workaround: 부하가 낮을 때 그 스펙만 다시 돌린다.
- Fix direction: 끝 표지를 명령 줄에 안 나오는 글로 만든다(예: `echo SEQ-DONE-$((1+1))` → 화면엔 `SEQ-DONE-2`). 그 뒤 부하 속에서 다시 재서 진짜 유실인지 가른다.

### 🐛 `tests/terminal/t78-phone-quality.spec.ts` — 전체 스위트에서 가끔 재연결 뒤 「typed while away」가 Mac 터미널에 안 닿는다
- Date: 2026-11-10
- Where: T78 재연결 단계(298–303줄) — 폰 서버를 껐다 켠 뒤 입력칸 글을 보내고 `waitForBufferText(…, 'typed while away', 15_000)` 로 기다린다.
- What: v1.30.0 릴리즈 빌드의 두 번째 전체 실행에서 1450 통과 · 이 1건 실패. 같은 코드로 첫 전체 실행은 통과했고, 따로 3번 돌려 3번 다 통과했다.
- Surfaced by: `node scripts/release.cjs --version 1.30.0 --build` 의 전체 시험. 그 릴리즈는 `--build --skip-tests` 로 나갔다(타입 검사는 돌았다).
- Impact: 제품 결함인지 시험 시간 문제인지 아직 모른다. 원인은 재 보지 않았다. 전체 스위트가 부하 속에서 다시 빨갛게 될 수 있다.
- Workaround: 그 스펙만 다시 돌린다(`pnpm test:term t78`).
- Fix direction: 실패할 때 폰 소켓이 다시 붙었는지(「Reconnecting…」이 사라졌는지)와 보내기 응답을 함께 남기게 해서, 다음 실패에서 원인을 가른다.

### 🐛 저장된 명령이 에이전트 이름이 아니면 재시작 때 맨 `claude`·`codex` 로 친다
- Date: 2026-11-08
- Where: `src/shared/agentCommand.ts` `decideAgentCommand` 의 `fallback` 이 `inputCommand: agent` 를 준다. 저장값은 `storedCommand` 로 남는다. 재시작 입력은 `src/main/index.ts` · `src/renderer/src/utils/resumeCommand.ts`.
- What: `node /x/mock.cjs` 로 저장된 세션을 재시작하자 `claude --resume <id>` 가 입력됐다. `origin/main` 은 저장값을 그대로 쳤다. `ccr code`·`npx …` 처럼 감싼 명령도 같은 길을 탈 것이다(코드 근거, 그 명령들로 재지는 않았다).
- Surfaced by: 합친 판 실기기 시험(`feat/phone-1107`). `tests/terminal/helpers.ts` 가 모의를 `claude` 이름으로 감싸서 스위트에는 안 잡힌다.
- Impact: 감싼 명령을 쓰는 사람은 재시작에서 그 명령을 잃고 맨 CLI 가 뜬다.
- Workaround: 터미널에서 감싼 명령으로 직접 resume 한다.
- Fix direction: D4 N2 의 계약(모르는 명령을 다시 치지 않음)과 맞물려 사람이 정한다. 맨 CLI 로 칠지, 저장값을 칠지, 치지 않고 안내할지.

### 🐛 Claude 로그인 메뉴가 떠 있어도 Chat 전송이 「Sent」로 끝난다
- Date: 2026-11-08
- Where: `AWAITING_INPUT_PATTERNS`(`src/main/TerminalMirror.ts` 쪽 판정) · `ConversationService` 보내기 확인. 격리 Claude 2.1.319 의 `Select login method` 메뉴.
- What: 그 메뉴에 문서 코멘트 120자를 보냈는데 시트는 `Sent to …` 를 보이고 대화 기록은 0건이었다. `phone-input` 은 1건 남았고 메뉴는 그대로였다.
- Surfaced by: 합친 판 실기기 시험(위 결함으로 실제 CLI 가 뜬 세션).
- Impact: 로그인 전 세션에서만 생긴다. 보낸 글이 사라지는데 성공으로 보인다.
- Workaround: 터미널에서 로그인한 뒤 다시 보낸다.
- Fix direction: 이 메뉴를 질문 대기로 읽거나, 보낸 뒤 기록에 글이 들어왔는지로 판정한다.

### 🐛 모드 칩 — shift+tab 으로 기본 모드로 돌려도 다음 프롬프트까지 옛 칩이 남는다
- Date: 2026-11-07
- Where: `src/main/ConversationService.ts:241` · `src/main/screenLines.ts` `screenAgentMode`. 화면의 모드 줄을 먼저 보고, 없으면(`null`) 기록의 `permissionMode` 로 돌아간다. 기본 모드는 화면에 모드 줄이 없어 `null` 이다.
- What: `bypass` 에서 shift+tab 으로 기본 모드로 돌리면 화면에는 모드 줄이 없는데 칩은 마지막 프롬프트의 `bypass` 를 계속 보인다. 코드를 읽어 찾았다. 실제 Claude 에서 재현하지는 않았다.
- Surfaced by: fb-1106 기획 세션의 diff 리뷰(v1.27.0 머지 전).
- Impact: 다음 프롬프트를 보낼 때까지 칩의 모드가 실제와 다르다. 권한 동작 자체는 바뀌지 않고 표시만 틀리다.
- Workaround: 프롬프트를 하나 보내면 맞아진다.
- Fix direction: 입력 상자가 보이는데 모드 줄이 없으면 「기본 모드」로 읽는다(화면을 못 읽은 경우와 구분). `screenAgentMode` 가 두 경우를 나눠 돌려주게 한다.

### 🐛 폰 ⚙ 메뉴 — 열린 채 다른 세션 알림이 오면 띠가 메뉴 첫 줄을 덮는다
- Date: 2026-11-07
- Where: `src/renderer/src/phone/phone.css` `.phone-droplet`(알림 띠) · `.phone-menu`.
- What: 폰 ⚙ 메뉴가 열려 있을 때 다른 세션 알림 띠가 뜨면 메뉴 첫 줄(`Return sends the message`)을 가린다. 캡처 `t96-phone-settings-390-after.png`(리뷰 폴더 `~/Downloads/_batches/fb-1106/review/CLImanger/`).
- Surfaced by: fb-1106 기획 세션의 화면 리뷰. v1.27.0 변경 때문인지는 확인하지 않았다.
- Impact: 알림 띠가 사라질 때까지 메뉴 첫 줄을 못 누른다.
- Workaround: 띠가 사라지기를 기다리거나, ⚙ 의 「알림 표시」를 끈다.
- Fix direction: 메뉴가 열려 있는 동안 띠를 미루거나 메뉴 아래로 내린다. 다른 시트(서랍·설정)와 같은 규칙으로 정한다.

### 🐛 Chat 보내기 버튼 — 글을 써도 파란 배경이 안 나온다
- Date: 2026-11-06
- Where: `src/renderer/src/components/ChatView/chat.css` `.chat-composer-send { background: #2563eb }`. Tailwind 리셋의 `[type="button"] { background-color: transparent }` 이 클래스 하나와 무게가 같고 더 뒤에 와서 이긴다.
- What: 입력칸에 글이 있을 때 보내기 버튼의 계산된 배경이 `rgba(0, 0, 0, 0)` 이다(앱에서 `getComputedStyle` 로 쟀다). 의도한 파랑이 한 번도 안 나온 것으로 보인다. 클래스 하나로 배경을 주는 다른 `<button type="button">`(`.chat-busy-draft-button` 등)도 같은 조건이다 — 그쪽은 재지 않았다.
- Surfaced by: fb-1106 「내 마지막 말」 띠의 배경이 투명하게 나와 원인을 찾다가. 그 띠는 `button.chat-pinned-last` 로 고쳤다.
- Impact: 보낼 수 있는 상태인지 색으로 안 갈린다. 동작은 정상이다.
- Workaround: 없음. 화살표 색으로 구분된다.
- Fix direction: 지금 화면에 익숙해졌을 수 있어 바로 바꾸지 않았다. 파랑을 원하면 선택자 무게만 올린다(`button.chat-composer-send`). 같은 조건의 버튼을 함께 재서 고친다.

---

### 🐛 메인 헤더 — 창 폭 390 · 사이드바 닫힘에서 「Related」 글자가 ‹ › 버튼과 겹친다
- Date: 2026-10-30
- Where: `App.tsx` 메인 헤더 — 왼쪽 묶음(사이드바 열기 · `SessionHistoryButtons` ‹ › · 브레드크럼)과 오른쪽 묶음(`ParentSessionButton` ·
  `RelatedSessionsButton` · 검색 …). 오른쪽 묶음은 `shrink-0` 이라 줄지 않는다.
- What: 390 폭에서 오른쪽 버튼 줄이 왼쪽 칸까지 밀고 들어와, 「Related」 글자 위에 ‹ › 가 겹쳐 「Rela‹ted ›」로 보였다.
- Surfaced by: 세션 작업 리스트 1차(브랜치 `feat/session-tasks-1030`, 방향이 바뀌어 머지 안 함) T71 의 390 캡처 — 그 변경은 헤더를 건드리지 않았다. 체크리스트 2차가 헤더에 칩을 넣으면 더 빠듯해진다.
- Impact: 좁은 창에서만. 버튼은 눌리지만 무엇을 누르는지 읽기 어렵다.
- Workaround: 창을 넓힌다.
- Fix direction: 좁을 때 Related 는 아이콘만(이미 분할 칸 헤더의 `compact`), 또는 왼쪽 묶음에 `overflow-hidden`.
- 재발(2026-11-05 fb-1105, v1.24.0 = `origin/main`): 같은 390·사이드바 닫힘에서 이번엔 **체크리스트 칩의 「0/1」 위에 인박스 종**이 겹쳐
  「0/1🔔」로 보였다. 고치기 전 코드와 고친 코드 캡처가 같아 그 회차 변경(헤더 칩이 프로젝트를 따라감)과는 무관하다.
  캡처 `~/Downloads/_batches/fb-1105/review/solhun-web-page/before-follow/header-follow-other-390.png`. 칩이 들어오며 위 「더 빠듯해진다」가 실제가 됐다 —
  고칠 때 Related 와 칩·종을 한 번에 본다.

---

### 🐛 `src/main/index.ts` — 업데이트 확인이 「버전이 다르면 업데이트」라 더 낮은 버전도 권한다
- Date: 2026-10-21
- Where: `src/main/index.ts` 의 `check-for-update` 핸들러 — `if (latestVersion && latestVersion !== currentVersion)` 이면
  `hasUpdate: true`. 받는 쪽은 `App.tsx` 의 주기 확인(토스트)과 `Settings.tsx` 의 수동 확인.
- What: 크기 비교가 아니라 같은지만 본다. 게시 전 v1.14.2 설치본을 띄우자 왼쪽 아래에 「Update Available v1.14.1」이 떴다 —
  지금 버전보다 낮은 GitHub 최신 릴리즈를 업데이트로 권한 것이다.
- Surfaced by: v1.14.2 릴리즈 중 설치본에서 세션 링크를 캡처하다가.
- Impact: 평소 사용자에겐 안 보인다(게시 뒤엔 최신 = 지금 버전). 릴리즈를 내려 최신이 한 단계 낮아졌을 때와, 게시 전 빌드를 돌릴 때
  다운그레이드를 권한다. 「Download」를 누르면 무엇이 되는지는 확인하지 않았다(`autoUpdater.allowDowngrade` 는 설정하지 않음).
- Workaround: 「Later」.
- Fix direction: semver 로 `latest > current` 일 때만 `hasUpdate`. electron-updater 의 `update-available` 이벤트는 이미 크기를 비교하니
  그 결과(`result.isUpdateAvailable` 등)를 그대로 쓰는 쪽이 간단하다.

---

### 🐛 `Settings.tsx` — Theme 을 Light 로 바꿔도 화면이 그대로 어둡다
- Date: 2026-10-09
- Where: `src/renderer/src/components/Settings.tsx` 의 Theme 선택(`settings.theme`) ↔
  `src/renderer/src/assets/index.css` 의 `:root.light` / `.light …` 규칙
- What: `light` 클래스를 `<html>` 에 붙이는 코드가 renderer 어디에도 없다(`classList` grep 0건). 설정값은 저장되지만
  CSS 의 라이트 규칙은 한 번도 적용되지 않는다. `theme: 'light'` 로 띄운 캡처가 다크와 눈으로 구분되지 않았다.
- Surfaced by: 사이드바 검색·복사 알림의 라이트 테마 캡처를 찍다가.
- Impact: 사용자 — 설정 화면에 고를 수 있는 옵션이 있는데 아무 일도 안 한다.
- Workaround: 없음(다크만 쓴다).
- Fix direction: 연결하기 전에 라이트 규칙이 지금 화면을 감당하는지부터 본다 — 새 컴포넌트들이 쓰는 `text-gray-200`·
  `bg-white/5` 등은 `.light` 오버라이드가 없다. 지원할 게 아니면 옵션을 지우는 쪽이 정직하다.

---

### 🐛 `App.tsx` — Control API 로 세션을 닫으면 그 탭이 보이던 화면이 빈 화면이 된다
- Date: 2026-10-03
- Where: `src/renderer/src/App.tsx` 의 `onSessionEvent` `case 'closed'` —
  `setActiveSession(prev => (prev?.id === event.sessionId ? null : prev))`
- What: 사이드바 삭제·Cmd+W 는 이제 위(없으면 아래) 탭으로 넘어가지만(T26), API 가 닫은 세션은
  여전히 `null` 로 떨어진다. 분할 화면에 있던 세션이면 `splitLayout` 에서도 빠지지 않아 빈 칸이 남는다.
  코드로만 확인했고 재현은 안 했다.
- Surfaced by: 탭 이동·삭제 일관성 수정(T26) 중 같은 상태를 바꾸는 다른 경로를 훑다가.
- Impact: 사용자 — AI 가 사용자가 보고 있던 세션을 닫으면 화면이 비고, 다음 Cmd+] 는 첫 탭으로 간다.
- Workaround: 사이드바에서 탭을 다시 클릭.
- Fix direction: 이 리스너는 `[]` 의존성이라 최신 `sortedWorkspaces` 를 못 본다. ref 로 최신 순서를
  들고 `neighborSession()`(`utils/sessionNavigation.ts`)을 쓰고, 분할 칸 정리도 같이 한다.

---

### 🐛 `tests/terminal/` — 두 테스트가 gitignore된 fixture에 의존해 새 클론에서 실패한다
- Date: 2026-08-16
- Where: `t2-scroll-bounce.spec.ts:267`, `t3-history-preservation.spec.ts:106` — 둘 다
  `scripts/mock-cli/recordings/claude.jsonl`을 참조. 그 경로는 `.gitignore:13`으로 제외돼 있고
  `git ls-files scripts/mock-cli/recordings`는 0건이다.
- What: 저장소를 새로 클론하면 녹화 파일이 없다. `replay.cjs`가 없는 파일을 재생하려다 아무것도
  출력하지 않고, 테스트는 `REPLAY-COMPLETE`를 기다리다 **96초 타임아웃**으로 실패한다. 실패
  메시지는 "timeout waiting for REPLAY-COMPLETE"뿐이라 원인이 fixture 부재라는 단서가 없다.
  조용히 통과하지는 않는다(그건 확인함) — 하지만 원인 파악에 드는 시간이 문제다.
- Surfaced by: 저장소 ops 부트스트랩 중 `scripts/CLAUDE.md`를 쓰면서 "recordings는 커밋되어
  있다"고 적었다가 실측(`git ls-files`)에서 아님을 확인. 이어서 파일을 잠시 옮기고 t3를 돌려
  실제 실패 양상을 확인했다.
- Impact: 개발 — 새 기여자와 CI가 33개 중 2개를 돌릴 수 없다. 그 2개는 실제 CLI 바이트 스트림
  회귀(스크롤 튐·히스토리 유실)를 잡는 유일한 테스트라 커버리지 손실이 크다.
- Workaround: `scripts/mock-cli/record-claude.cjs`로 직접 녹화 (실 API 토큰 소모).
- Decision: 미정 — 선택지가 셋이고 성격이 다르다. (a) 녹화본을 커밋 (저장소 크기·라이선스 판단
  필요), (b) fixture 없으면 `test.skip`으로 건너뛰기 (커버리지 구멍이 조용해짐 — 위험), (c) 작은
  합성 fixture를 만들어 커밋 (실제 CLI 바이트가 아니라 회귀 검출력이 떨어짐). 저장소 소유자
  결정이 필요해 구조 정리 커밋에 섞지 않았다.


---
