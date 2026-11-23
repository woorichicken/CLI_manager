import { execFile } from 'child_process'
import { ipcMain } from 'electron'
import { QueueActionResult, StatusAction, StatusCommandResult, StatusReport, StatusSource, StatusState } from '../shared/types'

/**
 * Status panel — runs the user's `statusCommand` when the System Monitor opens and hands its JSON
 * (StatusReport v1) to the popover. No background polling: like the rest of the popover, it costs
 * nothing until someone looks.
 *
 * The app ships to other people, so it knows only the report's shape — which queues exist is the
 * command's business (the author's is `queues status --json`).
 *
 * Rows can also be acted on (decision 0014): a source lists the actions it has, a row lists the ones
 * it offers right now, and `statusActionCommand` runs one — only after a fresh report still offers it,
 * with the three names passed as arguments, never as command text. No action command → read only.
 */

export const STATUS_COMMAND_TIMEOUT_MS = 20_000
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024
const MAX_SOURCES = 40
const MAX_ITEMS_PER_SOURCE = 60
const MAX_TEXT = 300
const MAX_ACTIONS = 8
export const STATUS_ACTION_TIMEOUT_MS = 30_000
const MAX_ACTION_OUTPUT = 2_000
/** Ids that address a row or an action. Plain names only — they end up as shell arguments and URL pieces. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/
const safeId = (value: unknown): string | undefined => (typeof value === 'string' && SAFE_ID.test(value) ? value : undefined)

const STATES: readonly StatusState[] = ['ok', 'busy', 'attention', 'blocked', 'error']
const isState = (value: unknown): value is StatusState => typeof value === 'string' && (STATES as readonly string[]).includes(value)
const text = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback).slice(0, MAX_TEXT)

/**
 * Turns the command's stdout into a StatusReport, or says why it cannot.
 * The output is the user's own command, but it is still parsed defensively: anything past the
 * caps is dropped, an unknown row state becomes 'error' (a row we cannot read must not look fine),
 * and the counts are recomputed here rather than trusted.
 */
