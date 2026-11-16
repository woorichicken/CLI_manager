import { test, expect } from '@playwright/test'
import { EventEmitter } from 'events'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { TerminalMirror } from '../../src/main/TerminalMirror'
import { TranscriptReader } from '../../src/main/TranscriptReader'
import { ConversationService } from '../../src/main/ConversationService'
import { allChatThreads, chatThreadParentIds, pollChatThreadChanges } from '../../src/main/chatThreads'
import type { SessionRelation } from '../../src/shared/types'

// T144 — the sidebar's Threads list (all sessions › 💬): one list of every anchored parent's
// threads, and a watch that widens to every parent only while that list is open.

const TS = '2026-11-16T10:00:00.000Z'
const fork = (from: string, to: string, extra: Partial<SessionRelation> = {}): SessionRelation => ({
    from, to, kind: 'opened', at: 100, anchor: { turnTs: TS, turnIndex: 0 }, ...extra
})
const session = (id: string, workspaceName = 'CLImanger') => ({ id, name: `Session ${id}`, workspaceName })
const quietScreen = {
    hasExited: (_id: string) => false,
    screenStatus: (_id: string): { busy: boolean; question: string | null } => ({ busy: false, question: null }),
    lastOutputAt: (_id: string) => 0
}

test('T144: threads of several parents merge into one list, newest activity first, each with its parent and workspace', () => {
    const relations = [fork('a', 'a1'), fork('b', 'b1'), fork('a', 'a2')]
    const sessions = [session('a'), session('b', 'backend'), session('a1'), session('a2'), session('b1')]
    const rows = allChatThreads(chatThreadParentIds(relations), relations, sessions, {
        ...quietScreen,
        lastOutputAt: (id) => ({ a1: 300, a2: 500, b1: 400 } as Record<string, number>)[id] ?? 0
    })
    expect(rows.map((row) => [row.childId, row.parentId, row.parentName, row.workspaceName])).toEqual([
        ['a2', 'a', 'Session a', 'CLImanger'],
        ['b1', 'b', 'Session b', 'backend'],
        ['a1', 'a', 'Session a', 'CLImanger']
    ])
    // equal activity: a stable tie-break by id, so the rows never trade places on a quiet tick
    const tied = allChatThreads(chatThreadParentIds(relations), relations, sessions, quietScreen)
    expect(tied.map((row) => row.childId)).toEqual(['a1', 'a2', 'b1'])
})

test('T144: only anchored outward forks are listed — old forks, hand pairs, master-opened and dismissed ones are not', () => {
    const relations = [
        fork('a', 'a1'),
        fork('a', 'old', { anchor: undefined }),
        fork('a', 'hand', { kind: 'manual' }),
        fork('master', 'worker', { anchor: undefined }),
        fork('a', 'gone', { dismissed: true })
    ]
    const sessions = ['a', 'a1', 'old', 'hand', 'master', 'worker', 'gone'].map((id) => session(id))
    expect(allChatThreads(chatThreadParentIds(relations), relations, sessions, quietScreen).map((row) => row.childId)).toEqual(['a1'])
})

test('T144: a closed child or parent drops out at once, and a renamed parent shows its new name', () => {
    const relations = [fork('a', 'a1'), fork('b', 'b1')]
    const sessions = [session('a'), session('b'), session('a1'), session('b1')]
    const parents = chatThreadParentIds(relations)
    expect(allChatThreads(parents, relations, sessions.filter((s) => s.id !== 'a1'), quietScreen).map((row) => row.childId)).toEqual(['b1'])
    expect(allChatThreads(parents, relations, sessions.filter((s) => s.id !== 'b'), quietScreen).map((row) => row.childId)).toEqual(['a1'])
    const renamed = sessions.map((s) => s.id === 'a' ? { ...s, name: 'Release prep' } : s)
    expect(allChatThreads(parents, relations, renamed, quietScreen).find((row) => row.childId === 'a1')?.parentName).toBe('Release prep')
    expect(allChatThreads(new Set(), relations, sessions, quietScreen)).toEqual([])
})

