# Codex 사용 가이드 (CLImanger)

## 기존 `.claude` 매핑 정리
- `.claude/commands/new-feature.md` -> `/prompts:new-feature`
- `.claude/commands/release.md` -> `/prompts:release`
- `.claude/rules/*.md` -> AGENTS 기반 규칙 + `/prompts:climanager-guidelines`

## 적용한 Codex 자원
- `AGENTS.md`: 프로젝트 최상위 규칙(필수)
- `~/.codex/prompts/new-feature.md`
- `~/.codex/prompts/release.md`
- `~/.codex/prompts/climanager-guidelines.md`

## 사용법
- 새 기능 시작: `/prompts:new-feature "기능 요약"`
- 릴리즈 준비: `/prompts:release "1.0.17"`
- CLImanger 전용 규칙 확인: `/prompts:climanager-guidelines`
