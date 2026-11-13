import { test, expect } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { nextRun, parseCron, planTick, runsBetween, DEFAULT_MISSED, ON_TIME_GRACE_MS } from '../../src/shared/cron'
import { CronStore, CRONS_MAX, CRON_NAME_MAX, CRON_PROMPT_MAX, WITHIN_MINUTES_MAX, checkCronInput } from '../../src/main/CronStore'
import { CronService, CronServiceDeps, OpenedSession } from '../../src/main/CronService'
import { ControlApiServer } from '../../src/main/ControlApiServer'
import type { ControlApiService } from '../../src/main/ControlApiService'
import { DEFAULT_CONTROL_API, type LoopState } from '../../src/shared/types'

/**
 * T129 — Autocron in more cases, without Electron (T127 is the first pass).
 *
 * 1. Next-run math against an independent oracle: a minute-by-minute walk with its own
 *    field reader, over seeded random schedules, in seven time zones, starting near each
 *    zone's clock changes (30-minute DST, a midnight change, +5:45, +12:45).
 * 2. The cron reader on edge inputs (accepted and refused, each with its message).
 * 3. The missed-run decision at its exact boundaries, a clock moved back, a week of
 *    every-minute misses.
 * 4. Job input limits and edits; the job cap; name lookups.
 * 5. The scheduler with a fake runner: disabled jobs, a broken schedule in the store,
 *    overlapping ticks and runs, thrown errors, a job removed mid-run, the attach queue
 *    after a failure.
 * 6. `/v1/crons` over real HTTP (ControlApiServer with a stand-in service).
 */

const MIN = 60_000
const DAY = 24 * 60 * MIN
const at = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi).getTime()

function schedule(expr: string) {
    const parsed = parseCron(expr)
    if (!parsed.ok) throw new Error(`${expr}: ${parsed.message}`)
    return parsed.schedule
}

function fakeStore(initial: Record<string, unknown> = {}) {
    const data: Record<string, unknown> = { ...initial }
    return { get: (key: string) => data[key], set: (key: string, value: unknown) => void (data[key] = value), data }
}

function withTz<T>(tz: string, body: () => T): T {
    const saved = process.env.TZ
    process.env.TZ = tz
    try {
        return body()
    } finally {
        if (saved === undefined) delete process.env.TZ
        else process.env.TZ = saved
    }
}

// ---------------------------------------------------------------------------
// The oracle: its own field reader and a walk over every minute
// ---------------------------------------------------------------------------

/** Reads one field the plain way — no shared code with src/shared/cron.ts. */
function oracleField(text: string, min: number, max: number, dayOfWeek = false): Set<number> {
    const out = new Set<number>()
    for (const part of text.split(',')) {
        const [range, stepText] = part.split('/')
        const step = stepText ? Number(stepText) : 1
        let lo: number
        let hi: number
        if (range === '*') {
            lo = min
            hi = dayOfWeek ? 6 : max
        } else if (range.includes('-')) {
            ;[lo, hi] = range.split('-').map(Number)
        } else {
            lo = Number(range)
            hi = stepText ? max : lo
        }
        for (let v = lo; v <= hi; v += step) out.add(dayOfWeek && v === 7 ? 0 : v)
    }
    return out
}

function oracle(expr: string) {
    const [mi, h, dom, mo, dow] = expr.split(' ')
    const m = oracleField(mi, 0, 59)
    const hr = oracleField(h, 0, 23)
    const d = oracleField(dom, 1, 31)
    const mon = oracleField(mo, 1, 12)
    const wd = oracleField(dow, 0, 7, true)
    const matches = (t: number): boolean => {
        const x = new Date(t)
        if (!m.has(x.getMinutes()) || !hr.has(x.getHours()) || !mon.has(x.getMonth() + 1)) return false
        const domOk = d.has(x.getDate())
        const dowOk = wd.has(x.getDay())
        if (dom === '*' && dow === '*') return true
        if (dom === '*') return dowOk
        if (dow === '*') return domOk
        return domOk || dowOk
    }
    return {
        matches,
        next(after: number, limitMinutes: number): number | null {
            let t = Math.floor(after / MIN) * MIN + MIN
            for (let i = 0; i < limitMinutes; i++, t += MIN) if (matches(t)) return t
            return null
        }
    }
}

