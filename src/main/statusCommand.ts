import { execFile } from 'child_process'
import { ipcMain } from 'electron'
import { StatusCommandResult, StatusReport, StatusSource, StatusState } from '../shared/types'

/**
 * Status panel — runs the user's `statusCommand` when the System Monitor opens and hands its JSON
 * (StatusReport v1) to the popover. No background polling: like the rest of the popover, it costs
 * nothing until someone looks.
 *
 * The app ships to other people, so it knows only the report's shape — which queues exist is the
 * command's business (the author's is `queues status --json`).
 */

export const STATUS_COMMAND_TIMEOUT_MS = 20_000
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024
const MAX_SOURCES = 40
const MAX_ITEMS_PER_SOURCE = 60
const MAX_TEXT = 300

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
        return {
            id: text(src.id, `source-${index}`),
            name: text(src.name, text(src.id, `source ${index + 1}`)),
            what: text(src.what) || undefined,
            state: isState(src.state) ? src.state : 'error',
            summary: text(src.summary),
            items: items.slice(0, MAX_ITEMS_PER_SOURCE).map(item => {
                const it = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>
                return { text: text(it.text), state: isState(it.state) ? it.state : undefined }
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
                resolve({ configured: true, ok: true, report: parsed.report, durationMs })
                return
            }
            const lastErr = String(stderr).trim().split('\n').pop()?.slice(0, 200)
            const exit = err ? ` (exit ${(err as { code?: unknown }).code ?? '?'})` : ''
            resolve({ configured: true, ok: false, error: `${parsed.error}${exit}${lastErr ? ` — ${lastErr}` : ''}`, durationMs })
        })
    })
}

/**
 * Registers `get-status-report`. The command comes from the saved settings, never from the
 * renderer, and a second open while one run is in flight shares that run.
 */
export function registerStatusCommandIpc(readCommand: () => string | undefined): void {
    let inFlight: Promise<StatusCommandResult> | null = null
    ipcMain.handle('get-status-report', async (): Promise<StatusCommandResult> => {
        const command = (readCommand() ?? '').trim()
        if (!command) return { configured: false }
        if (!inFlight) inFlight = runStatusCommand(command).finally(() => { inFlight = null })
        return inFlight
    })
}
