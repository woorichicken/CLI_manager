import { test, expect } from '@playwright/test'
import fs from 'fs'
import path from 'path'
import { answerSteps, confirmTarget, KEYS, readPrompt } from '../../src/main/promptScreen'

/**
 * T108 — question cards off real screens, round chat-gap-1109 (Q-1 · Q-2 · Q-3 · Q-4 · Q-6). No Electron.
 *
 * The screens are copies of real Claude Code 2.1.319 and codex-cli 0.166.0 screens, captured on
 * 2026-11-09 in throwaway folders (fixtures/prompts, the user name and session id masked to the same
 * length so the line widths stay). The keys expected here are the ones pressed while capturing them:
 * Enter ticks a multiple-choice row, the cursor walks the rows top to bottom with the Next/Submit row
 * between "Type something" and "Chat about this", Enter on that row goes on (next question or the
 * review), Enter on "Submit answers" sends them. Codex's "No … (esc)" is Esc, as its label says.
 */

const screen = (name: string): string[] =>
    fs.readFileSync(path.join(__dirname, 'fixtures/prompts', name), 'utf8').replace(/\s+$/, '').split('\n')
const { up, down, enter, esc } = KEYS
const keys = (...list: string[]) => list.map((key) => ({ key }))

test.describe('T108 Claude question tabs (Q-3)', () => {
    test('the tab bar is steps, not context: answered marks read, the Submit tab last', () => {
        const menu = readPrompt(screen('claude-2.1.319-multi-q1.txt'), 'claude')!
        expect(menu.question).toBe('Which color?')
        expect(menu.context).toEqual([])
        expect(menu.steps).toEqual([
            { label: 'Color', answered: false },
            { label: 'Fruits', answered: false },
            { label: 'Size', answered: false },
            { label: 'Submit', answered: false, submit: true }
        ])
        const next = readPrompt(screen('claude-2.1.319-multi-q2.txt'), 'claude')!
        expect(next.steps?.map((step) => step.answered)).toEqual([true, false, false, false])
    })

    test('a single question with options still answers by arrows and Enter', () => {
        const menu = readPrompt(screen('claude-2.1.319-multi-q3.txt'), 'claude')!
        expect([menu.multi, menu.answerable]).toEqual([false, true])
        expect(menu.options.map((o) => o.label)).toEqual(['Small', 'Large', 'Type something.', 'Chat about this'])
        expect(answerSteps(menu, { signature: menu.signature, optionIndex: 1 })).toEqual(keys(down, enter))
    })
})