test('T144 watch: the list widens the tick to every anchored parent only while it is open', () => {
    const relations = [fork('a', 'a1'), fork('b', 'b1'), fork('c', 'c1')]
    const sessions = ['a', 'b', 'c', 'a1', 'b1', 'c1'].map((id) => session(id))
    const anchored = chatThreadParentIds(relations)
    const screenReads: string[] = []
    let storeReads = 0
    const sources = {
        relations: () => { storeReads++; return relations },
        sessions: () => { storeReads++; return sessions },
        screen: { ...quietScreen, screenStatus: (id: string) => { screenReads.push(id); return { busy: false, question: null } } }
    }
    // closed list, one chat open on parent a: exactly what the tick read before the list existed
    const closed = pollChatThreadChanges(new Set(['a']), anchored, new Map(), sources)
    expect(closed.all).toBeUndefined()
    expect(screenReads).toEqual(['a1'])
    expect(storeReads).toBe(2)

    // closed list, no chat open: zero reads
    screenReads.length = 0
    storeReads = 0
    pollChatThreadChanges(new Set(), anchored, new Map(), sources)
    expect([screenReads.length, storeReads]).toEqual([0, 0])

    // open list: every anchored parent, the subscribed one read once (shared), the store read once
    const open = pollChatThreadChanges(new Set(['a']), anchored, new Map(), sources, { previous: null })
    expect([...screenReads].sort()).toEqual(['a1', 'b1', 'c1'])
    expect(storeReads).toBe(2)
    expect(open.all?.changed).toBe(true)

    // open list with no forks anywhere: still nothing to read
    screenReads.length = 0
    storeReads = 0
    const none = pollChatThreadChanges(new Set(), new Set(), new Map(), sources, { previous: null })
    expect([screenReads.length, storeReads]).toEqual([0, 0])
    expect(none.all?.snapshot).toBe('[]')
})

test('T144 watch: status, rename and close notify on the next tick; quiet output within a bucket does not', () => {
    let relations = [fork('a', 'a1'), fork('b', 'b1')]
    let sessions = ['a', 'b', 'a1', 'b1'].map((id) => session(id))
    let status = { busy: false, question: null as string | null }
    let at = 1000
    const sources = {
        relations: () => relations,
        sessions: () => sessions,
        screen: { ...quietScreen, lastOutputAt: () => at, screenStatus: () => status }
    }
    let previous: string | null = null
    const tick = (): boolean => {
        const result = pollChatThreadChanges(new Set(), chatThreadParentIds(relations), new Map(), sources, { previous })
        previous = result.all!.snapshot
        return result.all!.changed
    }
    expect(tick()).toBe(true)
    expect(tick()).toBe(false)
    at = 20_000
    expect(tick()).toBe(false)
    status = { busy: false, question: 'Allow this?' }
    expect(tick()).toBe(true)
    sessions = sessions.map((s) => s.id === 'b' ? { ...s, name: 'Renamed parent' } : s)
    expect(tick()).toBe(true)
    sessions = sessions.map((s) => s.id === 'b' ? { ...s, workspaceName: 'moved' } : s)
    expect(tick()).toBe(true)
    sessions = sessions.filter((s) => s.id !== 'a1')
    expect(tick()).toBe(true)
    relations = relations.filter((r) => r.to !== 'a1')
    expect(tick()).toBe(false)
})

test('T144 cost: 40 sessions and 20 threads — one tick with the list open, and the closed tick, measured', () => {
    // 10 parents × 2 forks = 20 threads among 40 sessions (the rest plain sessions).
    const relations: SessionRelation[] = []
    const sessions = Array.from({ length: 40 }, (_, i) => session(`s${i}`, `ws${i % 5}`))
    for (let p = 0; p < 10; p++) {
        relations.push(fork(`s${p}`, `s${10 + p * 2}`), fork(`s${p}`, `s${11 + p * 2}`))
    }
    // the master's own opened sessions without anchors, as a real batch has
    for (let i = 30; i < 40; i++) relations.push(fork('s0', `s${i}`, { anchor: undefined }))
    const anchored = chatThreadParentIds(relations)
    expect(anchored.size).toBe(10)
    let screenReads = 0
    const sources = {
        relations: () => relations,
        sessions: () => sessions,
        screen: {
            ...quietScreen,
            screenStatus: (_id: string) => { screenReads++; return { busy: false, question: null } },
            lastOutputAt: (id: string) => Number(id.slice(1)) * 1000
        }
    }
    const measure = (run: () => void): number => {
        const times: number[] = []
        for (let round = 0; round < 5; round++) {
            const started = performance.now()
            for (let i = 0; i < 200; i++) run()
            times.push((performance.now() - started) / 200)
        }
        return times.sort((a, b) => a - b)[2]
    }
    let previous: string | null = null
    const openTick = (): void => {
        previous = pollChatThreadChanges(new Set(), anchored, new Map(), sources, { previous }).all!.snapshot
    }
    openTick()
    const rows = allChatThreads(anchored, relations, sessions, sources.screen)
    expect(rows).toHaveLength(20)
    screenReads = 0
    openTick()
    expect(screenReads).toBe(20)
    const openMs = measure(openTick)
    const closedMs = measure(() => { pollChatThreadChanges(new Set(), anchored, new Map(), sources) })
    console.log(`[T144] 40 sessions · 20 threads: open-list tick median ${openMs.toFixed(4)} ms; closed tick ${closedMs.toFixed(4)} ms (1 tick/s → open ${(openMs / 10).toFixed(4)}% CPU)`)
    // A tick every second must stay far below a millisecond-scale budget on this size.
    expect(openMs).toBeLessThan(5)
})

