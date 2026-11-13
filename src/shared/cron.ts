/**
 * Autocron schedule math — pure, so main (scheduler) and renderer (next-run labels)
 * share one reading of a schedule, and unit tests need no Electron.
 *
 * A schedule is a five-field cron expression in the Mac's local time:
 *   minute hour day-of-month month day-of-week
 * Each field takes `*`, a number, `a-b`, a list `a,b`, and steps (`*\/15`, `a-b/2`).
 * Day-of-week is 0-6 (Sunday 0; 7 is read as Sunday too). When both day fields are
 * restricted, a day matches if EITHER does — the classic cron rule people expect.
 * `@hourly`, `@daily`, `@weekly`, `@monthly` are shorthands.
 */

export interface CronSchedule {
    minutes: ReadonlySet<number>
    hours: ReadonlySet<number>
    daysOfMonth: ReadonlySet<number>
    months: ReadonlySet<number>
    daysOfWeek: ReadonlySet<number>
    /** True when the field was `*` — needed for the either-day rule. */
    anyDayOfMonth: boolean
    anyDayOfWeek: boolean
}

export type ParsedCron = { ok: true; schedule: CronSchedule } | { ok: false; message: string }

const ALIASES: Record<string, string> = {
    '@hourly': '0 * * * *',
    '@daily': '0 0 * * *',
    '@midnight': '0 0 * * *',
    '@weekly': '0 0 * * 0',
    '@monthly': '0 0 1 * *'
}

interface FieldSpec {
    name: string
    min: number
    max: number
}

const FIELDS: FieldSpec[] = [
    { name: 'minute', min: 0, max: 59 },
    { name: 'hour', min: 0, max: 23 },
    { name: 'day of month', min: 1, max: 31 },
    { name: 'month', min: 1, max: 12 },
    { name: 'day of week', min: 0, max: 7 }
]

const MINUTE_MS = 60_000
/** A schedule that matches nothing within this far is refused (e.g. 30 February). */
const SEARCH_LIMIT_DAYS = 366 * 5

function parseField(text: string, spec: FieldSpec): Set<number> | string {
    const values = new Set<number>()
    for (const part of text.split(',')) {
        const [rangeText, stepText, extra] = part.split('/')
        if (extra !== undefined || rangeText === '') return `bad ${spec.name}: "${part}"`
        let step = 1
        if (stepText !== undefined) {
            if (!/^\d+$/.test(stepText) || Number(stepText) < 1) return `bad step in ${spec.name}: "${part}"`
            step = Number(stepText)
        }
        let from: number
        let to: number
        if (rangeText === '*') {
            from = spec.min
            to = spec.name === 'day of week' ? 6 : spec.max
        } else {
            const match = /^(\d+)(?:-(\d+))?$/.exec(rangeText)
            if (!match) return `bad ${spec.name}: "${part}"`
            from = Number(match[1])
            to = match[2] !== undefined ? Number(match[2]) : stepText !== undefined ? spec.max : from
            if (from < spec.min || to > spec.max || from > to) {
                return `${spec.name} must be ${spec.min}-${spec.max === 7 ? 6 : spec.max}: "${part}"`
            }
        }
        for (let v = from; v <= to; v += step) values.add(spec.name === 'day of week' && v === 7 ? 0 : v)
    }
    return values
}

/** Reads a schedule. The message names the field that is wrong, for the form and the API. */
export function parseCron(expression: string): ParsedCron {
    const text = (ALIASES[expression.trim().toLowerCase()] ?? expression).trim()
    const parts = text.split(/\s+/)
    if (parts.length !== 5) {
        return { ok: false, message: 'schedule needs five fields: minute hour day-of-month month day-of-week' }
    }
    const sets: Set<number>[] = []
    for (let i = 0; i < 5; i++) {
        const parsed = parseField(parts[i], FIELDS[i])
        if (typeof parsed === 'string') return { ok: false, message: parsed }
        sets.push(parsed)
    }
    const schedule: CronSchedule = {
        minutes: sets[0],
        hours: sets[1],
        daysOfMonth: sets[2],
        months: sets[3],
        daysOfWeek: sets[4],
        anyDayOfMonth: parts[2] === '*',
        anyDayOfWeek: parts[4] === '*'
    }
    if (nextRun(schedule, Date.now()) === null) return { ok: false, message: 'schedule never matches a real date' }
    return { ok: true, schedule }
}