test.describe('T108 Claude multiple choice (Q-2)', () => {
    test('checkboxes become ticks, the Next row is not a description, Type something is the typed answer', () => {
        const menu = readPrompt(screen('claude-2.1.319-multi-q2.txt'), 'claude')!
        expect([menu.multi, menu.answerable]).toEqual([true, true])
        expect(menu.options.map((o) => [o.label, o.checked ?? null, o.selected])).toEqual([
            ['Apple', false, true],
            ['Banana', false, false],
            ['Cherry', false, false],
            ['Type something', false, false],
            ['Chat about this', null, false]
        ])
        expect(menu.options[3].custom).toBe(true)
        expect(menu.options[3].description).toBeUndefined()
        expect(menu.submitRow).toEqual({ label: 'Next', selected: false, after: 3 })
    })

    test('ticks what differs, then Enter on the Next row (the keys used to capture the next screens)', () => {
        const menu = readPrompt(screen('claude-2.1.319-multi-q2.txt'), 'claude')!
        const answer = { signature: menu.signature, optionIndices: [0, 2] }
        expect(answerSteps(menu, answer)).toEqual(keys(enter, down, down, enter, down, down, enter))
        expect(confirmTarget(menu, answer)).toBe(0)
    })

    test('ticked on screen already: only the difference is pressed; the cursor below a tick counts from there', () => {
        const menu = readPrompt(screen('claude-2.1.319-multi-q2-ticked.txt'), 'claude')!
        expect(menu.options.map((o) => o.checked ?? null)).toEqual([true, false, true, false, null])
        expect(menu.options.findIndex((o) => o.selected)).toBe(2)
        expect(answerSteps(menu, { signature: menu.signature, optionIndices: [0, 2] })).toEqual(keys(down, down, enter))
        // Banana only: untick Apple and Cherry, tick Banana — in screen order from the cursor
        expect(answerSteps(menu, { signature: menu.signature, optionIndices: [1] })).toEqual(keys(up, up, enter, down, enter, down, enter, down, down, enter))
        expect(confirmTarget(menu, { signature: menu.signature, optionIndices: [0, 2] })).toBe(-1)
    })

    test('the cursor on the Next row: no option highlighted, Enter goes on', () => {
        const menu = readPrompt(screen('claude-2.1.319-multi-q2-next-row.txt'), 'claude')!
        expect(menu.options.some((o) => o.selected)).toBe(false)
        expect(menu.submitRow).toEqual({ label: 'Next', selected: true, after: 3 })
        expect(menu.answerable).toBe(true)
        expect(answerSteps(menu, { signature: menu.signature, optionIndices: [0, 2] })).toEqual(keys(enter))
        expect(answerSteps(menu, { signature: menu.signature, optionIndices: [0] })).toEqual(keys(up, up, enter, down, down, enter))
    })

    test('one multiple-choice question: its row is Submit; a typed answer ticks its row and goes on', () => {
        const menu = readPrompt(screen('claude-2.1.319-multi-only.txt'), 'claude')!
        expect(menu.submitRow).toEqual({ label: 'Submit', selected: false, after: 3 })
        expect(menu.steps).toEqual([{ label: 'Review', answered: false }, { label: 'Submit', answered: false, submit: true }])
        // typing into the row ticks it (ovis, measured on 2.1.301), then the row under it goes on
        expect(answerSteps(menu, { signature: menu.signature, optionIndices: [1], customText: 'D-review' }))
            .toEqual([...keys(down, enter, down, down), { text: 'D-review' }, ...keys(down, enter)])
        const onSubmit = readPrompt(screen('claude-2.1.319-multi-only-submit-row.txt'), 'claude')!
        expect(onSubmit.submitRow?.selected).toBe(true)
        expect(answerSteps(onSubmit, { signature: onSubmit.signature, optionIndices: [0, 1] })).toEqual(keys(enter))
    })

    test('no choice, a single pick, or an index outside the menu is refused', () => {
        const menu = readPrompt(screen('claude-2.1.319-multi-q2.txt'), 'claude')!
        expect(() => answerSteps(menu, { signature: menu.signature, optionIndices: [] })).toThrow()
        expect(() => answerSteps(menu, { signature: menu.signature, optionIndices: [9] })).toThrow()
        expect(() => answerSteps(menu, { signature: menu.signature, optionIndices: [4] })).toThrow()
        expect(() => answerSteps(menu, { signature: menu.signature, optionIndex: 1 })).toThrow()
        expect(() => answerSteps(menu, { signature: menu.signature, optionIndices: ['1'] } as never)).toThrow()
        // "Chat about this" is a plain row under a multiple choice
        expect(answerSteps(menu, { signature: menu.signature, optionIndex: 4 })).toEqual(keys(down, down, down, down, down, enter))
    })

    test('ticking a row does not change the menu the answer was made for', () => {
        const before = readPrompt(screen('claude-2.1.319-multi-q2.txt'), 'claude')!
        const ticked = readPrompt(screen('claude-2.1.319-multi-q2-apple.txt'), 'claude')!
        expect(ticked.options.map((o) => o.label)).toEqual(before.options.map((o) => o.label))
        expect(ticked.options[0].checked).toBe(true)
    })
})

