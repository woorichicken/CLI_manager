import { execFile } from 'child_process'
import { realpathSync, statSync } from 'fs'
import path from 'path'
import { OPENCODE_SESSION_ID, opencodeTitleStart } from './transcript/opencodeTranscript'
import { hasSession, sessionsIn, sessionsTitled } from './transcript/opencodeStore'

/**
 * Finds the OpenCode session each terminal shows, so the chat can read it and a restart can resume it
 * (`opencode --session <id>`).
 *
 * OpenCode 1.18.15 (measured 2026-11-27) holds no file per session — every session of every project is in
 * one SQLite store, which every running OpenCode keeps open — and herdr learns the id from a plugin it
 * installs into the person's OpenCode config, which this app does not do (decision 0002). What a terminal
 * does show of it:
 *
 * 1. The top-level sessions of the process's folder whose title the terminal title OpenCode sets
 *    stands for — `OC | <session title>`, once the first answer named it (ovis paneSession, MIT); several
 *    (a title cut at 40 characters, a title used twice): the one used since the process started. The home
 *    screen and an unnamed session are titled `OpenCode`: no session yet. The title follows a `/sessions`
 *    switch inside the TUI.
 * 2. Without a session title on screen, `--session <id>` / `-s <id>` on the command line.
 *
 * Bound only when exactly one session is left. Two OpenCodes in one folder whose sessions share a title, or
 * a title not written to the store yet, stay unbound until it is clear — a wrong session in the chat is worse
 * than none. The store is the one the process holds open (lsof), so `OPENCODE_DB`/`XDG_DATA_HOME` are followed.
 *
 * Cost: a stat of the default store and its WAL per tick, and the terminal titles. The process table and lsof
 * run only when either changed, or at most every FULL_SCAN_MS. No store on this Mac: nothing runs.
 */

export interface OpencodeProcess {
    pid: number
    ppid: number
    /** seconds since it started (`ps etime`) */
    age: number
    /** the command line as `ps` prints it (`args`) */
    args: string
}

export interface OpencodeSessionSyncDeps {
    /** the store OpenCode opens by default (`~/.local/share/opencode/opencode.db`), or null */
    defaultStore: () => string | null
    /** pty shell pid → terminal id */
    ptyPids: () => Map<number, string>
    /** the title the terminal's program set (OSC 0/2), or null */
    title: (terminalId: string) => string | null
    /** A terminal's OpenCode shows another session than last reported. `command` starts it again, resumed. */
    onSession: (terminalId: string, sessionId: string, command: string) => void
    intervalMs?: number
    fullScanMs?: number
    /** the process table; `ps` by default */
    processes?: () => Promise<OpencodeProcess[]>
    /** a process's folder and the OpenCode store it holds open; `lsof` by default */
    openFiles?: (pid: number) => Promise<{ cwd: string | null; files: string[] }>
}

const DEFAULT_INTERVAL_MS = 5_000
const DEFAULT_FULL_SCAN_MS = 30_000
/** An opencode deeper under the shell than this is not the terminal's agent. */
const MAX_DEPTH = 4
/** ps prints whole seconds: a session made in the process's first second still counts. */
const START_SLACK_MS = 2_000
/** lsof must not hold a tick forever (a network volume): the tick gives up, the next tries again. */
const LSOF_TIMEOUT_MS = 10_000
/** OpenCode's subcommands (`opencode --help`, 1.18.15): no TUI session of their own on screen. */
const NOT_INTERACTIVE = new Set(['acp', 'agent', 'attach', 'auth', 'completion', 'db', 'debug', 'export', 'github', 'import', 'mcp', 'models', 'plugin', 'pr', 'providers', 'run', 'serve', 'session', 'stats', 'uninstall', 'upgrade', 'web', '-h', '--help', '-v', '--version'])
/** Its options that take a value, so the value stays with its option. */
const VALUE_FLAGS = new Set(['-m', '--model', '--agent', '--port', '--hostname', '--log-level', '--mdns-domain', '--cors'])
/** Options that name the session or the first prompt: dropped from a restart command (`--session <id>` is added). */
const SESSION_FLAGS = new Set(['-s', '--session', '--prompt'])
const SESSION_SWITCHES = new Set(['-c', '--continue', '--fork'])

export class OpencodeSessionSync {
    private timer: NodeJS.Timeout | null = null
    private running = false
    private mark: string | null = null
    private titles = ''
    private scannedAt = 0
    private readonly reported = new Map<string, string>()

    constructor(private readonly deps: OpencodeSessionSyncDeps) {}

