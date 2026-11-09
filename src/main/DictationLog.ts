import { randomUUID } from 'crypto'
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'fs'
import path from 'path'
import {
    DICTATION_LOG_AUDIO_DAYS,
    DICTATION_LOG_TEXT_DAYS,
    type DictationAgent,
    type DictationCancelReason,
    type DictationErrorCode,
    type DictationEvent,
    type DictationOutcome,
    type DictationStartContext
} from '../shared/dictation'
import { maskSecretLines } from './maskSecrets'

/**
 * The dictation log (Settings › Chat view › Keep dictation log, default off — decision 0012).
 *
 * Why it exists: to make dictation better later, the useful signal is the gap between what the
 * recognizer wrote (`finalText`) and what the person actually sent (`sentText`). A later change can
 * turn the words people keep fixing into hints (`SFSpeechRecognitionRequest.contextualStrings`).
 *
 * What it keeps, on this Mac only:
 *   userData/dictation-log/YYYY-MM-DD.jsonl   one line per run (the day it started), 30 days
 *   userData/dictation-log/audio/<id>.wav     the run's sound, when "Also keep audio" is on, 7 days
 * Folders 0700, files 0600. Text is masked (`maskSecrets.ts`) before it is written. Nothing here goes
 * into a feedback report, to a phone or through the Control API.
 *
 * A run's line is written once its fate is known: Esc (`cancelled`), nothing heard (`empty`), a failure
 * (`failed`), or — for words that reached the box — what the Chat view reports (`sent` / `edited-away`).
 * A report that never comes (the view went away, the app quit, half an hour passed) is `discarded`.
 *
 * No Electron import: the tests drive it with a temporary folder and their own clock.
 */

export type DictationLogOutcome = 'sent' | 'edited-away' | 'cancelled' | 'discarded' | 'empty' | 'failed'

/** One line of `YYYY-MM-DD.jsonl`. */
export interface DictationLogEntry {
    /** the line's shape; bump when a field changes meaning */
    v: 1
    id: string
    /** ISO time the run started */
    startedAt: string
    /** start to the helper's end, ms */
    durationMs: number
    /** what the recognizer listened for, e.g. "ko_KR" ("" if it never said) */
    locale: string
    agent: DictationAgent | null
    /** how many partial results came before the end — how much it revised itself */
    partialCount: number
    /** the recognizer's last words (its final result, or the last partial when Esc cut it) */
    finalText: string
    /** the whole message box as sent; null when the words were not sent (`outcome` says why) */
    sentText: string | null
    outcome: DictationLogOutcome
    /** set when `outcome` is `failed` */
    error?: DictationErrorCode
    /** relative to the log folder, e.g. "audio/<id>.wav"; null when no sound was kept */
    audioFile: string | null
}

export interface DictationLogSettings {
    enabled: boolean
    audio: boolean
}

/** What DictationService tells the log about a run (src/main/Dictation.ts). */
export interface DictationRecorder {
    /** a run is about to start; returns where the helper should write its sound, or null for none */
    begin(runId: number, owner: number, context: DictationStartContext): { audioPath: string | null }
    /** a helper line (or main's own error for a helper that died) */
    heard(runId: number, event: DictationEvent, locale?: string): void
    /** the helper is gone; `cancelled` when main killed it on purpose */
    ended(runId: number, cancelled?: DictationCancelReason): void
    /** what the Chat view did with the words */
    report(runId: number, owner: number, outcome: DictationOutcome): void
    /** a window closed or reloaded: its runs will hear nothing more */
    ownerGone(owner: number): void
    /** app quit: write what is still waiting */
    flush(): void
}

export interface DictationLogOptions {
    /** the log folder (userData/dictation-log) */
    dir: string
    /** read at the start of a run and again before writing — turning it off mid-run keeps nothing */
    settings(): DictationLogSettings
    /** replaced with `~` in the text */
    homeDir?: string
    now?: () => number
    /** how long finished words wait for the Chat view's report before they count as discarded */
    outcomeWaitMs?: number
    newId?: () => string
}

