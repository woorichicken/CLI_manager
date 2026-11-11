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

Any session may append to `## Open

### 폰 Chat — 바뀌면 바뀐 만큼만(ETag·304, ovis 방식)
- Discovered: 2026-11-10 fb-1110 91e1b27e · 1e556f10. 첫 쪽은 3회차에 고쳤다(사람 결정 11-10) — 폰은 최근 20턴(`PHONE_CHAT_TURN_PAGE`)만 읽고 「Show earlier」로 20턴씩 더(T123). 16MB 사본 T118: Wi-Fi 0.22→0.14초, LTE 중계 0.51→0.28초, 전송 130→36KB.
- Evidence: 남은 몫은 턴이 바뀔 때마다 첫 쪽 창 전체를 다시 받는 것(지금 36KB)과 렌더 ~0.06초(폰 CPU 4배 감속). ovis 는 `If-None-Match` 로 안 바뀌면 304·클라이언트 캐시로 먼저 그림(`refs/ovis` `server/pane-routes.ts:289`, `src/lib/api.ts:584`).
- Trigger: 폰에서 Chat 이 바쁜 턴 동안 버벅인다는 제보가 다시 오거나, 실기기 측정에서 렌더가 0.3초를 넘을 때.
- Fix direction: 응답에 ETag(revision + limit) → 304. 재는 법: `PHONE_READ_PERF=1 PHONE_READ_TRANSCRIPT=<익명 사본> npx playwright test tests/terminal/t118-phone-read-perf.spec.ts`.
- Owner: 없음

### 질문 판정 — 메뉴가 화면 맨 아래면 위쪽 스피너 글은 무시(ovis·herdr 규칙)
- Discovered: 2026-11-10 fb-1110 4f10a0fc 비교.
- Evidence: 우리는 화면 어디든 일하는 중 줄(`isBusyRow`)이 있으면 질문 카드를 안 읽는다(`promptScreen.readPrompt` 첫 줄, T94 「a menu is not read under a 2.1.318 spinner」가 그 결정을 고정). ovis 는 메뉴 키 안내가 마지막 1~3줄이면 그 위 스피너 글을 무시하고(`refs/ovis server/dialogs/live.ts:87-99`), herdr 도 질문 규칙(980)이 스피너 줄(970)보다 높다(`claude.toml`). 이번 실제 캡처에서는 질문 중 스피너가 남지 않아 재현되지 않았다.
- Why deferred: T66·T94 가 일부러 정한 방향(에이전트 출력 속 대화상자 글은 질문이 아님)을 뒤집는 일이라 사람이 정한다.
- Trigger: 질문이 떠 있는데 Chat 이 「working」으로 남는 제보가 1.31 이후에도 다시 올 때.
- Fix direction: Claude 만, 메뉴의 첫 보기 줄 위에 있는 busy 줄은 무시. 키 안내가 마지막이어야 한다(`menuIsLast`)는 조건은 그대로.
- Owner: 없음

### 앱 안 브라우저 — HTML 보고서·웹 페이지를 앱에서 열기
- Discovered: 2026-11-10 사람 요청: 「html 일정 이상 넘어가면 too large 떠서 브라우저에서 보고 있는데 … 다른 것처럼 이 앱 안에서 브라우저를 쓸 수 있으면 좋겠는데 일단 백로그로」.
- Evidence: Mac 미리보기는 글 파일을 500KB 까지만 읽고(`read-file-content`, `src/main/index.ts` `maxSize = 500000`) 넘으면 `File too large (NNNKB)`, 그 아래여도 `.html` 은 소스만 보인다(`components/FilePreview.tsx`). Fork 리뷰 페이지가 925KB 였다. 폰은 이미 HTML 을 분리 칸에서 64MB 까지 그린다(`phone/phoneDoc.ts`, 결정 0011 — `connect-src 'none'`, 바깥 스크립트·글꼴 막음, localStorage 는 칸 안 대체).
- Why deferred: 범위가 갈린다 — (a) 보고서만 폰 칸 방식으로 그리기(바깥 자원 막힘) vs (b) 바깥 사이트까지 여는 진짜 브라우저 탭(`WebContentsView`, 주소창·뒤로·로그인 쿠키 분리). (b) 는 보안 경계(앱 IPC 와 분리·권한 요청·다운로드)를 새로 정해야 한다.
- Trigger: 사람이 시작하자고 할 때, 또는 큰 HTML 보고서를 앱 밖으로 여는 일이 계속 불편하다는 말이 다시 나올 때.
- Fix direction: 먼저 (a) — `.html` 은 기본으로 그려서 보이고 Source 전환 · 「Open in browser」 버튼, 한도는 폰과 같은 64MB. (b) 는 그 뒤 따로 결정 기록을 쓰고.
- Owner: 없음

### Chat 「새 세션으로 보내기」 전용 명령(`/split`)
- Discovered: 2026-11-10 사람 요청 — 한 세션에서 여러 이야기가 나올 때 한 갈래를 새 세션으로 떼어 보내고 여기서는 하던 일을 계속하고 싶다.
- Evidence: 먼저 Chat 말풍선 머리의 Fork 버튼 → 모달(대화 전체 복사 `claude --resume <id> --fork-session` · `codex fork <id>` 기본, 기록 발췌 선택)로 만들기로 했다. 같은 동작을 입력칸에서 치는 길은 없다. `split` 은 Claude·Codex 명령 표(`src/main/chatCommands.ts`)에 없어 겹치지 않는다(같은 날 확인).
- Why deferred: 사람 결정 「전용 명령어는 일단 백로그로」 — 버튼 + 모달을 먼저 써 보고 정한다.
- Update 2026-11-10: Fork 버튼 들어감(`feat/chat-fork-1110` — `ChatView/ForkDialog.tsx`, main `ConversationService.fork`·`ControlApiService.openFork`, 폰 `POST …/fork`). `/split` 은 이 모달을 여는 길로 만들면 된다.
- Trigger: Fork 버튼을 쓰면서 키보드·폰 입력칸에서 바로 보내고 싶다는 말이 나올 때.
- Fix direction: 앱이 Chat 입력칸에서 가로채는 `/split <이야기>`(에이전트에는 안 보냄), `/` 메뉴에 「CLI Manager」 묶음으로, 고른 뒤 같은 모달을 연다.
- Owner: 없음

### 폰 받아쓰기
- Discovered: 2026-11-09 사람 결정: 「목소리 기록도 병렬로 바로 시작」, 폰 받아쓰기는 백로그 — 폰 키보드의 마이크로 우선 대체.
- Evidence: Chat 받아쓰기는 Mac 에서만 돈다(`src/main/Dictation.ts` + Swift 헬퍼). 폰 Chat 은 `phoneChatTransport` 에 `dictation` 이 없어 마이크 버튼이 안 그려진다(`ChatDictation` 이 없으면 숨김, `src/shared/dictation.ts`). 받아쓰기 기록(`DictationLog.ts`)도 Mac 실행만 담는다.
- Why deferred: 폰 키보드(iOS·Android)의 마이크가 이미 같은 일을 한다. 폰 소리를 Mac 으로 보내면 소리가 네트워크를 탄다 — 결정 0009·0012 를 다시 봐야 한다.
- Trigger: 폰 키보드 마이크로 부족하다는 말이 나올 때(한국어 인식 품질·코드 낱말·긴 말).
- Fix direction(후보): 폰 마이크 → (Tailscale 위) Mac 헬퍼 인식 — 헬퍼에 소리 입력 모드(`listen --stdin-audio`)를 더하고 폰 서버에 WS 경로. 기록에는 `surface: 'phone'`.
- Owner: 없음

### D4 통합 뒤 명령 판정·이어짐 입력·복원 브리지 후속 (N16~N20)
- Discovered: 2026-11-08 D4 재검수 3회차(`review-claude-3.md`).
- Evidence: `shared/agentCommand.ts`는 프롬프트 뒤 옵션(N17)을 버리고, 불명확한 마지막 구간에서 준비/감싸는 명령도 입력에서 빠지며(N18), 앞 구간에 있는 에이전트 프롬프트는 남을 수 있다(N19). `preload.writeRestoredTerminal(id, data)`는 임의 글을 받는 형태다(N20, 권한 문제는 아님). `TerminalMirror.hasContinuationPrompt`는 cmdand/cmdor/if/subsh/cursh/array/복합·사용자 PROMPT2를 모두 알지 못한다(N16).
- 걸러지지 않은 터미널 응답(예: DECRQM)이 셸 프로필 실행 중에 오면 사람 입력으로 세어(`CLISessionTracker.processInput` 의 `terminalsWithInput`) 재시작 때 resume 을 안 칠 수 있다. 코드 근거이고 재지 않았다(Claude 5회차 검수, 2026-11-08).
- Why deferred: 기획 세션 fix-3 지시로 통합 이후 범위. 이번에는 판정/패턴을 늘리지 않고 수동 Connect의 Enter를 제거했다. 따라서 판정이 빗나가 글이 붙어 보이더라도 Connect가 Enter를 보내 실행하지는 않는다. 세션 재시작은 별도의 기존 Enter 동작을 유지한다.
- Trigger: D1~D4 통합·실기기 확인 뒤 후속 명령/복원 계약을 재설계할 때.
- Fix direction: N17 뒤 옵션/원문 보존, N18 준비 구간과 마지막 도구 fallback 분리, N19 앞 구간 에이전트 재전송 차단, N20 main의 restoreSession(id)로 입력 조립 범위 축소, N16 이어짐/사용자 PROMPT2 한계 정리. 이번 커밋에서 해당 패턴과 판정은 바꾸지 않는다.
- Owner: 기획 세션 후속.
- 4회차 추가: 시작 명령 재입력 — initialCommand의 프롬프트가 id 없는 세션에서 다시 쳐진다(main도 같음). Enter 안내에 줄을 확인하라는 문구를 더한다. pendingSessionRestores가 안 풀리는 길(복원 전에 뷰가 닫히거나 렌더러가 재개 명령을 묻지 않음)을 정리한다.
` without running a curation skill — the session that found the
problem is the one holding the evidence. Appending sessions do not reorder or remove other entries.