/** mulberry32 — the same cases every run. */
function rng(seed: number) {
    let a = seed
    return () => {
        a |= 0
        a = (a + 0x6d2b79f5) | 0
        let t = Math.imul(a ^ (a >>> 15), 1 | a)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}

function randomField(rand: () => number, min: number, max: number, starChance: number): string {
    const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1))
    const roll = rand()
    if (roll < starChance) return '*'
    const kind = int(0, 4)
    if (kind === 0) return `*/${int(1, Math.max(1, Math.floor((max - min) / 2)))}`
    if (kind === 1) return String(int(min, max))
    const a = int(min, max)
    const b = int(a, max)
    if (kind === 2) return `${a}-${b}`
    if (kind === 3) return `${a}-${b}/${int(1, 4)}`
    return [int(min, max), int(min, max), int(min, max)].join(',')
}

const ZONES: Array<{ tz: string; around: Array<[number, number, number]> }> = [
    { tz: 'Asia/Seoul', around: [[2026, 11, 14], [2028, 2, 28]] },
    { tz: 'America/New_York', around: [[2026, 3, 8], [2026, 11, 1]] },
    { tz: 'Europe/London', around: [[2026, 3, 29], [2026, 10, 25]] },
    { tz: 'Australia/Lord_Howe', around: [[2026, 4, 5], [2026, 10, 4]] }, // 30-minute DST
    { tz: 'America/Santiago', around: [[2026, 4, 5], [2026, 9, 6]] }, // clocks change at midnight
    { tz: 'Asia/Kathmandu', around: [[2026, 6, 1]] }, // +5:45
    { tz: 'Pacific/Chatham', around: [[2026, 4, 5], [2026, 9, 27]] } // +12:45 / +13:45
]