export function parseStatusReport(stdout: string): { report: StatusReport } | { error: string } {
    // A login shell may print lines before the report (motd, warnings). The report starts at a line
    // that begins with "{"; a brace in the middle of a warning line ("check /path/{a,b}") is not one.
    const starts = [...stdout.matchAll(/(^|\n)\{/g)].map(m => m.index! + m[1].length)
    if (starts.length === 0) return { error: 'no JSON in the output' }
    let raw: unknown
    let lastError = ''
    for (const start of starts) {
        try {
            raw = JSON.parse(stdout.slice(start))
            break
        } catch (e) {
            lastError = (e as Error).message.slice(0, 120)
        }
    }
    if (raw === undefined) return { error: `output is not valid JSON (${lastError})` }
    if (!raw || typeof raw !== 'object') return { error: 'output is not a JSON object' }
    const obj = raw as Record<string, unknown>
    if (obj.version !== 1) return { error: `unsupported report version ${JSON.stringify(obj.version)} (expected 1)` }
    if (!Array.isArray(obj.sources)) return { error: 'report has no "sources" array' }

    const sources: StatusSource[] = obj.sources.slice(0, MAX_SOURCES).map((entry, index) => {
        const src = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>
        const items = Array.isArray(src.items) ? src.items : []
        // An action needs a plain id; one without is dropped rather than guessed. A row may only offer
        // what its source lists — an unknown id is dropped too, so the row stays read only.
        const actions: StatusAction[] = []
        for (const raw of (Array.isArray(src.actions) ? src.actions : []).slice(0, MAX_ACTIONS)) {
            const a = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
            const id = safeId(a.id)
            if (id && !actions.some(x => x.id === id)) actions.push({ id, label: text(a.label, id) || id })
        }
        const known = new Set(actions.map(a => a.id))
        return {
            id: text(src.id, `source-${index}`),
            name: text(src.name, text(src.id, `source ${index + 1}`)),
            what: text(src.what) || undefined,
            state: isState(src.state) ? src.state : 'error',
            summary: text(src.summary),
            actions,
            items: items.slice(0, MAX_ITEMS_PER_SOURCE).map(item => {
                const it = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>
                const id = safeId(it.id)
                const offered = id && Array.isArray(it.actions)
                    ? [...new Set(it.actions.filter((a): a is string => typeof a === 'string' && known.has(a)))]
                    : []
                return { id, text: text(it.text), state: isState(it.state) ? it.state : undefined, actions: offered }
            }),
            see: text(src.see) || undefined
        }
    })
    const counts = { ok: 0, busy: 0, attention: 0, blocked: 0, error: 0 } as Record<StatusState, number>
    for (const s of sources) counts[s.state] += 1
    return { report: { version: 1, generatedAt: text(obj.generatedAt, new Date().toISOString()), counts, sources } }
}

/** Runs `command` in the login shell (Finder-launched apps lack the terminal PATH — CLAUDE.md). */
export function runStatusCommand(command: string, timeoutMs = STATUS_COMMAND_TIMEOUT_MS): Promise<StatusCommandResult> {
    const startedAt = Date.now()
    const shell = process.env.SHELL || '/bin/zsh'
    return new Promise(resolve => {
        // SIGKILL like phoneUsage.ts: a command that ignores SIGTERM must not outlive the timeout.
        execFile(shell, ['-l', '-c', command], { timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, killSignal: 'SIGKILL' }, (err, stdout, stderr) => {
            const durationMs = Date.now() - startedAt
            const failure = err as (NodeJS.ErrnoException & { killed?: boolean }) | null
            if (failure?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
                resolve({ configured: true, ok: false, error: `output is larger than ${MAX_OUTPUT_BYTES / 1024 / 1024} MB`, durationMs })
                return
            }
            if (failure?.killed) {
                resolve({ configured: true, ok: false, error: `timed out after ${Math.round(timeoutMs / 1000)}s`, durationMs })
                return
            }
            // A non-zero exit still counts when the JSON is there: `queues status` exits 3 when a queue is blocked.
            const parsed = parseStatusReport(String(stdout))
            if ('report' in parsed) {
                resolve({ configured: true, ok: true, report: parsed.report, durationMs, actionsEnabled: false })
                return
            }
            const lastErr = String(stderr).trim().split('\n').pop()?.slice(0, 200)
            const exit = err ? ` (exit ${(err as { code?: unknown }).code ?? '?'})` : ''
            resolve({ configured: true, ok: false, error: `${parsed.error}${exit}${lastErr ? ` — ${lastErr}` : ''}`, durationMs })
        })
    })
}

/**
 * Runs `actionCommand` with the three names as positional arguments: the shell sees
 * `<actionCommand> "$@"`, so a name is never parsed as shell text even if one slipped past SAFE_ID.
 */
export function runStatusAction(
    actionCommand: string, source: string, item: string, action: string, timeoutMs = STATUS_ACTION_TIMEOUT_MS
): Promise<{ exitCode: number | 'timeout'; output: string; durationMs: number }> {
    const startedAt = Date.now()
    const shell = process.env.SHELL || '/bin/zsh'
    return new Promise(resolve => {
        execFile(shell, ['-l', '-c', `${actionCommand} "$@"`, 'status-action', source, item, action],
            { timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, killSignal: 'SIGKILL' },
            (err, stdout, stderr) => {
                const failure = err as (NodeJS.ErrnoException & { killed?: boolean }) | null
                const exitCode = failure?.killed ? 'timeout' : failure ? (typeof failure.code === 'number' ? failure.code : 1) : 0
                const output = `${String(stdout).trim()}\n${String(stderr).trim()}`.trim().slice(-MAX_ACTION_OUTPUT)
                resolve({ exitCode, output, durationMs: Date.now() - startedAt })
            })
    })
}

export interface StatusService {
    /** The report the popover and `GET /v1/queues` show. Concurrent callers share one run. */
    report(): Promise<StatusCommandResult>
    /** Runs one action after a fresh report confirms the row still offers it. */
    act(source: string, item: string, action: string): Promise<QueueActionResult>
}

export function createStatusService(settings: () => { command?: string; actionCommand?: string }): StatusService {
    let inFlight: Promise<StatusCommandResult> | null = null
    const read = (): { command: string; actionCommand: string } => {
        const s = settings()
        return { command: (s.command ?? '').trim(), actionCommand: (s.actionCommand ?? '').trim() }
    }
    const fresh = (command: string): Promise<StatusCommandResult> => {
        if (!inFlight) inFlight = runStatusCommand(command).finally(() => { inFlight = null })
        return inFlight
    }
    const refuse = (status: number, code: string, message: string): QueueActionResult => ({ ok: false, status, code, message })
    return {
        async report() {
            const { command, actionCommand } = read()
            if (!command) return { configured: false }
            const result = await fresh(command)
            return result.configured && result.ok ? { ...result, actionsEnabled: actionCommand.length > 0 } : result
        },
        async act(source, item, action) {
            const { command, actionCommand } = read()
            if (!command) return refuse(404, 'not_configured', 'No status command in Settings › General.')
            if (!actionCommand) return refuse(404, 'actions_off', 'No action command in Settings › General — every queue is read only.')
            if (!safeId(item) || !safeId(action)) return refuse(400, 'bad_request', 'item and action must be plain ids.')
            // Its own run, not a shared one: a run that started before this call may predate the row's change.
            const result = await runStatusCommand(command)
            if (!result.configured) return refuse(404, 'not_configured', 'No status command in Settings › General.')
            if (!result.ok) return refuse(502, 'status_command_failed', result.error)
            const src = result.report.sources.find(s => s.id === source)
            if (!src) return refuse(404, 'queue_not_found', `No queue "${source}" in the report.`)
            if (src.state === 'error') return refuse(409, 'queue_unreadable', `Queue "${source}" could not be read: ${src.summary}`)
            const row = src.items.find(i => i.id === item)
            if (!row) return refuse(404, 'queue_item_not_found', `Queue "${source}" has no row "${item}" now.`)
            if (!row.actions.includes(action)) {
                return refuse(409, 'action_not_offered', src.actions.length === 0
                    ? `Queue "${source}" is read only.`
                    : `Row "${item}" does not offer "${action}" now.`)
            }
            const ran = await runStatusAction(actionCommand, source, item, action)
            if (ran.exitCode !== 0) {
                return refuse(502, 'action_failed', `exit ${ran.exitCode}${ran.output ? ` — ${ran.output.split('\n').pop()}` : ''}`)
            }
            return { ok: true, source, item, action, output: ran.output, durationMs: ran.durationMs }
        }
    }
}

/**
 * Registers `get-status-report`. The command comes from the saved settings, never from the
 * renderer, and a second open while one run is in flight shares that run.
 */
export function registerStatusCommandIpc(service: StatusService): void {
    ipcMain.handle('get-status-report', (): Promise<StatusCommandResult> => service.report())
}