Remove an entry in the same change that resolves it. If resolving it produced a durable rule, that
rule goes to [`decisions/`](decisions/) or a scoped `CLAUDE.md`, never back into this file.

## Open

### 폰 Chat — 맨 위로 스크롤하면 앞 턴 자동 불러오기
- Discovered: 2026-11-11, 폰 첫 쪽 20턴(T123) 뒤 후속으로 나온 안. 사람 결정 11-11: 보류.
- Evidence: 지금은 맨 위의 「Show earlier」 버튼을 눌러야 20턴씩 더 붙는다(`src/renderer/src/components/ChatView/index.tsx:157` `showEarlier`). 읽던 줄 유지는 손으로 한다(Safari 에 스크롤 앵커가 없다).
- Why deferred: 사람이 버튼으로 두기로 정했다.
- Trigger: 사람이 다시 요청할 때.
- Fix direction: 맨 위 근처에서 `showEarlier` 를 부르는 관찰자(IntersectionObserver) — 같은 `earlierAnchor` 로 줄 유지, T123 에 자동 불러오기 판정 추가.
- Owner: 없음

### 음성 지휘(herdr-voice형)·질문에 말로 답(Hark형)
- Discovered: 2026-11-08 Orca·herdr 보이스 모드 비교 뒤 사람 결정: 「orca 형으로 하고 herdr 는 백로그로」. Chat 받아쓰기(Orca형)는 같은 날 들어갔다(`src/main/Dictation.ts`).
- Evidence: herdr-voice 는 실시간 음성 AI(Grok·OpenAI·Gemini)가 `list_agents`·`start_agent`·`read_pane` 같은 도구로 세션을 부린다. Hark 는 막힌 에이전트의 질문을 스피커로 묻고 답을 키로 넣는다. 우리 쪽 재료는 이미 있다 — Control API·MCP(세션 열기·입력·대기·화면 읽기), 질문 대기 감지(`SessionScreenStatus.ts`), 질문 카드(`promptScreen.ts`, 보내기 직전 같은 메뉴 재확인), 인박스, 폰 푸시.
- Why deferred: 음성 AI 가 셸에 입력하는 길이 하나 더 생긴다 — API 키 비용·클라우드로 나가는 음성·위험 동작 확인(Hark R0~R3 같은)을 설계해야 한다. 앱에 「메인 에이전트」가 없어 누가 지휘하는지도 정해야 한다.
- Trigger: 받아쓰기를 쓰면서 「말로 시키고 싶다」는 요구가 나올 때, 또는 사람이 시작하자고 할 때. Hark형(질문에 답)이 재료가 더 많이 있어 먼저 볼 후보다.
- Fix direction(미정): Hark형 — 질문 대기가 뜨면 TTS 로 읽고, 받아쓰기 헬퍼로 답을 듣고, 질문 카드 경로로 보낸다. herdr형 — 실시간 음성 클라이언트가 Control API MCP 를 도구로 쓴다.
- Owner: 없음

### 받아쓰기 — 듣는 언어를 고르는 설정
- Discovered: 2026-11-08 Chat 받아쓰기 시범.
- Evidence: 헬퍼는 Mac 의 언어로 듣는다(`SFSpeechRecognizer()`, `native/dictation/main.swift`). `--locale` 은 받지만 앱이 넘기지 않는다.
- Why deferred: 시범이라 가장 좁게 시작했다. 한국어 Mac 에서 영어로 말하면 한국어로 받아 적힌다.
- Trigger: 시스템 언어와 다른 언어로 받아 적고 싶다는 말이 나올 때.
- Fix direction: Settings › Terminal(Chat) 에 언어 선택, `dictation-start` 가 locale 을 넘기고 `status` 도 그 locale 로 기기 안 지원을 다시 본다.
- Owner: 없음

### 보낸 기기에 맞춘 답변 형태(폰/컴퓨터)
- Discovered: 2026-11-07 사람 아이디어: 「각 메세지 앞에, 컴퓨터에서 보내는지, 핸드폰에서 보내는지를 헤더처럼 달아서, 각 화면에서 보기 좋은 형태의 답변을 내게」.
- Evidence: 폰 폭 390 에는 넓은 표가 맞지 않는다. 앱은 폰 입력을 이미 안다(`recordPhoneInput`, `src/main/phone/phoneApi.ts:64`).
- Why deferred: 넣는 방식이 정해지지 않았고, 에이전트 훅 경로를 건드린다.
- Trigger: 폰에서 받은 답이 표·긴 줄로 읽기 어렵다는 말이 다시 나올 때, 또는 사람이 시작하자고 할 때.
- Fix direction(제안, 미정): 글에 머리말을 박으면 기록·말풍선에 남는다. 앱이 세션별 마지막 입력 출처를 파일에 적고 `UserPromptSubmit` 훅이 그 값을 보이지 않는 문맥으로 넣는 쪽을 먼저 본다. 스풀·훅 불변식(앱이 꺼져도 멈추지 않음)을 지킨다. Codex 는 훅 경로가 달라 따로 본다.
- Owner: 없음

### T1 `6 terminals flooding` — 대기 조건이 명령 줄의 `SEQ-DONE` 과 출력의 `SEQ-DONE` 을 구분 못 한다
- Discovered: 2026-11-07 v1.27.0 `--build` 1회차, 전체 시험에서 이 1건만 실패(1 failed · 1011 passed).
- Evidence: `tests/terminal/t1-data-loss.spec.ts:70` 이 입력하는 명령 줄에 `echo SEQ-DONE-…` 글이 들어 있고 `:75` 가 같은 글을 기다린다. 출력이 끝나기 전에 통과할 수 있다. 실패 때 `last` 275024 · 269697 · 265076(기대 300000), 나머지 3개는 300000, 6개 모두 gap 0 · discard 0. 10회 반복은 머지판 `a51ef6a` 트리·v1.26.1 모두 10/10 통과, 재빌드 전체 시험도 통과. v1.26.1 뒤 `src` 에 터미널 경로 변경 없음. v1.22.0 의 단일 터미널 시험도 같은 모양이었다(`last` 228478).
- 한계: 원인은 유력하나 미증명이다. 위 근거는 데이터 유실이 없다는 증명이 아니다.
- Why deferred: 릴리즈 중이었고 이번 범위가 아니다.
- Trigger: 사전 점검에서 T1 이 다시 실패할 때, 또는 터미널 출력 경로를 만질 때.
- Fix direction: 명령 줄에 없는 글을 기다린다(예: `echo SEQ-DONE-$((1+1))` 처럼 셸이 계산한 값). 그 뒤에도 `last` 가 모자라면 그때는 진짜 유실로 본다. 단일 터미널 시험(`:29`)도 같은 모양이라 함께 고친다.
- Owner: 없음

