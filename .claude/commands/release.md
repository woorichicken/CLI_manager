---
description: 릴리즈 — 빌드·공증·GitHub 게시·R2·웹사이트·changelog
---

# Release

전부 스크립트로 돈다. 손으로 하지 말 것 — 스크립트가 들고 있는 전제조건과 검증을
빠뜨리기 쉽고, 빠뜨리면 비싸다. 절차와 근거는 `.claude/rules/deploy-workflow.md`.

## 순서

```bash
# 준비 상태 확인 (아무것도 안 바꿈) — 테스트는 아래 --build 가 한 번 돌린다.
# --skip-tests 없이 돌리면 전체 스위트(약 8분)를 --check·--build 에서 두 번 돈다(2026-10-21 v1.14.2)
node scripts/release.cjs --check --skip-tests

# 빌드 — 약 10분. 세션 타임아웃에 안 죽게 분리 실행
nohup sh -c 'node scripts/release.cjs --version X.Y.Z --build > /tmp/build.log 2>&1; \
  echo "EXIT=$?" >> /tmp/build.log; touch /tmp/build.done' >/dev/null 2>&1 &
disown

# 끝나면 EXIT= 줄로 결과 확인 (배경 작업 알림의 종료코드는 래퍼 것이다)
grep EXIT= /tmp/build.log

# 게시 — 몇 초
node scripts/release.cjs --version X.Y.Z --publish --notes /tmp/release-notes.md

# 배포 — R2 · 웹사이트 링크 · changelog. 이것도 분리 실행한다:
# DMG 두 개(약 230MB)를 한 번에 PUT 해서 느린 회선에선 수십 분 걸리고 끊기면 write EPIPE 로 실패한다(실패해도 사이트는 안 건드려 다시 돌리면 된다).
# 그동안 사람이 앱 업데이트를 설치하면(재시작) 앱 터미널의 자식 프로세스가 같이 죽는다 — 2026-10-21 v1.15.0 에서 한 번 EPIPE, 한 번 재시작으로 끊겼다
DATABASE_URL=... nohup sh -c 'node scripts/post-release.cjs --version X.Y.Z --notes /tmp/changelog.json > /tmp/post.log 2>&1; \
  echo "EXIT=$?" >> /tmp/post.log' >/dev/null 2>&1 &
disown
```

## 사용자에게 물을 것

- 버전 번호 (기본 patch, 기능 추가면 minor)
- 릴리즈 노트 내용 — GitHub용 Markdown과 changelog용 JSON 두 가지

## 실패하면

스크립트가 알아서 멈추고 되돌린다. 게시된 것이 없다는 뜻이므로 원인만 고쳐 다시 돌리면 된다.
빌드 실패 시 산출물은 `release-failed-<timestamp>/`에 남으니 확인 후 지운다.