function dayMatches(s: CronSchedule, date: Date): boolean {
    const dom = s.daysOfMonth.has(date.getDate())
    const dow = s.daysOfWeek.has(date.getDay())
    if (s.anyDayOfMonth && s.anyDayOfWeek) return true
    if (s.anyDayOfMonth) return dow
    if (s.anyDayOfWeek) return dom
    return dom || dow
}

/**
 * The first matching minute strictly after `after` (ms), or null when nothing matches
 * within five years. Jumps a month / day / hour at a time instead of walking minutes.
 */
export function nextRun(s: CronSchedule, after: number): number | null {
    const d = new Date(after)
    d.setSeconds(0, 0)
    d.setMinutes(d.getMinutes() + 1)
    const limit = after + SEARCH_LIMIT_DAYS * 24 * 60 * MINUTE_MS
    while (d.getTime() <= limit) {
        if (!s.months.has(d.getMonth() + 1)) {
            d.setMonth(d.getMonth() + 1, 1)
            d.setHours(0, 0, 0, 0)
            continue
        }
        if (!dayMatches(s, d)) {
            d.setDate(d.getDate() + 1)
            d.setHours(0, 0, 0, 0)
            continue
        }
        if (!s.hours.has(d.getHours())) {
            d.setHours(d.getHours() + 1, 0, 0, 0)
            continue
        }
        if (!s.minutes.has(d.getMinutes())) {
            d.setMinutes(d.getMinutes() + 1, 0, 0)
            continue
        }
        return d.getTime()
    }
    return null
}

/** Matching minutes in (from, to], oldest first, at most `cap` of the NEWEST (older ones are only counted). */
export function runsBetween(s: CronSchedule, from: number, to: number, cap = 50): { times: number[]; total: number } {
    const times: number[] = []
    let total = 0
    let t = nextRun(s, from)
    while (t !== null && t <= to) {
        total++
        times.push(t)
        if (times.length > cap) times.shift()
        t = nextRun(s, t)
    }
    return { times, total }
}

// ---------------------------------------------------------------------------
// What to do at a tick — including the times the Mac was off, asleep or the app closed
// ---------------------------------------------------------------------------

/**
 * What to do with a run whose time passed while nothing could start it.
 * - once:   run one time when we notice (however many were missed), if within `withinMinutes`
 * - skip:   wait for the next time
 * - notify: do not run; mark it missed and tell the person
 */
export type MissedPolicy = 'once' | 'skip' | 'notify'
export const MISSED_POLICIES: readonly MissedPolicy[] = ['once', 'skip', 'notify']
export const DEFAULT_MISSED = { policy: 'once' as MissedPolicy, withinMinutes: 360 }

/** A run counts as on time when we see it within this long of its minute (ticks are every 30 s). */
export const ON_TIME_GRACE_MS = 2 * MINUTE_MS

export type TickAction =
    | { type: 'run'; plannedAt: number; reason: 'scheduled' | 'caught-up'; missedCount: number }
    | { type: 'missed'; plannedAt: number; missedCount: number; why: 'skip' | 'notify' | 'expired' }

/**
 * One job at one tick. `lastCheckedAt` is the end of the previous tick (or when the job was
 * made / switched on). Everything in (lastCheckedAt, now] is due; what is older than the
 * grace was missed. Missed runs fold into one decision — the newest of them — so waking
 * from a weekend asleep is one run (or one note), not dozens.
 */
export function planTick(
    s: CronSchedule,
    lastCheckedAt: number,
    now: number,
    missed: { policy: MissedPolicy; withinMinutes: number }
): TickAction[] {
    const { times, total } = runsBetween(s, lastCheckedAt, now, 2)
    if (total === 0) return []
    const newest = times[times.length - 1]
    const onTime = now - newest <= ON_TIME_GRACE_MS
    // Older times folded into the newest one — they get no run of their own.
    const lateCount = total - 1
    const actions: TickAction[] = []

    if (onTime) {
        // The run that is due now covers anything missed before it.
        actions.push({ type: 'run', plannedAt: newest, reason: 'scheduled', missedCount: lateCount })
        return actions
    }

    if (missed.policy === 'skip') {
        actions.push({ type: 'missed', plannedAt: newest, missedCount: lateCount, why: 'skip' })
    } else if (missed.policy === 'notify') {
        actions.push({ type: 'missed', plannedAt: newest, missedCount: lateCount, why: 'notify' })
    } else if (now - newest <= missed.withinMinutes * MINUTE_MS) {
        actions.push({ type: 'run', plannedAt: newest, reason: 'caught-up', missedCount: lateCount })
    } else {
        actions.push({ type: 'missed', plannedAt: newest, missedCount: lateCount, why: 'expired' })
    }
    return actions
}