### Muse Code Chat 지원
- Discovered: 2026-11-07 사람 결정: 「muse 는 일단 백로그로 두자」.
- Evidence: `agentOf`(`src/main/ConversationService.ts:871`)가 claude·codex 만 받아 전환 버튼·읽기·보내기·대화 id 추적이 없다. 재료(아직 형식 미확인): `~/.local/share/muse/sessions` · `muse export`(세션 JSON) · `muse serve`(MSP) · ovis 에 Muse 리더가 있었다(`src/main/transcript/metadata.ts:2` 주석).
- Why deferred: 사람 결정.
- Trigger: 사람이 Muse 를 Chat 으로 쓰자고 할 때.
- Fix direction: 읽기·보내기 먼저, 질문 카드는 실제 화면 사본을 모은 뒤.
- Owner: 없음

### 폰에서 Mac 인박스 보기·바로 답
- Discovered: 2026-11-06 폰 기능 기획 세션. 사람 결정: 「인박스는 자주 사용하지는 않아서, 일단 백로그로」.
- Evidence: 폰 코드에 인박스가 없다 — `src/renderer/src/phone/` · `src/main/phone/` · `src/shared/phone.ts` 에서 `inbox` 검색 0건(대조: Mac 쪽 `src/main/InboxStore.ts` · `components/Inbox/` · `hooks/useInbox.ts` 는 있다). 사람도 자주 쓰지 않는다(11-06).
- Why deferred: 쓰는 빈도가 낮고, 넣으려면 폰 서버에 인박스 경로가 새로 필요하다.
- Trigger: 사람이 폰에서 인박스를 찾거나, 리뷰 요청을 Dock·알림으로 놓칠 때.
- Fix direction: `InboxStore` 를 폰 서버 경로로 내보내 목록을 보이고, 요청을 누르면 그 세션 Chat 으로 가서 답한다. 읽음은 Mac 과 같이 줄의 ✓ 로만 바꾼다(세션을 봐도 안 읽은 채 — 제보 b165acc4).
- Owner: 없음

### `scripts/post-release.cjs` — 끝날 때 아직 안 닫은 제보를 알려 주기
- Discovered: 2026-11-06 v1.26.1 회고. 릴리즈 스크립트가 모두 성공해도 제보 상태는 그대로라, 고친 제보 17건이 열린 채 끝 보고가 나갔다.
- Evidence: `.claude/commands/release.md` 에 절차를 적었지만 문서라 건너뛸 수 있다. 같은 일이 2026-09-22 standup 에서도 있었다(제보 14건이 엿새 동안 열림).
- Why deferred: 스크립트 수정이라 문서 변경과 따로 승인받아야 한다. 또 어떤 제보가 이번 릴리즈 몫인지 스크립트가 알 방법부터 정해야 한다.
- Trigger: 다음 릴리즈에서 제보 닫기가 또 빠졌을 때.

### `scripts/release.cjs` — 업데이트를 바뀐 만큼만 받게 `*.zip.blockmap` 도 올리기
- Discovered: 2026-11-11 「안드로이드 OTA 처럼 작은 업데이트가 되나」 질문을 조사하며. 사람 결정: 「일단, 백로그로만 넣어줘」.
- Evidence: electron-updater 는 직전 판 zip 의 blockmap 과 새 판 blockmap 을 비교해 바뀐 블록만 받는다(differential download). 그런데 `scripts/release.cjs` `verifyArtifacts` 의 `expected` 목록(dmg 2 · zip 2 · `latest-mac.yml`)만 `publish` 가 `gh release create` 에 넘겨서 blockmap 은 GitHub 릴리즈에 없다 — 그래서 업데이트마다 zip 전체를 받는다. 설치 단계(`quitAndInstall` → 앱 종료)는 이것과 무관하게 그대로다.
- Why deferred: 릴리즈 스크립트 수정이라 문서 변경과 따로 승인받아야 하고, 한 번 올린 뒤에야 **다음** 판부터 효과가 난다(첫 판은 비교할 옛 blockmap 이 없다).
- Trigger: 다음 릴리즈를 준비할 때, 또는 업데이트 용량·시간에 대한 제보가 나올 때.
- Fix direction: `expected` 에 `cli-manager-${version}-{arm64,x64}.zip.blockmap` 을 더한다(없으면 fail). 효과는 두 판을 올린 뒤 업데이트 로그의 다운로드 바이트로 잰다. 앱을 끄지 않고 세션을 살리는 쪽은 아래 데몬 항목이다.
- Owner: 없음

### 데몬을 앱과 분리 — 앱을 꺼도 세션이 사는 구조(Paseo 방식)
- Discovered: 2026-11-06 폰 기능 기획 세션에서 Paseo(`getpaseo/paseo`)와 비교하며. 사람 결정: 「파세오 - 데몬 관련해서는 일단 백로그로」.
- Evidence: 지금은 앱 main 프로세스가 세션을 쥔다(`src/main/TerminalManager.ts` 의 node-pty, 폰 서버 `src/main/phone/PhoneServer.ts`). 그래서 앱을 끄면 세션과 폰 연결이 같이 끝난다. Paseo 는 데몬이 에이전트를 쥐고 데스크톱·모바일·웹이 클라이언트로 붙는다.
- Why deferred: 구조 변경이 크다 — 지금 진행 중인 폰 화면 작업과 섞으면 둘 다 늦어진다.
- Trigger: 앱을 끈 뒤에도 세션을 계속 돌려야 하는 요구가 실제로 나올 때.
- Fix direction: 폰 기능 작업과 분리해 따로 기획한다. 터미널 히스토리 원본(결정 [`0008`](decisions/0008-terminal-history-lives-in-main.md))과 폰 서버(결정 [`0009`](decisions/0009-phone-connection-second-server.md))가 main 에 있다는 전제가 함께 바뀐다.
- Owner: 없음

### 폰 연결 — N시간 안 쓰면 자동으로 끄기
- Discovered: 2026-11-05 사람 질문(「N 시간 사용을 안하면 phone 기능을 끄는 기능이 있는지」). 2026-11-06 사람 결정: 백로그.
- Evidence: 설정은 `enabled`·`port` 둘뿐이다(`src/shared/types.ts` `DEFAULT_PHONE`). 켜 두면 앱을 끌 때까지 tailnet 에 열려 있고, 켜고 끈 기록도 남지 않는다.
- Why deferred: 지금 불편은 배지 ✕ 실수로 꺼지는 쪽이었고 v1.26.1 확인 창으로 막았다. 자동 끄기는 반대 방향(꺼지는 일이 늘어남)이라 정할 게 있다.
- Trigger: 폰 연결을 켜 둔 채 잊는 일이 실제로 문제가 될 때, 또는 폰 화면 다음 회차.
- Fix direction: 설정에 「N시간 안 쓰면 끄기」(기본 끔). 「안 씀」 기준(폰 소켓 연결 수 0 이 N시간)과 꺼질 때 Mac·폰에 무엇을 보여 줄지 먼저 정한다. 켜고 끈 사건 기록도 같이 넣으면 「왜 꺼졌나」를 잴 수 있다.
- Owner: 없음