/** A parent Claude conversation on disk, read by the real TranscriptReader (T119's harness). */
async function quoteService(idleKeepMs?: number) {
    const conversation = '00000000-0000-4000-8000-0000000c1440'
    const cwd = '/t144/project'
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'climanager-t144-'))
    const folder = path.join(home, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'))
    fs.mkdirSync(folder, { recursive: true })
    const file = path.join(folder, `${conversation}.jsonl`)
    let n = 0
    let last: string | null = null
    const turn = (question: string, answer: string): string => {
        const user = { type: 'user', uuid: `u-${++n}`, parentUuid: last, timestamp: new Date(Date.UTC(2026, 10, 16, 0, 0, n)).toISOString(), message: { role: 'user', content: question } }
        const assistant = {
            type: 'assistant', uuid: `a-${++n}`, parentUuid: user.uuid, timestamp: new Date(Date.UTC(2026, 10, 16, 0, 0, n)).toISOString(),
            message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: answer }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }
        }
        last = assistant.uuid
        return `${JSON.stringify(user)}\n${JSON.stringify(assistant)}\n`
    }
    fs.writeFileSync(file, turn('first question', '| a | b |\n|---|---|\n\nChangelog draft is ready. Two items need your call.'))
    const reader = new TranscriptReader({ claudeConfigDir: () => home, codexHome: () => path.join(home, 'codex') })
    let forgets = 0
    const forget = reader.forget.bind(reader)
    reader.forget = (key: string) => (forgets++, forget(key))
    const events = new EventEmitter()
    const mirror = new TerminalMirror({ events, getSize: () => ({ cols: 100, rows: 30 }), hasTerminal: () => true } as never)
    events.emit('created', 'parent', 100, 30)
    const rule = '─'.repeat(98)
    events.emit('output', 'parent', ['⏺ Done.', '', rule, '❯ ', rule].join('\r\n'))
    await mirror.flush('parent')
    const changes: number[] = []
    const service = new ConversationService({
        session: () => ({ cwd, cliSessionId: conversation, cliToolName: 'claude' }),
        reader, mirror, hasTerminal: () => true, writeInput: () => undefined, type: async () => true,
        onChange: (_id, revision) => changes.push(revision),
        ...(idleKeepMs !== undefined ? { idleKeepMs } : {})
    })
    const anchorTs = new Date(Date.UTC(2026, 10, 16, 0, 0, 2)).toISOString()
    return { service, file, turn, changes, forgets: () => forgets, anchor: { turnTs: anchorTs, turnIndex: 1 } }
}

test('T144 quote: the parent reply is quoted as the thread panel quotes it; a moved anchor quotes nothing', async () => {
    const { service, anchor } = await quoteService()
    expect(service.replyQuote('parent', anchor)).toBe('Changelog draft is ready. Two items need your call.')
    expect(service.replyQuote('parent', { turnTs: anchor.turnTs })).toBe('Changelog draft is ready. Two items need your call.')
    expect(service.replyQuote('parent', { ...anchor, turnIndex: 0 })).toBe('')
    expect(service.replyQuote('parent', { turnTs: '2020-01-01T00:00:00.000Z' })).toBe('')
})

test('T144 quote (codex review): new records the quote read takes are still announced to an open parent Chat', async () => {
    const { service, file, turn, changes, anchor } = await quoteService()
    await service.getConversation('parent')
    service.subscribe('parent')
    fs.appendFileSync(file, turn('second question', 'second answer'))
    // the list reads first: the next poll will find nothing new, so the quote read has to tell
    expect(service.replyQuote('parent', anchor)).toContain('Changelog draft')
    expect(changes.length).toBe(1)
    await new Promise((resolve) => setTimeout(resolve, 1600))
    expect(changes.length).toBe(1)
    expect((await service.getConversation('parent')).turns.length).toBe(4)
    service.unsubscribe('parent')
})

test('T144 quote (codex review): a parent read only for its quote is let go after the idle wait', async () => {
    const { service, forgets, anchor } = await quoteService(80)
    expect(service.replyQuote('parent', anchor)).not.toBe('')
    expect(forgets()).toBe(0)
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(forgets()).toBe(1)
})
