---
description: 릴리즈 — 빌드·공증·GitHub 게시·R2·웹사이트·changelog
---

# Release

전부 스크립트로 돈다. 손으로 하지 말 것 — 스크립트가 들고 있는 전제조건과 검증을
빠뜨리기 쉽고, 빠뜨리면 비싸다. 절차와 근거는 `.claude/rules/deploy-workflow.md`.

## 순서

```bash
# 준비 상태 확인 (아무것도 안 바꿈)
node scripts/release.cjs --check

# 빌드 — 약 10분. 세션 타임아웃에 안 죽게 분리 실행
nohup sh -c 'node scripts/release.cjs --version X.Y.Z --build > /tmp/build.log 2>&1; \
  echo "EXIT=$?" >> /tmp/build.log; touch /tmp/build.done' >/dev/null 2>&1 &
disown

# 끝나면 EXIT= 줄로 결과 확인 (배경 작업 알림의 종료코드는 래퍼 것이다)
grep EXIT= /tmp/build.log

# 게시 — 몇 초
node scripts/release.cjs --version X.Y.Z --publish --notes /tmp/release-notes.md

# 배포 — R2 · 웹사이트 링크 · changelog
DATABASE_URL=... node scripts/post-release.cjs --version X.Y.Z --notes /tmp/changelog.json
```

## 사용자에게 물을 것

- 버전 번호 (기본 patch, 기능 추가면 minor)
- 릴리즈 노트 내용 — GitHub용 Markdown과 changelog용 JSON 두 가지

## 실패하면

스크립트가 알아서 멈추고 되돌린다. 게시된 것이 없다는 뜻이므로 원인만 고쳐 다시 돌리면 된다.
빌드 실패 시 산출물은 `release-failed-<timestamp>/`에 남으니 확인 후 지운다.
