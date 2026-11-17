# 배포 기준 (ship-bar)

이 저장소의 변경이 배포되려면 무엇을 넘어야 하는지 적는다. 판정은 `ship-bar.mjs check` 가 이 파일의 설정 블록으로 한다.
**사람이 정한 기준이다.** 기준을 낮추는 수정(관문 빼기 · 확신 단계 내리기)은 커밋 메시지에 이유를 적는다.

## 변경 등급

| 등급 | 뜻 | 예 |
| --- | --- | --- |
| T0 | 문서만 | `*.md` · `docs/**` |
| T1 | 화면 · 문구 · 테스트 | `src/renderer/**/components/**` · CSS · `tests/**` |
| T2 | 로직 · 저장 · 의존성 | `src/main/**` 대부분 · 렌더러 utils/hooks · 패키지 버전 |
| T3 | 한쪽 문 — 되돌리기 어렵다 | 사용자 설정 파일 편집(훅) · AI 가 셸에 입력하는 길(Control API) · 폰 접근 · 밖으로 나가는 데이터(제보·가림) · 빌드·서명·릴리즈 스크립트 · CI |

## 판정

- **GO** — 등급이 요구하는 관문이 모두 이 커밋에서 확신 4단계(실행함) 이상으로 통과했다.
- **NO-GO** — 하나라도 실패했다.
- **미증명** — 돌리지 못했거나, 다른 커밋에서 잰 증거뿐이거나, 확신이 4단계 미만이다. 통과로 치지 않는다.

## 이 저장소에서 「반영」은 두 단계다

| 단계 | 무엇이 일어나나 | 누가 |
| --- | --- | --- |
| main 머지 | CI 가 돈다. 사용자에게는 아직 아무것도 안 간다 | 아래 「자동 반영」 표 |
| 릴리즈 | 공증 빌드 → GitHub 릴리즈 → 자동 업데이트·R2·웹사이트 링크·changelog. **다른 사용자 앱이 바뀐다** | 사람이 「배포」라고 할 때만(`.claude/rules/deploy-workflow.md`) |

## 자동 반영 — 판정이 GO 면 세션이 어디까지 하나

`node ~/.claude/skills/ship-bar/scripts/ship-bar.mjs check --repo . --base origin/main` 이 **GO** 일 때:

| 등급 | 세션이 혼자 | 사람에게 남김 |
| --- | --- | --- |
| T0 | 머지까지(문서 규칙 그대로) | — |
| T1 · T2 | push → PR → CI 초록 → 머지 · 제보 닫기 | 릴리즈 |
| T3 | PR 까지 | 승인 · 머지 · 릴리즈 |

미증명·NO-GO 면 머지하지 않고 어느 관문이 왜 그런지 한 줄씩 보고한다. 「대부분 통과」로 접지 않는다.

## 배포 뒤 기준 (phase=post — 릴리즈 뒤)

이 앱에는 오류 추적(Sentry)이 없다. 그래서 배포 뒤 기준은 숫자가 아니라 두 관문이다.

| 관문 | 그대로 | 멈추고 본다 | 되돌린다 |
| --- | --- | --- | --- |
| `post-update-smoke` | 업데이트 뒤 앱이 뜨고 세션이 복원됨 | 바뀐 흐름 하나가 이상함 | 앱이 안 뜸 · 세션 복원 실패 · 사용자 설정 파일 손상 |
| `post-feedback` | 24시간 관련 새 제보 0 | 관련 제보 1건 | 같은 회귀 제보 2건 이상 |

## 롤백

- **main 머지 되돌리기**: `git revert -m 1 <머지 커밋>` → PR → 머지. 사용자에게 나간 것이 없어 이것으로 끝.
- **릴리즈 되돌리기**: 자동 업데이터는 버전을 내리지 않는다. 고친 판(패치 +1)을 새로 릴리즈한다 — `release.md` 전 과정, 빌드 약 10분 + 공증. 웹사이트 다운로드 링크는 `post-release.cjs` 가 R2 공개 주소를 확인한 뒤에만 바꾸므로, 그 전 실패면 이전 판을 가리킨 채다.
- **사용자 설정 파일**(훅 설치가 고친 `~/.claude/settings.json`·`~/.codex/config.toml`)은 래핑이라 Settings › Agents 에서 끄면 원래 값으로 돌아간다(불변식 3). 이 동작을 바꾼 변경은 T3 다.

## 설정

