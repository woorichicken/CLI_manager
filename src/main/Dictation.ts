import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { existsSync } from 'fs'
import { createInterface } from 'readline'
import {
    DICTATION_MAX_SECONDS,
    type DictationErrorCode,
    type DictationEvent,
    type DictationStartResult,
    type DictationStatus
} from '../shared/dictation'

/**
 * Runs the dictation helper (native/dictation/main.swift) for the Chat view's mic button.
 * One run at a time — there is one microphone — owned by the window that started it.
 *
 * No Electron import, so the tests drive it with a fake helper (`CLIMANAGER_DICTATION_HELPER`).
 * index.ts registers the IPC and passes `send`.
 */

/** `status` answers in a few tens of ms; one that hangs must not hold the Chat view. */
const STATUS_TIMEOUT_MS = 5000
/** Mounting a Chat view per session asks for the status: answers this fresh are reused. */
const STATUS_CACHE_MS = 3000
/** The helper stops itself at DICTATION_MAX_SECONDS; past this, main stops waiting for it. */
const KILL_GRACE_MS = 10_000

export interface DictationServiceOptions {
    /** absolute path of the helper, or null when this build has none */
    helperPath(): string | null
    platform?: NodeJS.Platform
    /** delivers an event to the window that owns the run */
    send(owner: number, event: DictationEvent): void
}

interface ActiveRun {
    id: number
    owner: number
    child: ChildProcessWithoutNullStreams
    /** `final` or `error` already reached the window: an exit after it is the normal end */
    settled: boolean
    cancelled: boolean
    killTimer: ReturnType<typeof setTimeout>
}

const HELPER_ERRORS = new Set<DictationErrorCode>([
    'speech_denied',
    'mic_denied',
    'no_microphone',
    'audio_failed',
    'recognition_failed',
    'unsupported'
])

const PERMISSION_STATES = new Set(['authorized', 'denied', 'restricted', 'notDetermined'])

function unavailable(reason: DictationStatus['reason']): DictationStatus {
    return { available: false, reason, locale: '', speech: 'unknown', mic: 'unknown' }
}

export class DictationService {
    private active: ActiveRun | null = null
    private nextId = 1
    private statusCache: { value: DictationStatus; at: number } | null = null

    constructor(private readonly options: DictationServiceOptions) {}

    private helper(): string | null {
        if ((this.options.platform ?? process.platform) !== 'darwin') return null
        const helper = this.options.helperPath()
        return helper && existsSync(helper) ? helper : null
    }

    async status(): Promise<DictationStatus> {
        if ((this.options.platform ?? process.platform) !== 'darwin') return unavailable('not_mac')
        const helper = this.helper()
        if (!helper) return unavailable('no_helper')
        if (this.statusCache && Date.now() - this.statusCache.at < STATUS_CACHE_MS) return this.statusCache.value
        const value = await new Promise<DictationStatus>((resolve) => {
            execFile(helper, ['status'], { timeout: STATUS_TIMEOUT_MS }, (error, stdout) => {
                if (error) {
                    console.warn('[dictation] status failed:', error.message)
                    resolve(unavailable('helper_failed'))
                    return
                }
                resolve(parseStatus(stdout))
            })
        })
        this.statusCache = { value, at: Date.now() }
        return value
    }

