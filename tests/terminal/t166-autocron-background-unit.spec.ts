import { test, expect } from '@playwright/test'
import { CronStore } from '../../src/main/CronStore'
import { CRON_IDLE_CLOSE_MS, CronBackgroundDeps, CronBackgroundState, CronService, CronServiceDeps } from '../../src/main/CronService'
import type { CronRunConversation } from '../../src/shared/autocron'
import type { SessionRelation, Workspace } from '../../src/shared/types'
import { unlistedSessionIds, withoutThreadSessions } from '../../src/renderer/src/utils/relatedSessions'

/**
 * T166 — Autocron's background sessions (2026-11-24), without Electron:
 *   - a «new» run opens its session hidden (out of the session lists); a failed start is shown at once
 *   - each tick: idle for CRON_IDLE_CLOSE_MS (no output, nothing running, no question) → closed, the
 *     conversation kept on the run; a question → the inbox once per question, never closed; nothing to
 *     resume from → shown instead; a hidden session no live run owns (job deleted) → shown
 *   - «Open session»: a live session is focused; a closed one is resumed in a new session the run then names
 *   - the sidebar's filter leaves hidden sessions out like reply threads, except the one on screen
 * The window side (sidebar rows, config.json, Resume) runs for real in T167.
 */

function fakeStore(initial: Record<string, unknown> = {}) {
    const data: Record<string, unknown> = { ...initial }
    return { get: (key: string) => data[key], set: (key: string, value: unknown) => void (data[key] = value), data }
}

const CONVERSATION: CronRunConversation = { agent: 'claude', id: '00000000-0000-4000-8000-000000000166', cwd: '/w', name: 'job · 11/24 08:00', command: 'cldy' }

function harness(over: Partial<CronServiceDeps> = {}) {
    let now = 1_000_000
    const hidden = new Set<string>()
    const states = new Map<string, CronBackgroundState>()
    const log: string[] = []
    const asked: Array<[string, string]> = []
    let conversationFor: (id: string) => CronRunConversation | null = () => CONVERSATION
    let next = 0
    const background: CronBackgroundDeps = {
        hiddenSessionIds: () => [...hidden],
        state: (id) => states.get(id) ?? { kind: 'gone' },
        reveal: (id) => {
            if (hidden.delete(id)) log.push(`reveal ${id}`)
        },
        close: (id) => {
            const conversation = conversationFor(id)
            if (conversation) {
                hidden.delete(id)
                log.push(`close ${id}`)
            }
            return conversation
        },
        resume: async (conversation) => {
            log.push(`resume ${conversation.id}`)
            return 'resumed-1'
        },
        askPerson: (id, text) => void asked.push([id, text])
    }
    const openedHidden: Array<boolean | undefined> = []
    const focusable = new Set<string>()
    const deps: CronServiceDeps = {
        store: new CronStore(fakeStore()),
        openSession: async (input) => {
            openedHidden.push(input.hidden)
            const id = `s${++next}`
            if (input.hidden) hidden.add(id)
            focusable.add(id)
            return { sessionId: id, terminalStarted: true, promptSent: true }
        },
        loops: () => ({ projects: [], sessions: [] }),
        typeIntoLoop: async () => 'submitted',
        hasTerminal: () => false,
        loopRefusal: async () => null,
        ensureMainWindow: async () => {},
        apiOn: () => true,
        notify: () => {},
        focusSession: (id) => focusable.has(id),
        background,
        now: () => now,
        ...over
    }
    const cron = new CronService(deps)
    const job = () => {
        const made = cron.create({ name: 'job', schedule: '0 8 * * *', agent: 'claude', cwd: '/w', prompt: 'go' }, 'app')
        if (!made.ok) throw new Error(made.message)
        return made.cron
    }
    return {
        cron, deps, hidden, states, log, asked, openedHidden, focusable, job,
        advance: (ms: number) => void (now += ms),
        now: () => now,
        setConversation: (fn: (id: string) => CronRunConversation | null) => void (conversationFor = fn)
    }
}