```json ship-bar
{
  "minProofLevel": 4,
  "permissionSignal": "\\b(?:token|authoriz\\w*|Origin|allowedHost\\w*|isAllowed\\w*|protected\\w*|maskSecrets|chmod|0o?600|0o?700|tailscale|funnel|revok\\w*|pair(?:ed|ing)?Device\\w*|sandbox|Content-Security-Policy|openExternal|openPath|execWithShell|settings\\.json|config\\.toml|autoUpdater|aiRegistration|X-Caller-Session|awaitingInput|password|secret)\\b",
  "tiers": {
    "T0": {
      "gates": []
    },
    "T1": {
      "gates": [
        "typecheck",
        "build",
        "ci-green",
        "e2e-changed"
      ]
    },
    "T2": {
      "gates": [
        "typecheck",
        "build",
        "ci-green",
        "check:publish",
        "e2e-changed",
        "old-code-fails",
        "independent-verify"
      ]
    },
    "T3": {
      "gates": [
        "typecheck",
        "build",
        "ci-green",
        "check:publish",
        "e2e-changed",
        "old-code-fails",
        "independent-verify",
        "invariant-specs",
        "human-approve",
        "rollback-plan",
        "post-update-smoke",
        "post-feedback"
      ]
    }
  },
  "gates": {
    "typecheck": {
      "cmd": "pnpm run typecheck",
      "where": "local",
      "kind": "typecheck",
      "ci": [
        ".github/workflows/ci.yml"
      ]
    },
    "build": {
      "cmd": "pnpm run build",
      "where": "local",
      "kind": "build",
      "ci": [
        ".github/workflows/ci.yml"
      ]
    },
    "check:publish": {
      "cmd": "pnpm run check:publish",
      "where": "local",
      "kind": "check",
      "ci": [
        ".github/workflows/ci.yml"
      ]
    },
    "ci-green": {
      "where": "manual",
      "desc": "이 커밋의 PR CI(typecheck·build·시크릿·위생·audit critical·터미널 시험 9종)가 초록 — `gh pr checks <PR>`. 취소(25분 시간 초과)는 초록이 아니다"
    },
    "e2e-changed": {
      "where": "manual",
      "desc": "바뀐 화면·영역의 tests/terminal 스펙을 `pnpm build` 뒤 `pnpm exec playwright test <spec> --workers=1` 로 돌림. 어느 스펙인지는 루트 CLAUDE.md 「Terminal Pipeline Testing」 표. 새 워크트리는 먼저 `pnpm exec electron-builder install-app-deps`"
    },
    "old-code-fails": {
      "where": "manual",
      "desc": "결함 수정이면 새 회귀 시험이 고치기 전 코드(base)에서 실패하는 것을 봤다. 새 기능이면 「옛 코드엔 그 요소가 없어 실패」로 같음"
    },
    "independent-verify": {
      "where": "manual",
      "desc": "작성 세션이 아닌 쪽(팀장의 서브에이전트 diff 리뷰 · pr-verdict · harsh-critic)이 돌려 보고 낸 판정. 그 쪽이 record 한다"
    },
    "invariant-specs": {
      "where": "manual",
      "desc": "루트 CLAUDE.md 불변식 시험: 렌더링 → `pnpm test:term` 의 t1·t4·t38·t41·t86·t87 · 훅 → t8·t11 · Control API → t15·t21 · 폰 접근 → t75·t76·t79 · 폰 파일/문서 → t97·t101·t102"
    },
    "human-approve": {
      "where": "manual",
      "desc": "사람이 before/after 리뷰(또는 diff)를 보고 승인. T3 는 세션이 스스로 머지하지 않는다"
    },
    "rollback-plan": {
      "where": "manual",
      "desc": "아래 「롤백」 중 어느 길로 되돌릴지와 사용자 설정(config.json·~/.claude/settings.json·~/.codex/config.toml)에 남는 흔적을 적었다"
    },
    "post-update-smoke": {
      "where": "post",
      "desc": "릴리즈 뒤 이 Mac 에서 자동 업데이트로 새 판 설치 → 앱이 뜨고 세션 복원·바뀐 흐름 한 번(release.md 순서)"
    },
    "post-feedback": {
      "where": "post",
      "desc": "릴리즈 뒤 24시간 라쏘런 새 제보(climanager-app 소스)에서 이 변경 관련 회귀가 없다"
    }
  },
  "paths": {
    "T3": [
      ".github/workflows/**",
      "electron-builder.yml",
      "electron.vite.config.ts",
      "build/entitlements*",
      "native/**",
      "scripts/release.cjs",
      "scripts/post-release.cjs",
      "scripts/prepublish-check.cjs",
      "src/main/HookInstaller.ts",
      "src/main/hookScripts.ts",
      "src/main/phone/phoneAccess.ts",
      "src/main/phone/PhoneDevices.ts",
      "src/main/phone/phoneFileAccess.ts",
      "src/main/phone/phoneDoc*.ts",
      "src/main/FeedbackRelay.ts",
      "src/main/maskSecrets.ts",
      "src/main/feedbackTerminalContext.ts",
      "**/.env*"
    ],
    "T0": [
      "**/*.md",
      "docs/**",
      "**/docs/**",
      "**/*.txt",
      "LICENSE"
    ],
    "T1": [
      "**/*.css",
      "**/components/**",
      "src/renderer/src/phone/**/*.tsx",
      "**/*.svg",
      "**/*.png",
      "**/*.icns",
      "tests/**",
      "**/*.spec.*",
      "**/*.test.*"
    ]
  }
}
```

## 지금 있는 관문

<!-- ship-bar:inventory:start -->
<!-- ship-bar.mjs init 이 이 칸만 다시 쓴다 · 2026-11-16 -->

| 관문 | 종류 | 명령 | CI | PR 에서 |
| --- | --- | --- | --- | --- |
| build | build | `pnpm run build` | .github/workflows/ci.yml | 예 |
| typecheck | typecheck | `pnpm run typecheck` | .github/workflows/ci.yml | 예 |
| check:publish | check | `pnpm run check:publish` | 없음 | 아니오 |

호스팅: 못 찾음 · 오류 추적: 없음 · 훅: 없음

**빠진 것**

- `e2e` — E2E 스펙·설정이 없다 — 버튼→화면→DB 거짓 성공은 E2E 로만 잡힌다
- `smoke` — 배포 뒤 확인(smoke) 명령이 없다 — 배포 완료 ≠ 기능 동작
- `error-tracking` — 오류 추적(Sentry 등) 흔적이 없다 — 배포 뒤 오류율 기준을 못 잰다

<!-- ship-bar:inventory:end -->

## 바꾼 이력

| 날짜 | 무엇을 | 왜 |
| --- | --- | --- |
| 2026-11-16 | 처음 세움 — inventory 초안에 CLImanger 관문(PR CI · 바뀐 영역 E2E · 불변식 시험)과 T3 경로·단어를 더함 | 사용자 요청 「수정 사항 자동 반영 가능하도록」 |