    start(owner: number): DictationStartResult {
        const helper = this.helper()
        if (!helper) return { status: 'rejected', code: 'unsupported', message: 'Dictation is not available in this build.' }
        if (this.active) {
            return { status: 'rejected', code: 'busy', message: 'Dictation is already listening in another chat.' }
        }
        const id = this.nextId++
        // The answers can change at the first use (macOS asks): read them again next time.
        this.statusCache = null
        let child: ChildProcessWithoutNullStreams
        try {
            child = spawn(helper, ['listen'], { stdio: ['pipe', 'pipe', 'pipe'] })
        } catch (error) {
            return { status: 'rejected', code: 'helper_failed', message: error instanceof Error ? error.message : String(error) }
        }
        const run: ActiveRun = {
            id,
            owner,
            child,
            settled: false,
            cancelled: false,
            killTimer: setTimeout(() => child.kill('SIGKILL'), DICTATION_MAX_SECONDS * 1000 + KILL_GRACE_MS)
        }
        this.active = run
        const deliver = (event: DictationEvent): void => {
            if (run.cancelled) return
            this.options.send(owner, event)
        }

        createInterface({ input: child.stdout }).on('line', (line) => {
            const event = parseLine(id, line)
            if (!event || run.settled) return
            if (event.type === 'final' || event.type === 'error') run.settled = true
            deliver(event)
        })
        // the helper writes nothing there on purpose; macOS's own messages are worth a log line
        child.stderr.on('data', (chunk: Buffer) => console.warn('[dictation] helper:', chunk.toString().trim()))
        child.stdin.on('error', () => undefined) // a helper that already exited closes the pipe

        child.once('error', (error) => {
            console.warn('[dictation] helper did not start:', error.message)
        })
        child.once('close', (code, signal) => {
            clearTimeout(run.killTimer)
            if (this.active === run) this.active = null
            if (!run.settled) {
                run.settled = true
                // macOS ends a process with SIGABRT when the responsible app has no usage
                // description for what it asked — Speech Recognition, in a build without our Info.plist.
                const code_: DictationErrorCode = signal === 'SIGABRT' || code === 134 ? 'permission_setup' : 'helper_failed'
                deliver({
                    id,
                    type: 'error',
                    code: code_,
                    message:
                        code_ === 'permission_setup'
                            ? 'macOS stopped dictation: this build of CLI Manager cannot ask for Speech Recognition. Use an installed release.'
                            : `Dictation stopped unexpectedly (${signal ?? `exit ${code}`}).`
                })
            }
            deliver({ id, type: 'ended' })
        })
        return { status: 'started', id }
    }

    /** Stops listening; the helper still reports its last words as `final`. */
    stop(owner: number, id: number): void {
        const run = this.active
        if (!run || run.id !== id || run.owner !== owner) return
        if (!run.child.stdin.writableEnded) run.child.stdin.end('stop\n')
    }

    /** Stops at once and drops the words not yet final; the window hears nothing more. */
    cancel(owner: number, id?: number): void {
        const run = this.active
        if (!run || run.owner !== owner || (id !== undefined && run.id !== id)) return
        run.cancelled = true
        run.child.kill('SIGTERM')
    }

    /** A window closed or reloaded: its run must not keep the microphone open. */
    ownerGone(owner: number): void {
        this.cancel(owner)
    }

    /** App quit. */
    dispose(): void {
        if (this.active) this.active.child.kill('SIGTERM')
    }
}

export function parseStatus(stdout: string): DictationStatus {
    try {
        const raw = JSON.parse(stdout.trim().split('\n').pop() ?? '') as Record<string, unknown>
        const permission = (value: unknown): DictationStatus['speech'] =>
            typeof value === 'string' && PERMISSION_STATES.has(value) ? (value as DictationStatus['speech']) : 'unknown'
        const supported = raw.supported === true && raw.onDevice === true
        return {
            available: supported,
            reason: supported ? null : 'unsupported',
            locale: typeof raw.locale === 'string' ? raw.locale : '',
            speech: permission(raw.speech),
            mic: permission(raw.mic)
        }
    } catch {
        return unavailable('helper_failed')
    }
}

/** One stdout line of `listen` as an event for the window, or null for anything else. */
export function parseLine(id: number, line: string): DictationEvent | null {
    let raw: Record<string, unknown>
    try {
        raw = JSON.parse(line) as Record<string, unknown>
    } catch {
        return null
    }
    const text = typeof raw.text === 'string' ? raw.text : ''
    switch (raw.type) {
        case 'listening':
            return { id, type: 'listening' }
        case 'partial':
            return { id, type: 'partial', text }
        case 'final':
            return { id, type: 'final', text }
        case 'error': {
            const code = typeof raw.code === 'string' && HELPER_ERRORS.has(raw.code as DictationErrorCode) ? (raw.code as DictationErrorCode) : 'helper_failed'
            return { id, type: 'error', code, message: typeof raw.message === 'string' ? raw.message : 'Dictation failed.' }
        }
        default:
            return null
    }
}