    start(): void {
        if (this.timer) return
        this.timer = setInterval(() => void this.tick(), this.deps.intervalMs ?? DEFAULT_INTERVAL_MS)
        this.timer.unref?.()
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer)
        this.timer = null
    }

    /** A manual link must not suppress the next correction. */
    forget(terminalId: string): void {
        this.reported.delete(terminalId)
    }

    async tick(now = Date.now()): Promise<void> {
        if (this.running) return
        this.running = true
        try {
            await this.sync(now)
        } catch (error) {
            console.warn('[OpencodeSessionSync] sync failed:', error)
        } finally {
            this.running = false
        }
    }

    private async sync(now: number): Promise<void> {
        const store = this.deps.defaultStore()
        let mark: string
        try {
            const db = store ? statSync(store) : null
            if (!db) return // OpenCode never ran here
            let wal = ''
            try {
                const stat = statSync(`${store}-wal`)
                wal = `${stat.size}:${stat.mtimeMs}`
            } catch {
                // no WAL: OpenCode is not running, or checkpointed on exit
            }
            mark = `${db.ino}:${db.mtimeMs}:${wal}`
        } catch {
            return
        }
        const ptyPids = this.deps.ptyPids()
        if (ptyPids.size === 0) return
        const titles = [...ptyPids.values()].map((id) => `${id}=${this.deps.title(id) ?? ''}`).join('\n')
        if (mark === this.mark && titles === this.titles && now - this.scannedAt < (this.deps.fullScanMs ?? DEFAULT_FULL_SCAN_MS)) return
        const rows = await (this.deps.processes ?? readProcesses)()
        if (rows.length === 0) return // ps failed: next tick tries again
        this.mark = mark
        this.titles = titles
        this.scannedAt = now
        const parents = new Map(rows.map((row) => [row.pid, row.ppid]))
        // a session bound to one terminal is no candidate for another in this pass
        const taken = new Set<string>()
        const found: { terminalId: string; id: string; args: string }[] = []
        for (const row of rows) {
            if (!isInteractiveOpencode(row.args)) continue
            const terminalId = terminalOf(row.pid, parents, ptyPids)
            if (!terminalId) continue
            const id = await this.sessionOf(row, terminalId, store, now, taken)
            if (!id) continue
            taken.add(id)
            found.push({ terminalId, id, args: row.args })
        }
        for (const { terminalId, id, args } of found) {
            if (this.reported.get(terminalId) === id) continue
            this.reported.set(terminalId, id)
            this.deps.onSession(terminalId, id, resumableCommand(args))
        }
    }

    private async sessionOf(row: OpencodeProcess, terminalId: string, fallbackStore: string | null, now: number, taken: Set<string>): Promise<string | null> {
        const open = await (this.deps.openFiles ?? readOpenFiles)(row.pid)
        const stores = open.files.filter((file) => file.endsWith('.db'))
        const store = stores.find((file) => path.basename(path.dirname(file)) === 'opencode') ?? stores[0] ?? fallbackStore
        const fromTitle = this.titled(row, terminalId, open.cwd, store, now, taken)
        if (fromTitle !== undefined) return fromTitle
        // no session title on screen yet: the one the command line opened
        const named = namedSession(row.args)
        return named && !taken.has(named) && hasSession(store, named) ? named : null
    }

    /**
     * The session the terminal title names in the process's folder; null when the title names one but not
     * exactly; undefined when it names none (the home screen, an unnamed session). The title follows a
     * `/sessions` switch inside the TUI, so it goes before `--session` (Codex review).
     */
    private titled(row: OpencodeProcess, terminalId: string, cwd: string | null, store: string | null, now: number, taken: Set<string>): string | null | undefined {
        const title = this.deps.title(terminalId)
        if (!title || opencodeTitleStart(title) === null) return undefined
        if (!cwd) return null
        const folders = [...new Set([cwd, realpath(cwd)])]
        // the sessions this title stands for in the process's folder — an older one too: OpenCode switches
        // sessions inside the TUI (`/sessions`) and the title follows
        // counted before the ones other terminals took are left out: by elimination, which terminal is
        // looked at first (the `ps` order) would decide the binding and could swap it (code review)
        const titled = sessionsIn(store, folders, sessionsTitled(store, title))
        const free = (id: string) => (taken.has(id) ? null : id)
        if (titled.length === 1) return free(titled[0].id)
        // the same title twice (a cut title stands for several): the one used since this process started
        const since = now - row.age * 1000 - START_SLACK_MS
        const recent = titled.filter((session) => session.updated >= since)
        return recent.length === 1 ? free(recent[0].id) : null
    }
}

function realpath(folder: string): string {
    try {
        return realpathSync(folder)
    } catch {
        return folder
    }
}

function words(args: string): string[] {
    return args.trim().split(/\s+/).filter(Boolean)
}

/** The words after the opencode program — the native `opencode` (Homebrew runs `opencode.exe`), or a script run by node/bun — or null. */
function opencodeArguments(args: string): string[] | null {
    const all = words(args)
    const program = all[0] ? path.basename(all[0]) : ''
    if (program === 'opencode' || program === 'opencode.exe') return all.slice(1)
    if ((program === 'node' || program === 'bun') && all[1] && path.basename(all[1]) === 'opencode') return all.slice(2)
    return null
}

