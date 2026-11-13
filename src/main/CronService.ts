import { CronInput, CronJob, CronRun, CronState, CronView } from '../shared/autocron'
import type { LoopState } from '../shared/types'
import { nextRun, parseCron, planTick } from '../shared/cron'
import { Checked, CronStore } from './CronStore'

/** How often the scheduler looks. A run is «on time» within ON_TIME_GRACE_MS (2 min) of its minute. */
export const CRON_TICK_MS = 30_000
/** Pause between typing a prompt into a loop and pressing Enter — TUIs drop an Enter sent in the same write. */
const ATTACH_ENTER_DELAY_MS = 300

export interface OpenedSession {
    sessionId: string
    terminalStarted: boolean
    promptSent: boolean
    note?: string
}

export interface CronServiceDeps {
    store: CronStore
    /** Opens a session the way the Control API does (ControlApiService.openSession). */
    openSession(input: { path: string; template?: string; command?: string; name: string; prompt: string }): Promise<OpenedSession>
    loops(): LoopState
    /** Writes to a terminal; false when it is not running. */
    writeInput(terminalId: string, data: string): boolean
    hasTerminal(terminalId: string): boolean
    /** Brings the main window up so a new session's terminal can start (it is spawned by the window). */
    ensureMainWindow(): Promise<void>
    /** A system notification for «notify» misses and failures. */
    notify(title: string, body: string): void
    /** Focus a session in the main window — «Open session». False when it is gone. */
    focusSession(sessionId: string): boolean
    now?: () => number
    sleep?: (ms: number) => Promise<void>
}

/**
 * Autocron: the scheduler (a 30-second tick plus a tick on wake) and the runner.
 *
 * Each tick asks shared/cron `planTick` what each job owes since its bookmark; that folds
 * whatever was missed while the Mac was off, asleep or the app closed into one decision,
 * following the job's «missed» setting. The bookmark moves before the run starts, so a crash
 * mid-run never replays it.
 */
export class CronService {
    private timer: ReturnType<typeof setInterval> | null = null
    private readonly inFlight = new Set<string>()
    private ticking: Promise<void> | null = null

    constructor(private readonly deps: CronServiceDeps) {}

    private now(): number {
        return this.deps.now ? this.deps.now() : Date.now()
    }

