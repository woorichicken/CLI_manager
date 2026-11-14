import { test, expect } from '@playwright/test'
import { EventEmitter } from 'events'
import { CronStore } from '../../src/main/CronStore'
import { CronService, CronServiceDeps, LoopTypeResult } from '../../src/main/CronService'
import { waitForWindowLoad } from '../../src/main/windowLoad'
import type { LoopState } from '../../src/shared/types'

/**
 * T132 — the fixes from the 2026-11-14 review of Autocron (PR #124 · #131), without Electron:
 *   - same names are refused, so a name reaches one job (an API DELETE by name cannot hit another)
 *   - a job made over the Control API does not run while the API is off (decision 0006 addendum)
 *   - attach types through the API's input path: a person's draft refuses, a swallowed Enter fails
 *   - a main window that fails to load ends the wait, so the scheduler does not stall
 * The typing itself (Enter retried, the draft read from the screen) runs for real in T133.
 */

const at = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi).getTime()

function fakeStore(initial: Record<string, unknown> = {}) {
    const data: Record<string, unknown> = { ...initial }
    return { get: (key: string) => data[key], set: (key: string, value: unknown) => void (data[key] = value), data }
}

const LOOPS: LoopState = {
    projects: [{ id: 'lp1', name: 'brand', path: '/b', sourceWorkspaceId: 'w', createdAt: 0 }],
    sessions: [{ id: 'ls1', loopProjectId: 'lp1', terminalId: 'term1', cliToolName: 'claude', status: 'ready', loopCount: 0, lastLoopAt: null, startedAt: 0 }]
}

function service(over: Partial<CronServiceDeps> = {}) {
    const opened: string[] = []
    const typed: Array<[string, string]> = []
    const deps: CronServiceDeps = {
        store: new CronStore(fakeStore()),
        openSession: async (input) => {
            opened.push(input.name)
            return { sessionId: `s${opened.length}`, terminalStarted: true, promptSent: true }
        },
        loops: () => LOOPS,
        typeIntoLoop: async (id, text) => (typed.push([id, text]), 'submitted'),
        hasTerminal: (id) => id === 'term1',
        loopRefusal: async () => null,
        ensureMainWindow: async () => {},
        apiOn: () => true,
        notify: () => {},
        focusSession: () => true,
        ...over
    }
    return { cron: new CronService(deps), deps, opened, typed }
}

