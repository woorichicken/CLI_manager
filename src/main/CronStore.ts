import { randomUUID } from 'crypto'
import { CronInput, CronJob, CronMissed, CronMode, CronRun } from '../shared/autocron'
import { DEFAULT_MISSED, MISSED_POLICIES, MissedPolicy, parseCron } from '../shared/cron'

export const CRONS_KEY = 'autocrons'
export const CRON_RUNS_KEY = 'autocronRuns'
/** End of the last scheduler tick, per job (ms). Missing = the job's createdAt / when it was switched on. */
export const CRON_CHECKED_KEY = 'autocronCheckedAt'

export const CRON_NAME_MAX = 80
export const CRON_PROMPT_MAX = 4000
/** Jobs kept at once — a guard against a runaway client, not a product limit. */
export const CRONS_MAX = 100
/** Run records kept, all jobs together; the oldest go first. */
export const CRON_RUNS_MAX = 500
/** `once` can reach back at most a week. */
export const WITHIN_MINUTES_MAX = 7 * 24 * 60

export type Checked<T> = ({ ok: true } & T) | { ok: false; message: string }

interface Store {
    get(key: string): unknown
    set(key: string, value: unknown): void
}

function text(value: unknown, field: string, max: number, required: boolean): Checked<{ value?: string }> {
    if (value === undefined || value === null || value === '') {
        return required ? { ok: false, message: `${field} is required` } : { ok: true, value: undefined }
    }
    if (typeof value !== 'string') return { ok: false, message: `${field} must be a string` }
    const trimmed = value.trim()
    if (!trimmed) return required ? { ok: false, message: `${field} is required` } : { ok: true, value: undefined }
    if (trimmed.length > max) return { ok: false, message: `${field} is limited to ${max} characters` }
    return { ok: true, value: trimmed }
}

function checkMissed(value: unknown): Checked<{ missed: CronMissed }> {
    if (typeof value !== 'object' || value === null) return { ok: false, message: 'missed must be { policy, withinMinutes }' }
    const raw = value as { policy?: unknown; withinMinutes?: unknown }
    const policy = raw.policy ?? DEFAULT_MISSED.policy
    if (typeof policy !== 'string' || !(MISSED_POLICIES as readonly string[]).includes(policy)) {
        return { ok: false, message: `missed.policy must be one of ${MISSED_POLICIES.join(', ')}` }
    }
    const within = raw.withinMinutes ?? DEFAULT_MISSED.withinMinutes
    if (typeof within !== 'number' || !Number.isInteger(within) || within < 1 || within > WITHIN_MINUTES_MAX) {
        return { ok: false, message: `missed.withinMinutes must be a whole number 1-${WITHIN_MINUTES_MAX}` }
    }
    return { ok: true, missed: { policy: policy as MissedPolicy, withinMinutes: within } }
}

/**
 * A job as sent (window form or Control API). On create every required field must be
 * there; on edit only what is sent is checked and the result is merged over `base`.
 * The merged job must still make sense — a `new` job needs an agent or template and a
 * folder, an `attach` job needs a loop project.
 */
export function checkCronInput(input: CronInput, base?: CronJob): Checked<{ job: Omit<CronJob, 'id' | 'createdAt' | 'updatedAt' | 'createdBy'> }> {
    const creating = base === undefined
    const pick = <K extends keyof CronInput>(key: K): unknown => (key in input ? input[key] : undefined)

    const name = text(pick('name'), 'name', CRON_NAME_MAX, creating)
    if (!name.ok) return name
    const prompt = text(pick('prompt'), 'prompt', CRON_PROMPT_MAX, creating)
    if (!prompt.ok) return prompt

    let schedule = base?.schedule
    if (input.schedule !== undefined || creating) {
        if (typeof input.schedule !== 'string') return { ok: false, message: 'schedule is required (five-field cron, e.g. "0 8 * * *")' }
        const parsed = parseCron(input.schedule)
        if (!parsed.ok) return { ok: false, message: `schedule: ${parsed.message}` }
        schedule = input.schedule.trim().replace(/\s+/g, ' ')
    }

    let mode: CronMode = base?.mode ?? 'new'
    if (input.mode !== undefined) {
        if (input.mode !== 'new' && input.mode !== 'attach') return { ok: false, message: 'mode must be "new" or "attach"' }
        mode = input.mode
    }

    const optional = (key: 'agent' | 'template' | 'cwd' | 'loopProjectId', max: number): Checked<{ value?: string }> => {
        if (!(key in input) || input[key] === undefined) return { ok: true, value: base?.[key] }
        return text(input[key], key, max, false)
    }
    const agent = optional('agent', 200)
    if (!agent.ok) return agent
    const template = optional('template', 200)
    if (!template.ok) return template
    const cwd = optional('cwd', 1000)
    if (!cwd.ok) return cwd
    const loopProjectId = optional('loopProjectId', 200)
    if (!loopProjectId.ok) return loopProjectId

    let missed = base?.missed ?? { ...DEFAULT_MISSED }
    if (input.missed !== undefined) {
        const checked = checkMissed(input.missed)
        if (!checked.ok) return checked
        missed = checked.missed
    }

    let enabled = base?.enabled ?? true
    if (input.enabled !== undefined) {
        if (typeof input.enabled !== 'boolean') return { ok: false, message: 'enabled must be true or false' }
        enabled = input.enabled
    }

    if (mode === 'new') {
        if (!agent.value && !template.value) return { ok: false, message: 'a "new" job needs agent (e.g. "claude") or template' }
        if (agent.value && template.value) return { ok: false, message: 'pass either agent or template, not both' }
        if (!cwd.value) return { ok: false, message: 'a "new" job needs cwd (the folder to open the session in)' }
    } else if (!loopProjectId.value) {
        return { ok: false, message: 'an "attach" job needs loopProjectId (a project in the Loop Dashboard)' }
    }

    return {
        ok: true,
        job: {
            name: name.value ?? base!.name,
            enabled,
            schedule: schedule!,
            mode,
            ...(mode === 'new'
                ? { ...(agent.value ? { agent: agent.value } : {}), ...(template.value ? { template: template.value } : {}), cwd: cwd.value }
                : { loopProjectId: loopProjectId.value }),
            prompt: prompt.value ?? base!.prompt,
            missed
        }
    }
}