test.describe('T166 autocron background sessions', () => {
    test('a new run opens hidden; without the background deps it opens an ordinary session', async () => {
        const h = harness()
        const run = await h.cron.runNow(h.job().id)
        expect(run).toMatchObject({ status: 'started', sessionId: 's1' })
        expect(h.openedHidden).toEqual([true])
        expect([...h.hidden]).toEqual(['s1'])

        const plain = harness({ background: undefined })
        await plain.cron.runNow(plain.job().id)
        expect(plain.openedHidden).toEqual([undefined])
    })

    test('a failed start is shown at once — it needs a person', async () => {
        const h = harness()
        h.deps.openSession = async (input) => {
            h.hidden.add('s9')
            return { sessionId: 's9', terminalStarted: true, promptSent: false, note: input.hidden ? 'trust question' : '' }
        }
        const run = await h.cron.runNow(h.job().id)
        expect(run).toMatchObject({ status: 'failed', sessionId: 's9', note: 'trust question' })
        expect(h.log).toEqual(['reveal s9'])
        expect(h.hidden.size).toBe(0)
    })

    test('idle for the close time → closed, conversation on the run; working or recent output → kept', async () => {
        const h = harness()
        const run = await h.cron.runNow(h.job().id)
        h.states.set('s1', { kind: 'working' })
        h.advance(CRON_IDLE_CLOSE_MS * 3)
        await h.cron.tick()
        expect(h.log).toEqual([])

        // idle, but its last output was a minute short of the close time
        h.states.set('s1', { kind: 'idle', since: h.now() - CRON_IDLE_CLOSE_MS + 60_000 })
        await h.cron.tick()
        expect(h.log).toEqual([])

        h.advance(60_000)
        await h.cron.tick()
        expect(h.log).toEqual(['close s1'])
        const record = h.cron.runs('job')!.find((r) => r.id === run.id)!
        expect(record).toMatchObject({ status: 'started', sessionId: 's1', closedAt: h.now(), conversation: CONVERSATION })

        // closed once: the next tick has nothing hidden to look at
        await h.cron.tick()
        expect(h.log).toEqual(['close s1'])
    })

    test('a question: the inbox once per question, never closed', async () => {
        const h = harness()
        await h.cron.runNow(h.job().id)
        h.states.set('s1', { kind: 'question', question: 'Do you want to proceed?' })
        h.advance(CRON_IDLE_CLOSE_MS * 2)
        await h.cron.tick()
        await h.cron.tick()
        expect(h.asked).toEqual([['s1', 'Autocron "job" is waiting for you: Do you want to proceed?']])
        h.states.set('s1', { kind: 'question', question: 'Allow this command?' })
        await h.cron.tick()
        expect(h.asked.map(([, text]) => text)).toEqual([
            'Autocron "job" is waiting for you: Do you want to proceed?',
            'Autocron "job" is waiting for you: Allow this command?'
        ])
        // answered and back again: asked again
        h.states.set('s1', { kind: 'working' })
        await h.cron.tick()
        h.states.set('s1', { kind: 'question', question: 'Allow this command?' })
        await h.cron.tick()
        expect(h.asked).toHaveLength(3)
        expect(h.log).toEqual([])
    })

    test('nothing to resume from → shown instead of closed', async () => {
        const h = harness()
        h.setConversation(() => null)
        const run = await h.cron.runNow(h.job().id)
        h.states.set('s1', { kind: 'idle', since: h.now() })
        h.advance(CRON_IDLE_CLOSE_MS)
        await h.cron.tick()
        expect(h.log).toEqual(['reveal s1'])
        expect(h.cron.runs('job')!.find((r) => r.id === run.id)!.closedAt).toBeUndefined()
    })

    test('a hidden session no live run owns is shown: its job deleted, or no record at all', async () => {
        const h = harness()
        const job = h.job()
        await h.cron.runNow(job.id)
        h.hidden.add('stray')
        h.states.set('s1', { kind: 'working' })
        await h.cron.tick()
        expect(h.log).toEqual(['reveal stray'])
        h.cron.remove(job.id)
        await h.cron.tick()
        expect(h.log).toEqual(['reveal stray', 'reveal s1'])
    })

    test('a session still starting (opened, run not recorded yet) is not taken for an orphan', async () => {
        const h = harness()
        let tickedWhileStarting = false
        h.deps.openSession = async () => {
            h.hidden.add('s1')
            // the scheduler ticks while openSession waits for the prompt to go in
            await h.cron.tick()
            tickedWhileStarting = true
            return { sessionId: 's1', terminalStarted: true, promptSent: true }
        }
        await h.cron.runNow(h.job().id)
        expect(tickedWhileStarting).toBe(true)
        expect(h.log).toEqual([])
        expect([...h.hidden]).toEqual(['s1'])
    })

    test('no output yet (since 0, a restored terminal not drawn) is not idle', async () => {
        const h = harness()
        await h.cron.runNow(h.job().id)
        h.states.set('s1', { kind: 'idle', since: 0 })
        h.advance(CRON_IDLE_CLOSE_MS * 10)
        await h.cron.tick()
        expect(h.log).toEqual([])
    })

    test('Resume clicked twice while the first is starting opens one session', async () => {
        const h = harness()
        await h.cron.runNow(h.job().id)
        h.states.set('s1', { kind: 'idle', since: h.now() })
        h.advance(CRON_IDLE_CLOSE_MS)
        await h.cron.tick()
        h.focusable.delete('s1')
        let release: (id: string) => void = () => {}
        let resumes = 0
        h.deps.background!.resume = () => {
            resumes++
            return new Promise<string>((resolve) => { release = resolve })
        }
        const first = h.cron.openSession('s1')
        const second = h.cron.openSession('s1')
        release('resumed-1')
        expect(await Promise.all([first, second])).toEqual([true, true])
        expect(resumes).toBe(1)
    })

    test('the test timing shortens the idle close', async () => {
        const h = harness({ timing: { idleCloseMs: 1000 } })
        await h.cron.runNow(h.job().id)
        h.states.set('s1', { kind: 'idle', since: h.now() })
        h.advance(1000)
        await h.cron.tick()
        expect(h.log).toEqual(['close s1'])
    })

    test('Open session: a live session is focused; a closed one is resumed and the run follows it', async () => {
        const h = harness()
        const run = await h.cron.runNow(h.job().id)
        expect(await h.cron.openSession('s1')).toBe(true)
        expect(h.log).toEqual([])

        h.states.set('s1', { kind: 'idle', since: h.now() })
        h.advance(CRON_IDLE_CLOSE_MS)
        await h.cron.tick()
        h.focusable.delete('s1')
        expect(await h.cron.openSession('s1')).toBe(true)
        expect(h.log).toEqual(['close s1', `resume ${CONVERSATION.id}`])
        const record = h.cron.runs('job')!.find((r) => r.id === run.id)!
        expect(record.sessionId).toBe('resumed-1')
        expect(record.closedAt).toBeUndefined()
        expect(record.conversation).toEqual(CONVERSATION)

        // gone with nothing to resume
        expect(await h.cron.openSession('never-was')).toBe(false)
    })

    test('the sidebar filter leaves hidden sessions out like threads, except the one on screen', () => {
        const session = (id: string, hidden?: boolean) => ({ id, name: id, cwd: '/w', type: 'regular' as const, ...(hidden ? { hidden } : {}) })
        const workspaces = [
            { id: 'w1', name: 'W1', path: '/w', sessions: [session('a'), session('bg', true), session('t')] },
            { id: 'w2', name: 'W2', path: '/v', sessions: [session('b')] }
        ] as unknown as Workspace[]
        const relations = [{ from: 'a', to: 't', kind: 'opened', at: 1, anchor: { turnTs: '2026-11-24T00:00:00Z' } }] as unknown as SessionRelation[]
        const unlisted = unlistedSessionIds(relations, workspaces)
        expect([...unlisted].sort()).toEqual(['bg', 't'])
        const listed = withoutThreadSessions(workspaces, unlisted)
        expect(listed[0].sessions.map((s) => s.id)).toEqual(['a'])
        expect(listed[1]).toBe(workspaces[1])
        expect(withoutThreadSessions(workspaces, unlisted, ['bg'])[0].sessions.map((s) => s.id)).toEqual(['a', 'bg'])
        // no hidden session, no thread: the same workspaces
        expect(unlistedSessionIds([], [workspaces[1]]).size).toBe(0)
    })
})
