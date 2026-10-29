import { test, expect } from '@playwright/test'
import { EventEmitter } from 'events'
import { TerminalMirror } from '../../src/main/TerminalMirror'
import { SessionScreenStatusPoller } from '../../src/main/SessionScreenStatus'
import type { AgentStatusUpdate, SessionScreenStatusMessage } from '../../src/shared/types'

/**
 * T66 — sidebar status dots, without Electron (fb-1029b · d499aed0 · 1dbd271b).
 *
 * The screen side runs a real TerminalMirror (headless xterm) over a fake
 * TerminalManager, so the question line is read from parsed screens the way
 * the app reads them. The poller side uses a fake mirror to count reads.
 */

function fakeTerminals() {
    const events = new EventEmitter()
    return {
        events,
        getSize: () => ({ cols: 100, rows: 30 }),
        hasTerminal: () => true
    }
}

async function mirrorShowing(screen: string): Promise<TerminalMirror> {
    const terminals = fakeTerminals()
    const mirror = new TerminalMirror(terminals as never)
    terminals.events.emit('created', 's1', 100, 30)
    terminals.events.emit('output', 's1', screen.replace(/\n/g, '\r\n'))
    await mirror.flush('s1')
    return mirror
}

test.describe('T66 screen status', () => {
    test('a permission prompt is waiting, and the question is the line ending in "?"', async () => {
        const mirror = await mirrorShowing([
            '● Bash(rm -rf build)',
            '╭──────────────────────────────────────────────╮',
            '│ Bash command                                 │',
            '│   rm -rf build                               │',
            '│ Do you want to proceed?                      │',
            '│ ❯ 1. Yes                                     │',
            '│   2. No, and tell Claude what to do differently │',
            '╰──────────────────────────────────────────────╯'
        ].join('\n'))
        expect(mirror.screenStatus('s1')).toEqual({ busy: false, question: 'Do you want to proceed?' })
        expect(mirror.showsAwaitingInput('s1')).toBe(true)
    })

    test('a selection menu (AskUserQuestion) is waiting: the question, not the "Esc to cancel" footer', async () => {
        // Copied from a real Claude Code 2.1.312 screen (fb-1029b evidence/askuserquestion-claude-2.1.312.txt).
        // The prompt above it also contains a "?" but ends in "마." — the question wins.
        const rule = '─'.repeat(98)
        const mirror = await mirrorShowing([
            "❯ AskUserQuestion 도구로 나에게 '어떤 색이 좋아?' 라고 빨강/파랑 두 보기로 물어봐. 다른 일은 하지 마.",
            rule,
            ' ☐ 색 선택 ',
            '',
            '어떤 색이 좋아?',
            '',
            '❯ 1. 빨강',
            '     빨간색을 선택합니다',
            '  2. 파랑',
            '     파란색을 선택합니다',
            '  3. Type something.',
            rule,
            '  4. Chat about this',
            '',
            'Enter to select · ↑/↓ to navigate · Esc to cancel'
        ].join('\n'))
        expect(mirror.screenStatus('s1')).toEqual({ busy: false, question: '어떤 색이 좋아?' })
    })

    test('a prompt that does not end in "?" falls back to the line that matched', async () => {
        const mirror = await mirrorShowing('Update available\nPress enter to continue')
        expect(mirror.screenStatus('s1').question).toBe('Press enter to continue')
    })

    test('a turn in progress is busy; a quiet input box is neither', async () => {
        const busy = await mirrorShowing('✻ Working… (3s · esc to interrupt)\n────\n❯ \n────')
        expect(busy.screenStatus('s1')).toEqual({ busy: true, question: null })
        const idle = await mirrorShowing('● Done.\n────\n❯ \n────')
        expect(idle.screenStatus('s1')).toEqual({ busy: false, question: null })
    })
})

function fakeMirror() {
    const screens = new Map<string, { busy: boolean; question: string | null; outputAt: number; exited?: boolean }>()
    let reads = 0
    return {
        screens,
        get reads() { return reads },
        ids: () => [...screens.keys()],
        hasExited: (id: string) => screens.get(id)?.exited ?? false,
        lastOutputAt: (id: string) => screens.get(id)?.outputAt ?? 0,
        screenStatus: (id: string) => {
            reads++
            const s = screens.get(id)!
            return { busy: s.busy, question: s.question }
        }
    }
}