### `src/renderer/src/phone/phone.css` — 폰 스타일이 한 파일(919줄)이다
- Discovered: 2026-11-06 사람 질문(「한 파일이면 기능 추가가 힘들 것 같다」)에 구조를 재며. 폰 화면 TS/TSX 는 약 25개 파일로 나뉘어 있고 이 파일만 한 덩어리다.
- Evidence: `wc -l` 919줄. 화면별 파일로 안 나뉘어 있어 기능을 넣을 때마다 같은 파일이 겹쳐 충돌하기 쉽다(병렬 세션이 많은 저장소).
- Why deferred: 지금 막히는 일은 없고, 파일만 쪼개는 일은 사용자에게 보이는 변화가 없다.
- Trigger: 폰 화면 기능을 여러 세션이 동시에 고쳐 이 파일에서 충돌이 날 때, 또는 1,500줄을 넘을 때.
- Fix direction: 화면별 파일(목록·세션·터미널·설정)로 나눠 각 컴포넌트가 import. 공용 토큰만 `phone.css` 에 남긴다. 스타일 변화 없음을 폰 캡처 전후로 확인.
- Owner: 없음

### 입력 상자 읽기 — edge-audit 나머지(4~13)와 복원 구분선
- Discovered: 2026-11-05 phone-fixes(A 확장 1·2·3·14 는 끝, T88). `~/Downloads/_batches/plan-ovis-1103/fixes/edge-audit/report.md` 4~13번(Stop 뒤 Claude 가 되돌려 놓은 초안 · /rewind 대화상자 · 보이지 않는 글자로 붙잡힌 전송 · 200자 넘는 한 줄 · 화면 어디든 `esc to interrupt` 면 작업 중 · 질문 판정 범위 · 계획 승인 문구 · 끝이 `\`·`@` · 숨긴 중단 힌트 · `/btw`·상세 기록 보기)와 14c(좁은 칸 줄바꿈 head 비교).
- Evidence: 새로 생긴 것 하나 — ovis 라벨 선(`/^─{2,}\s.*─$/`)이 우리 복원 구분선 `── Restored from previous session · saved … ──` 에도 맞는다. 복원 직후 Claude 가 상자를 그리기 전에는 선이 하나뿐이라 `clipped` → Claude 세션 Chat 이 잠깐 `input_busy`(실제 개발판 화면에서 그 줄을 봤다, 거절 자체는 재현 안 함).
- Why deferred: 총괄 지시로 이번 범위는 1·2·3·14.
- Trigger: 다음 Chat 안정화 회차, 또는 복원 직후 「input line already has text」 제보.
- Fix direction: 4~13 은 report 「추천 순서」대로(8·9 먼저). 구분선은 판정에서 `Restored from previous session` 을 빼거나 구분선 모양을 라벨 선과 다르게.
- Owner: 없음

### 폰 페이지 — Chrome 이 「페이지를 번역하시겠습니까?」를 매번 띄운다
- Discovered: 2026-11-05 phone-fixes 갤럭시 캡처 — localhost:8765 와 Tailscale 주소 모두, 출발어 영어 · 도착어 한국어.
- Evidence: 리뷰 캡처 `fixes/phone-fixes/shots/a-before-galaxy.png` 등 상단 풍선. 화면 위를 덮어 지목·캡처를 가린다.
- Why deferred: 이번 범위 밖(phone.html 머리말).
- Trigger: 폰 화면 다음 회차.
- Fix direction: `phone.html` 에 `<meta name="google" content="notranslate">` 또는 `translate="no"`. 실제 대화 글은 사람이 번역하고 싶을 수 있어 범위를 고른다.
- Owner: 없음

### E2E 전체 실행 — 회차마다 다른 1~2건이 흔들린다(부하·동시 앱)
- Discovered: 2026-11-05 밤샘 시험(plan-ovis-1103) — 같은 브랜치 전체 실행 6회: 893·911건 중 실패 2 · 2 · 0 · 2 · 2 · 1, 실패한 건은 매번 다시 3번 돌리면 대부분 통과.
- Evidence: 회차별 실패 — T3(녹화 파일 없음, 환경) · T20 잠자기(R1′ 「Execution context was destroyed」) · T74 r2(질문 카드 10초 623행 — 11-03 에도 1/6) · T77 가로 폭 맞춤 83/103 · T19 #5 흐린 제안(3/3 통과). 로그 `~/Downloads/_batches/plan-ovis-1103/regress/full-final{,2,3,4,5,6}.log`. 같은 시간에 실제 Claude 세션이 든 격리 개발판·갤럭시 장시간 시험이 함께 돌았다.
- Done tonight: T20 깨우기 순서(df7052c 자식 먼저 → 64ae70d 메인 먼저: 단독 4/10 → 10/10, 단 전체 실행 중 1회 재발) · T77 폭 맞춤 기준 폭을 ResizeObserver 로(0e34b09 — 원인은 계측으로 확인, 강제 재현은 못 함).
- Why deferred: 남은 건 시험 장치·부하 문제로 보이고 제품 결함 증거가 없다. 머지를 막을 정도는 아님(실패 건은 다시 돌리면 통과).
- Trigger: pre-push·CI 에서 같은 건이 두 번 넘게 떨어질 때, 또는 T20 을 실제 잠자기로 다시 볼 일이 생길 때.
- Fix direction: T20 은 앱 메인까지 SIGSTOP 하지 말고 PTY 아래만 멈추기 · T74 r2 카드 단계는 「카드가 뜨기 전 화면」을 기다리는 조건을 개수로 · 전체 실행은 다른 Electron 앱이 없는 깨끗한 맥미니(remote-job-runner)로.
- Owner: 없음

### 폰 페이지 — Mac 기능 전반(헤더 체크리스트·총괄 보기)을 폰에서 확인
- Discovered: 2026-11-05, 사람 요청(「climanager 기능 총괄 / 체크리스트 등 핸드폰에서 확인 가능」) — 밤샘 갤럭시 시험 직후.
- Evidence: 폰 페이지(`src/renderer/src/phone/*`)에는 세션 목록·Chat·Terminal·알림만 있다. 헤더 체크리스트는 `src/main/ChecklistStore.ts` 에 있고 Mac 헤더와
  Control API(`/v1/checklists`)·MCP(`checklist_*`)로만 닿는다 — `src/main/phone`·`src/renderer/src/phone` 에서 `checklist` 0건. 총괄이 만든 목록(예: 03ec3e81 「폰 연결 머지 전」 3/5)은
  Mac 앞에서만 보인다. 총괄 세션은 폰 세션 목록에 한 줄로 섞여 있어 「총괄이 지금 뭘 맡겼고 무엇이 남았나」를 따로 볼 화면이 없다.
- Why deferred: 이번 범위(폰 연결 품질·검증) 밖. 먼저 `feat/phone-1103` 머지가 정해져야 한다.
- Trigger: 사람이 Mac 을 떠나 폰으로 밤샘·배치 진행을 확인하는 일이 다시 생길 때, 또는 총괄 체크리스트를 폰에서 체크하려 할 때.
- Fix direction: ① 폰 서버에 체크리스트 읽기 경로(+ control 역할만 항목 체크) — `ChecklistStore` 변경을 폰 소켓으로 밀어 실시간 반영 ② 폰 ☰ 에 「체크리스트」 화면(목록별 진행 n/m, 항목 탭 = 체크)
  ③ 세션 목록에서 「대화:」·총괄 세션을 위로 묶거나 따로 표시 ④ Mac 에만 있는 기능 목록(헤더 체크리스트·Related·split view·설정)을 표로 만들어 폰에서 볼 것/뺄 것을 사람이 고른다. 보기 전용(watch) 기기는 읽기만.
- Owner: 없음

### Mac 터미널 기본 글꼴 — 한글이 글자마다 벌어져 보인다(폰 G3 와 같은 증상)
- Discovered: 2026-11-05, Chat 보기 위치 안내 캡처(격리 개발판, 설정 기본값) — 터미널에 「안 녕 하 세 요 !」처럼 글자 사이 틈. 캡처 `~/Downloads/_batches/plan-ovis-1103/review/where-chat/1-terminal.png`.
- Evidence: 기본 글꼴 `DEFAULT_TERMINAL_FONT_FAMILY = 'Menlo, Monaco, "Courier New", monospace'`(`src/renderer/src/components/TerminalView.tsx`)에 한글 글리프가 없어 대체 글꼴로 그리는데, 그 폭이 2칸보다 좁아 xterm 이 남는 폭을 글자 뒤 틈으로 둔다.
  폰은 G3 에서 한글 고정폭 부분 글꼴(`CLIM Phone Mono`)로 2.00 을 맞췄다. 사람이 쓰는 실제 앱 설정도 글꼴을 따로 고르지 않았다(`config.json` 에 `terminalFontFamily` 없음) — 같은 기본값을 쓴다.
- Why deferred: 이번 범위(릴리즈 v1.26.0) 밖. 실제 앱 화면에서 같은 틈이 보이는지 사람 확인이 먼저다.
- Trigger: 사람이 Mac 터미널 한글 간격을 말할 때, 또는 새 사용자 기본 글꼴을 다시 정할 때.
- Fix direction: 기본 글꼴 목록 끝에 한글 고정폭(예: 폰과 같은 나눔고딕코딩 부분 글꼴을 데스크톱에도 싣거나 `D2Coding` 이 있으면 사용) — 한글/라틴 폭 비를 T81 처럼 재서 2.00 확인.
- Owner: 없음

### 폰 알림 — Chrome 「스팸일 수 있음」 안내 · 두 주소로 붙은 같은 폰에 알림 두 번 · 번역 팝업
- Discovered: 2026-11-05 Tailscale 주소(`tailscale serve`) 점검, 갤럭시 M23 · Chrome 156.
- Evidence: ① 처음 받는 알림은 주소마다 Chrome 이 내용을 「스팸일 수 있음(1개) — Chrome에서 <주소>의 스팸 가능성이 감지되었습니다」로 바꿔 보여 준다(localhost:8765 · *.ts.net 둘 다).
  알림을 펼쳐 「알림 표시」 → 「항상 허용」을 한 번 누르면 그 주소의 다음 알림부터 제목·본문이 그대로 온다(`dumpsys notification`: title=CLI Manager · text=Test alert from your Mac). 앱 화면 어디에도 이 안내가 없다.
  ② 같은 폰이 USB(localhost)와 Tailscale 두 주소에서 알림을 켜면 구독이 2개(`pushDevices: 2`)라 알림이 두 번 온다. Mac 기기 목록에는 같은 이름 「Galaxy M23」이 3줄로 보여 어느 게 어느 주소인지 모른다.
  ③ `src/renderer/phone.html` 이 `lang="en"` 이라 한글 세션 이름이 많은 목록에서 Chrome 이 「페이지를 번역하시겠습니까?」를 띄운다.
- Why deferred: 이번 범위(밤샘 검증) 밖이고 사람이 한 번 누르면 풀린다.
- Trigger: 다른 사람·새 폰이 Tailscale 로 처음 붙을 때, 또는 알림이 두 번 온다는 말이 나올 때.
- Fix direction: ① 알림 메뉴 「Send a test alert」 결과 줄에 「알림이 『스팸일 수 있음』으로 오면 펼쳐서 알림 표시 → 항상 허용」 한 줄 ② 기기 목록에 들어온 주소(USB/Tailscale)를 같이 표시하고, 같은 폰의 옛 구독은 새 구독이 생길 때 끄기를 제안 ③ `<meta name="google" content="notranslate">` 또는 `translate="no"`.
- Owner: 없음

### 폰 서버 — 앱을 켠 채 다시 빌드하면 폰 페이지 새 청크가 404
- Discovered: 2026-11-04, 폰 품질 3회차(quality-phone) — 시험 앱을 띄운 채 `pnpm build` 를 하자 폰 페이지가 빈 화면(자산 404).
- Evidence: `PhoneServer.assets()` 가 `out/renderer/.vite/manifest.json` 으로 만든 허용 목록을 처음 한 번만 읽고 `allowedAssets` 에 들고 있다(`src/main/phone/PhoneServer.ts` 403행 근처).
  빌드가 청크 이름(해시)을 바꾸면 새 이름은 목록에 없어 404. 앱을 다시 켜면 풀린다. 배포 앱은 실행 중에 `out/` 이 안 바뀌므로 개발 중에만 생긴다.
- Why deferred: 이번 범위(폰 화면 품질) 밖이고 사용자 영향 없음.
- Trigger: 폰 페이지를 고치며 앱을 띄워 둔 채 빌드를 되풀이하는 일이 다시 생길 때(재시작이 귀찮아질 때).
- Fix direction: 매니페스트 파일의 mtime 이 바뀌면 목록을 다시 읽는다(요청마다 `statSync` 한 번) — 또는 개발 빌드(`CLIMANGER_TEST_USERDATA`/dev)일 때만 캐시하지 않는다.
- Owner: 없음

### 헤더 체크리스트 — 항목을 특정 세션에 배정하기
- Discovered: 2026-10-31, 스탠드업 메모 「기획 - 리스트」 2차 기획(사람: 「특정 프로젝트에 따라서, 세션셜로 부여도 가능한건 일단 백로그로 두고 싶고」).
- Evidence: 지금 체크리스트(`ChecklistStore`)는 세션에 묶이지 않는다 — 총괄이 `checklist_create` 로 만들고 일은 `send_input` 으로 직접 시킨다. 항목에 「누가 맡았나」 칸이 없어서
  헤더만 봐서는 어느 세션이 그 항목을 하고 있는지 모른다.
- Why deferred: 사람 결정 — 1차(세션마다 목록)가 세션을 닫을 때 넘기기·정리 규칙을 키웠다. 배정을 넣으면 같은 질문(맡은 세션이 닫히면?)이 항목 단위로 돌아온다.
- Trigger: 총괄이 항목마다 세션을 적어 두는 일이 반복되거나(항목 글에 세션 이름·링크를 붙이기 시작하면), 사람이 「이 항목 누가 하고 있지?」를 헤더에서 찾을 때.
- Fix direction: 항목에 선택 칸 `assignee`(세션 id) — 패널 줄에 세션 이름 배지(누르면 그 세션), `checklist_check` 는 그대로. 맡은 세션이 닫히면 칸만 비운다(항목은 남음).
- Owner: 없음

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
- 정정 (2026-10-30, 총괄 재조사 — 사람: 「idleCompaction 이 아니라 터미널(CLI Manager) 문제 같다」): 위 「압축 때 다시 그리기」는 **시각이 겹친다는 정황뿐**이고, 남은 기록으로는 원인을 못 가른다.
  - 원 답(Claude 대화 기록 `~/.claude/projects/-Users-jeong-gyeonghun/031f2aec-….jsonl`, 16:15 KST)과 맞대면 빠진 것은 약 8줄 — 158행 꼬리 「 `check`·`verify` 모두 통과)」, 빈 줄, 표 윗선·머리·구분선, 첫 줄 「넘길 몫」(2줄), 구분선.
    **손실이 158행 72번째 칸, 줄 중간에서 시작한다** — 그 줄은 71칸에서 끊겼고 남은 글(24칸)은 103열에 충분히 들어간다. 줄이 통째로 밀려난 게 아니라 그 자리에서 「여기부터 지우기」가 들어간 흔적이다.
  - 언제 지워졌는지도 모른다 — 답 16:15 · 압축 17:09~17:10 · 제보 17:35 사이 어디든 된다.
  - 「미러 줄에도 없다」는 **CLI Manager·xterm.js 를 무죄로 만들지 않는다.** 화면과 미러(`TerminalMirror`) 모두 xterm.js 6.0.0 이 같은 바이트를 해석한 결과라, 해석 쪽 문제면 둘 다 같이 잃는다. 렌더러(그리기)만의 문제가 아니라는 뜻뿐이다.
  - 판정에 필요한 것은 **PTY 에서 들어온 원본 바이트**인데 어디에도 남지 않는다 — `TerminalEventLog` 는 메모리 사건 기록, `ScrollbackStore`(`.ans`)는 xterm 이 처리한 결과를 덮어쓰고 세션을 닫으면 사라진다.
  - 제안(사람 결정 대기): 터미널마다 최근 원본 출력 링버퍼(메모리 약 2MB)를 두고 제보에 첨부한다. 같은 바이트를 Terminal.app·iTerm 과 CLI Manager 에서 재생해 **CLI Manager 에서만 사라지면 앱·xterm.js, 둘 다 사라지면 Claude Code** 로 가른다.
    앱 변경 없이 당장 쓸 길: CLI Manager 터미널에서 `script -q -r <파일> claude …` 로 원본을 기록해 두고 재현되면 같은 비교를 한다.
- 부분 해결 (2026-11-05 resize-anchor-1105): 높이 변경은 이제 `src/shared/terminalResize.ts`(렌더러·미러 공용)가 「화면 아래 기준」으로 한다 — 커서 아래에 입력 상자가 있는 TUI 는
  줄 때 위 줄을 스크롤백으로, 늘 때는 **화면이 찼을 때만** 스크롤백에서 되돌린다(짧은 프로그램 위의 복원 구분선은 안 끌어내린다, T86). 남은 것: ① 커서가 **맨 아래 줄**에 있는 경우는
  xterm 기본(늘 때 끌어내림) 그대로다 — 셸 프롬프트의 정석 동작이라 바꾸지 않았다. ② 크기 변경 없이 사라진 477ecebd 계열(원본 바이트 링버퍼 제안)은 그대로 열려 있다.
- Owner: 없음

### `electron-vite.config.ts` — 이 설정 파일은 읽히지 않는다
- Discovered: 2026-10-13, StrictMode 확인용 개발 번들을 만들다가.
- Evidence: electron-vite 는 `electron.vite.config.*` 를 찾는다. 같은 내용으로 `--config` 를 주면 `Cannot find package '@vitejs/plugin-react'` 로
  죽는다 — 그 플러그인은 설치돼 있지 않다(`ls node_modules/@vitejs` 없음). 지금 빌드는 기본 설정(esbuild JSX)으로 돌고 `@renderer` alias 도 없다.
- Why deferred: 빌드는 정상이고, 이름을 바꾸면 플러그인 설치·alias 사용처 확인까지 따라오는 별개 변경이다.
- Trigger: 빌드 설정(alias·React 플러그인·Fast Refresh)을 실제로 바꾸려 할 때 — 그 전에 이 파일이 읽히는지부터 고친다.
- Trigger hit: 2026-11-03 phone-1103 — 폰 페이지(렌더러 두 번째 입구)와 main `define` 이 필요해 **`electron.vite.config.ts`(점)를 새로 만들었다**:
  기본값 그대로(main·preload `{}`) + 렌더러 입구 둘 + `manifest: true` + main `define`(ws 스위치). 빌드 결과 main 크기 2,151.93 kB 그대로(전후 같음).
  하이픈 파일은 손대지 않았다 — 지우거나 합치는 일(React 플러그인·`@renderer` alias 를 실제로 켤지)이 남았다.
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
- Update 2026-11-06: v1.26.1 업데이트 재시작(09:00:56)에서 다시 잼 — claude 프로세스 65개의 시작 시각이 5초 안(`ps -axo etime,comm`). 31분 뒤 15분 부하 평균이 아직 15.56. 재시작 직후 최고 부하와 MCP 누락은 안 쟀다.
- Fix direction: 복원을 몇 개씩 나눠 띄운다(예: 4개씩, 앞 묶음의 에이전트가 프롬프트를 띄운 뒤 다음). 오래 쉰 세션은 탭만 복원하고 프로세스는 첫 포커스 때 띄우는 선택지.
- Owner: 없음

### `tests/terminal/t26-session-navigation.spec.ts` — 「split view 삭제」가 셸 자식 대기 뒤에도 간헐로 남는다
- Discovered: 2026-10-27 v1.21.0 릴리스 빌드 1회차 사전 점검 — `t26-session-navigation.spec.ts:187` 「deleting a session shown in split view removes its pane」이 `deleteFromSidebar` 의 `expect(row).toHaveCount(0, { timeout: 10_000 })` 에서 실패(Received 1, 24회 확인). 302 passed · 1 failed(12.3m), 게시 없음. 부하 1분 값 38(배치 밖 헤드리스 크롬 4개). 단독 `--repeat-each=3` 3/3, 2회차 빌드 303 passed 로 공개. 로그 `/tmp/climanager-release-121-build-try1.log` → 전체 `/var/folders/cx/yf5b5yt170q7jsdn4xz6pfhr0000gn/T/release-tests-1793070940740.log` · `/tmp/climanager-release-121-t26split.log`.
- 앞 이력: 10-09 v1.13.0 · 10-25 1.18.0(T40) · 10-26 1.19.0(T40) 에 같은 사이드바 삭제 버튼에서 났다. 원인 경로(코드로 확인): `App.tsx` `handleRemoveSession` 이 `hasRunningProcess` 참이면 네이티브 확인 상자를 띄운다 — 숨긴 시험 창에서는 아무도 답하지 않는다. 2026-10-26 PR #62 가 클릭 전에 `hasRunningProcess === false` 를 기다리게 했고 day-1027 #69 가 이 줄을 닫았지만, **대기를 지난 뒤에도 줄이 남았다** — 대기와 클릭 사이에 자식이 생겼는지, 클릭이 hover 전환 중에 빗나갔는지는 아직 모른다.
- 「Ctrl keys」(같은 파일)는 PR #66 뒤 1.21.0 사전 점검 두 번 모두 통과 — 그 줄의 트리거대로 지웠다.
- **재발(트리거 충족)**: 2026-10-29 v1.22.1 릴리스 빌드 1회차 — `:132` 「Cmd+] skips a session deleted from the sidebar」·`:141` 「deleting the active session from the sidebar shows its neighbour」 둘 다 `Delete session` 클릭이 **「performing click action」에서 끝나지 않고** 4.5분 시간 초과(줄이 남은 게 아니라 클릭이 안 돌아옴 → 네이티브 확인 상자 쪽으로 기운다). 단독 `--repeat-each=2` 4회 중 1회 같은 멈춤(`/tmp/climanager-release-1221-t26.log`), 2회차 빌드 345 passed 로 공개. 1회차 로그 `/tmp/climanager-release-1221-build-try1.log` → 전체 `/var/folders/cx/yf5b5yt170q7jsdn4xz6pfhr0000gn/T/release-tests-1793215725560.log`.
- 재발: 2026-10-30 세션 작업 리스트 1차 회귀 묶음(10 스펙 · 스왑 48G) — `:141` 1회 실패(행이 10초 안에 안 사라짐), 단독 재실행 15/15 통과.
- 재발: 2026-10-31 헤더 체크리스트 2차 회귀 묶음(8 스펙 · 스왑 49~54G, 30분 대기 뒤) — `:132` 「Cmd+] skips a session deleted from the sidebar」가 `Delete session` 클릭 「performing click action」에서 4.5분 멈춤(10-29 와 같은 모양). 같은 빌드 계열로 T26 단독 11/11 통과.
- 재발: 2026-11-01 v1.24.0 사전 점검 2·3회차(스왑 49~51G) — `:132` 가 두 번 모두, 3회차에는 `t40-session-tree.spec.ts:156` 「what you looked at … survives a restart」도 같은 `Delete session` 클릭 「performing click action」에서 4.5분 멈춤. 두 시험 단독 `--repeat-each=3` 6/6 통과(16초). 로그 `/tmp/climanager-release-124-build-2.log` · `/tmp/climanager-release-124-build.log` → 전체 `/var/folders/cx/yf5b5yt170q7jsdn4xz6pfhr0000gn/T/release-tests-1793464630529.log` · `-1793467211086.log`.
- Trigger: 사전 점검·묶음 실행에서 사이드바 삭제 시험이 다시 실패할 때.
- Fix direction: 실패 때 화면(확인 상자 여부)과 `hasRunningProcess` 값을 남긴다 → 원인이 상자면 시험 모드에서 확인을 건너뛰는 길, 빗나간 클릭이면 「hover → 버튼 보임 대기 → 클릭 → 행 사라짐」 재시도. 여러 시험(T26·T40·T45·T52)의 사이드바 삭제를 공용 도우미로 묶는 것은 사람 컨펌.
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
- Trigger: 새 머신·새 워크트리에서 `pnpm test:term`을 돌려야 할 때. (CI 는 2026-11-11 PR #117 부터 `ci.yml` 이 install-app-deps 를 직접 돈다.)
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
### `scripts/release.cjs` — 프리플라이트 테스트가 간헐적으로 실패하는데 원인을 못 잡았다
- Discovered: 2026-09-23, v1.9.0 배포 중 두 번
- Why deferred: 실패가 재현되지 않았고(직접 돌린 전체 스위트는 87건 통과), 배포를 멈추고 추적할
  단계가 아니었다. 같은 날 게이트가 실패 내역을 남기도록 고쳤으니(5e3edff) 다음에 재현되면
  어느 스펙인지 바로 나온다.
- Trigger: 다음 릴리즈에서 또 실패하면 그때 남는 `/tmp/release-tests-*.log` 로 스펙을 특정한다.
- Evidence: `--check` 1회차와 `--build` 1회차가 `tests failed` 로 멈췄고, 사이에 돌린
  `pnpm test:term` 은 87 passed (3.7m). 세 번째 `--check` 도 87 passed.
- 2026-10-29 v1.22.0 사전 점검(부하 15~21 · 스왑 49~56GB, 배치 밖 dev 서버·Docker): 1회차 T19-4 「text sent right after Escape arrives whole」 · 2회차 T1 「single visible terminal keeps seq output contiguous」(`last` 228478 / 300000 — `SEQ-DONE` 를 본 뒤에도 화면이 덜 따라옴) 각 1건 실패, 둘 다 단독 3/3 통과(T1 은 gap 0), 3회차 340 passed 로 공개. 로그 `/tmp/climanager-release-122-build-try1.log` · `-try2.log` · `/tmp/climanager-release-122-t19.log` · `-t1.log`. 바꾼 곳과 무관한 시험이 부하 높을 때만 하나씩 걸린다 — 한 회차에 한 건이면 단독 재실행 후 다시 빌드가 지금 절차.
- 2026-11-01 v1.24.0(스왑 49~51G · 부하 49): 세 회차가 매번 다른 시험에서 멈췄다 — 1회차 5건(T2 · T22 · T30 · T64 · T71, 367 passed) · 2회차 T19-4 · T26(370) · 3회차 T26 · T40(370). 기준판 bede9e5 에서도 T22 · T30 이 실패해 회귀가 아니었고, 실패한 시험은 모두 다른 회차 전체 실행에서 통과했다. 그래서 4회차는 두 시험 단독 6/6 확인 뒤 `--build --skip-tests` 로 공개했다(typecheck · build 는 그대로 돎). 로그 `/tmp/climanager-release-124-build-1.log` · `-2.log` · `/tmp/climanager-release-124-build.log` · `-build4.log`. 「한 회차에 한 건」 절차가 부하 높은 날은 세 회차를 먹는다 — 시험 실패만 따로 다시 돌리는 옵션(`--retry-failed`)이 있으면 회차마다 30분을 아낀다.
- Owner: Maintainer

### 개선안 — 여러 AI 세션의 상태 변화를 한 번에 기다리는 `watch`
- Discovered: 2026-09-29, 저녁 매니저 세션이 세션 5~6개를 동시에 관리하며
- Why deferred: 이번엔 외부 스크립트(상태를 20초마다 폴링하고 busy→idle 전환만 알림)로 대신했다.
- Trigger: Control API 개선 작업 착수 시
- Evidence: `wait` 는 세션 하나만 기다린다. 여러 개를 폴링하면 (1) 감시를 다시 거는 사이에 끝난 세션을 놓쳤고
  (2) 백그라운드 셸을 기다리며 잠깐 쉬는 세션을 완료로 잘못 알렸다(화면의 `shell still running` 으로 구분).
  제안: `GET /v1/events` 또는 `POST /v1/wait-any` — busy→idle·질문 대기 전환을 이벤트로, 백그라운드 셸 대기는 제외.
- Evidence 2026-10-31 (AI TOP 100 예선, 인터뷰 세션 8개 + 압축 세션 1개를 `watch-sessions.sh` 스트림 모드로 감시):
  - 한 세션(홍보라)이 12:0x~12:2x 사이 `QUESTION`↔`IDLE` 을 8번 넘게 오갔다. 원인은 아래 「Claude Code 안내 창」 항목이고, 감시에서 그 세션을 `grep -v` 로 빼서야 조용해졌다.
  - 세션이 Bash 명령을 배경으로 돌리고 턴을 끝내면(`1 shell still running`) 일은 계속 도는데 감시는 `IDLE` 로 알렸다 — 위 (2) 와 같은 것이 9개 세션 규모에서 계속 났다.
  - 감시를 Claude Code `Monitor` 로 걸면 30분마다 끝나 다시 걸어야 했다(4시간 동안 6번). 앱 쪽 이벤트 스트림이 있으면 감시 스크립트 재기동이 필요 없다.
  - 재현 명령: `SESSION_PREFIX='AI: aitop' WATCH_STREAM=1 zsh ~/skills/macbook-cc/climanager-session/scripts/watch-sessions.sh` — 안내 창이 뜬 세션 하나만 있어도 같은 줄이 반복된다.
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

### `src/main/TerminalMirror.ts` `showsAwaitingInput` — 일하는 세션도 화면에 대화상자 문구가 있으면 「질문 대기」로 읽힌다
- Discovered: 2026-10-29, fb-1029b 상태 점 작업 중 총괄 관찰(14:30) — 시험 픽스처의 `Esc to cancel` 이 도구 출력으로 화면에 떠 있던 세션 4개가 스피너가 도는데도 `clim sessions`·Related 에서 질문 대기였다
- Why deferred: 이 판정은 API 입력 거부(409, AI Control API 불변식 3)의 안전장치다. 느슨하게 바꾸면 진짜 질문에 글이 들어가 Enter 가 보기를 고를 수 있어 따로 정한다. 사이드바 상태 점(`screenStatus`)은 1.23.0 에서 엄격한 규칙을 이미 쓴다
- Trigger: `clim send` 가 일하는 세션에 409 로 막히거나, Related 「Waiting for you」 가 일하는 세션에 뜬다는 제보
- Evidence: 실제 Claude Code 2.1.312 권한 질문·AskUserQuestion 화면에는 스피너(`esc to interrupt`)도 입력 상자(─ 규칙선 둘 + `❯`)도 없다(fb-1029b `review/climanager/evidence/*-claude-2.1.312.txt`). 제안: `screenStatus` 와 같은 두 규칙 — 작업 중이면 질문 아님, 입력 상자가 있으면 그 아래만 — 을 `showsAwaitingInput` 에도. 먼저 Codex 질문 화면 한 장으로 확인(Codex 입력 상자에는 ─ 규칙선이 없다). T66 의 「API 는 그대로 true」 단언을 같이 바꾼다
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
- Evidence 2026-10-31 (AI TOP 100 예선): 인터뷰 세션 8개의 진행(질문 N/100 · 발굴률 X%)을 보려고 각 세션이 자기 장부 파일 첫 줄에
  `<!-- 상태: … -->` 를 쓰고 총괄이 `head -1 ledger/*.md` 로 읽었다. 사이드바에서 한눈에 보이지 않아 사람이 진행을 물을 때마다 총괄이 표로 다시 옮겼다.
  메모 쓰기가 보류라면 대안: 사용자 메모와 **별도인 「AI 상태 한 줄」 필드**(AI 만 쓰고 사람 메모를 건드리지 않음 — 위 충돌 문제를 피한다)를 사이드바 세션 행 아래에.
- Owner: Human Review

### Claude Code 안내 창(「Teach auto mode about your environment?」)이 쉬는 세션을 막는다 — API 로는 닫을 길이 없다
- Discovered: 2026-10-31, AI TOP 100 예선 — auto 모드로 연 인터뷰 세션들.
- Evidence: Claude Code 가 auto 모드 세션이 턴을 마칠 때 `Teach auto mode about your environment? ❯ 1. Yes 2. Not now 3. Don't show again · Enter to confirm · Esc to cancel` 를 띄운다.
  - 이 창은 권한 질문이 아니라 기능 안내인데, 화면 판정이 질문 대기로 읽어 `clim send` 가 종료코드 3 으로 거부됐다(홍보라·고길동 세션, 12:0x).
  - 총괄 AI 가 `clim send <세션> --keys down,enter`(Not now)로 닫으려 하자 총괄 쪽 auto 모드 검사기가 「Auto-Mode Bypass」로 막았다 — 결국 사람이 세션마다 눌러야 했다.
  - 세션이 배경 셸로 턴을 끝낼 때마다 다시 떠서(「Not now」) 같은 세션에 반복된다.
- Why deferred: 어떤 창을 AI 가 대신 닫아도 되는지는 안전 경계(질문 대기 = 입력 거부, AI Control API 불변식 3)라 사람 결정이다.
- Trigger: 사람이 세션마다 이 창을 닫아 달라는 요청을 또 받을 때, 또는 Claude Code 가 비슷한 안내 창을 더 늘릴 때.
- 제안: ① 판정에서 「알려진 안내 창」(권한·AskUserQuestion 이 아님)을 따로 분류해 `awaitingInput` 대신 `tip` 상태로 · ② 앱 설정 「AI 세션의 안내 창은 자동으로 Not now」(허용 목록 문구만) · ③ 화면에 안내 창이 있을 때 사이드바 행에 「사람 확인 필요 — 안내 창」 표시.
- Owner: Human Review

### 세션 템플릿 — auto 모드로 여는 Claude Code 템플릿이 없다
- Discovered: 2026-10-31, AI TOP 100 예선 — 외부 글(관계자 답)을 다루는 세션을 우회 모드(`cldy`) 대신 열려다.
- Evidence: `clim templates` 는 `claude-code`(cldy = 권한 우회) 뿐이다. `--command "claude --permission-mode default --allowedTools …"` 로 연 세션 3개는
  첫 명령 `pwd; ls; ls ..; date` 에서 바로 승인 창에 섰다(허용 목록이 복합 셸을 못 덮음). `--command "claude --permission-mode auto --disallowedTools Agent Task WebFetch WebSearch"` 로 다시 열어 9개가 승인 창 없이 돌았다.
- Why deferred: 템플릿 목록은 사용자 설정이라 기본값을 바꾸는 건 사람 결정이다.
- Trigger: 외부 글을 읽는 세션을 우회 모드 없이 여러 개 열 일이 또 생길 때.
- 제안: 기본 템플릿에 `claude-auto`(`claude --permission-mode auto`)를 추가하고, `clim open --template claude-auto` 로 열 수 있게.
- Owner: Human Review

### 숨긴 세션의 시작 크기 — PR #47 뒤에 남은 것
- Discovered: 2026-10-23 day-1023, PR #47 총괄 독립 리뷰.
- Evidence: #47 은 숨긴 채 만든 세션도 상자 크기로 PTY 를 띄운다. 그래도 남는 경우가 셋이다.
  ① 숨긴 세션은 **보이기 전에 잰 크기**를 그대로 쓴다 — 앱 시작 중 사이드바·글꼴 로딩으로 상자가 최종 크기와 다르거나, 숨긴 동안 창 크기를 바꾸면 처음 볼 때 resize 가 한 번 일어난다(옛 코드보다 확률은 낮다).
  ② 분할 화면에서 숨긴 세션은 **전체 폭**으로 재서 시작하고, 칸에 처음 보일 때 resize 된다(옛 코드와 같음).
  ③ 시험 공백: T41 은 20×5 가드(`MIN_HIDDEN_FIT_COLS`·`MIN_HIDDEN_FIT_ROWS`) · 분할 칸 · 이미 살아 있는 PTY 에 다시 붙는 경로(`existed: true`) · 실제 Claude 를 덮지 않는다.
- Why deferred: #47 이 가장 흔한 원인(80×30 시작)을 없앴고, 남은 셋은 처음 볼 때 resize 를 0 으로 만드는 일이라 위 「높이만 바뀌는 resize」 보정(공용 모듈, 사람 컨펌)과 같이 풀어야 덜 겹친다.
- Trigger: 사람이 높이 보정 공용 모듈을 승인할 때, 또는 #47 뒤에도 재시작·분할 화면에서 표 잘림 제보가 올 때.
- Fix direction: 보이기 직전에 한 번 더 재서 다르면 그때 PTY 를 맞추고(보이기 전이라 잔해가 화면에 안 남음), 분할 칸은 칸 상자로 잰다. T41 에 가드·분할·`existed` 경우를 더하고, 실제 Claude 녹화 재생을 고정 입력으로 쓴다.
- 2026-11-05 resize-anchor-1105 판정: 높이 보정(공용 모듈)과 PTY resize 한 번 묶기는 들어갔다. ①·②는 **안 함** — 보이기 직전에 재든 직후에 재든 PTY resize 는 한 번이라
  SIGWINCH·다시 그리기 횟수는 같고, 그 resize 가 높이만 다르면 이제 무해하다(T86·T87). 폭이 다른 경우(분할 칸·숨긴 동안 창 폭 변경)는 Claude 가 화면만 다시 칠하는 문제라
  미리 재도 「어느 칸에 보일지」를 레이아웃보다 먼저 알아야 해서 위험 대비 이득이 작다. ③ 시험 공백은 그대로(T41 에 가드·분할·`existed` 경우 없음).
- Trigger (갱신): 분할 화면에 처음 띄운 세션에서 표가 끊긴다는 제보(폭 변경 계열)가 오면 ②부터.
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

### 헤더 「상위 세션」 바로가기는 끌어 넣은(손 짝) 부모를 따르지 않는다
- Discovered: 2026-10-29 fb-1028, 제보 9fa825e7(끌어 넣은 자리 = 부모) 작업 세션 B.
- Evidence: 1.22.0 부터 사이드바 Tree·Related 창은 손으로 끌어 넣은 짝을 부모→자식으로 그리고 손 짝이 연 세션을 이긴다(`splitTreeRelations`). 헤더 ↑ 바로가기(`parentSessionsOf`, `SessionNavButtons.tsx`)는 여전히 `manual` 을 빼고 「이 세션을 연 세션」만 본다 — 끌어 옮긴 세션에서 트리 부모와 ↑ 가 다른 곳을 가리킨다. 버튼 글도 "the session that opened this one" 이라 의미로는 맞다.
- Why deferred: 그 파일들(App.tsx·SessionNavButtons)이 이번 브랜치 몫이 아니었고, 제보가 사이드바·Related 창만 말했다.
- Trigger: 끌어 옮긴 세션에서 ↑ 가 트리와 다른 세션으로 간다는 제보.
- Fix direction: `parentSessionsOf` 가 `splitTreeRelations` 의 부모를 쓰고 버튼 글을 「위 세션」으로. T50 갱신.
- Owner: 없음

### `relatedSessionsFor` · `RelatedGroups.manual` 을 아무도 안 부른다
- Discovered: 2026-10-29 fb-1028, PR #73 독립 리뷰.
- Evidence: `src/renderer/src/utils/relatedSessions.ts` 의 `relatedSessionsFor` 는 export 만 있고 src 에 호출이 없다(Related 창은 `sessionTreeFor` 로 바뀜). 그 안의 `manual` 묶음은 1.22.0 의 「손 짝은 트리 안」 모델과 다르다 — 누가 다시 쓰면 손 짝이 따로 빠진다.
- Why deferred: 이번 범위는 제보 5건이었고 지워도 동작은 같다.
- Trigger: `relatedSessions.ts` 를 다음에 고칠 때.
- Fix direction: 함수와 `RelatedGroups` 타입을 지우고 T34 의 해당 줄을 정리.
- Owner: 없음

### 터미널 ⌘-클릭 링크는 한글 파일명·이미지 확장자·끊긴 경로를 잡지 않는다
- Discovered: 2026-10-29 fb-1028, 제보 09eff960 · 85703148 작업 세션 A(`A-30-options.md`).
- Evidence: `src/renderer/src/utils/filePathLinkProvider.ts` 정규식은 `\w`·코드 확장자만 본다 — `/private/tmp/…/1-비교표-시안.jpg` 는 링크가 아니다. 1.22.0 은 **선택**(우클릭·⌘⇧O/E·⌘C)만 고쳤다(`terminalPathSelection.ts`).
- Why deferred: 확장자 목록·문자 집합과 URL 오탐 가드를 같이 손봐야 해서 별도 작업.
- Trigger: 한글 경로·사진 경로를 ⌘-클릭해도 안 열린다는 제보.
- Fix direction: 「한글 포함 절대경로 + 이미지·문서 확장자」만 더하고, 들여쓴 이어짐은 `terminalPathSelection` 의 잇기 규칙을 같이 쓴다. T14 에 한글·jpg 경우.
- Owner: 없음

## Blocked

없음.