/** An opencode that shows a session in its TUI: not a subcommand (`run`, `serve`, `session list` …). */
export function isInteractiveOpencode(args: string): boolean {
    const rest = opencodeArguments(args)
    if (rest === null) return false
    if (rest.some((word) => NOT_INTERACTIVE.has(word.split('=')[0]) && word.startsWith('-'))) return false
    // the first plain word is a subcommand or the project folder (`opencode ~/work`)
    const first = rest.find((word, index) => !word.startsWith('-') && !VALUE_FLAGS.has(rest[index - 1] ?? '') && !SESSION_FLAGS.has(rest[index - 1] ?? ''))
    return first === undefined || !NOT_INTERACTIVE.has(first)
}

/** The session `--session <id>` / `-s <id>` / `--session=<id>` names, or null. */
export function namedSession(args: string): string | null {
    const rest = opencodeArguments(args) ?? []
    for (let i = 0; i < rest.length; i++) {
        const word = rest[i]
        const value = word === '-s' || word === '--session' ? rest[i + 1] : /^--session=(.+)$/.exec(word)?.[1]
        if (value !== undefined) return OPENCODE_SESSION_ID.test(value) ? value : null
    }
    return null
}

/**
 * The command that started opencode, without the session it named and its first prompt, so `--session <id>`
 * can be added. A command line `ps` cannot hand back word for word (quotes, braces) is reduced to `opencode`;
 * a project folder argument is dropped (the restart runs in the session's folder).
 */
export function resumableCommand(args: string): string {
    const rest = opencodeArguments(args)
    if (rest === null || /["'{}\\$`]/.test(args)) return 'opencode'
    const kept: string[] = ['opencode']
    for (let i = 0; i < rest.length; i++) {
        const word = rest[i]
        if (SESSION_SWITCHES.has(word)) continue
        if (SESSION_FLAGS.has(word)) {
            i++
            continue
        }
        if (/^--(?:session|prompt)=/.test(word)) continue
        if (!word.startsWith('-')) continue
        kept.push(word)
        if (VALUE_FLAGS.has(word) && i + 1 < rest.length) kept.push(rest[++i])
    }
    return kept.join(' ')
}

/**
 * The stored start command, when it is one `resumableCommand` could have made: `opencode` and plain flags.
 * Anything else (it is typed into the shell on restart) falls back to plain `opencode`.
 */
export function opencodeStartCommand(stored: string | undefined): string {
    // single spaces only: `\s` would take a newline, and the shell runs what follows it (agy review 11-25)
    return stored && /^opencode(?: [A-Za-z0-9_.:=/@+,-]+)*$/.test(stored.trim()) ? stored.trim() : 'opencode'
}

function terminalOf(pid: number, parents: Map<number, number>, ptyPids: Map<number, string>): string | null {
    let current = pid
    for (let depth = 1; depth <= MAX_DEPTH; depth++) {
        const parent = parents.get(current)
        if (parent === undefined || parent <= 1) return null
        const terminalId = ptyPids.get(parent)
        if (terminalId) return terminalId
        current = parent
    }
    return null
}

/** `ps etime`: `[[dd-]hh:]mm:ss` → seconds. */
export function etimeSeconds(value: string): number {
    const match = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(value.trim())
    if (!match) return 0
    const [, days, hours, minutes, seconds] = match
    return Number(days ?? 0) * 86_400 + Number(hours ?? 0) * 3_600 + Number(minutes) * 60 + Number(seconds)
}

function readProcesses(): Promise<OpencodeProcess[]> {
    return new Promise((resolve) => {
        execFile('ps', ['-axww', '-o', 'pid=,ppid=,etime=,args='], { maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
            if (error) return resolve([])
            const rows: OpencodeProcess[] = []
            for (const line of stdout.split('\n')) {
                const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line)
                if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), age: etimeSeconds(match[3]), args: match[4] })
            }
            resolve(rows)
        })
    })
}

/** The process's folder (`cwd`) and its open files, from one `lsof`. */
function readOpenFiles(pid: number): Promise<{ cwd: string | null; files: string[] }> {
    return new Promise((resolve) => {
        execFile('lsof', ['-a', '-p', String(pid), '-Ffn'], { maxBuffer: 8 * 1024 * 1024, timeout: LSOF_TIMEOUT_MS }, (_error, stdout) => {
            // lsof exits 1 when some descriptors could not be read: what it printed still counts
            resolve(parseOpenFiles(stdout ?? ''))
        })
    })
}

/** lsof `-Ffn` output: `f<descriptor>` then `n<name>` lines. */
export function parseOpenFiles(output: string): { cwd: string | null; files: string[] } {
    let cwd: string | null = null
    let descriptor = ''
    const files: string[] = []
    for (const line of output.split('\n')) {
        if (line.startsWith('f')) descriptor = line.slice(1)
        else if (line.startsWith('n')) {
            if (descriptor === 'cwd') cwd = line.slice(1)
            else files.push(line.slice(1))
        }
    }
    return { cwd, files }
}
