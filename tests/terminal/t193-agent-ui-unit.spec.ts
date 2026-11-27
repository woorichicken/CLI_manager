import { test, expect } from '@playwright/test'
import {
    AGENT_UI_ANSWER_PREFIX,
    AGENT_UI_MAX_ANSWER_VALUE,
    AGENT_UI_MAX_BYTES,
    AGENT_UI_MAX_COMPONENTS,
    AGENT_UI_MAX_DEPTH,
    AGENT_UI_MAX_LINE,
    agentUiActionLine,
    checkAgentUi
} from '../../src/main/agentUi'
import { InboxStore } from '../../src/main/InboxStore'
import type { AgentUi } from '../../src/shared/types'

/**
 * T193 — agent-sent UI (decision 0016), without Electron: what main accepts from `show_ui` (an
 * allowlist of A2UI v1.0 basic-catalog parts, one tree under root, small caps), the line a button
 * press types into the session (built from the stored card, not from the renderer), and the inbox
 * keeping and locking a card.
 */

/** The card the brand smoke drew (client.jsx): a title, a note field, approve / hold. */
function approvalCard(): Array<Record<string, unknown>> {
    return [
        { id: 'root', component: 'Card', child: 'col' },
        { id: 'col', component: 'Column', children: ['title', 'note', 'row'] },
        { id: 'title', component: 'Text', text: { '@path': '/title' } },
        { id: 'note', component: 'TextField', label: 'Note', value: { '@path': '/note' } },
        { id: 'row', component: 'Row', children: ['ok', 'no'] },
        { id: 'okL', component: 'Text', text: 'Approve' },
        { id: 'noL', component: 'Text', text: 'Hold' },
        { id: 'ok', component: 'Button', child: 'okL', variant: 'primary', action: { event: { name: 'approve', context: { pr: 324, note: { '@path': '/note' } } } } },
        { id: 'no', component: 'Button', child: 'noL', action: { event: { name: 'hold', context: { pr: 324 } } } }
    ]
}

const accepted = (components: unknown, data?: unknown): AgentUi => {
    const result = checkAgentUi({ components, data })
    if (!result.ok) throw new Error(`refused: ${result.message}`)
    return result.ui
}
const refusal = (components: unknown, data?: unknown): string => {
    const result = checkAgentUi({ components, data })
    expect(result.ok, 'should be refused').toBe(false)
    return result.ok ? '' : result.message
}
const withChange = (id: string, patch: Record<string, unknown>) =>
    approvalCard().map((c) => (c.id === id ? { ...c, ...patch } : c))

