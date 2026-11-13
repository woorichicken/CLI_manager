import { test, expect } from '@playwright/test'
import { nextRun, parseCron, planTick, runsBetween, DEFAULT_MISSED, ON_TIME_GRACE_MS } from '../../src/shared/cron'
import { CronStore, CRON_RUNS_MAX, checkCronInput } from '../../src/main/CronStore'
import { CronService, CronServiceDeps } from '../../src/main/CronService'
import type { LoopState } from '../../src/shared/types'

/**
 * T127 — Autocron without Electron: the cron reader, next-run math, the missed-run decision
 * (on time / caught up once / skipped / notify / expired), job input checks, and the scheduler
 * driving a fake runner (new session, attach to a loop, failures, the bookmark moving first).
 * Expected times are built with `new Date(y, m, d, h, min)` — the same local clock the code reads.
 */

const MIN = 60_000
const at = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi).getTime()

function schedule(expr: string) {
    const parsed = parseCron(expr)
    if (!parsed.ok) throw new Error(parsed.message)
    return parsed.schedule
}

function fakeStore(initial: Record<string, unknown> = {}) {
    const data: Record<string, unknown> = { ...initial }
    return { get: (key: string) => data[key], set: (key: string, value: unknown) => void (data[key] = value), data }
}

test.describe('T127 autocron', () => {
    test('cron reader: fields, ranges, steps, lists, aliases, and clear errors', () => {
        expect(parseCron('0 8 * * *').ok).toBe(true)
        expect(parseCron('*/15 9-18 * * 1-5').ok).toBe(true)
        expect(parseCron('0 0 1,15 * *').ok).toBe(true)
        expect(parseCron('@daily').ok).toBe(true)
        expect(parseCron('0 9 * * 7').ok).toBe(true)

        const bad = (expr: string) => {
            const r = parseCron(expr)
            return r.ok ? '' : r.message
        }
        expect(bad('0 8 * *')).toContain('five fields')
        // inherited object keys are not aliases (Codex review: they threw instead of a message)
        expect(bad('constructor')).toContain('five fields')
        expect(bad('__proto__')).toContain('five fields')
        expect(bad('60 8 * * *')).toContain('minute')
        expect(bad('0 24 * * *')).toContain('hour')
        expect(bad('0 8 * 13 *')).toContain('month')
        expect(bad('*/0 * * * *')).toContain('step')
        expect(bad('0 0 30 2 *')).toContain('never matches')
    })

    test('next run: same day, next day, weekdays only, either-day rule, Sunday as 7', () => {
        const from = at(2026, 11, 13, 7, 59) // Friday
        expect(nextRun(schedule('0 8 * * *'), from)).toBe(at(2026, 11, 13, 8, 0))
        expect(nextRun(schedule('0 8 * * *'), at(2026, 11, 13, 8, 0))).toBe(at(2026, 11, 14, 8, 0))
        // weekdays: Friday 18:00 → Monday 09:00
        expect(nextRun(schedule('0 9 * * 1-5'), at(2026, 11, 13, 18, 0))).toBe(at(2026, 11, 16, 9, 0))
        expect(nextRun(schedule('0 9 * * 7'), from)).toBe(at(2026, 11, 15, 9, 0))
        // day 1 OR Monday: from Fri 13th, the next Monday (16th) comes before the 1st
        expect(nextRun(schedule('0 0 1 * 1'), from)).toBe(at(2026, 11, 16, 0, 0))
        // steps across the hour
        expect(nextRun(schedule('*/15 * * * *'), at(2026, 11, 13, 10, 50))).toBe(at(2026, 11, 13, 11, 0))
        // month rollover and year
        expect(nextRun(schedule('30 6 1 1 *'), from)).toBe(at(2027, 1, 1, 6, 30))
    })

    test('runsBetween counts all and keeps the newest', () => {
        const { times, total } = runsBetween(schedule('0 * * * *'), at(2026, 11, 13, 0, 0), at(2026, 11, 13, 5, 0), 2)
        expect(total).toBe(5)
        expect(times).toEqual([at(2026, 11, 13, 4, 0), at(2026, 11, 13, 5, 0)])
    })

    test('planTick: on time runs; one due now covers earlier misses', () => {
        const s = schedule('0 8 * * *')
        const now = at(2026, 11, 13, 8, 0) + 30_000
        expect(planTick(s, now - 60_000, now, DEFAULT_MISSED)).toEqual([
            { type: 'run', plannedAt: at(2026, 11, 13, 8, 0), reason: 'scheduled', missedCount: 0 }
        ])
        // app was closed for two days and opened right at 08:00:30
        expect(planTick(s, at(2026, 11, 11, 7, 0), now, DEFAULT_MISSED)).toEqual([
            { type: 'run', plannedAt: at(2026, 11, 13, 8, 0), reason: 'scheduled', missedCount: 2 }
        ])
        expect(planTick(s, now - 30_000, now, DEFAULT_MISSED)).toEqual([]) // already looked at 08:00:00 → nothing new
    })

    test('planTick: missed runs fold into one decision per policy', () => {
        const s = schedule('0 8 * * *')
        const wokeAt = at(2026, 11, 13, 9, 41) // Mac asleep since the night before
        const lastChecked = at(2026, 11, 12, 23, 0)

        expect(planTick(s, lastChecked, wokeAt, { policy: 'once', withinMinutes: 360 })).toEqual([
            { type: 'run', plannedAt: at(2026, 11, 13, 8, 0), reason: 'caught-up', missedCount: 0 }
        ])
        expect(planTick(s, lastChecked, wokeAt, { policy: 'once', withinMinutes: 60 })).toEqual([
            { type: 'missed', plannedAt: at(2026, 11, 13, 8, 0), missedCount: 0, why: 'expired' }
        ])
        expect(planTick(s, lastChecked, wokeAt, { policy: 'skip', withinMinutes: 360 })[0]).toMatchObject({ type: 'missed', why: 'skip' })
        expect(planTick(s, lastChecked, wokeAt, { policy: 'notify', withinMinutes: 360 })[0]).toMatchObject({ type: 'missed', why: 'notify' })

        // a weekend off: three mornings missed, caught up once
        const monday = at(2026, 11, 16, 9, 0)
        expect(planTick(s, at(2026, 11, 13, 9, 0), monday, DEFAULT_MISSED)).toEqual([
            { type: 'run', plannedAt: at(2026, 11, 16, 8, 0), reason: 'caught-up', missedCount: 2 }
        ])
        // just outside the grace is late
        const late = at(2026, 11, 13, 8, 0) + ON_TIME_GRACE_MS + 1
        expect(planTick(s, at(2026, 11, 13, 7, 0), late, DEFAULT_MISSED)[0]).toMatchObject({ reason: 'caught-up' })
    })

    test('job input: required fields, mode rules, missed bounds, edit merges', () => {
        const ok = checkCronInput({ name: 'Morning', schedule: '0 8 * * *', agent: 'claude', cwd: '/tmp', prompt: '/content-plan work next' })
        expect(ok.ok).toBe(true)
        if (ok.ok) expect(ok.job).toMatchObject({ mode: 'new', enabled: true, missed: DEFAULT_MISSED })

        const msg = (input: Record<string, unknown>) => {
            const r = checkCronInput(input)
            return r.ok ? '' : r.message
        }
        const base = { name: 'x', schedule: '0 8 * * *', prompt: 'p' }
        expect(msg({ ...base, agent: 'claude' })).toContain('cwd')
        expect(msg({ ...base, cwd: '/tmp' })).toContain('agent')
        expect(msg({ ...base, cwd: '/tmp', agent: 'claude', template: 'T' })).toContain('either')
        expect(msg({ ...base, mode: 'attach' })).toContain('loopProjectId')
        expect(msg({ ...base, mode: 'loop', cwd: '/tmp', agent: 'c' })).toContain('mode')
        expect(msg({ ...base, schedule: '0 8 * *', cwd: '/tmp', agent: 'c' })).toContain('schedule')
        expect(msg({ ...base, cwd: '/tmp', agent: 'c', missed: { policy: 'later' } })).toContain('missed.policy')
        expect(msg({ ...base, cwd: '/tmp', agent: 'c', missed: { policy: 'once', withinMinutes: 0 } })).toContain('withinMinutes')
        expect(msg({ ...base, prompt: '', cwd: '/tmp', agent: 'c' })).toContain('prompt')

        const store = new CronStore(fakeStore())
        const made = store.create({ ...base, cwd: '/tmp', agent: 'claude' }, 'app', 1000)
        expect(made.ok).toBe(true)
        if (!made.ok) return
        const edited = store.update(made.job.id, { mode: 'attach', loopProjectId: 'lp1' }, 2000)
        expect(edited.ok).toBe(true)
        if (edited.ok) {
            expect(edited.job).toMatchObject({ mode: 'attach', loopProjectId: 'lp1', name: 'x', prompt: 'p' })
            expect(edited.job.agent).toBeUndefined()
            expect(edited.job.cwd).toBeUndefined()
        }

        // the form switching Template → Command drops the template (it kept it and ran it)
        const t = store.create({ ...base, name: 'y', cwd: '/tmp', template: 'T' }, 'app', 1000)
        if (!t.ok) throw new Error(t.message)
        const switched = store.update(t.job.id, { agent: 'claude', template: '' }, 2000)
        expect(switched.ok && switched.job).toMatchObject({ agent: 'claude' })
        if (switched.ok) expect(switched.job.template).toBeUndefined()
        expect(store.update(t.job.id, { enabled: false }, 3000).ok).toBe(true)
    })

    test('next run moves forward through the night clocks go back (America/New_York 2026-11-01)', () => {
        const savedTz = process.env.TZ
        process.env.TZ = 'America/New_York'
        try {
            const every = schedule('* * * * *')
            // 01:30 EST, the second 01:30 of the night (06:30 UTC)
            const after = Date.UTC(2026, 10, 1, 6, 30)
            expect(nextRun(every, after)).toBe(after + MIN)
            // two real hours, 120 minutes — none twice, none skipped
            expect(runsBetween(every, Date.UTC(2026, 10, 1, 5, 0), Date.UTC(2026, 10, 1, 7, 0)).total).toBe(120)
            // a daily 03:00 still lands on local 03:00 (08:00 UTC after the change)
            expect(nextRun(schedule('0 3 * * *'), Date.UTC(2026, 10, 1, 5, 0))).toBe(Date.UTC(2026, 10, 1, 8, 0))
        } finally {
            if (savedTz === undefined) delete process.env.TZ
            else process.env.TZ = savedTz
        }
    })

    test('store: switching on or changing the schedule restarts the bookmark; runs are capped', () => {
        const store = new CronStore(fakeStore())
        const made = store.create({ name: 'a', schedule: '0 8 * * *', agent: 'claude', cwd: '/tmp', prompt: 'p' }, 'app', 1000)
        if (!made.ok) throw new Error(made.message)
        const id = made.job.id
        expect(store.checkedAt(store.get(id)!)).toBe(1000)
        store.setCheckedAt(id, 5000)
        store.update(id, { enabled: false }, 6000)
        expect(store.checkedAt(store.get(id)!)).toBe(5000)
        store.update(id, { enabled: true }, 9000)
        expect(store.checkedAt(store.get(id)!)).toBe(9000)
        store.update(id, { schedule: '0 9 * * *' }, 12000)
        expect(store.checkedAt(store.get(id)!)).toBe(12000)

        for (let i = 0; i < CRON_RUNS_MAX + 5; i++) {
            store.addRun({ cronId: id, plannedAt: i, at: i, trigger: 'manual', status: 'started', missedCount: 0 })
        }
        expect(store.runs().length).toBe(CRON_RUNS_MAX)
        expect(store.runs()[0].plannedAt).toBe(CRON_RUNS_MAX + 4)
        expect(store.get('A')?.id).toBe(id) // by name, case-insensitive
        expect(store.remove(id)).toBe(true)
        expect(store.runs().length).toBe(0)
    })

    test('scheduler: runs a new session on time, catches up once on wake, records misses and failures', async () => {
        let now = at(2026, 11, 13, 7, 59)
        const opened: Array<Record<string, unknown>> = []
        const notes: string[] = []
        const loops: LoopState = { projects: [], sessions: [] }
        const written: Array<[string, string]> = []
        let openResult = { terminalStarted: true, promptSent: true }
        const deps: CronServiceDeps = {
            store: new CronStore(fakeStore()),
            openSession: async (input) => {
                opened.push(input)
                return { sessionId: `s${opened.length}`, ...openResult }
            },
            loops: () => loops,
            writeInput: (id, data) => (written.push([id, data]), id === 'term1'),
            hasTerminal: (id) => id === 'term1',
            loopRefusal: async () => null,
            ensureMainWindow: async () => {},
            notify: (title) => void notes.push(title),
            focusSession: (id) => id.startsWith('s'),
            now: () => now,
            sleep: async () => {}
        }
        const service = new CronService(deps)
        const made = service.create({ name: 'Morning', schedule: '0 8 * * *', agent: 'claude', cwd: '/w', prompt: 'go' }, 'app')
        if (!made.ok) throw new Error(made.message)
        expect(made.cron.nextRunAt).toBe(at(2026, 11, 13, 8, 0))

        now = at(2026, 11, 13, 8, 0) + 20_000
        await service.tick()
        expect(opened).toEqual([{ path: '/w', command: 'claude', name: 'Morning · 11/13 08:00', prompt: 'go' }])
        expect(service.runs('Morning')![0]).toMatchObject({ status: 'started', trigger: 'scheduled', sessionId: 's1' })

        await service.tick() // same minute again: nothing more
        expect(opened.length).toBe(1)

        // asleep overnight, woke 09:41 next day → caught up once
        now = at(2026, 11, 14, 9, 41)
        await service.tick()
        expect(opened.length).toBe(2)
        expect(service.runs('Morning')![0]).toMatchObject({ trigger: 'caught-up', missedCount: 0, plannedAt: at(2026, 11, 14, 8, 0) })

        // set to notify; next morning missed → no session, a missed record, a notification
        service.update('Morning', { missed: { policy: 'notify', withinMinutes: 360 } })
        now = at(2026, 11, 15, 10, 0)
        await service.tick()
        expect(opened.length).toBe(2)
        expect(service.runs('Morning')![0]).toMatchObject({ status: 'missed' })
        expect(notes.some((n) => n.startsWith('Autocron missed'))).toBe(true)

        // a run that cannot start is recorded as failed with the reason
        openResult = { terminalStarted: true, promptSent: false }
        const failed = await service.runNow('Morning')
        expect(failed).toMatchObject({ status: 'failed', trigger: 'manual', sessionId: 's3' })
        expect(service.openSession('s3')).toBe(true)
    })

    test('scheduler: attach types into a running loop, or fails when it is not running', async () => {
        const now = at(2026, 11, 13, 12, 0)
        const loops: LoopState = {
            projects: [{ id: 'lp1', name: 'brand', path: '/b', sourceWorkspaceId: 'w', createdAt: 0 }],
            sessions: [{ id: 'ls1', loopProjectId: 'lp1', terminalId: 'term1', cliToolName: 'claude', status: 'ready', loopCount: 0, lastLoopAt: null, startedAt: 0 }]
        }
        const written: Array<[string, string]> = []
        let refusal: string | null = null
        const service = new CronService({
            store: new CronStore(fakeStore()),
            openSession: async () => { throw new Error('should not open') },
            loops: () => loops,
            writeInput: (id, data) => (written.push([id, data]), id === 'term1'),
            hasTerminal: (id) => id === 'term1',
            loopRefusal: async () => refusal,
            ensureMainWindow: async () => {},
            notify: () => {},
            focusSession: () => true,
            now: () => now,
            sleep: () => new Promise((r) => setTimeout(r, 5))
        })
        const made = service.create({ name: 'Nudge', schedule: '*/30 * * * *', mode: 'attach', loopProjectId: 'lp1', prompt: 'next step\nplease' }, 'api')
        if (!made.ok) throw new Error(made.message)
        const run = await service.runNow(made.cron.id)
        expect(run).toMatchObject({ status: 'started', sessionId: 'term1' })
        expect(written).toEqual([['term1', 'next step please'], ['term1', '\r']])

        // a question on screen, or only the shell left: nothing is typed, the run fails with why
        written.length = 0
        refusal = 'the loop is showing a question or menu'
        expect(await service.runNow(made.cron.id)).toMatchObject({ status: 'failed', note: refusal })
        expect(written).toEqual([])
        refusal = null

        // two jobs on the same loop at once: each text is followed by its own Enter, never «AB↵↵»
        const other = service.create({ name: 'Nudge 2', schedule: '*/30 * * * *', mode: 'attach', loopProjectId: 'lp1', prompt: 'B' }, 'api')
        if (!other.ok) throw new Error(other.message)
        await Promise.all([service.runNow(made.cron.id), service.runNow(other.cron.id)])
        expect(written).toEqual([['term1', 'next step please'], ['term1', '\r'], ['term1', 'B'], ['term1', '\r']])

        loops.sessions[0] = { ...loops.sessions[0], terminalId: 'gone' }
        expect(await service.runNow(made.cron.id)).toMatchObject({ status: 'failed' })
        loops.projects.length = 0
        expect(service.get(made.cron.id)?.problem).toContain('removed')
    })
})