test.describe('T108 Claude review of the answers (Q-1)', () => {
    test('"Ready to submit your answers?" is a card: the answers as context, Enter submits', () => {
        const menu = readPrompt(screen('claude-2.1.319-review.txt'), 'claude')!
        expect(menu.kind).toBe('review')
        expect(menu.question).toBe('Ready to submit your answers?')
        expect(menu.context).toEqual(['Which color? → Red', 'Which fruits? → Apple, Cherry', 'Which size? → Large'])
        expect(menu.options.map((o) => [o.label, o.selected])).toEqual([['Submit answers', true], ['Cancel', false]])
        expect(menu.steps?.every((step) => step.answered || step.submit)).toBe(true)
        expect(menu.answerable).toBe(true)
        expect(answerSteps(menu, { signature: menu.signature, optionIndex: 0 })).toEqual(keys(enter))
        const one = readPrompt(screen('claude-2.1.319-multi-only-review.txt'), 'claude')!
        expect([one.kind, one.context]).toEqual(['review', ['Which reviews do you want? → A-review, B-review']])
    })

    test('a review with anything drawn under it is gone (answered, or words in the output)', () => {
        const lines = screen('claude-2.1.319-review.txt')
        expect(readPrompt([...lines, '', '⏺ User answered Claude\'s questions:'], 'claude')).toBeNull()
        const rule = '─'.repeat(40)
        expect(readPrompt(['  Ready to submit your answers?', '  1. Submit answers', '  2. Cancel', rule, '❯ ', rule], 'claude')).toBeNull()
    })
})