function poller(mirror: ReturnType<typeof fakeMirror>, hooks: Map<string, AgentStatusUpdate> = new Map()) {
    const sent: SessionScreenStatusMessage[] = []
    let now = 10_000
    const p = new SessionScreenStatusPoller({
        mirror,
        hookStatus: (id) => hooks.get(id) ?? null,
        publish: (m) => sent.push(m),
        now: () => now
    })
    return { p, sent, advance: (ms: number) => { now += ms } }
}

test.describe('T66 poller', () => {
    test('sends only what changed; idle sessions never appear', () => {
        const mirror = fakeMirror()
        mirror.screens.set('work', { busy: true, question: null, outputAt: 9_990 })
        mirror.screens.set('ask', { busy: false, question: 'Do you want to proceed?', outputAt: 9_990 })
        mirror.screens.set('quiet', { busy: false, question: null, outputAt: 1 })
        const { p, sent, advance } = poller(mirror)

        expect(p.tick()).toEqual([
            { sessionId: 'work', state: 'working' },
            { sessionId: 'ask', state: 'waiting', question: 'Do you want to proceed?' }
        ])
        advance(1000)
        expect(p.tick()).toEqual([])
        expect(sent).toHaveLength(1)

        // The turn ends: one change, the waiting row is not resent.
        mirror.screens.set('work', { busy: false, question: null, outputAt: 10_900 })
        advance(1000)
        expect(p.tick()).toEqual([{ sessionId: 'work', state: 'idle' }])
        expect(p.snapshot().changes).toEqual([{ sessionId: 'ask', state: 'waiting', question: 'Do you want to proceed?' }])
    })

    test('a screen is re-read only after new output (one extra read to let parsing settle)', () => {
        const mirror = fakeMirror()
        mirror.screens.set('a', { busy: false, question: null, outputAt: 9_900 })
        mirror.screens.set('b', { busy: false, question: null, outputAt: 1 })
        const { p, advance } = poller(mirror)
        p.tick()
        expect(mirror.reads).toBe(2)
        advance(1000)
        p.tick() // a printed 100ms before the first read — read again in case the tail was still parsing
        expect(mirror.reads).toBe(3)
        for (let i = 0; i < 10; i++) {
            advance(1000)
            p.tick()
        }
        expect(mirror.reads).toBe(3)
        mirror.screens.get('b')!.outputAt = 20_500
        advance(1000)
        p.tick()
        expect(mirror.reads).toBe(4)
    })

    test('hooks still count: running is working, awaitingInput is waiting with its detail', () => {
        const mirror = fakeMirror()
        mirror.screens.set('h', { busy: false, question: null, outputAt: 1 })
        const hooks = new Map<string, AgentStatusUpdate>([
            ['h', { terminalId: 'h', status: 'running', source: 'hook', at: 1 }]
        ])
        const { p, advance } = poller(mirror, hooks)
        expect(p.tick()).toEqual([{ sessionId: 'h', state: 'working' }])
        hooks.set('h', { terminalId: 'h', status: 'ready', source: 'hook', at: 2, awaitingInput: true, detail: 'Bash: rm -rf build' })
        advance(1000)
        expect(p.tick()).toEqual([{ sessionId: 'h', state: 'waiting', question: 'Bash: rm -rf build' }])
    })

    test('exited and closed sessions lose their dot', () => {
        const mirror = fakeMirror()
        mirror.screens.set('x', { busy: true, question: null, outputAt: 9_999 })
        mirror.screens.set('y', { busy: true, question: null, outputAt: 9_999 })
        const { p, advance } = poller(mirror)
        p.tick()
        mirror.screens.get('x')!.exited = true
        mirror.screens.delete('y')
        advance(1000)
        expect(p.tick()).toEqual([{ sessionId: 'x', state: 'idle' }, { sessionId: 'y', state: 'idle' }])
    })

    test('stop clears everything and says so; start says enabled', () => {
        const mirror = fakeMirror()
        mirror.screens.set('w', { busy: true, question: null, outputAt: 9_999 })
        const { p, sent } = poller(mirror)
        p.start()
        expect(p.running).toBe(true)
        expect(sent[0]).toEqual({ enabled: true, reset: true, changes: [] })
        expect(sent[1].changes).toEqual([{ sessionId: 'w', state: 'working' }])
        p.stop()
        expect(p.running).toBe(false)
        expect(sent.at(-1)).toEqual({ enabled: false, reset: true, changes: [] })
        expect(p.snapshot()).toEqual({ enabled: false, reset: true, changes: [] })
        p.stop() // no second message
        expect(sent).toHaveLength(3)
    })
})