test.describe('T129 autocron cases', () => {
    test('next run equals a minute-by-minute walk: random schedules, seven zones, around clock changes', () => {
        const rand = rng(20261114)
        let compared = 0
        for (const zone of ZONES) {
            withTz(zone.tz, () => {
                for (let i = 0; i < 40; i++) {
                    const expr = [
                        randomField(rand, 0, 59, 0.25),
                        randomField(rand, 0, 23, 0.4),
                        randomField(rand, 1, 31, 0.75),
                        randomField(rand, 1, 12, 0.8),
                        randomField(rand, 0, 7, 0.7)
                    ].join(' ')
                    const parsed = parseCron(expr)
                    if (!parsed.ok) continue // e.g. 31 in a month list without 31-day months
                    const [y, mo, d] = zone.around[i % zone.around.length]
                    // start from a few hours before the change night to a few days after
                    const after = new Date(y, mo - 1, d).getTime() - 6 * 3600_000 + Math.floor(rand() * 3 * DAY)
                    const o = oracle(expr)
                    const limit = 120 * 24 * 60
                    const want = o.next(after, limit)
                    const got = nextRun(parsed.schedule, after)
                    if (want === null) {
                        expect(got === null || got > after + limit * MIN, `${zone.tz} ${expr} after ${new Date(after).toISOString()}`).toBe(true)
                        continue
                    }
                    expect(got, `${zone.tz} «${expr}» after ${new Date(after).toISOString()}`).toBe(want)
                    compared++
                }
            })
        }
        expect(compared).toBeGreaterThan(200)
    })

    test('runsBetween counts the same minutes as the walk across a change night, in every zone', () => {
        const exprs = ['* * * * *', '*/7 * * * *', '30 * * * *', '0,30 0-3 * * *', '15 2 * * *', '0 0 * * *', '45 1 * * 0']
        for (const zone of ZONES) {
            withTz(zone.tz, () => {
                for (const [y, mo, d] of zone.around) {
                    const from = new Date(y, mo - 1, d).getTime() - DAY
                    const to = from + 3 * DAY
                    for (const expr of exprs) {
                        const o = oracle(expr)
                        let want = 0
                        for (let t = Math.floor(from / MIN) * MIN + MIN; t <= to; t += MIN) if (o.matches(t)) want++
                        expect(runsBetween(schedule(expr), from, to, 1).total, `${zone.tz} ${y}-${mo}-${d} «${expr}»`).toBe(want)
                    }
                }
            })
        }
    })

    test('the change nights in words: a skipped 02:30, a doubled 01:30, a missing midnight', () => {
        withTz('America/New_York', () => {
            // spring forward 2026-03-08: 02:00-02:59 does not exist — a daily 02:30 skips that day
            expect(nextRun(schedule('30 2 * * *'), at(2026, 3, 8, 1, 0))).toBe(at(2026, 3, 9, 2, 30))
            // fall back 2026-11-01: 01:30 happens twice, so a daily 01:30 runs twice that night
            const first = nextRun(schedule('30 1 * * *'), at(2026, 11, 1, 0, 0))!
            const second = nextRun(schedule('30 1 * * *'), first)!
            expect(second - first).toBe(60 * MIN)
            expect(new Date(second).getDate()).toBe(1)
        })
        withTz('America/Santiago', () => {
            // 2026-09-06 00:00 does not exist (clocks jump to 01:00); a daily 00:00 skips that day
            // and the walk still moves forward past the gap instead of looping
            const s = schedule('0 0 * * *')
            const t = nextRun(s, at(2026, 9, 5, 12, 0))!
            expect(t).toBeGreaterThan(at(2026, 9, 5, 12, 0))
            expect(new Date(t).getHours()).toBe(0)
            expect(new Date(t).getDate()).toBe(7)
            expect(nextRun(schedule('30 0 * * *'), at(2026, 9, 5, 23, 59))).toBe(at(2026, 9, 7, 0, 30))
        })
        withTz('Asia/Seoul', () => {
            // no clock changes: 01:30 once a night, 02:30 every night
            expect(runsBetween(schedule('30 1 * * *'), at(2026, 1, 1, 0, 0), at(2027, 1, 1, 0, 0)).total).toBe(365)
        })
    })

    test('cron reader: edge inputs it accepts and what they mean', () => {
        const from = at(2026, 11, 13, 10, 6) // Friday
        const cases: Array<[string, number]> = [
            ['0\t8 * * *', at(2026, 11, 14, 8, 0)], // tab between fields
            ['  0 8 * * *  ', at(2026, 11, 14, 8, 0)], // spaces around
            ['@DAILY', at(2026, 11, 14, 0, 0)], // shorthands ignore case
            ['@Weekly', at(2026, 11, 15, 0, 0)],
            ['@midnight', at(2026, 11, 14, 0, 0)],
            ['@monthly', at(2026, 12, 1, 0, 0)],
            ['@hourly', at(2026, 11, 13, 11, 0)],
            ['5/15 * * * *', at(2026, 11, 13, 10, 20)], // start/step: 5,20,35,50
            ['0-59/20 * * * *', at(2026, 11, 13, 10, 20)],
            ['*/90 * * * *', at(2026, 11, 13, 11, 0)], // a step past the range: only the first value
            ['00 08 * * *', at(2026, 11, 14, 8, 0)], // leading zeros
            ['0 0 * * 0-7', at(2026, 11, 14, 0, 0)], // 0 and 7 are both Sunday
            ['0 0 29 2 *', at(2028, 2, 29, 0, 0)], // only in a leap year
            ['0 0 31 * *', at(2026, 12, 31, 0, 0)], // November has no 31st
            ['0 0 13 * 5', at(2026, 11, 20, 0, 0)], // 13th OR Friday: today's 00:00 passed, next Friday
            ['59 23 31 12 *', at(2026, 12, 31, 23, 59)],
            ['0 12 * * 1,3,5', at(2026, 11, 13, 12, 0)]
        ]
        for (const [expr, want] of cases) expect(nextRun(schedule(expr), from), expr).toBe(want)
    })

    test('cron reader: inputs it refuses, each with a message naming the problem', () => {
        const bad = (expr: string) => {
            const r = parseCron(expr)
            return r.ok ? 'ACCEPTED' : r.message
        }
        const cases: Array<[string, string]> = [
            ['', 'five fields'],
            ['   ', 'five fields'],
            ['0 8 * * * *', 'five fields'], // seconds field (Quartz style)
            ['@yearly', 'five fields'], // not one of the supported shorthands
            ['@reboot', 'five fields'],
            ['0 8 * * MON', 'day of week'], // names are not read
            ['0 8 * JAN *', 'month'],
            ['0 8 ? * *', 'day of month'], // Quartz «?»
            ['0 8 L * *', 'day of month'],
            ['5-3 * * * *', 'minute'], // reversed range
            ['1,,2 * * * *', 'minute'],
            ['-1 * * * *', 'minute'],
            ['1.5 * * * *', 'minute'],
            ['*/ * * * *', 'step'],
            ['1/2/3 * * * *', 'minute'],
            ['0 0 0 * *', 'day of month'],
            ['0 0 * 0 *', 'month'],
            ['0 0 * * 8', 'day of week'],
            ['0 0 31 4 *', 'never matches'],
            ['0 0 30,31 2 *', 'never matches'],
            ['0 0 31 2,4,6,9,11 *', 'never matches']
        ]
        for (const [expr, word] of cases) expect(bad(expr), JSON.stringify(expr)).toContain(word)
    })

    test('missed-run decision at its exact edges', () => {
        const s = schedule('0 8 * * *')
        const eight = at(2026, 11, 13, 8, 0)
        // seen exactly at the grace: still on time
        expect(planTick(s, eight - MIN, eight + ON_TIME_GRACE_MS, DEFAULT_MISSED)[0]).toMatchObject({ reason: 'scheduled' })
        // «once within 60»: exactly 60 min late still runs, 1 ms more is expired
        expect(planTick(s, eight - MIN, eight + 60 * MIN, { policy: 'once', withinMinutes: 60 })[0]).toMatchObject({ type: 'run', reason: 'caught-up' })
        expect(planTick(s, eight - MIN, eight + 60 * MIN + 1, { policy: 'once', withinMinutes: 60 })[0]).toMatchObject({ type: 'missed', why: 'expired' })
        // the bookmark on the minute itself: that minute was already looked at
        expect(planTick(s, eight, eight + 30_000, DEFAULT_MISSED)).toEqual([])
        expect(planTick(s, eight - 1, eight + 30_000, DEFAULT_MISSED)).toHaveLength(1)
        // the clock moved back (bookmark in the future): nothing, and no throw
        expect(planTick(s, eight + DAY, eight, DEFAULT_MISSED)).toEqual([])
        // skip and notify never run, even one minute late
        expect(planTick(s, eight - MIN, eight + ON_TIME_GRACE_MS + 1, { policy: 'skip', withinMinutes: 360 })[0]).toMatchObject({ type: 'missed', why: 'skip' })
        // a week of every-minute misses folds into one decision, quickly
        const started = Date.now()
        const week = planTick(schedule('* * * * *'), eight - 7 * DAY, eight + 10 * MIN, DEFAULT_MISSED)
        expect(Date.now() - started).toBeLessThan(2000)
        expect(week).toEqual([{ type: 'run', plannedAt: eight + 10 * MIN, reason: 'scheduled', missedCount: 7 * 24 * 60 + 9 }])
    })

    test('job input limits, types and defaults', () => {
        const base = { name: 'n', schedule: '0 8 * * *', agent: 'claude', cwd: '/tmp', prompt: 'p' }
        const msg = (patch: Record<string, unknown>) => {
            const r = checkCronInput({ ...base, ...patch })
            return r.ok ? 'OK' : r.message
        }
        expect(msg({ name: 'x'.repeat(CRON_NAME_MAX) })).toBe('OK')
        expect(msg({ name: 'x'.repeat(CRON_NAME_MAX + 1) })).toContain('limited')
        expect(msg({ prompt: 'x'.repeat(CRON_PROMPT_MAX) })).toBe('OK')
        expect(msg({ prompt: 'x'.repeat(CRON_PROMPT_MAX + 1) })).toContain('limited')
        expect(msg({ name: '   ' })).toContain('name is required')
        expect(msg({ name: 42 })).toContain('must be a string')
        expect(msg({ schedule: 800 })).toContain('schedule is required')
        expect(msg({ enabled: 'true' })).toContain('enabled')
        expect(msg({ missed: null })).toContain('missed must be')
        expect(msg({ missed: 'once' })).toContain('missed must be')
        expect(msg({ missed: { withinMinutes: WITHIN_MINUTES_MAX } })).toBe('OK')
        expect(msg({ missed: { withinMinutes: WITHIN_MINUTES_MAX + 1 } })).toContain('withinMinutes')
        expect(msg({ missed: { withinMinutes: 1.5 } })).toContain('withinMinutes')
        expect(msg({ missed: { withinMinutes: '60' } })).toContain('withinMinutes')
        expect(msg({ agent: 'x'.repeat(201) })).toContain('limited')
        expect(msg({ mode: 'attach', loopProjectId: 'lp' })).toBe('OK') // stray agent/cwd are dropped, not an error

        const ok = checkCronInput({ ...base, name: '  Morning  ', schedule: '  0   8 *  * * ', prompt: '  go  ', missed: {} })
        expect(ok.ok && ok.job).toMatchObject({ name: 'Morning', schedule: '0 8 * * *', prompt: 'go', missed: DEFAULT_MISSED })
        const attach = checkCronInput({ ...base, mode: 'attach', loopProjectId: 'lp' })
        expect(attach.ok && attach.job).not.toHaveProperty('agent')
        expect(attach.ok && attach.job).not.toHaveProperty('cwd')
    })

    test('store: the job cap, edits that keep or reset the bookmark, lookups by id and name', () => {
        const store = new CronStore(fakeStore())
        const base = { schedule: '0 8 * * *', agent: 'claude', cwd: '/tmp', prompt: 'p' }
        for (let i = 0; i < CRONS_MAX; i++) expect(store.create({ ...base, name: `job ${i}` }, 'app', 1000).ok).toBe(true)
        const over = store.create({ ...base, name: 'one too many' }, 'app', 1000)
        expect(over.ok ? '' : over.message).toContain(String(CRONS_MAX))

        const first = store.list()[0]
        store.setCheckedAt(first.id, 5000)
        // the same schedule written differently is not a change: the bookmark stays
        expect(store.update(first.id, { schedule: ' 0  8 * * * ' }, 6000).ok).toBe(true)
        expect(store.checkedAt(store.get(first.id)!)).toBe(5000)
        // an edit that leaves the name or prompt empty keeps the old one
        const kept = store.update(first.id, { name: '', prompt: '   ' }, 7000)
        expect(kept.ok && kept.job).toMatchObject({ name: 'job 0', prompt: 'p' })
        // switching to «new» without an agent is refused with the reason
        const att = store.update(first.id, { mode: 'attach', loopProjectId: 'lp' }, 8000)
        expect(att.ok).toBe(true)
        const back = store.update(first.id, { mode: 'new' }, 9000)
        expect(back.ok ? '' : back.message).toContain('agent')
        expect(store.update('nope', { name: 'x' }).ok).toBe(false)
        expect(store.remove('nope')).toBe(false)

        // name lookups ignore case and outer spaces; an id wins over a name
        expect(store.get('  JOB 1 ')?.name).toBe('job 1')
        const shadow = store.list()[2]
        store.remove(store.list()[3].id)
        expect(store.create({ ...base, name: shadow.id }, 'app').ok).toBe(true)
        expect(store.get(shadow.id)?.name).toBe('job 2')
    })

    test('scheduler: disabled, broken schedule, overlapping ticks and runs, thrown errors, removed mid-run', async () => {
        let now = at(2026, 11, 13, 7, 59)
        const opened: Array<Record<string, unknown>> = []
        const notes: string[] = []
        let gate: (() => void) | null = null
        let behavior: 'ok' | 'throw' | 'no-terminal' | 'hold' = 'ok'
        const store = new CronStore(fakeStore())
        const deps: CronServiceDeps = {
            store,
            openSession: async (input) => {
                opened.push(input)
                if (behavior === 'throw') throw new Error('spawn failed: no such program')
                if (behavior === 'hold') await new Promise<void>((r) => (gate = r))
                const result: OpenedSession = { sessionId: `s${opened.length}`, terminalStarted: behavior !== 'no-terminal', promptSent: true }
                return result
            },
            loops: () => ({ projects: [], sessions: [] }),
            writeInput: () => true,
            hasTerminal: () => true,
            loopRefusal: async () => null,
            ensureMainWindow: async () => {},
            notify: (title, body) => void notes.push(`${title} | ${body}`),
            focusSession: () => true,
            now: () => now,
            sleep: async () => {}
        }
        const service = new CronService(deps)
        const make = (name: string, extra: Record<string, unknown> = {}) => {
            const r = service.create({ name, schedule: '0 8 * * *', agent: 'claude', cwd: '/w', prompt: 'go', ...extra }, 'app')
            if (!r.ok) throw new Error(r.message)
            return r.cron
        }
        const off = make('Off', { enabled: false })
        const tpl = make('Tpl', { agent: undefined, template: 'claude-yolo' })
        const a = make('A')

        // a schedule broken by hand in the store: skipped by the tick, shown as a problem
        const raw = store.list()
        store['store'].set('autocrons', [...raw, { ...raw[2], id: 'broken', name: 'Broken', schedule: '0 8 * *' }])
        expect(service.get('Broken')).toMatchObject({ nextRunAt: null, problem: expect.stringContaining('five fields') })
        expect(service.get('Off')?.nextRunAt).toBeNull()

        // two ticks at once share one pass: one session per job
        now = at(2026, 11, 13, 8, 0) + 10_000
        await Promise.all([service.tick(), service.tick()])
        expect(opened.map((o) => o.name).sort()).toEqual(['A · 11/13 08:00', 'Tpl · 11/13 08:00'])
        expect(opened.find((o) => String(o.name).startsWith('Tpl'))).toMatchObject({ template: 'claude-yolo' })
        expect(opened.find((o) => String(o.name).startsWith('Tpl'))).not.toHaveProperty('command')
        expect(service.runs(off.id)).toEqual([])

        // switched on after a day off: the day it was off is not caught up
        now = at(2026, 11, 14, 9, 0)
        service.update(off.id, { enabled: true })
        await service.tick()
        expect(service.runs(off.id)).toEqual([])

        // «Run now» twice while the first is still opening: the second is refused, not doubled
        behavior = 'hold'
        const firstRun = service.runNow(a.id)
        const secondRun = await service.runNow(a.id)
        expect(secondRun).toMatchObject({ status: 'failed', note: 'the previous run was still starting' })
        gate!()
        expect(await firstRun).toMatchObject({ status: 'started' })

        // a thrown error and a terminal that never started are failures with a reason and a notice
        behavior = 'throw'
        expect(await service.runNow(a.id)).toMatchObject({ status: 'failed', note: 'spawn failed: no such program' })
        behavior = 'no-terminal'
        expect(await service.runNow(a.id)).toMatchObject({ status: 'failed', note: 'the terminal did not start' })
        expect(notes.filter((n) => n.startsWith('Autocron failed: A')).length).toBe(2)

        // one job failing at a tick does not stop another due at the same minute
        behavior = 'ok'
        const b = make('B', { schedule: '30 9 * * *' })
        const c = make('C', { schedule: '30 9 * * *', agent: undefined, template: 'missing' })
        deps.openSession = async (input) => {
            opened.push(input)
            if (input.template === 'missing') throw new Error('no template "missing"')
            return { sessionId: `s${opened.length}`, terminalStarted: true, promptSent: true }
        }
        now = at(2026, 11, 14, 9, 30) + 5_000
        await service.tick()
        expect(service.runs(b.id)![0]).toMatchObject({ status: 'started' })
        expect(service.runs(c.id)![0]).toMatchObject({ status: 'failed', note: 'no template "missing"' })

        // the label pads the hour and minute
        now = at(2026, 11, 14, 9, 5)
        await service.runNow(b.id)
        expect(opened[opened.length - 1].name).toBe('B · 11/14 09:05')

        // removed while its session is still opening: no run record is left behind for it
        let release: (() => void) | null = null
        deps.openSession = async () => {
            await new Promise<void>((r) => (release = r))
            return { sessionId: 'late', terminalStarted: true, promptSent: true }
        }
        const pending = service.runNow(tpl.id)
        await new Promise((r) => setTimeout(r, 0))
        expect(service.remove(tpl.id)).toBe(true)
        release!()
        await pending
        expect(store.runs().filter((r) => r.cronId === tpl.id)).toEqual([])

        await expect(service.runNow('nope')).rejects.toThrow('no such job')
    })

    test('scheduler: start ticks at once and only one timer runs; stop is safe twice', async () => {
        let opened = 0
        const now = at(2026, 11, 13, 8, 0) + 5_000
        const store = new CronStore(fakeStore())
        const service = new CronService({
            store,
            openSession: async () => ({ sessionId: `s${++opened}`, terminalStarted: true, promptSent: true }),
            loops: () => ({ projects: [], sessions: [] }),
            writeInput: () => true,
            hasTerminal: () => true,
            loopRefusal: async () => null,
            ensureMainWindow: async () => {},
            notify: () => {},
            focusSession: () => true,
            now: () => now
        })
        store.create({ name: 'A', schedule: '0 8 * * *', agent: 'claude', cwd: '/w', prompt: 'go' }, 'app', at(2026, 11, 13, 7, 0))
        service.start()
        service.start()
        await service.tick()
        service.stop()
        service.stop()
        expect(opened).toBe(1)
    })

    test('attach: a refusal that throws, a write that fails, and the queue keeps going', async () => {
        const loops: LoopState = {
            projects: [
                { id: 'lp1', name: 'brand', path: '/b', sourceWorkspaceId: 'w', createdAt: 0 },
                { id: 'lp2', name: 'idle', path: '/i', sourceWorkspaceId: 'w', createdAt: 0 }
            ],
            sessions: [{ id: 'ls1', loopProjectId: 'lp1', terminalId: 'term1', cliToolName: 'claude', status: 'ready', loopCount: 0, lastLoopAt: null, startedAt: 0 }]
        }
        const written: Array<[string, string]> = []
        let refusal: () => Promise<string | null> = async () => null
        let writable = true
        const service = new CronService({
            store: new CronStore(fakeStore()),
            openSession: async () => { throw new Error('should not open') },
            loops: () => loops,
            writeInput: (id, data) => (written.push([id, data]), writable),
            hasTerminal: (id) => id === 'term1',
            loopRefusal: () => refusal(),
            ensureMainWindow: async () => {},
            notify: () => {},
            focusSession: () => true,
            now: () => at(2026, 11, 13, 12, 0),
            sleep: () => new Promise((r) => setTimeout(r, 2))
        })
        const make = (name: string, loopProjectId: string, prompt: string) => {
            const r = service.create({ name, schedule: '*/30 * * * *', mode: 'attach', loopProjectId, prompt }, 'api')
            if (!r.ok) throw new Error(r.message)
            return r.cron
        }
        const one = make('One', 'lp1', 'line one\r\nline two\nline three')
        const two = make('Two', 'lp1', 'second')
        const idle = make('Idle', 'lp2', 'x')

        // the project exists but its loop was never opened
        expect(await service.runNow(idle.id)).toMatchObject({ status: 'failed', note: expect.stringContaining('not running') })

        // the guard itself throws: that run fails with the error, the next one still types
        refusal = async () => { throw new Error('ps failed') }
        const [r1, r2] = await Promise.all([service.runNow(one.id), (async () => {
            await new Promise((r) => setTimeout(r, 0))
            refusal = async () => null
            return service.runNow(two.id)
        })()])
        expect(r1).toMatchObject({ status: 'failed', note: 'ps failed' })
        expect(r2).toMatchObject({ status: 'started' })
        expect(written).toEqual([['term1', 'second'], ['term1', '\r']])

        // CRLF and LF both become one line
        written.length = 0
        await service.runNow(one.id)
        expect(written[0]).toEqual(['term1', 'line one line two line three'])

        // the text write fails: no Enter is sent after it
        written.length = 0
        writable = false
        expect(await service.runNow(two.id)).toMatchObject({ status: 'failed', note: 'the loop terminal is gone' })
        expect(written).toEqual([['term1', 'second']])
    })

    test('/v1/crons over real HTTP: auth, codes, names, edits, pause/resume, run, delete', async () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'climanger-t129-'))
        const cronStore = new CronStore(fakeStore())
        const service = new CronService({
            store: cronStore,
            openSession: async () => ({ sessionId: 'api-s1', terminalStarted: true, promptSent: true }),
            loops: () => ({ projects: [], sessions: [] }),
            writeInput: () => true,
            hasTerminal: () => false,
            loopRefusal: async () => null,
            ensureMainWindow: async () => {},
            notify: () => {},
            focusSession: () => true
        })
        const stand = { clearOrchestrators: () => {}, noteCaller: () => {} } as unknown as ControlApiService
        const server = new ControlApiServer({ service: stand, crons: service, store: fakeStore(), appVersion: 't129', homeDir: home })
        const without = new ControlApiServer({ service: stand, store: fakeStore(), appVersion: 't129', homeDir: fs.mkdtempSync(path.join(os.tmpdir(), 'climanger-t129b-')) })
        try {
            const state = await server.apply({ ...DEFAULT_CONTROL_API, enabled: true, port: 0 })
            expect(state.running, state.error).toBe(true)
            const call = async (method: string, route: string, body?: unknown, auth = true, base = state) => {
                const res = await fetch(base.url + route, {
                    method,
                    headers: { ...(auth ? { Authorization: `Bearer ${base.token}` } : {}), 'Content-Type': 'application/json', 'X-Client-Name': 't129' },
                    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
                })
                const text = await res.text()
                return { status: res.status, json: text ? JSON.parse(text) : null }
            }
            const job = { schedule: '0 8 * * 1-5', agent: 'claude', cwd: home, prompt: '/content-plan work next' }

            expect((await call('GET', '/v1/crons', undefined, false)).status).toBe(401)
            expect((await call('GET', '/v1/crons')).json).toEqual({ crons: [], runs: [] })
            expect((await call('POST', '/v1/crons', '{not json')).status).toBe(400)
            expect((await call('POST', '/v1/crons', '[1,2]')).json.error.code).toBe('bad_json')
            expect((await call('POST', '/v1/crons', '')).json.error.message).toContain('name is required')
            expect((await call('POST', '/v1/crons', { ...job, name: 'x'.repeat(81) })).json.error.message).toContain('limited')

            // Korean, slash and percent names round-trip through the path
            for (const name of ['아침 편성', 'brand/daily', '50% check']) {
                const made = await call('POST', '/v1/crons', { ...job, name })
                expect(made.status, name).toBe(201)
                expect(made.json.cron).toMatchObject({ name, createdBy: 't129', enabled: true })
                expect((await call('GET', `/v1/crons/${encodeURIComponent(name)}`)).json.cron.id).toBe(made.json.cron.id)
            }
            const id = (await call('GET', `/v1/crons/${encodeURIComponent('아침 편성')}`)).json.cron.id as string

            // edit: switch to a template, then to attach (its loop is missing → shown as a problem)
            const toTpl = await call('POST', `/v1/crons/${id}`, { template: 'claude-yolo', agent: '' })
            expect(toTpl.json.cron).toMatchObject({ template: 'claude-yolo' })
            expect(toTpl.json.cron.agent).toBeUndefined()
            const toAttach = await call('POST', `/v1/crons/${id}`, { mode: 'attach', loopProjectId: 'gone' })
            expect(toAttach.json.cron).toMatchObject({ mode: 'attach', loopProjectId: 'gone', problem: 'the Loop project was removed' })
            expect((await call('POST', `/v1/crons/${id}`, { mode: 'new' })).status).toBe(400)

            // pause twice and resume twice are both fine; paused has no next run
            for (const step of ['pause', 'pause']) {
                const r = await call('POST', `/v1/crons/${id}/${step}`)
                expect(r.json.cron).toMatchObject({ enabled: false, nextRunAt: null })
            }
            for (const step of ['resume', 'resume']) expect((await call('POST', `/v1/crons/${id}/${step}`)).json.cron.enabled).toBe(true)

            // «run» on an attach job whose loop is gone answers 200 with a failed run
            const ran = await call('POST', `/v1/crons/${id}/run`)
            expect(ran.status).toBe(200)
            expect(ran.json.run).toMatchObject({ status: 'failed', trigger: 'manual', note: 'the Loop project was removed' })
            expect((await call('GET', `/v1/crons/${id}/runs`)).json.runs).toHaveLength(1)

            // a new-session job runs and records the session
            const daily = (await call('GET', `/v1/crons/${encodeURIComponent('brand/daily')}`)).json.cron.id
            expect((await call('POST', `/v1/crons/${daily}/run`)).json.run).toMatchObject({ status: 'started', sessionId: 'api-s1' })

            // unknown routes and jobs
            expect((await call('GET', '/v1/crons/nope/runs')).json.error.code).toBe('cron_not_found')
            expect((await call('PUT', `/v1/crons/${id}`, {})).status).toBe(404)
            expect((await call('DELETE', `/v1/crons/${id}`)).json.removed).toBe(true)
            expect((await call('DELETE', `/v1/crons/${id}`)).status).toBe(404)

            // a build without the scheduler answers 404 on every cron route
            const bare = await without.apply({ ...DEFAULT_CONTROL_API, enabled: true, port: 0 })
            const off = await call('GET', '/v1/crons', undefined, true, bare)
            expect(off).toMatchObject({ status: 404, json: { error: { code: 'not_found' } } })
        } finally {
            await server.stop()
            await without.stop()
            fs.rmSync(home, { recursive: true, force: true })
        }
    })
})