test.describe('T108 Claude plan approval (Q-4)', () => {
    test('the plan is the context, "Tell Claude what to change" takes words', () => {
        const menu = readPrompt(screen('claude-2.1.319-plan-approval.txt'), 'claude')!
        expect(menu.kind).toBe('plan')
        expect(menu.question).toBe('Claude has written up a plan and is ready to execute. Would you like to proceed?')
        expect(menu.context[0]).toBe('Plan: create notes.txt')
        expect(menu.context).toContain('- Read notes.txt and confirm it contains hello.')
        expect(menu.context.some((line) => /Here is Claude's plan|Ready to code/.test(line))).toBe(false)
        expect(menu.options.map((o) => [o.label, o.selected, o.custom ?? false])).toEqual([
            ['Yes, and use auto mode', true, false],
            ['Yes, manually approve edits', false, false],
            ['Tell Claude what to change', false, true]
        ])
        expect(menu.answerable).toBe(true)
        expect(answerSteps(menu, { signature: menu.signature, optionIndex: 1 })).toEqual(keys(down, enter))
        expect(answerSteps(menu, { signature: menu.signature, customText: 'add a test' })).toEqual([...keys(down, down), { text: 'add a test' }, ...keys(enter)])
    })

    test('the same words above an idle input box are no card', () => {
        const rule = '─'.repeat(40)
        const quoted = [' Claude has written up a plan and is ready to execute. Would you like to proceed?', ' ❯ 1. Yes, and use auto mode', '   2. Yes, manually approve edits', '⏺ ok', rule, '❯ ', rule]
        expect(readPrompt(quoted, 'claude')).toBeNull()
    })
})

test.describe('T108 Codex approvals (Q-6)', () => {
    test('a command approval: its question, what it runs as context, answerable, No is Esc', () => {
        const menu = readPrompt(screen('codex-0.166-exec-approval.txt'), 'codex')!
        expect(menu.kind).toBe('permission')
        expect(menu.question).toBe('Would you like to run the following command?')
        expect(menu.context).toEqual(['Environment: local', 'Reason: Allow creating hello.txt in the current directory?', '$ touch hello.txt'])
        expect(menu.options.map((o) => o.label)).toEqual([
            'Yes, proceed',
            "Yes, and don't ask again for commands that start with `touch hello.txt`",
            'No, and tell Codex what to do differently'
        ])
        expect(menu.answerable).toBe(true)
        expect(answerSteps(menu, { signature: menu.signature, optionIndex: 0 })).toEqual(keys(enter))
        expect(answerSteps(menu, { signature: menu.signature, optionIndex: 1 })).toEqual(keys(down, enter))
        expect(answerSteps(menu, { signature: menu.signature, optionIndex: 2 })).toEqual(keys(esc))
        // Esc does not move the highlight: the one on screen must still be where it was
        expect(confirmTarget(menu, { signature: menu.signature, optionIndex: 2 })).toBe(0)
    })

    test('an edit approval: the file as context; the agent output above is not', () => {
        const menu = readPrompt(screen('codex-0.166-patch-approval.txt'), 'codex')!
        expect(menu.question).toBe('Would you like to make the following edits?')
        expect(menu.context[0]).toBe('Description: Apply proposed file edits')
        expect(menu.context.some((line) => /hello\.txt$/.test(line))).toBe(true)
        expect(menu.context.some((line) => /Show details|Edited/.test(line))).toBe(false)
        expect(menu.answerable).toBe(true)
    })

    test('an approval with output under its hint is not answered; the folder trust stays in the terminal', () => {
        const lines = screen('codex-0.166-exec-approval.txt')
        expect(readPrompt([...lines, '', '• Ran touch hello.txt'], 'codex')?.answerable ?? false).toBe(false)
        const trust = readPrompt(screen('codex-0.166-trust.txt'), 'codex')
        expect(trust?.answerable ?? false).toBe(false)
    })
})

test.describe('T108 the permission prompt of 2.1.319 still reads as before', () => {
    test('Bash permission: four options, Yes highlighted, answerable', () => {
        const menu = readPrompt(screen('claude-2.1.319-permission-bash.txt'), 'claude')!
        expect([menu.kind, menu.question, menu.options.length, menu.answerable]).toEqual(['permission', 'Do you want to proceed?', 4, true])
        expect(menu.context).toContain('rm -rf ./tmp-cache && mkdir tmp-cache')
    })
})

test.describe('T108 a narrow pane wraps the question', () => {
    test('the plan question over three rows, the Codex question over two: read whole, still answerable', () => {
        const plan = screen('claude-2.1.319-plan-approval.txt').flatMap((line) =>
            /Would you like to proceed\?$/.test(line) ? [' Claude has written up a plan and is', ' ready to execute. Would you like to', ' proceed?'] : [line]
        )
        const menu = readPrompt(plan, 'claude')!
        expect([menu.kind, menu.question, menu.answerable]).toEqual(['plan', 'Claude has written up a plan and is ready to execute. Would you like to proceed?', true])
        const codex = screen('codex-0.166-exec-approval.txt').flatMap((line) =>
            /Would you like to run/.test(line) ? ['  Would you like to run the following', '  command?'] : /Press enter to confirm/.test(line) ? ['  Press enter to confirm or esc to', '  cancel'] : [line]
        )
        const approval = readPrompt(codex, 'codex')!
        expect([approval.question, approval.context[0], approval.answerable]).toEqual(['Would you like to run the following command?', 'Environment: local', true])
        // at 40 columns "(esc)" ends the second row of the No option: still Esc
        const narrow = codex.flatMap((line) =>
            /3\. No, and tell Codex/.test(line) ? ['  3. No, and tell Codex what to do', '     differently (esc)'] : [line]
        )
        const no = readPrompt(narrow, 'codex')!
        expect(no.options[2]).toMatchObject({ label: 'No, and tell Codex what to do differently', escape: true })
        expect(answerSteps(no, { signature: no.signature, optionIndex: 2 })).toEqual(keys(esc))
        // the plan's question wrapped another way: "is" moved to the second row
        const plan2 = screen('claude-2.1.319-plan-approval.txt').flatMap((line) =>
            /Would you like to proceed\?$/.test(line) ? [' Claude has written up a plan and', ' is ready to execute. Would you', ' like to proceed?'] : [line]
        )
        const wrappedPlan = readPrompt(plan2, 'claude')!
        expect(wrappedPlan.kind).toBe('plan')
        // the plan is still the context, not the question's first rows
        expect(wrappedPlan.context[0]).toBe('Plan: create notes.txt')
        expect(wrappedPlan.context.some((line) => /written up a plan/.test(line))).toBe(false)
    })
})
