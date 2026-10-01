import { closeSync, existsSync, openSync, readdirSync, readSync, realpathSync, statSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

/**
 * Finds the conversation id of a Codex session so a restart can
 * `codex … resume <id>` instead of starting over.
 *
 * Claude Code takes `--session-id` from us; Codex has no such flag. It names
 * the conversation itself and records it in a rollout file under
 * $CODEX_HOME/sessions/YYYY/MM/DD/ whose first line is a `session_meta`
 * record with the id, the working directory and the start time (checked
 * against codex-cli 0.155.1, 2026-10-01). So after a terminal starts Codex, we
 * look for a new rollout whose directory matches that terminal's.
 */

/** Codex subcommands that are not an interactive conversation to resume later. */
const NON_INTERACTIVE = new Set([
    'exec', 'e', 'login', 'logout', 'mcp', 'mcp-server', 'app-server', 'completion', 'sandbox', 'debug',
    'apply', 'a', 'cloud', 'features', 'resume', 'fork', 'help', '-h', '--help', '-V', '--version'
])
/** Codex flags that take the next token as their value. */
const FLAGS_WITH_VALUE = new Set(['-c', '--config', '-m', '--model', '-p', '--profile', '-C', '--cd', '-s', '--sandbox', '-a', '--ask-for-approval', '-i', '--image', '--enable', '--disable', '--add-dir'])

/** Rollouts can be written a little before our clock reading of "started". */
const START_SLACK_MS = 5_000
const POLL_MS = 3_000
/** Codex writes the rollout once the conversation starts, which can be minutes after launch. */
const WATCH_MS = 15 * 60 * 1000
/** session_meta is the first line; it is long (it carries instructions) but its fields come first. */
const HEAD_BYTES = 8 * 1024

/**
 * True when `tokens` (an already alias-expanded command line) starts an
 * interactive Codex conversation.
 */
export function isInteractiveCodex(tokens: string[]): boolean {
    const name = (tokens[0] ?? '').split('/').pop()
    if (name !== 'codex') return false
    for (let i = 1; i < tokens.length; i++) {
        const token = tokens[i]
        if (FLAGS_WITH_VALUE.has(token)) {
            i++
            continue
        }
        if (token.startsWith('-')) {
            if (NON_INTERACTIVE.has(token)) return false
            continue
        }
        // The first bare word is either a subcommand or the opening prompt.
        return !NON_INTERACTIVE.has(token)
    }
    return true
}

interface RolloutMeta {
    id: string
    cwd: string
    startedAt: number
}

function readMeta(file: string): RolloutMeta | null {
    let fd: number | undefined
    try {
        fd = openSync(file, 'r')
        const buffer = Buffer.alloc(HEAD_BYTES)
        const read = readSync(fd, buffer, 0, HEAD_BYTES, 0)
        const head = buffer.toString('utf-8', 0, read)
        // The line is usually longer than HEAD_BYTES, so pick fields instead of parsing JSON.
        if (!head.includes('"type":"session_meta"')) return null
        const id = /"id":"([0-9a-f-]{36})"/.exec(head)?.[1]
        const cwd = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(head)?.[1]
        const timestamp = /"payload":\{[^}]*?"timestamp":"([^"]+)"/.exec(head)?.[1]
        if (!id || !cwd || !timestamp) return null
        return { id, cwd: JSON.parse(`"${cwd}"`), startedAt: Date.parse(timestamp) }
    } catch {
        return null
    } finally {
        if (fd !== undefined) closeSync(fd)
    }
}

function canonical(dir: string): string {
    try {
        return realpathSync(dir)
    } catch {
        return dir
    }
}

function dayDir(sessionsDir: string, at: number): string {
    const d = new Date(at)
    const pad = (n: number): string => String(n).padStart(2, '0')
    return join(sessionsDir, String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate()))
}

export class CodexSessionLocator {
    private readonly sessionsDir: string
    /** Ids already handed to a terminal, so two sessions in one folder get different ones. */
    private readonly claimed = new Set<string>()

    constructor(codexHome = process.env.CODEX_HOME || join(homedir(), '.codex')) {
        this.sessionsDir = join(codexHome, 'sessions')
    }

    /**
     * Polls for the rollout of a conversation started in `cwd` at `startedAt`.
     * Calls `onFound` once with its id. Returns a function that stops watching.
     */
    watch(cwd: string, startedAt: number, onFound: (id: string) => void): () => void {
        const target = canonical(cwd)
        let stopped = false
        const poll = (): void => {
            if (stopped) return
            const id = this.find(target, startedAt)
            if (id) {
                stop()
                onFound(id)
            }
        }
        const interval = setInterval(poll, POLL_MS)
        const timeout = setTimeout(() => stop(), WATCH_MS)
        const stop = (): void => {
            stopped = true
            clearInterval(interval)
            clearTimeout(timeout)
        }
        return stop
    }

    /** True when a rollout for this conversation still exists, so `resume` has something to load. */
    exists(id: string): boolean {
        if (!existsSync(this.sessionsDir)) return false
        try {
            for (const year of readdirSync(this.sessionsDir)) {
                for (const month of readdirSync(join(this.sessionsDir, year))) {
                    for (const day of readdirSync(join(this.sessionsDir, year, month))) {
                        if (readdirSync(join(this.sessionsDir, year, month, day)).some((f) => f.endsWith(`${id}.jsonl`))) return true
                    }
                }
            }
        } catch {
            // An unreadable tree is treated as "not found"; the session then starts fresh.
        }
        return false
    }

    private find(target: string, startedAt: number): string | null {
        // A session started just before midnight writes into the next day's folder.
        const dirs = [...new Set([dayDir(this.sessionsDir, startedAt), dayDir(this.sessionsDir, Date.now())])]
        const candidates: Array<{ id: string; startedAt: number }> = []
        for (const dir of dirs) {
            let files: string[]
            try {
                files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
            } catch {
                continue
            }
            for (const file of files) {
                const path = join(dir, file)
                try {
                    if (statSync(path).mtimeMs < startedAt - START_SLACK_MS) continue
                } catch {
                    continue
                }
                const meta = readMeta(path)
                if (!meta || this.claimed.has(meta.id)) continue
                if (meta.startedAt < startedAt - START_SLACK_MS) continue
                if (canonical(meta.cwd) !== target) continue
                candidates.push(meta)
            }
        }
        if (candidates.length === 0) return null
        // The earliest conversation after the start is the one this terminal began.
        candidates.sort((a, b) => a.startedAt - b.startedAt)
        this.claimed.add(candidates[0].id)
        return candidates[0].id
    }
}
