import type { MissedPolicy } from './cron'

/**
 * Autocron — jobs CLI Manager starts on a schedule, shown in the Loop window's «Autocron» tab
 * and reachable over the Control API (`/v1/crons`).
 *
 * Two modes for an agent job:
 * - new:    open a fresh session with `agent` (or a saved template) in `cwd` and type `prompt`
 * - attach: type `prompt` into a promoted /loop session (Loop Dashboard), keeping its context
 */
export type CronMode = 'new' | 'attach'

export interface CronMissed {
    policy: MissedPolicy
    /** For `once`: a missed run older than this is not caught up (it is marked expired). */
    withinMinutes: number
}

export interface CronJob {
    id: string
    name: string
    enabled: boolean
    /** Five-field cron expression, Mac local time (see shared/cron.ts). */
    schedule: string
    mode: CronMode
    /** mode new: the program to start — a command such as `claude` / `codex`, unless `template` is set. */
    agent?: string
    /** mode new: a saved terminal template (name or id) instead of `agent`. */
    template?: string
    /** mode new: folder the session opens in. */
    cwd?: string
    /** mode attach: the Loop project whose session receives the prompt. */
    loopProjectId?: string
    prompt: string
    missed: CronMissed
    createdAt: number
    updatedAt: number
    /** Who made it: 'app' from the window, or the Control API client name. */
    createdBy: string
}

/**
 * - started: the session was opened / the loop received the prompt
 * - failed:  it could not start (note says why)
 * - missed:  its time passed while nothing could run it, and the policy said not to run (note: skip / notify / expired)
 */
export type CronRunStatus = 'started' | 'failed' | 'missed'

export interface CronRun {
    id: string
    cronId: string
    /** The scheduled minute this run belongs to (ms). Manual runs use the click time. */
    plannedAt: number
    /** When CLI Manager acted on it. */
    at: number
    trigger: 'scheduled' | 'caught-up' | 'manual'
    status: CronRunStatus
    /** Older scheduled times folded into this one (the Mac was off / asleep / the app closed). */
    missedCount: number
    /** The CLI Manager session it opened or typed into — «Open session». */
    sessionId?: string
    note?: string
}

/** One job as the window and the API show it. */
export interface CronView extends CronJob {
    nextRunAt: number | null
    lastRun: CronRun | null
    /** Why the schedule cannot run, when it cannot (bad expression, missing loop project). */
    problem?: string
}

export interface CronState {
    crons: CronView[]
    /** Newest first, all jobs. */
    runs: CronRun[]
}

/** Fields a person or a client sends to make or edit a job. Absent = unchanged (edit) / default (create). */
export interface CronInput {
    name?: unknown
    schedule?: unknown
    mode?: unknown
    agent?: unknown
    template?: unknown
    cwd?: unknown
    loopProjectId?: unknown
    prompt?: unknown
    missed?: unknown
    enabled?: unknown
}

export const CRON_CHANNELS = {
    list: 'cron-list',
    create: 'cron-create',
    update: 'cron-update-job',
    remove: 'cron-remove',
    run: 'cron-run',
    openSession: 'cron-open-session',
    update_broadcast: 'cron-state'
} as const