    start(): void {
        if (this.timer) return
        this.timer = setInterval(() => void this.tick(), CRON_TICK_MS)
        void this.tick()
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer)
        this.timer = null
    }

    /** One pass over every job. Overlapping calls (timer + wake) share the same pass. */
    tick(): Promise<void> {
        if (this.ticking) return this.ticking
        this.ticking = this.runTick().finally(() => {
            this.ticking = null
        })
        return this.ticking
    }

    private async runTick(): Promise<void> {
        const now = this.now()
        const work: Promise<unknown>[] = []
        for (const job of this.deps.store.list()) {
            if (!job.enabled) continue
            const parsed = parseCron(job.schedule)
            if (!parsed.ok) continue
            const actions = planTick(parsed.schedule, this.deps.store.checkedAt(job), now, job.missed)
            this.deps.store.setCheckedAt(job.id, now)
            for (const action of actions) {
                if (action.type === 'run') {
                    work.push(this.run(job, { plannedAt: action.plannedAt, trigger: action.reason, missedCount: action.missedCount }))
                } else {
                    const note = action.why === 'skip'
                        ? 'missed — set to skip'
                        : action.why === 'notify'
                            ? 'missed — set to notify only'
                            : `missed — more than ${job.missed.withinMinutes} min late`
                    this.deps.store.addRun({
                        cronId: job.id, plannedAt: action.plannedAt, at: now, trigger: 'scheduled',
                        status: 'missed', missedCount: action.missedCount, note
                    })
                    if (action.why !== 'skip') {
                        this.deps.notify(`Autocron missed: ${job.name}`, `${new Date(action.plannedAt).toLocaleString()} — ${note}`)
                    }
                }
            }
        }
        await Promise.all(work)
    }

    /** «Run now» from the window or `POST /v1/crons/:id/run`. */
    runNow(ref: string): Promise<CronRun> {
        const job = this.deps.store.get(ref)
        if (!job) return Promise.reject(new Error('no such job'))
        const now = this.now()
        return this.run(job, { plannedAt: now, trigger: 'manual', missedCount: 0 })
    }

    private async run(job: CronJob, at: { plannedAt: number; trigger: CronRun['trigger']; missedCount: number }): Promise<CronRun> {
        const base = { cronId: job.id, plannedAt: at.plannedAt, trigger: at.trigger, missedCount: at.missedCount }
        if (this.inFlight.has(job.id)) {
            return this.deps.store.addRun({ ...base, at: this.now(), status: 'failed', note: 'the previous run was still starting' })
        }
        this.inFlight.add(job.id)
        try {
            const result = job.mode === 'attach' ? await this.runAttach(job) : await this.runNew(job)
            const run = this.deps.store.addRun({ ...base, at: this.now(), ...result })
            if (run.status === 'failed') this.deps.notify(`Autocron failed: ${job.name}`, run.note ?? '')
            return run
        } catch (error) {
            const note = error instanceof Error ? error.message : String(error)
            this.deps.notify(`Autocron failed: ${job.name}`, note)
            return this.deps.store.addRun({ ...base, at: this.now(), status: 'failed', note })
        } finally {
            this.inFlight.delete(job.id)
        }
    }

    private async runNew(job: CronJob): Promise<Pick<CronRun, 'status' | 'sessionId' | 'note'>> {
        await this.deps.ensureMainWindow()
        const stamp = new Date(this.now())
        const label = `${stamp.getMonth() + 1}/${stamp.getDate()} ${String(stamp.getHours()).padStart(2, '0')}:${String(stamp.getMinutes()).padStart(2, '0')}`
        const opened = await this.deps.openSession({
            path: job.cwd!,
            ...(job.template ? { template: job.template } : { command: job.agent }),
            name: `${job.name} · ${label}`,
            prompt: job.prompt
        })
        if (!opened.terminalStarted) {
            return { status: 'failed', sessionId: opened.sessionId, note: opened.note ?? 'the terminal did not start' }
        }
        if (!opened.promptSent) {
            return { status: 'failed', sessionId: opened.sessionId, note: opened.note ?? 'the prompt was not sent' }
        }
        return { status: 'started', sessionId: opened.sessionId, ...(opened.note ? { note: opened.note } : {}) }
    }

    private async runAttach(job: CronJob): Promise<Pick<CronRun, 'status' | 'sessionId' | 'note'>> {
        const state = this.deps.loops()
        const project = state.projects.find((p) => p.id === job.loopProjectId)
        if (!project) return { status: 'failed', note: 'the Loop project was removed' }
        const session = state.sessions.find((s) => s.loopProjectId === project.id)
        if (!session || !this.deps.hasTerminal(session.terminalId)) {
            return { status: 'failed', note: `the loop in "${project.name}" is not running — open it in the Loop window` }
        }
        const text = job.prompt.replace(/\r?\n/g, ' ')
        if (!this.deps.writeInput(session.terminalId, text)) return { status: 'failed', note: 'the loop terminal is gone' }
        await (this.deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(ATTACH_ENTER_DELAY_MS)
        this.deps.writeInput(session.terminalId, '\r')
        return { status: 'started', sessionId: session.terminalId }
    }

    // ------------------------------------------------------------------
    // Reading and editing — the window and the Control API share these
    // ------------------------------------------------------------------

    view(job: CronJob): CronView {
        const parsed = parseCron(job.schedule)
        let problem: string | undefined
        if (!parsed.ok) problem = parsed.message
        else if (job.mode === 'attach' && !this.deps.loops().projects.some((p) => p.id === job.loopProjectId)) {
            problem = 'the Loop project was removed'
        }
        return {
            ...job,
            nextRunAt: parsed.ok && job.enabled ? nextRun(parsed.schedule, this.now()) : null,
            lastRun: this.deps.store.lastRun(job.id),
            ...(problem ? { problem } : {})
        }
    }

    state(): CronState {
        return { crons: this.deps.store.list().map((j) => this.view(j)), runs: this.deps.store.runs().slice(0, 100) }
    }

    create(input: CronInput, createdBy: string): Checked<{ cron: CronView }> {
        const made = this.deps.store.create(input, createdBy, this.now())
        return made.ok ? { ok: true, cron: this.view(made.job) } : made
    }

    update(ref: string, input: CronInput): Checked<{ cron: CronView }> {
        const job = this.deps.store.get(ref)
        if (!job) return { ok: false, message: 'no such job' }
        const updated = this.deps.store.update(job.id, input, this.now())
        return updated.ok ? { ok: true, cron: this.view(updated.job) } : updated
    }

    remove(ref: string): boolean {
        const job = this.deps.store.get(ref)
        return job ? this.deps.store.remove(job.id) : false
    }

    get(ref: string): CronView | undefined {
        const job = this.deps.store.get(ref)
        return job ? this.view(job) : undefined
    }

    runs(ref: string): CronRun[] | undefined {
        const job = this.deps.store.get(ref)
        return job ? this.deps.store.runs(job.id) : undefined
    }

    /** «Open session» on a run: focuses it in the main window (new) or opens the Loop window (attach). */
    openSession(sessionId: string): boolean {
        return this.deps.focusSession(sessionId)
    }
}
