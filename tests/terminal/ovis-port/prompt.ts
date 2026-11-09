/**
 * ovis tests moved onto src/main/promptScreen.ts (group G = prompt).
 * Source: ovis server/prompt.test.ts (parseInteractivePrompt / answerKeys on Claude screens) @3e51902 (MIT, devswha).
 * server/dialogs/claude.test.ts is all about features we do not have (rewind, /effort slider, /goal, question tabs as
 * steps, fullscreen diff panel, words over the question) — counted in the report, not moved.
 *
 * Screens and expected values are ovis's. Only the call shape changes:
 *   parseInteractivePrompt("claude", s)  ->  readPrompt(s.split("\n"), "claude")
 *   answerKeys(p, {option_index})        ->  answerSteps(menu, {signature, optionIndex}) mapped to {keys:[..]} / {text}
 * Fields this app's PromptMenu does not have (title, body, answers, custom_option_index, multi answers) are left out of
 * the comparison; "custom_option_index" becomes `options[i].custom`, and ovis's `labels()` (which leaves the typed-answer
 * row out) filters `custom` rows.
 */
import { test, expect } from '@playwright/test'
import { answerSteps, KEYS, readPrompt } from '../../../src/main/promptScreen'
import type { PromptMenu } from '../../../src/shared/conversation'

const parse = (screen: string): PromptMenu | null => readPrompt(screen.split('\n'), 'claude')
// ovis's option list leaves out the typed-answer row and the trailing "Chat about this" row; ours lists both (the latter is
// asserted separately below), so both are filtered here to compare the answers themselves.
const isAnswer = (o: { custom?: boolean; label: string }): boolean => !o.custom && !/^Chat about this$/i.test(o.label)
const labels = (menu: PromptMenu | null): string[] | undefined => menu?.options.filter(isAnswer).map((o) => o.label)
const customIndex = (menu: PromptMenu | null): number | null => {
    const i = menu?.options.findIndex((o) => o.custom) ?? -1
    return i < 0 ? null : i
}
const KEY_NAME: Record<string, string> = { [KEYS.up]: 'up', [KEYS.down]: 'down', [KEYS.enter]: 'enter' }
/** ovis answerKeys shape: [{keys:['down']}, {text}] */
const keys = (menu: PromptMenu, answer: { option_index: number } | { custom_text: string }) =>
    answerSteps(menu, 'custom_text' in answer ? { signature: menu.signature, customText: answer.custom_text } : { signature: menu.signature, optionIndex: answer.option_index }).map((step) =>
        'key' in step ? { keys: [KEY_NAME[step.key]] } : { text: step.text }
    )
const flatKeys = (menu: PromptMenu, answer: { option_index: number }): string[] => keys(menu, answer).flatMap((s) => ('keys' in s ? s.keys : [])) as string[]
/** ovis kinds -> ours: approval=permission, a trust dialog is a menu there */
const ovisKind = (menu: PromptMenu | null): string | undefined => (menu ? ({ permission: 'approval', trust: 'menu' } as Record<string, string>)[menu.kind] ?? menu.kind : undefined)

const RULE = '─'.repeat(80)
const DASH = '╌'.repeat(80)