const DAY_MS = 24 * 60 * 60 * 1000
/** Long enough to read and fix the words before sending; past it the person has moved on. */
const DEFAULT_OUTCOME_WAIT_MS = 30 * 60 * 1000
const AUDIO_DIR = 'audio'
const LOG_FILE = /^(\d{4})-(\d{2})-(\d{2})\.jsonl$/
const DIR_MODE = 0o700
const FILE_MODE = 0o600

interface Run {
    owner: number
    id: string
    startedAt: number
    endedAt: number | null
    agent: DictationAgent | null
    locale: string
    listened: boolean
    partialCount: number
    lastText: string
    finalText: string | null
    error: DictationErrorCode | null
    audioPath: string | null
    /** a report that came before the helper's end */
    outcome: DictationOutcome | null
    timer: ReturnType<typeof setTimeout> | null
}

/** Local calendar day, so a day's file holds what was said that day on this Mac. */
export function dictationLogDay(time: number): string {
    const date = new Date(time)
    const pad = (value: number): string => String(value).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export class DictationLog implements DictationRecorder {
    private readonly runs = new Map<number, Run>()

    constructor(private readonly options: DictationLogOptions) {}

    get folder(): string {
        return this.options.dir
    }

    private now(): number {
        return this.options.now ? this.options.now() : Date.now()
    }

    private ensureDir(dir: string): void {
        mkdirSync(dir, { recursive: true, mode: DIR_MODE })
        // mkdir's mode is cut by the umask and ignored for a folder that already exists
        chmodSync(dir, DIR_MODE)
    }

    begin(runId: number, owner: number, context: DictationStartContext): { audioPath: string | null } {
        const settings = this.options.settings()
        if (!settings.enabled) return { audioPath: null }
        const id = this.options.newId ? this.options.newId() : randomUUID()
        let audioPath: string | null = null
        if (settings.audio) {
            try {
                const audioDir = path.join(this.options.dir, AUDIO_DIR)
                this.ensureDir(this.options.dir)
                this.ensureDir(audioDir)
                audioPath = path.join(audioDir, `${id}.wav`)
            } catch (error) {
                console.warn('[dictation-log] audio folder failed:', error instanceof Error ? error.message : error)
            }
        }
        this.runs.set(runId, {
            owner,
            id,
            startedAt: this.now(),
            endedAt: null,
            agent: context.agent === 'claude' || context.agent === 'codex' ? context.agent : null,
            locale: '',
            listened: false,
            partialCount: 0,
            lastText: '',
            finalText: null,
            error: null,
            audioPath,
            outcome: null,
            timer: null
        })
        return { audioPath }
    }

    heard(runId: number, event: DictationEvent, locale?: string): void {
        const run = this.runs.get(runId)
        if (!run) return
        if (event.type === 'listening') {
            run.listened = true
            if (locale) run.locale = locale
        } else if (event.type === 'partial') {
            run.partialCount += 1
            run.lastText = event.text
        } else if (event.type === 'final') run.finalText = event.text
        else if (event.type === 'error') run.error = event.code
    }

    ended(runId: number, cancelled?: DictationCancelReason): void {
        const run = this.runs.get(runId)
        if (!run || run.endedAt !== null) return
        run.endedAt = this.now()
        // never listened (permission refused, no microphone): there are no words to learn from
        if (!run.listened) {
            this.drop(runId, run)
            return
        }
        if (cancelled) return this.write(runId, run, cancelled, null)
        if (run.finalText === null) return this.write(runId, run, run.error ? 'failed' : 'discarded', null)
        if (run.finalText.trim() === '') return this.write(runId, run, 'empty', null)
        if (run.outcome) return this.writeOutcome(runId, run, run.outcome)
        const wait = this.options.outcomeWaitMs ?? DEFAULT_OUTCOME_WAIT_MS
        run.timer = setTimeout(() => this.write(runId, run, 'discarded', null), wait)
        run.timer.unref?.()
    }

    report(runId: number, owner: number, outcome: DictationOutcome): void {
        const run = this.runs.get(runId)
        if (!run || run.owner !== owner) return
        if (run.endedAt === null) {
            run.outcome = outcome
            return
        }
        this.writeOutcome(runId, run, outcome)
    }

    ownerGone(owner: number): void {
        for (const [runId, run] of this.runs) {
            if (run.owner === owner && run.endedAt !== null) this.write(runId, run, 'discarded', null)
        }
    }

    flush(): void {
        for (const [runId, run] of this.runs) {
            if (run.endedAt === null) run.endedAt = this.now()
            if (run.listened) this.write(runId, run, 'discarded', null)
            else this.drop(runId, run)
        }
    }

    private writeOutcome(runId: number, run: Run, outcome: DictationOutcome): void {
        if (outcome.type === 'sent' && typeof outcome.text === 'string') this.write(runId, run, 'sent', outcome.text)
        else this.write(runId, run, 'edited-away', null)
    }

    private drop(runId: number, run: Run): void {
        if (run.timer) clearTimeout(run.timer)
        this.runs.delete(runId)
        if (run.audioPath) rmSync(run.audioPath, { force: true })
    }

    private mask(text: string): string {
        return maskSecretLines(text.split('\n'), { homeDir: this.options.homeDir, joinLines: false }).lines.join('\n')
    }

    private write(runId: number, run: Run, outcome: DictationLogOutcome, sentText: string | null): void {
        if (run.timer) clearTimeout(run.timer)
        this.runs.delete(runId)
        const settings = this.options.settings()
        // turned off since the run started: keep nothing of it
        if (!settings.enabled) {
            if (run.audioPath) rmSync(run.audioPath, { force: true })
            return
        }
        let audioFile: string | null = null
        if (run.audioPath && existsSync(run.audioPath)) {
            if (settings.audio) {
                chmodSync(run.audioPath, FILE_MODE)
                audioFile = path.relative(this.options.dir, run.audioPath)
            } else rmSync(run.audioPath, { force: true })
        }
        const entry: DictationLogEntry = {
            v: 1,
            id: run.id,
            startedAt: new Date(run.startedAt).toISOString(),
            durationMs: Math.max(0, (run.endedAt ?? this.now()) - run.startedAt),
            locale: run.locale,
            agent: run.agent,
            partialCount: run.partialCount,
            finalText: this.mask(run.finalText ?? run.lastText),
            sentText: sentText === null ? null : this.mask(sentText),
            outcome,
            ...(outcome === 'failed' && run.error ? { error: run.error } : {}),
            audioFile
        }
        try {
            this.ensureDir(this.options.dir)
            const file = path.join(this.options.dir, `${dictationLogDay(run.startedAt)}.jsonl`)
            appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: FILE_MODE })
            chmodSync(file, FILE_MODE)
        } catch (error) {
            console.warn('[dictation-log] write failed:', error instanceof Error ? error.message : error)
        }
    }

    /**
     * Removes day files older than DICTATION_LOG_TEXT_DAYS and sounds older than DICTATION_LOG_AUDIO_DAYS.
     * Runs whether or not the log is on now: what was kept before still expires. Never creates the folder.
     */
    prune(): { text: number; audio: number } {
        const removed = { text: 0, audio: 0 }
        const dir = this.options.dir
        if (!existsSync(dir)) return removed
        const now = this.now()
        const oldestDay = dictationLogDay(now - DICTATION_LOG_TEXT_DAYS * DAY_MS)
        for (const name of readdirSync(dir)) {
            const match = LOG_FILE.exec(name)
            // the day files' names sort as dates
            if (match && name.slice(0, 10) < oldestDay) {
                rmSync(path.join(dir, name), { force: true })
                removed.text += 1
            }
        }
        const audioDir = path.join(dir, AUDIO_DIR)
        if (existsSync(audioDir)) {
            const active = new Set([...this.runs.values()].map((run) => run.audioPath))
            for (const name of readdirSync(audioDir)) {
                const file = path.join(audioDir, name)
                if (!name.endsWith('.wav') || active.has(file)) continue
                try {
                    if (now - statSync(file).mtimeMs > DICTATION_LOG_AUDIO_DAYS * DAY_MS) {
                        rmSync(file, { force: true })
                        removed.audio += 1
                    }
                } catch {
                    // gone in between
                }
            }
        }
        return removed
    }

    /** Settings › Delete all: the folder goes, and runs still waiting keep nothing. */
    deleteAll(): void {
        for (const run of this.runs.values()) if (run.timer) clearTimeout(run.timer)
        this.runs.clear()
        rmSync(this.options.dir, { recursive: true, force: true })
    }
}