test.describe('T132 autocron review fixes', () => {
    test('same names: refused on create and rename, case and spaces ignored; old duplicates are not picked by name', () => {
        const store = new CronStore(fakeStore())
        const base = { schedule: '0 8 * * *', agent: 'claude', cwd: '/w', prompt: 'p' }
        const first = store.create({ ...base, name: 'Dup' }, 'app', 1000)
        if (!first.ok) throw new Error(first.message)
        const again = store.create({ ...base, name: '  dUP ' }, 'api', 1000)
        expect(again).toMatchObject({ ok: false, message: expect.stringContaining('already') })

        const other = store.create({ ...base, name: 'Other' }, 'app', 1000)
        if (!other.ok) throw new Error(other.message)
        expect(store.update(other.job.id, { name: 'DUP' })).toMatchObject({ ok: false, message: expect.stringContaining('already') })
        // keeping its own name (or changing only its case) is not a clash with itself
        expect(store.update(first.job.id, { name: 'dup', prompt: 'q' }).ok).toBe(true)
        expect(store.list().map((j) => j.name)).toEqual(['dup', 'Other'])

        // two jobs that already share a name (made before this check): a name picks neither
        const raw = fakeStore({ autocrons: [{ ...first.job, id: 'a', name: 'Twin' }, { ...first.job, id: 'b', name: 'twin' }] })
        const old = new CronStore(raw)
        expect(old.get('Twin')).toBeUndefined()
        expect(old.get('b')?.id).toBe('b')
    })

    test('API-made jobs: wait while the Control API is off, show why, no catch-up when it comes back', async () => {
        let now = at(2026, 11, 13, 7, 59)
        let on = false
        const { cron, opened } = service({ apiOn: () => on, now: () => now })
        const make = (name: string, by: string) => {
            const made = cron.create({ name, schedule: '0 8 * * *', agent: 'claude', cwd: '/w', prompt: 'go' }, by)
            if (!made.ok) throw new Error(made.message)
            return made.cron
        }
        const windowJob = make('Window', 'app')
        const apiJob = make('Api', 'mcp')

        expect(cron.get(windowJob.id)).toMatchObject({ nextRunAt: at(2026, 11, 13, 8, 0) })
        expect(cron.get(windowJob.id)?.problem).toBeUndefined()
        expect(cron.get(apiJob.id)).toMatchObject({ nextRunAt: null, problem: expect.stringContaining('Control API is off') })

        now = at(2026, 11, 13, 8, 0) + 10_000
        await cron.tick()
        expect(opened).toEqual(['Window · 11/13 08:00'])
        expect(cron.runs(apiJob.id)).toEqual([])

        // «Run now» from the window does not get around it either
        const manual = await cron.runNow(apiJob.id)
        expect(manual).toMatchObject({ status: 'failed', note: expect.stringContaining('Control API is off') })
        expect(opened.length).toBe(1)

        // the API comes back at 09:00: 08:00 is not caught up, the next morning runs
        on = true
        now = at(2026, 11, 13, 9, 0)
        await cron.tick()
        expect(opened.length).toBe(1)
        expect(cron.get(apiJob.id)?.problem).toBeUndefined()
        now = at(2026, 11, 14, 8, 0) + 10_000
        await cron.tick()
        expect(opened.sort()).toEqual(['Api · 11/14 08:00', 'Window · 11/13 08:00', 'Window · 11/14 08:00'])
    })

    test('attach: one line through typeIntoLoop; a draft, a stuck prompt or a gone terminal fail with why', async () => {
        let answer: LoopTypeResult = 'submitted'
        const { cron, typed } = service({ typeIntoLoop: async (id, text) => (typed.push([id, text]), answer), now: () => at(2026, 11, 13, 12, 0) })
        const made = cron.create({ name: 'Nudge', schedule: '*/30 * * * *', mode: 'attach', loopProjectId: 'lp1', prompt: 'next\r\nstep' }, 'app')
        if (!made.ok) throw new Error(made.message)

        expect(await cron.runNow(made.cron.id)).toMatchObject({ status: 'started', sessionId: 'term1' })
        expect(typed).toEqual([['term1', 'next step']])

        answer = 'busy'
        expect(await cron.runNow(made.cron.id)).toMatchObject({ status: 'failed', sessionId: 'term1', note: expect.stringContaining('already has text') })
        answer = 'stuck'
        expect(await cron.runNow(made.cron.id)).toMatchObject({ status: 'failed', sessionId: 'term1', note: expect.stringContaining('still in the input box') })
        answer = 'gone'
        expect(await cron.runNow(made.cron.id)).toMatchObject({ status: 'failed', note: 'the loop terminal is gone' })
    })

    test('window load: finish resolves; a main-frame failure or the time limit rejects; listeners go', async () => {
        const contents = () => new EventEmitter()

        const ok = contents()
        const loaded = waitForWindowLoad(ok, 1000)
        ok.emit('did-finish-load')
        await expect(loaded).resolves.toBeUndefined()
        expect(ok.listenerCount('did-finish-load') + ok.listenerCount('did-fail-load')).toBe(0)

        const failing = contents()
        const failed = waitForWindowLoad(failing, 1000)
        failing.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'app://x', true) // an aborted navigation is not a failure
        failing.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://frame', false) // a sub-frame
        failing.emit('did-fail-load', {}, -6, 'ERR_FILE_NOT_FOUND', 'file:///index.html', true)
        await expect(failed).rejects.toThrow('ERR_FILE_NOT_FOUND')
        expect(failing.listenerCount('did-finish-load') + failing.listenerCount('did-fail-load')).toBe(0)

        const silent = contents()
        await expect(waitForWindowLoad(silent, 30)).rejects.toThrow('did not load')
        expect(silent.listenerCount('did-finish-load') + silent.listenerCount('did-fail-load')).toBe(0)
    })

    test('scheduler: a window that cannot load fails that run, and later ticks still run', async () => {
        let now = at(2026, 11, 13, 7, 59)
        let windowOk = false
        const { cron, opened } = service({
            now: () => now,
            ensureMainWindow: () => (windowOk ? Promise.resolve() : waitForWindowLoad(new EventEmitter(), 30))
        })
        const made = cron.create({ name: 'A', schedule: '0 * * * *', agent: 'claude', cwd: '/w', prompt: 'go' }, 'app')
        if (!made.ok) throw new Error(made.message)

        now = at(2026, 11, 13, 8, 0) + 5_000
        await cron.tick()
        expect(cron.runs(made.cron.id)![0]).toMatchObject({ status: 'failed', note: expect.stringContaining('did not load') })

        windowOk = true
        now = at(2026, 11, 13, 9, 0) + 5_000
        await cron.tick()
        expect(opened).toEqual(['A · 11/13 09:00'])
    })
})