test.describe('T193 agent UI', () => {
    test('accepts the approval card and every allowed part, keeping only what was checked', () => {
        const ui = accepted(approvalCard(), { title: 'PR #324 — merge?', note: '' })
        expect(ui.components.map((c) => c.id)).toEqual(['root', 'col', 'title', 'note', 'row', 'okL', 'noL', 'ok', 'no'])
        expect(ui.data).toEqual({ title: 'PR #324 — merge?', note: '' })

        const all = accepted([
            { id: 'root', component: 'Column', children: ['t', 'd', 'c', 'p', 'b'], align: 'start' },
            { id: 't', component: 'Text', text: 'Pick', variant: 'caption' },
            { id: 'd', component: 'Divider', axis: 'horizontal' },
            { id: 'c', component: 'CheckBox', label: 'Also deploy', value: { '@path': '/deploy' } },
            { id: 'p', component: 'ChoicePicker', label: 'Which', options: [{ label: 'A', value: 'a' }, { label: { '@path': '/bLabel' }, value: 'b' }], value: { '@path': '/pick' }, displayStyle: 'chips' },
            { id: 'b', component: 'Button', child: 'bl', action: { event: { name: 'pick', context: { which: { '@path': '/pick' }, deploy: { '@path': '/deploy' } } } } },
            { id: 'bl', component: 'Text', text: 'Go' }
        ], { deploy: false, pick: [], bLabel: 'B' })
        expect(all.components).toHaveLength(7)
        // An empty data object is not stored.
        expect(accepted(approvalCard(), {}).data).toBeUndefined()
    })

    test('refuses parts and properties outside the allowlist — images, links, functions, passwords', () => {
        expect(refusal([{ id: 'root', component: 'Image', url: 'https://example.com/a.png' }])).toMatch(/component must be one of/)
        for (const name of ['Icon', 'Video', 'AudioPlayer', 'Modal', 'Tabs', 'List', 'Slider', 'DateTimeInput', 'Surface', '__proto__']) {
            expect(refusal([{ id: 'root', component: name }]), name).toMatch(/component must be one of/)
        }
        // functionCall (openUrl), @call bindings, userMessage, @checks, templates.
        expect(refusal(withChange('ok', { action: { functionCall: { call: 'openUrl', args: { url: 'https://x' } } } }))).toMatch(/functionCall is not allowed/)
        expect(refusal(withChange('title', { text: { '@call': 'formatString', args: { value: 'x' } } }))).toMatch(/only \{ "@path"/)
        expect(refusal(withChange('ok', { action: { event: { name: 'a', userMessage: 'hi' } } }))).toMatch(/unknown property "userMessage"/)
        expect(refusal(withChange('note', { '@checks': [] }))).toMatch(/unknown property "@checks"/)
        expect(refusal(withChange('col', { children: { path: '/rows', componentId: 'title' } }))).toMatch(/list of component ids/)
        expect(refusal(withChange('note', { variant: 'obscured' }))).toMatch(/variant must be one of/)
        expect(refusal(withChange('title', { onClick: 'x' }))).toMatch(/unknown property "onClick"/)
        expect(refusal(withChange('title', { text: { '@path': 'relative' } }))).toMatch(/absolute path/)
        expect(refusal(withChange('ok', { action: { event: { name: 'has space' } } }))).toMatch(/event.name/)
        expect(refusal(withChange('ok', { action: { event: { name: 'a', context: { k: { nested: 1 } } } } }))).toMatch(/only \{ "@path"/)
        expect(refusal(approvalCard().map((c) => (c.id === 'ok' ? { id: 'ok', component: 'Button', child: 'okL' } : c)))).toMatch(/needs "action"/)
        expect(refusal([{ id: 'root', component: 'Text' }])).toMatch(/needs "text"/)
        expect(refusal(approvalCard(), { 'bad key': 1 })).toMatch(/key "bad key"/)
        expect(refusal(approvalCard(), [1])).toMatch(/data must be an object/)
    })

    test('refuses anything but one tree under root — missing root, unknown ids, cycles, shared children, strays', () => {
        expect(refusal([])).toMatch(/non-empty/)
        expect(refusal('nope')).toMatch(/non-empty/)
        expect(refusal(approvalCard().map((c) => (c.id === 'root' ? { ...c, id: 'top' } : c)))).toMatch(/id "root"/)
        expect(refusal(withChange('row', { children: ['ok', 'missing'] }))).toMatch(/"missing", which is not in components/)
        expect(refusal([...approvalCard(), { id: 'ok', component: 'Text', text: 'dup' }])).toMatch(/used twice/)
        // A cycle back to root, a cycle off to the side, a diamond (shared child), a stray.
        expect(refusal(withChange('row', { children: ['ok', 'no', 'root'] }))).toMatch(/root cannot be a child/)
        expect(refusal([
            { id: 'root', component: 'Text', text: 'x' },
            { id: 'a', component: 'Card', child: 'b' },
            { id: 'b', component: 'Card', child: 'a' }
        ])).toMatch(/not reachable from root/)
        expect(refusal(withChange('col', { children: ['title', 'note', 'row', 'okL'] }))).toMatch(/used by both/)
        expect(refusal([...approvalCard(), { id: 'stray', component: 'Text', text: 'x' }])).toMatch(/"stray" is not reachable/)
    })

    test('caps: component count, depth, children, strings, bytes', () => {
        const many = [{ id: 'root', component: 'Column', children: [] as string[] }] as Array<Record<string, unknown>>
        for (let i = 0; i < AGENT_UI_MAX_COMPONENTS; i++) many.push({ id: `t${i}`, component: 'Text', text: 'x' })
        expect(refusal(many)).toMatch(new RegExp(`limited to ${AGENT_UI_MAX_COMPONENTS}`))

        const deep: Array<Record<string, unknown>> = [{ id: 'root', component: 'Card', child: 'c1' }]
        for (let i = 1; i <= AGENT_UI_MAX_DEPTH; i++) deep.push({ id: `c${i}`, component: 'Card', child: `c${i + 1}` })
        deep.push({ id: `c${AGENT_UI_MAX_DEPTH + 1}`, component: 'Text', text: 'bottom' })
        expect(refusal(deep)).toMatch(/nested deeper/)
        // Exactly the limit is fine.
        const atLimit: Array<Record<string, unknown>> = [{ id: 'root', component: 'Card', child: 'c1' }]
        for (let i = 1; i < AGENT_UI_MAX_DEPTH - 1; i++) atLimit.push({ id: `c${i}`, component: 'Card', child: `c${i + 1}` })
        atLimit.push({ id: `c${AGENT_UI_MAX_DEPTH - 1}`, component: 'Text', text: 'bottom' })
        expect(checkAgentUi({ components: atLimit }).ok).toBe(true)

        const wide = [{ id: 'root', component: 'Row', children: Array.from({ length: 13 }, (_, i) => `t${i}`) }, ...Array.from({ length: 13 }, (_, i) => ({ id: `t${i}`, component: 'Text', text: 'x' }))]
        expect(refusal(wide)).toMatch(/limited to 12 children/)
        expect(refusal(withChange('okL', { text: 'x'.repeat(501) }))).toMatch(/limited to 500 characters/)
        const huge = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, 'y'.repeat(480)]))
        expect(refusal(approvalCard(), huge)).toMatch(new RegExp(`limited to ${AGENT_UI_MAX_BYTES} bytes`))
    })

    test('a button press becomes one fixed line from the stored card — the renderer only supplies bound values', () => {
        const ui = accepted(approvalCard(), { note: '' })
        expect(agentUiActionLine(ui, 'ok', { note: 'tests pass', pr: 999 })).toEqual({
            ok: true,
            action: 'approve',
            line: `${AGENT_UI_ANSWER_PREFIX} approve {"pr":324,"note":"tests pass"}`
        })
        // The literal pr stays 324 whatever the renderer says; a missing bound value is null.
        expect(agentUiActionLine(ui, 'ok', {})).toMatchObject({ line: `${AGENT_UI_ANSWER_PREFIX} approve {"pr":324,"note":null}` })
        expect(agentUiActionLine(ui, 'no', { note: 'ignored', injected: 'x' })).toMatchObject({ line: `${AGENT_UI_ANSWER_PREFIX} hold {"pr":324}` })
        // A newline typed into a field stays on one line.
        const multi = agentUiActionLine(ui, 'ok', { note: 'a\nb\r\nEnter' })
        expect(multi.ok && multi.line.includes('\n')).toBe(false)
        expect(multi.ok && multi.line).toContain('"note":"a\\nb\\r\\nEnter"')
        // Objects from the renderer are not passed through; long text is cut.
        expect(agentUiActionLine(ui, 'ok', { note: { evil: true } })).toMatchObject({ line: `${AGENT_UI_ANSWER_PREFIX} approve {"pr":324,"note":null}` })
        const long = agentUiActionLine(ui, 'ok', { note: 'z'.repeat(AGENT_UI_MAX_ANSWER_VALUE + 50) })
        expect(long.ok && long.line.length).toBeLessThanOrEqual(AGENT_UI_MAX_LINE)
        expect(long.ok && long.line).toContain('z'.repeat(AGENT_UI_MAX_ANSWER_VALUE) + '"')
        // Not a button, or not in the card.
        expect(agentUiActionLine(ui, 'note', {})).toMatchObject({ ok: false, reason: 'not_a_button' })
        expect(agentUiActionLine(ui, 'nope', {})).toMatchObject({ ok: false, reason: 'not_a_button' })
        expect(agentUiActionLine(ui, 42, {})).toMatchObject({ ok: false, reason: 'not_a_button' })
        // A picker's list stays a list of strings.
        const picker = accepted([
            { id: 'root', component: 'Column', children: ['p', 'b'] },
            { id: 'p', component: 'ChoicePicker', options: [{ label: 'A', value: 'a' }], value: { '@path': '/pick' } },
            { id: 'b', component: 'Button', child: 'bl', action: { event: { name: 'pick', context: { which: { '@path': '/pick' } } } } },
            { id: 'bl', component: 'Text', text: 'Go' }
        ])
        expect(agentUiActionLine(picker, 'b', { which: ['a', 3, 'b'] })).toMatchObject({ line: `${AGENT_UI_ANSWER_PREFIX} pick {"which":["a","b"]}` })
    })

    test('the inbox keeps the card with a rev; a repeat replaces it (new rev, unanswered); an answer locks only the card it was for', () => {
        const data: Record<string, unknown> = {}
        const inbox = new InboxStore({ get: (k) => data[k], set: (k, v) => void (data[k] = v) })
        const ui = accepted(approvalCard(), { note: '' })
        const { request } = inbox.add({ sessionId: 's1', kind: 'question', text: 'Merge?', client: 't', ui })
        const first = inbox.get(request.id)!.ui!
        expect(first.components).toHaveLength(9)
        expect(first.rev).toMatch(/^[0-9a-f-]{36}$/)

        const locked = inbox.setUiAnswer(request.id, first.rev, { at: 5, action: 'approve', status: 'sent' })
        expect(locked?.ui?.answered).toEqual({ at: 5, action: 'approve', status: 'sent' })
        expect(locked?.readAt).toBeUndefined()

        const again = inbox.add({ sessionId: 's1', kind: 'question', text: 'Merge?', client: 't', ui })
        expect(again.created).toBe(false)
        expect(again.request.ui?.answered).toBeUndefined()
        expect(again.request.ui?.rev).not.toBe(first.rev)
        // An answer to the replaced card (it was being sent while the repeat came) does not lock the new one.
        expect(inbox.setUiAnswer(request.id, first.rev, { at: 6, action: 'approve', status: 'sent' })).toBeNull()
        expect(inbox.get(request.id)?.ui?.answered).toBeUndefined()

        const plain = inbox.add({ sessionId: 's1', kind: 'login', text: 'Sign in', client: 't' })
        expect(inbox.setUiAnswer(plain.request.id, undefined, { at: 1, action: 'x', status: 'sent' })).toBeNull()
        expect(inbox.setUiAnswer('missing', first.rev, { at: 1, action: 'x', status: 'sent' })).toBeNull()
    })

    test('a bound slot must get data its part can show — no object where text goes', () => {
        // Codex review: { toString: "oops" } at a Text path passed the allowlist and made the renderer throw.
        expect(refusal(approvalCard(), { title: { toString: 'oops' }, note: '' })).toMatch(/data at \/title must be a string or number/)
        expect(refusal(approvalCard(), { note: ['a'] })).toMatch(/data at \/note must be a string or number/)
        const box = [
            { id: 'root', component: 'Column', children: ['c', 'p'] },
            { id: 'c', component: 'CheckBox', label: 'x', value: { '@path': '/on' } },
            { id: 'p', component: 'ChoicePicker', options: [{ label: 'A', value: 'a' }], value: { '@path': '/pick' } }
        ]
        expect(refusal(box, { on: 'yes' })).toMatch(/must be true or false/)
        expect(refusal(box, { on: true, pick: 'a' })).toMatch(/must be a list of strings/)
        expect(refusal(box, { on: true, pick: [1] })).toMatch(/must be a list of strings/)
        // Through a list index, as the renderer reads it (Codex recheck); an inherited key is not data.
        const listText = [{ id: 'root', component: 'Text', text: { '@path': '/rows/0/title' } }]
        expect(refusal(listText, { rows: [{ title: { toString: 'oops' } }] })).toMatch(/data at \/rows\/0\/title/)
        expect(checkAgentUi({ components: listText, data: { rows: [{ title: 'ok' }] } }).ok).toBe(true)
        expect(checkAgentUi({ components: [{ id: 'root', component: 'Text', text: { '@path': '/toString' } }], data: {} }).ok).toBe(true)
        // Absent is fine (the field starts empty); numbers show as text; a button's context may bind anything.
        expect(checkAgentUi({ components: box, data: { on: false, pick: ['a'] } }).ok).toBe(true)
        expect(checkAgentUi({ components: box }).ok).toBe(true)
        expect(checkAgentUi({ components: approvalCard(), data: { title: 324, note: '' } }).ok).toBe(true)
    })
})
