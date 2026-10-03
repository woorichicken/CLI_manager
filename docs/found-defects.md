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
