# Phone Parity Checklist

Mac 에 화면·동작을 더하는 PR 은 **폰(phone.html)이 그걸 받는지** 한 줄로 정한다. 정하지 않으면 폰은 조용히 뒤처진다
(2026-11-28 실측: 11-10 이후 기능·수정 머지 59건 중 폰 짝이 필요했는데 빠진 것 6건 — 역할·태그 · agy Chat · @ 세션 · 답 스레드 칩·칸 · Threads 목록).

## PR 본문에 한 줄

```
폰: 함 (T__) | 공용 부품이라 따라감 | 안 함 — <결정 번호 또는 이유> | 백로그 — <항목 제목>
```

- **공용 부품이라 따라감** — `components/ChatView/` 안에서 끝나고 `ChatTransport` 의 새 메서드가 없을 때만. 폰은 `touch` 로 그 Chat 을 그린다.
- **안 함** — 아래 「일부러 안 하는 것」에 걸리거나, 폰이 한 화면이라 뜻이 없는 것(탭·분할·단축키).
- **백로그** — `docs/backlog.md` 에 폰 항목을 같은 PR 에 적는다. 「나중에」만 쓰지 않는다.

## 조용히 꺼지는 곳 — 이것을 건드렸으면 폰을 확인한다

| 건드린 것 | 폰에서 일어나는 일 |
| --- | --- |
| `ChatTransport` 에 선택 메서드(`?`)를 더함 | `src/renderer/src/phone/phoneChatTransport.ts` 에 없으면 버튼이 **말없이 숨는다** |
| ChatView 에 `touch` 분기를 더함 | 폰에서만 꺼진다 — 왜 끄는지 주석에 적는다 |
| 에이전트 종류(`cliToolName`)를 더함 | `src/main/phone/phoneSetup.ts` 의 `agent` 판정(두 곳)이 claude·codex 만 본다 — 새 에이전트는 폰 Chat 이 없다 |
| 사이드바 목록·줄 표시를 바꿈 | 폰 목록은 따로 그린다(`phone/SessionList.tsx`·`sessionListLines.ts`). 순서·나무는 main 이 같이 계산(`phoneSetup.ts`) |
| 세션 목록에서 무언가를 숨김 | 폰도 숨는지, 숨긴 것에 닿는 다른 길(칩·목록)이 폰에 있는지 |

## 일부러 안 하는 것 (결정이 막는다 — 바꾸려면 결정부터)

- 폰이 세션을 만들기 · 터미널 크기 바꾸기 — [`docs/decisions/0009`](../../docs/decisions/0009-phone-connection-second-server.md)
- Control API 토큰을 폰에 주기 — 0009
- 대화에 안 나온 파일 읽기 — [`0010`](../../docs/decisions/0010-phone-reads-only-what-the-chat-names.md)
- 문서 칸에서 네트워크 쓰기 — [`0011`](../../docs/decisions/0011-phone-documents-in-a-sandboxed-frame.md)
- 받아쓰기 기록을 폰으로 내보내기 — [`0012`](../../docs/decisions/0012-dictation-log-stays-on-this-mac.md)

지금 남은 격차와 순서는 `docs/backlog.md` 「폰 ↔ Mac 격차」 항목들이 원본이다.
