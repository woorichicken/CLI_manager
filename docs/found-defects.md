---
description: When touching an area that misbehaves, or when triaging a report against known-wrong behavior
authority: Defects observed in this repository and deliberately not fixed yet
status: active
owner: maintainer
last-reviewed: 2026-08-16
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

### 🐛 `src/renderer/src/App.tsx` — 업데이트 확인이 시작 시 1회뿐이라 계속 켜두면 영영 모른다
- Date: 2026-08-16
- Where: `App.tsx:262` 부근 `setTimeout(checkUpdate, 2000)`, `src/main/index.ts:878`
  `autoUpdater.checkForUpdatesAndNotify()`. 둘 다 앱 기동 시 1회만 실행되고
  재확인 타이머가 없다(`grep -n "setInterval" src/main/index.ts src/renderer/src/App.tsx`에
  업데이트 관련 항목 없음).
- What: CLI Manager는 터미널 세션을 유지하는 게 목적이라 몇 주씩 안 끄고 쓰는 앱이다. 그 사용
  패턴에서는 "시작 시 1회 확인"이 사실상 "확인 안 함"이 된다. 실제로 v1.6.0이 2026-06-23에
  나왔는데 설치본은 2개월 가까이 1.5.1에 머물러 있었다.
- Surfaced by: "1.6.0 업데이트가 안 된다"는 제보를 조사하다가. 설치본을 격리 userData로 직접
  띄워 로그를 읽은 결과 업데이트 체인은 **전부 정상**이었다 — `Update available: 1.6.0`을 찾고,
  매니페스트도 받아오고, 1.6.0 빌드도 설치본과 **같은 팀 ID(65FBP4FBDV)로 서명 + 공증**돼 있다.
  못 본 이유는 재확인이 없어서다.
- Impact: 사용자 — 릴리즈가 나가도 도달하지 않는다. 오픈소스로 배포 중이라 보안 수정을 내보내도
  같은 문제가 생긴다.
- Workaround: 앱을 완전 종료 후 재실행하면 2초 뒤 좌하단에 알림이 뜬다.
- Decision: 미정 — 주기 확인(예: 6시간)만 넣을지, 창 포커스 복귀 시에도 확인할지, 알림 위치를
  좌하단(240px)에서 더 눈에 띄는 곳으로 옮길지가 함께 결정돼야 한다.

### 🐛 `.gitignore` — `.claude/`를 무시해서 새 룰 파일이 조용히 커밋에서 빠진다
- Date: 2026-08-16
- Where: `.gitignore:61` (`.claude/`). 그런데 그 아래 10개 파일은 이미 추적 중이다
  (`git ls-files .claude`).
- What: 이미 추적된 파일은 계속 추적되지만, **새로 추가하는 `.claude/rules/*.md`는 무시된다.**
  `git status`에 아무것도 안 뜨고 `git check-ignore -v`로만 확인된다. 프로젝트 규칙을 새로
  쓰면 커밋됐다고 착각한 채 사라진다. 루트 `CLAUDE.md`와 문서 라우팅 인덱스가
  `.claude/commands/*.md`를 참조하고 있어 실제로 저장소가 의존하는 경로다.
- Surfaced by: 오픈소스 공개 전 점검 중 실측(`touch .claude/rules/__probe.md` → 무시됨 확인).
- Impact: 개발 — 규칙/커맨드 추가가 유실된다. 기여자에게는 원인이 전혀 안 보인다.
- Workaround: `git add -f .claude/...`
- Decision: 미정 — `.claude/`에서 공유할 것(rules·commands·skills)과 로컬 전용(state, settings.local.json)을
  갈라 `.gitignore`를 `!` 예외로 다시 쓸지, 아니면 공유분을 다른 경로로 옮길지 정해야 한다.
