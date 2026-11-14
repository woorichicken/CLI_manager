import { CronInput, CronJob, CronRun, CronState, CronView } from '../shared/autocron'
import type { LoopState } from '../shared/types'
import { nextRun, parseCron, planTick } from '../shared/cron'
import { Checked, CronStore } from './CronStore'

/** How often the scheduler looks. A run is «on time» within ON_TIME_GRACE_MS (2 min) of its minute. */
export const CRON_TICK_MS = 30_000
/** Who made a job in the Loop window. Any other `createdBy` is a Control API client. */
export const CRON_MADE_IN_WINDOW = 'app'
const API_OFF_NOTE = 'the Control API is off — this job was made over the API, so it runs only while the API is on (Settings)'

/**
 * What typing a prompt into a loop came to (ControlApiService.typeIntoLoop):
 * - submitted: the prompt left the input box (or the program draws none)
 * - busy:      the input box already held text — a person's draft — so nothing was typed
 * - stuck:     the prompt was still in the box after Enter and the retries
 * - gone:      the terminal is no longer running
 */
export type LoopTypeResult = 'submitted' | 'busy' | 'stuck' | 'gone'

const LOOP_TYPE_NOTES: Record<Exclude<LoopTypeResult, 'submitted'>, string> = {
    busy: 'the loop\'s input line already has text someone was typing — nothing was typed, so the two do not mix',
    stuck: 'the prompt is still in the input box of the loop after Enter was pressed again — send it in the Loop window',
    gone: 'the loop terminal is gone'
}

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
    /**
     * Types one line into a loop terminal and presses Enter the Control API's way: refused while the
     * input box holds a person's draft, Enter pressed again while the prompt stays in the box.
     */
    typeIntoLoop(terminalId: string, text: string): Promise<LoopTypeResult>
    hasTerminal(terminalId: string): boolean
    /**
     * Whether a prompt may be typed into the loop now — null when it may, else why not: only the
     * shell is left (the agent exited), or the screen shows a question where Enter would pick the
     * highlighted option (the Control API's input guard, CLAUDE.md «Control API» 3).
     */
    loopRefusal(terminalId: string): Promise<string | null>
    /** Makes sure the main window exists (hidden is fine) so a new session's terminal can start — it is spawned by the window. */
    ensureMainWindow(): Promise<void>
    /**
     * Whether the Control API is switched on. A job a client made over the API runs only while it
     * is (decision 0006 addendum): turning the API off is how a person ends every API reach,
     * and a job's `agent` is a command typed into a shell.
     */
    apiOn(): boolean
    /** A system notification for «notify» misses and failures. */
    notify(title: string, body: string): void
    /** Focus a session in the main window — «Open session». False when it is gone. */
    focusSession(sessionId: string): boolean
    now?: () => number
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
    /** Typing into one loop terminal, one job at a time: text, pause, Enter must not interleave. */
    private readonly terminalQueue = new Map<string, Promise<unknown>>()
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
            if (this.waitsForApi(job)) {
                // like a paused job: the bookmark moves, so turning the API back on starts from then
                this.deps.store.setCheckedAt(job.id, now)
                continue
            }
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

    /** A job made over the Control API, while the API is off. */
    private waitsForApi(job: CronJob): boolean {
        return job.createdBy !== CRON_MADE_IN_WINDOW && !this.deps.apiOn()
    }

    private async run(job: CronJob, at: { plannedAt: number; trigger: CronRun['trigger']; missedCount: number }): Promise<CronRun> {
        const base = { cronId: job.id, plannedAt: at.plannedAt, trigger: at.trigger, missedCount: at.missedCount }
        if (this.waitsForApi(job)) return this.deps.store.addRun({ ...base, at: this.now(), status: 'failed', note: API_OFF_NOTE })
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
        const terminalId = session.terminalId
        return this.oneAtATime<Pick<CronRun, 'status' | 'sessionId' | 'note'>>(terminalId, async () => {
            // asked inside the queue: the job before this one may have just opened a question
            const refusal = await this.deps.loopRefusal(terminalId)
            if (refusal) return { status: 'failed', sessionId: terminalId, note: refusal }
            const result = await this.deps.typeIntoLoop(terminalId, job.prompt.replace(/\r?\n/g, ' '))
            if (result === 'submitted') return { status: 'started', sessionId: terminalId }
            return { status: 'failed', ...(result === 'gone' ? {} : { sessionId: terminalId }), note: LOOP_TYPE_NOTES[result] }
        })
    }

    private oneAtATime<T>(terminalId: string, work: () => Promise<T>): Promise<T> {
        const previous = this.terminalQueue.get(terminalId) ?? Promise.resolve()
        const next = previous.catch(() => undefined).then(work)
        this.terminalQueue.set(terminalId, next)
        void next.finally(() => {
            if (this.terminalQueue.get(terminalId) === next) this.terminalQueue.delete(terminalId)
        }).catch(() => undefined)
        return next
    }

    // ------------------------------------------------------------------
    // Reading and editing — the window and the Control API share these
    // ------------------------------------------------------------------

    view(job: CronJob): CronView {
        const parsed = parseCron(job.schedule)
        const apiOff = this.waitsForApi(job)
        let problem: string | undefined
        if (!parsed.ok) problem = parsed.message
        else if (apiOff) problem = API_OFF_NOTE
        else if (job.mode === 'attach' && !this.deps.loops().projects.some((p) => p.id === job.loopProjectId)) {
            problem = 'the Loop project was removed'
        }
        return {
            ...job,
            nextRunAt: parsed.ok && job.enabled && !apiOff ? nextRun(parsed.schedule, this.now()) : null,
            lastRun: this.deps.store.lastRun(job.id),
            ...(problem ? { problem } : {}),
            ...(apiOff ? { apiOff: true } : {})
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