/**
 * Jobs, their run records and the scheduler's bookmark, in the app store.
 * Pure bookkeeping: no timers, no sessions — CronService does those.
 */
export class CronStore {
    constructor(
        private readonly store: Store,
        private readonly onChange: () => void = () => {}
    ) {}

    list(): CronJob[] {
        return (this.store.get(CRONS_KEY) as CronJob[] | undefined) ?? []
    }

    get(ref: string): CronJob | undefined {
        const all = this.list()
        return all.find((j) => j.id === ref) ?? all.find((j) => j.name.toLowerCase() === ref.trim().toLowerCase())
    }

    create(input: CronInput, createdBy: string, now = Date.now()): Checked<{ job: CronJob }> {
        const all = this.list()
        if (all.length >= CRONS_MAX) return { ok: false, message: `at most ${CRONS_MAX} jobs` }
        const checked = checkCronInput(input)
        if (!checked.ok) return checked
        const job: CronJob = { id: randomUUID(), ...checked.job, createdAt: now, updatedAt: now, createdBy }
        this.store.set(CRONS_KEY, [...all, job])
        this.setCheckedAt(job.id, now)
        this.onChange()
        return { ok: true, job }
    }

    update(id: string, input: CronInput, now = Date.now()): Checked<{ job: CronJob }> {
        const all = this.list()
        const index = all.findIndex((j) => j.id === id)
        if (index < 0) return { ok: false, message: 'no such job' }
        const before = all[index]
        const checked = checkCronInput(input, before)
        if (!checked.ok) return checked
        const job: CronJob = { ...before, ...checked.job, updatedAt: now }
        // checkCronInput returns only the fields the job keeps, so anything else from `before` goes:
        // the other mode's fields, and the agent or template the form switched away from.
        if (job.mode === 'new') {
            delete job.loopProjectId
            if (!checked.job.agent) delete job.agent
            if (!checked.job.template) delete job.template
        } else { delete job.agent; delete job.template; delete job.cwd }
        const next = [...all]
        next[index] = job
        this.store.set(CRONS_KEY, next)
        // Switching on, or changing the schedule, starts counting from now — no surprise catch-up
        // of runs that belonged to the old schedule or to the time it was off.
        if ((!before.enabled && job.enabled) || before.schedule !== job.schedule) this.setCheckedAt(id, now)
        this.onChange()
        return { ok: true, job }
    }

    remove(id: string): boolean {
        const all = this.list()
        if (!all.some((j) => j.id === id)) return false
        this.store.set(CRONS_KEY, all.filter((j) => j.id !== id))
        this.store.set(CRON_RUNS_KEY, this.runs().filter((r) => r.cronId !== id))
        const checked = { ...this.checkedMap() }
        delete checked[id]
        this.store.set(CRON_CHECKED_KEY, checked)
        this.onChange()
        return true
    }

    /** Newest first. */
    runs(cronId?: string): CronRun[] {
        const all = (this.store.get(CRON_RUNS_KEY) as CronRun[] | undefined) ?? []
        return cronId ? all.filter((r) => r.cronId === cronId) : all
    }

    addRun(run: Omit<CronRun, 'id'>): CronRun {
        const record: CronRun = { id: randomUUID(), ...run }
        // The job was removed while this run was starting: its records went with it, so this one
        // would be an orphan row in the run list that no job owns.
        if (!this.list().some((j) => j.id === run.cronId)) return record
        this.store.set(CRON_RUNS_KEY, [record, ...this.runs()].slice(0, CRON_RUNS_MAX))
        this.onChange()
        return record
    }

    lastRun(cronId: string): CronRun | null {
        return this.runs(cronId)[0] ?? null
    }

    private checkedMap(): Record<string, number> {
        return (this.store.get(CRON_CHECKED_KEY) as Record<string, number> | undefined) ?? {}
    }

    checkedAt(job: CronJob): number {
        return this.checkedMap()[job.id] ?? job.createdAt
    }

    setCheckedAt(id: string, at: number): void {
        this.store.set(CRON_CHECKED_KEY, { ...this.checkedMap(), [id]: at })
    }
}