test.describe('ovis server/prompt.test.ts', () => {
    test.describe('interactive prompt parsing', () => {
        test('parses Claude questions, approvals, and plans — question', () => {
            const questionScreen = `
☐ Dataset

Which evaluation dataset should we use?

❯ 1. LM-O
     Occlusion benchmark.
  2. YCB-V
     Household objects.
  3. T-LESS
     Texture-less objects.
  4. Type something.
────────────────────────────
  5. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel
`
            const question = parse(questionScreen)
            expect(question).toMatchObject({ agent: 'claude', kind: 'question', question: 'Which evaluation dataset should we use?', multi: false })
            expect(customIndex(question)).toBe(3)
            expect(labels(question)).toEqual(['LM-O', 'YCB-V', 'T-LESS'])
            expect(question?.options[0]?.description).toBe('Occlusion benchmark.')
            expect(parse(questionScreen)?.signature).toBe(question?.signature)
        })

        test('parses Claude questions, approvals, and plans — approval', () => {
            const approval = parse(`
Bash command

  curl -I https://example.com
  Fetch HTTP headers.

This command requires approval

Do you want to proceed?
❯ 1. Yes
  2. Yes, and don’t ask again for: curl *
  3. No

Esc to cancel · Tab to amend · ctrl+e to explain
`)
            expect(ovisKind(approval)).toBe('approval')
            expect(labels(approval)).toEqual(['Yes', 'Yes, and don’t ask again for: curl *', 'No'])
        })

        test('parses Claude Code 2.1 question tabs, their review, and tool approvals without the old markers — first question', () => {
            const first = parse(`
←  ☐ Route  ☐ Author  ✔ Submit  →
Which way should the PR go?
❯ 1. Log in as owner
     Authenticate as the repository owner and open the PR directly on the repo.
  2. Fork
     Push the branch to a fork and open the PR from there.
  3. Type something.
────────────────────────────────────────
  4. Chat about this
Enter to select · Tab/Arrow keys to navigate · Esc to cancel
`)
            expect(first).toMatchObject({ kind: 'question', question: 'Which way should the PR go?' })
            expect(customIndex(first)).toBe(2)
            expect(labels(first)).toEqual(['Log in as owner', 'Fork'])
        })

        test('parses Claude Code 2.1 question tabs, their review, and tool approvals without the old markers — multiple choice tab', () => {
            const sets = parse(`
←  ☒ Route  ☐ Sets  ✔ Submit  →
Which datasets?
❯ 1. [ ] LM-O
         Include the LM-O dataset.
  2. [ ] YCB-V
         Include the YCB-V dataset.
  3. [ ] T-LESS
         Include the T-LESS dataset.
  4. [ ] Type something
     Next
────────────────────────────────────────
  5. Chat about this
Enter to select · Tab/Arrow keys to navigate · Esc to cancel
`)
            expect(sets).toMatchObject({ multi: true })
            // ovis lists the three datasets without their "[ ]" boxes and without the typed-answer / chat rows
            expect(labels(sets)).toEqual(['LM-O', 'YCB-V', 'T-LESS'])
        })

        test('parses Claude Code 2.1 question tabs, their review, and tool approvals without the old markers — review of answers', () => {
            const review = parse(`
←  ☒ Route  ☒ Author  ✔ Submit  →
Review your answers
 ● Which way should the PR go?
   → Log in as owner
 ● Who should author the commits?
   → Repo owner
Ready to submit your answers?
❯ 1. Submit answers
  2. Cancel
`)
            // ovis calls it a menu; ours is 'review', so the card can list the answers (chat-gap-1109 Q-1)
            expect(review).toMatchObject({ kind: 'review', question: 'Ready to submit your answers?' })
            expect(customIndex(review)).toBeNull()
            expect(labels(review)).toEqual(['Submit answers', 'Cancel'])
        })

        const bashScreen = `
● Deleting the junk directory
  ⎿  $ rm -rf junk
────────────────────────────────────────
 Bash command
 Tip: auto mode handles these prompts for you — choose "switch to auto mode" below
   rm -rf junk
   Delete the junk directory
 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and always allow access to /tmp/prompt-lab/junk from this project
   3. Yes, and switch to auto mode · auto mode handles these prompts for you
   4. No
 Esc to cancel · Tab to amend
`
        test('parses Claude Code 2.1 question tabs, their review, and tool approvals without the old markers — bash approval', () => {
            const bash = parse(bashScreen)!
            expect(ovisKind(bash)).toBe('approval')
            expect(bash.question).toBe('Do you want to proceed?')
            expect(labels(bash)).toEqual(['Yes', 'Yes, and always allow access to /tmp/prompt-lab/junk from this project', 'Yes, and switch to auto mode · auto mode handles these prompts for you', 'No'])
            expect(keys(bash, { option_index: 3 })).toEqual([{ keys: ['down'] }, { keys: ['down'] }, { keys: ['down'] }, { keys: ['enter'] }])
        })

        test('parses Claude Code 2.1 question tabs, their review, and tool approvals without the old markers — a narrow pane wraps a long option', () => {
            test.fail(true, "ovis-port bug: an option label wrapped over rows is not joined (reads only the first row)")
            const wrapped = parse(`
────────────────────────────────────────
 Bash command
   rm -rf junk
 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and always allow access to
   /tmp/prompt-lab/junk from this project
   3. No
 Esc to cancel · Tab to amend
`)
            expect(labels(wrapped)).toEqual(['Yes', 'Yes, and always allow access to /tmp/prompt-lab/junk from this project', 'No'])
        })

        test('parses Claude Code 2.1 question tabs, their review, and tool approvals without the old markers — Claude text opens with a bullet too', () => {
            const underText = parse(`
● Results table follows:
────────────────────────────────────────
  run   AR
────────────────────────────────────────
  a     0.66
────────────────────────────────────────
 Bash command
   rm -rf junk
   Delete the junk directory
 Do you want to proceed?
 ❯ 1. Yes
   2. No
 Esc to cancel · Tab to amend
`)
            expect(ovisKind(underText)).toBe('approval')
            expect(labels(underText)).toEqual(['Yes', 'No'])
            // ovis: title "Bash command" + body "rm -rf junk\nDelete the junk directory"; here title and body are one context list
            expect(underText?.context).toEqual(['Bash command', 'rm -rf junk', 'Delete the junk directory'])
        })

        test('parses Claude Code 2.1 question tabs, their review, and tool approvals without the old markers — MCP call', () => {
            const mcp = parse(`
● github - create_issue (MCP)(title: "Flaky test")
────────────────────────────────────────
 Tool use
   github - create_issue(title: "Flaky test")
────────────────────────────────────────
 Do you want to proceed?
 ❯ 1. Yes
   2. No
 Esc to cancel · Tab to amend
`)
            expect(ovisKind(mcp)).toBe('approval')
            expect(labels(mcp)).toEqual(['Yes', 'No'])
        })

        test('parses Claude Code 2.1 question tabs, their review, and tool approvals without the old markers — file write', () => {
            const write = parse(`
● Write(hello.txt)
────────────────────────────────────────
 Create file
 hello.txt
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
  1 hi
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 Do you want to create hello.txt?
 ❯ 1. Yes
   2. Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)
   3. No
 Esc to cancel · Tab to amend
`)
            expect(ovisKind(write)).toBe('approval')
            expect(write?.question).toBe('Do you want to create hello.txt?')
        })

        test("finds Claude's question tabs over a wrapped question and a cut-off bar, and never answers the next question — wrapped question", () => {
            test.fail(true, "ovis-port bug: a question wrapped over several rows is not joined (reads only the last row)")
            const wrapped = parse(`
────────────────────────────
←  ☒ Route  ☐ Author  ✔ Su
Who should author the
commits that go into the
pull request, given that
the fork belongs to the
lab account and the
upstream repository to
its owner?
❯ 1. Keep local
     The local git identity.
  2. Repo owner
     The repository owner.
  3. Type something.
────────────────────────────
  4. Chat about this
Enter to select · Tab/Arrow keys to navigate · Esc to cancel
`)!
            expect(wrapped.kind).toBe('question')
            expect(wrapped.question).toBe('Who should author the commits that go into the pull request, given that the fork belongs to the lab account and the upstream repository to its owner?')
            expect(keys(wrapped, { option_index: 1 })).toEqual([{ keys: ['down'] }, { keys: ['enter'] }])
        })

        test('titles a Claude approval from its panel, not from rules in a file preview, and joins labels wrapped over lines', () => {
            test.fail(true, "ovis-port bug: an option label wrapped over rows is not joined")
            const edit = parse(`
● Write(notes.md)
────────────────────────────────────────
 Create file
 notes.md
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
  1 # Notes
  2 ────────────────────────────────────────
  3 Results below the rule
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 Do you want to create notes.md?
 ❯ 1. Yes
   2. Yes, and switch to accept edits
   (auto-approve file edits and common
   file commands) for this session
   3. No
 Esc to cancel · Tab to amend
`)
            expect(ovisKind(edit)).toBe('approval')
            expect(edit?.question).toBe('Do you want to create notes.md?')
            expect(labels(edit)).toEqual(['Yes', 'Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session', 'No'])
        })

        test('ignores unknown agents, stale transcript menus, and ordinary output — ordinary output', () => {
            expect(parse('hello\nworld\n')).toBeNull()
            expect(parse('1. First\n2. Second\n')).toBeNull()
        })
    })

    test.describe("Claude's question in a narrow pane", () => {
        const narrow = `────────────────────────────────────────────
 ☐ 재현 테스트

│ 재현용 테스트 질문입니다. 지금 이 질문
│ 화면을 백그라운드에서 캡처하고 있으니,
│ 15초쯤 기다렸다가 아무거나 골라 주세요.
│ 기다리는 동안 채팅 모드에 이 질문 카드가
│ 뜨는지도 봐 주시면 좋습니다.

❯ 1. 채팅에 카드가 안 떠요
     채팅 모드에 이 질문이 보이지 않음
  2. 채팅에 카드가 떠요
     채팅 모드에 이 질문이 카드로 보임
  3. Type something.
────────────────────────────────────────────
  4. Chat about this

Enter to select · ↑/↓ to navigate · Esc to
cancel
`
        test('reads the question though its hint wrapped, and knows it is still open', () => {
            test.fail(true, "ovis-port bug: question lines drawn behind a │ bar and a hint wrapped onto two rows: question is not the boxed text")
            const prompt = parse(narrow)
            expect(prompt?.kind).toBe('question')
            expect(labels(prompt)).toEqual(['채팅에 카드가 안 떠요', '채팅에 카드가 떠요'])
            expect(customIndex(prompt)).toBe(2)
            expect(prompt?.question.startsWith('재현용 테스트 질문입니다.')).toBe(true)
        })

        test('does not take an answered menu above later output for an open one', () => {
            expect(parse(narrow + '\n● Done.\n\n> ')).toBeNull()
        })
    })

    test.describe('a question under a numbered message sent earlier', () => {
        const claude = `
❯ 1. 로그인해서 커넥트 눌럿어

⏺ Tailscale 로그인은 완료됐습니다.

  Ran 1 shell command
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
 ☐ Buzz 공개

│ Buzz를 Tailscale 없이 인터넷에서 쓰도록 공개할까요?

❯ 1. 공개 진행 (추천)
     Cloudflare Tunnel로 buzz.kilpenguin.com을 엽니다. 인바운드 포트는 열지 않습니다. relay는 닫힌 모드(멤버 키 서명만
     허용)이고 relay와 /pair만 노출합니다.
  2. Tailscale 유지
     지금 구성 그대로 갑니다(이미 동작 중).
  3. Type something.
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  4. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel
─────────────────────────────────────────────────────────────────────────────────────────────── Buzz 슬랙 대체 AI 조사 ─
`
        test("reads Claude's question, not the sent message, as the menu, with a description wrapped over two lines", () => {
            const prompt = parse(claude)!
            expect(prompt.kind).toBe('question')
            expect(prompt.question).toBe('Buzz를 Tailscale 없이 인터넷에서 쓰도록 공개할까요?')
            expect(customIndex(prompt)).toBe(2)
            expect(labels(prompt)).toEqual(['공개 진행 (추천)', 'Tailscale 유지'])
            expect(prompt.options.filter(isAnswer).map((o) => o.description)).toEqual([
                'Cloudflare Tunnel로 buzz.kilpenguin.com을 엽니다. 인바운드 포트는 열지 않습니다. relay는 닫힌 모드(멤버 키 서명만 허용)이고 relay와 /pair만 노출합니다.',
                '지금 구성 그대로 갑니다(이미 동작 중).'
            ])
            expect(keys(prompt, { option_index: 1 })).toEqual([{ keys: ['down'] }, { keys: ['enter'] }])
        })

        test("does not start the menu at a numbered line in the first option's description", () => {
            const prompt = parse(`
 ☐ Setup

How should we set up?

  1. Script
     Runs these steps:
     1. Install deps
❯ 2. Manual
     Follow the guide.
  3. Type something.
────────────────────────────────────────
  4. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel
`)!
            expect(prompt.kind).toBe('question')
            expect(prompt.question).toBe('How should we set up?')
            expect(customIndex(prompt)).toBe(2)
            expect(labels(prompt)).toEqual(['Script', 'Manual'])
            expect(keys(prompt, { option_index: 0 })).toEqual([{ keys: ['up'] }, { keys: ['enter'] }])
        })
    })

    test.describe("Claude's question with option previews", () => {
        const withPreview = `────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
←  ☐ Layout  ☐ Features  ✔ Submit  →

Which layout?

❯ 1. Grid                         ┌──────────────────────────────────────────┐
  2. List                         │ ┌──┐ ┌──┐                                │
                                  │ │  │ │  │                                │
                                  │ └──┘ └──┘                                │
                                  │ ┌──┐ ┌──┐                                │
                                  └──────────────────────────────────────────┘

                                  Notes: press n to add notes

────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  Chat about this

Enter to select · ↑/↓ to navigate · n to add notes · Tab to switch questions · Esc to cancel
`
        test('reads the options without the preview box and offers no typed answer', () => {
            test.fail(true, "ovis-port bug: option previews drawn in a box to the right are glued into the labels/descriptions")
            const prompt = parse(withPreview)!
            expect(prompt).toMatchObject({ kind: 'question', question: 'Which layout?', multi: false })
            expect(prompt.options.map((o) => [o.label, o.description ?? null])).toEqual([['Grid', null], ['List', null]])
            expect(customIndex(prompt)).toBeNull()
            expect(keys(prompt, { option_index: 1 })).toEqual([{ keys: ['down'] }, { keys: ['enter'] }])
            expect(() => keys(prompt, { custom_text: 'x' })).toThrow()
        })

        test('does not take an answered form above later output for an open one', () => {
            expect(parse(withPreview + '\n● Done.\n\n> ')).toBeNull()
        })

        const described = (cursorOn: 0 | 1) => cursorOn === 0 ? `────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
 ☐ Layout

Which layout should the report use?

❯ 1. Single Column                ┌──────────────────────────────────────────┐
  2. Two Column                   │ ┌──────────────────┐                     │
  3. Dashboard Grid               │ │     HEADER       │                     │
                                  │ ├──────────────────┤                     │
                                  │ │   Content here   │                     │
                                  │ │   More content   │                     │
                                  │ └──────────────────┘                     │
                                  └──────────────────────────────────────────┘

                                  Notes: press n to add notes

────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  Chat about this

Enter to select · ↑/↓ to navigate · n to add notes · Esc to cancel
` : `────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
 ☐ Layout

Which layout should the report use?

  1. Single Column                ┌──────────────────────────────────────────┐
❯ 2. Two Column                   │ ┌─────┬──────────┐                       │
  3. Dashboard Grid               │ │ KEY │ CONTENT  │                       │
                                  │ │ INF │ CONTENT  │                       │
                                  │ │ O   │ CONTENT  │                       │
                                  │ │     │ CONTENT  │                       │
                                  │ └─────┴──────────┘                       │
                                  └──────────────────────────────────────────┘

                                  Notes: press n to add notes

────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  Chat about this

Enter to select · ↑/↓ to navigate · n to add notes · Esc to cancel
`
        test('draws no option descriptions though the question gave them, and keeps its id as the cursor moves', () => {
            test.fail(true, "ovis-port bug: option previews drawn in a box to the right are glued into the labels")
            const first = parse(described(0))
            const second = parse(described(1))
            expect(labels(first)).toEqual(['Single Column', 'Two Column', 'Dashboard Grid'])
            expect(first?.options.map((o) => o.description ?? null)).toEqual([null, null, null])
            expect(second?.signature).toBe(first!.signature)
        })
    })

    test.describe("Claude's unnumbered menus", () => {
        const trust = (selected: 0 | 1 = 0, after = '') => `
❯ claude --model claude-haiku-4-5-20251001

────────────────────────────────────────────────────────────────────────────────
 Accessing workspace:

 /home/user/projects/new-app

 Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source
 project, or work from your team). If not, take a moment to review what's in this folder first.

 Claude Code'll be able to read, edit, and execute files here.

 Security guide

 ${selected === 0 ? '❯' : ' '} No, exit
 ${selected === 1 ? '❯' : ' '} Yes, I trust this folder

 Enter to confirm · Esc to cancel
${after}`

        test('reads the folder-trust check as a menu with its question and both rows', () => {
            const prompt = parse(trust())!
            expect(prompt).not.toBeNull()
            expect(ovisKind(prompt)).toBe('menu')
            expect(prompt.question).toBe('Is this a project you created or one you trust?')
            expect(labels(prompt)).toEqual(['No, exit', 'Yes, I trust this folder'])
        })

        test('answers from the native cursor, and keeps its id when only the cursor moves', () => {
            const prompt = parse(trust())!
            expect(keys(prompt, { option_index: 1 })).toEqual([{ keys: ['down'] }, { keys: ['enter'] }])
            expect(keys(prompt, { option_index: 0 })).toEqual([{ keys: ['enter'] }])
            const moved = parse(trust(1))!
            expect(keys(moved, { option_index: 0 })).toEqual([{ keys: ['up'] }, { keys: ['enter'] }])
            expect(() => keys(prompt, { custom_text: 'maybe' })).toThrow()
        })

        test('keeps its id when only the cursor moves', () => {
            test.fixme(true, "t73 'the signature changes when the highlight moves': answerSteps counts arrows from the highlighted row, so a moved cursor must make the card's answer stale (promptScreen.ts signature)")
            expect(parse(trust(1))!.signature).toBe(parse(trust())!.signature)
        })

        test('is gone once the menu is answered and Claude draws under it', () => {
            expect(parse(trust(1, ' ▐▛███▛█   Claude Code v2.1.285\n❯ Try "fix typecheck errors"\n'))).toBeNull()
        })

        test('keeps a label a narrow pane wrapped as one row', () => {
            const narrow = (selected: 0 | 1) => `
 Accessing workspace:

 Quick safety check: Is
 this a project you
 created or one you
 trust?

 ${selected === 0 ? '❯' : ' '} No, exit
 ${selected === 1 ? '❯' : ' '} Yes, I trust this
   folder

 Enter to confirm · Esc
 to cancel
`
            const prompt = parse(narrow(0))!
            expect(labels(prompt)).toEqual(['No, exit', 'Yes, I trust this folder'])
            expect(keys(prompt, { option_index: 1 })).toEqual([{ keys: ['down'] }, { keys: ['enter'] }])
            expect(labels(parse(narrow(1)))).toEqual(['No, exit', 'Yes, I trust this folder'])
        })

        test('never takes the next row for a wrapped label when a row is the widest line', () => {
            const two = (selected: 0 | 1) => `
 Trust?

 ${selected === 0 ? '❯' : ' '} Yes, trust this folder and continue
 ${selected === 1 ? '❯' : ' '} No, exit

 Enter to confirm · Esc to cancel
`
            expect(parse(two(0))).toBeNull()
            expect(labels(parse(two(1)))).toEqual(['Yes, trust this folder and continue', 'No, exit'])
            const three = `
 Trust?

 ❯ No, exit and keep this folder untrusted
   Yes
   Yes, and allow hooks too

 Enter to confirm · Esc to cancel
`
            expect(parse(three)).toBeNull()
            const panel = ` Trust? The first row is not the widest line here, so this one tells the width.\n${three.slice(' Trust?\n'.length + 1)}`
            const prompt = parse(panel)
            expect(labels(prompt)).toEqual(['No, exit and keep this folder untrusted', 'Yes', 'Yes, and allow hooks too'])
            expect(keys(prompt!, { option_index: 2 })).toEqual([{ keys: ['down'] }, { keys: ['down'] }, { keys: ['enter'] }])
        })

        test('leaves numbered rows and a menu without one selected row to the other readers', () => {
            test.fixme(true, "src/shared/conversation.ts:118-122 a menu with no readable option still gets a card that only offers Answer in Terminal (answerable:false)")
            // ovis also asserts null for a numbered menu here (left to its numbered reader); readPrompt IS that reader, so only
            // the nothing-selected case is moved.
            expect(parse('Pick one\n\n  First\n  Second\n\nEnter to confirm · Esc to cancel\n')).toBeNull()
        })
    })

    test.describe('Claude Code 2.1.29x approvals and questions', () => {
        const backgroundApproval = (selected: number, footer: string) => {
            const row = (index: number, label: string) => `${index === selected ? ' ❯ ' : '   '}${index + 1}. ${label}`
            return [
                '✻ Waiting for 1 background agent to finish', '', '─'.repeat(80),
                ' Bash command · from the general-purpose agent', ' Run shell command', '╌'.repeat(80),
                ' │ systemctl --user start demo.service', '╌'.repeat(80),
                ' │ Permission rule Bash(systemctl --user start:*) requires confirmation for this command.',
                ' /permissions to update rules', '', ' Do you want to proceed?',
                row(0, 'Yes'), row(1, "Yes, and don't ask again for: systemctl --user start demo.service"), row(2, 'No'),
                '', ` ${footer}`, ''
            ].join('\n')
        }
        const FOOTER = 'Esc to cancel · ctrl+x ctrl+k twice to stop background agents'

        test('accepts its exact background-agent footer, but not unknown trailing text', () => {
            for (const accepted of [FOOTER, 'Esc to cancel · Tab to amend', 'Esc to cancel · Tab to amend · ctrl+e to explain', 'Esc to cancel · ctrl+e to explain', 'Esc to cancel']) {
                const prompt = parse(backgroundApproval(1, accepted))
                expect(prompt).toMatchObject({ question: 'Do you want to proceed?' })
                expect(ovisKind(prompt)).toBe('approval')
                expect(labels(prompt)).toEqual(['Yes', "Yes, and don't ask again for: systemctl --user start demo.service", 'No'])
            }
            for (const unknown of ['Esc to cancel Password:', 'Esc to cancel · Password:', 'Esc to cancel · unknown trailing text', `${FOOTER} · Password:`]) {
                expect(parse(backgroundApproval(1, unknown))).toBeNull()
            }
        })

        test('an approval whose hint is Esc to cancel alone is a card', () => {
            const screen = [
                '● Bash(systemctl --user restart demo.service)', '  ⎿  Waiting…', '', RULE, ' Bash command', ' Restart the demo service', DASH,
                ' │ systemctl --user restart demo.service', DASH,
                ' │ Permission rule Bash(systemctl --user restart:*) requires confirmation for this command.',
                ' /permissions to update rules', '', ' Do you want to proceed?', '   1. Yes', " ❯ 2. Yes, and don't ask again for: systemctl *", '   3. No', '', ' Esc to cancel', ''
            ].join('\n')
            const prompt = parse(screen)!
            expect(ovisKind(prompt)).toBe('approval')
            expect(prompt.question).toBe('Do you want to proceed?')
            expect(prompt.options.map((o) => o.label)).toEqual(['Yes', "Yes, and don't ask again for: systemctl *", 'No'])
            expect(flatKeys(prompt, { option_index: 0 })).toEqual(['up', 'enter'])
        })

        test("a long command pushes the panel's title off the screen: still an approval", () => {
            const screen = [
                ...Array.from({ length: 24 }, (_, index) => ` │ echo line ${index}`), DASH,
                " A variable in this command can't be checked before it runs",
                ' │ Permission rule Bash(systemctl --user daemon-reload:*) requires confirmation for this command.',
                ' /permissions to update rules', '', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', '', ' Esc to cancel · Tab to amend', ''
            ].join('\n')
            const prompt = parse(screen)!
            expect(ovisKind(prompt)).toBe('approval')
            expect(prompt.question).toBe('Do you want to proceed?')
            expect(prompt.options.map((o) => o.label)).toEqual(['Yes', 'No'])
        })

        test('a question whose typed-answer row already holds a draft keeps it as the typed answer', () => {
            test.fail(true, "ovis-port bug: the Type something row holding a typed draft is a different text, so it is not found as the custom row")
            const screen = [
                '❯ which session should get the notes?', RULE, ' ☐ Session', '', 'Two sessions are open. Which one?', '',
                '  1. builder-a', '     started 15 hours ago', '  2. builder-b', '     started 13 hours ago',
                '❯ 3. neither, tell me their names', RULE, '  4. Chat about this', '',
                'Enter to select · ↑/↓ to navigate · ctrl+g to edit in VS Code · Esc to cancel', ''
            ].join('\n')
            const prompt = parse(screen)!
            expect(prompt).toMatchObject({ kind: 'question', question: 'Two sessions are open. Which one?' })
            expect(customIndex(prompt)).toBe(2)
            expect(prompt.options.filter(isAnswer).map((o) => o.label)).toEqual(['builder-a', 'builder-b'])
            expect(flatKeys(prompt, { option_index: 1 })).toEqual(['up', 'enter'])
        })

        test("an answered approval above another program's bare Esc to cancel hint is no card", () => {
            const screen = [RULE, ' Bash command', ' sudo -v', '', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', '', ' Esc to cancel · Tab to amend', 'Password:', 'Esc to cancel', ''].join('\n')
            expect(parse(screen)).toBeNull()
        })

        test('a menu ending in Chat about this with no question chip or rule over it has no typed-answer row', () => {
            const screen = ['Choose an item', '  1. Keep', '❯ 2. Delete', '  3. Chat about this', 'Enter to select · ↑/↓ to navigate · ctrl+g to edit in Vim · Esc to cancel', ''].join('\n')
            expect(customIndex(parse(screen))).toBeNull()
        })
    })

    test.describe("Claude's multiple choice ticked in the terminal", () => {
        const screen = (ticked: boolean, at: 'A' | 'B' | 'Submit' | 'Chat') => [
            `←  ${ticked ? '☒' : '☐'} Pick  ✔ Submit  →`, 'Which ones?',
            `${at === 'A' ? '❯' : ' '} 1. [${ticked ? '✔' : ' '}] Option A`, '         First description',
            `${at === 'B' ? '❯' : ' '} 2. [${ticked ? '✔' : ' '}] Option B`, '         Second description',
            '  3. [ ] Type something', `${at === 'Submit' ? '❯' : ' '}    Submit`, '─'.repeat(40),
            `${at === 'Chat' ? '❯' : ' '} 4. Chat about this`, 'Enter to select · ↑/↓ to navigate · Esc to cancel'
        ].join('\n')

        test('reads [✔] rows as ticked, without the box in their labels', () => {
            const prompt = parse(screen(true, 'B'))!
            expect(prompt).toMatchObject({ kind: 'question', question: 'Which ones?', multi: true })
            expect(customIndex(prompt)).toBe(2)
            expect(prompt.options.filter(isAnswer).map((o) => o.label)).toEqual(['Option A', 'Option B'])
        })

        test('keeps the card with the cursor on Submit, counting the moves from that row', () => {
            const prompt = parse(screen(true, 'Submit'))!
            expect(prompt).toMatchObject({ question: 'Which ones?', multi: true })
            expect(prompt.options.filter(isAnswer).map((o) => o.label)).toEqual(['Option A', 'Option B'])
        })
    })
})
