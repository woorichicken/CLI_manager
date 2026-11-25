import { execFile } from 'child_process'
import { realpathSync, statSync } from 'fs'
import path from 'path'

/**
 * Finds the Antigravity CLI (`agy`) conversation each terminal runs, so the chat can read it and a
 * restart can resume it (`agy --conversation <id>`).
 *
 * agy picks its own conversation id, writes it nowhere a terminal can see, and holds one lock file
 * for the conversation it shows: `<data dir>/presence/<id>.lock` (agy 1.5.16, measured 2026-11-25
 * with lsof — exactly one per process; the folder also keeps stale locks of finished processes, so a
 * listing proves nothing). The id is read from the locks the agy process itself holds open.
 *
 * Cost: a stat of the presence folder per tick. The process table and lsof run only when that
 * folder changed (a new conversation makes its lock) or, at most, every FULL_SCAN_MS — `/resume`
 * inside agy can reuse an old lock file without touching the folder. No agy data folder: nothing runs.
 */

export interface AgyProcess {
    pid: number
    ppid: number
    /** the command line as `ps` prints it (`args`) */
    args: string
}

export interface AgySessionSyncDeps {
    /** agy's data folder (`~/.gemini/antigravity-cli`) */
    dataDir: () => string
    /** pty shell pid → terminal id */
    ptyPids: () => Map<number, string>
    /** A terminal's agy shows another conversation than last reported. `command` starts it again, resumed. */
    onConversation: (terminalId: string, conversationId: string, command: string) => void
    intervalMs?: number
    fullScanMs?: number
    /** the process table; `ps` by default */
    processes?: () => Promise<AgyProcess[]>
    /** files a process holds open; `lsof` by default */
    openFiles?: (pid: number) => Promise<string[]>
}

const DEFAULT_INTERVAL_MS = 5_000
const DEFAULT_FULL_SCAN_MS = 30_000
/** An agy run deeper under the shell than this is not the terminal's agent (a tool it started, say). */
const MAX_DEPTH = 4
const LOCK = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.lock$/i
/** agy subcommands and one-shot flags: no conversation of their own on screen. */
const NOT_INTERACTIVE = new Set(['acp', 'agent', 'agents', 'changelog', 'help', 'install', 'mcp', 'mic-serve', 'models', 'plugin', 'plugins', 'remote-control', 'update', '-p', '--print', '--prompt', '-h', '--help', '--version', '-v'])

/** agy 1.5.16 options that take a value (`agy --help`), so the value is kept with its option. */
const VALUE_FLAGS = new Set(['--add-dir', '--agent', '--effort', '--input-format', '--json-schema', '--log-file', '--mode', '--model', '--output-format', '--print-timeout', '--project', '--settings'])

export class AgySessionSync {
    private timer: NodeJS.Timeout | null = null
    private running = false
    private folderMark: string | null = null
    private scannedAt = 0
    private readonly reported = new Map<string, string>()

    constructor(private readonly deps: AgySessionSyncDeps) {}

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
            console.warn('[AgySessionSync] sync failed:', error)
        } finally {
            this.running = false
        }
    }

    private async sync(now: number): Promise<void> {
        const presence = path.join(this.deps.dataDir(), 'presence')
        let mark: string
        // lsof prints resolved paths: a data folder under a symlink (/var → /private/var, a linked ~/.gemini)
        let folders: string[]
        try {
            const stat = statSync(presence)
            mark = `${stat.ino}:${stat.mtimeMs}`
            folders = [presence, realpathSync(presence)]
        } catch {
            return // agy never ran here
        }
        const ptyPids = this.deps.ptyPids()
        if (ptyPids.size === 0) return
        if (mark === this.folderMark && now - this.scannedAt < (this.deps.fullScanMs ?? DEFAULT_FULL_SCAN_MS)) return
        const rows = await (this.deps.processes ?? readProcesses)()
        if (rows.length === 0) return // ps failed: next tick tries again
        this.folderMark = mark
        this.scannedAt = now
        const parents = new Map(rows.map((row) => [row.pid, row.ppid]))
        for (const row of rows) {
            if (!isInteractiveAgy(row.args)) continue
            const terminalId = terminalOf(row.pid, parents, ptyPids)
            if (!terminalId) continue
            const id = lockedConversation(await (this.deps.openFiles ?? readOpenFiles)(row.pid), folders)
            if (!id || this.reported.get(terminalId) === id) continue
            this.reported.set(terminalId, id)
            this.deps.onConversation(terminalId, id, resumableCommand(row.args))
        }
    }
}

/** The one conversation lock among a process's open files, or null (none, or more than one). */
export function lockedConversation(files: readonly string[], presence: string | readonly string[]): string | null {
    const folders = typeof presence === 'string' ? [presence] : presence
    const ids = new Set<string>()
    for (const file of files) {
        if (!folders.includes(path.dirname(file))) continue
        const match = LOCK.exec(path.basename(file))
        if (match) ids.add(match[1].toLowerCase())
    }
    return ids.size === 1 ? [...ids][0] : null
}

function words(args: string): string[] {
    return args.trim().split(/\s+/).filter(Boolean)
}

/** An agy that holds a conversation on screen: not a subcommand, not a one-shot print. */
export function isInteractiveAgy(args: string): boolean {
    const rest = agyArguments(args)
    return rest !== null && !rest.some((word) => NOT_INTERACTIVE.has(word.split('=')[0]))
}

/** The words after the agy program — a native `agy`, or an `agy` script run by node/bun — or null. */
function agyArguments(args: string): string[] | null {
    const all = words(args)
    const program = all[0] ? path.basename(all[0]) : ''
    if (program === 'agy') return all.slice(1)
    if ((program === 'node' || program === 'bun') && all[1] && path.basename(all[1]) === 'agy') return all.slice(2)
    return null
}

/**
 * The command that started agy, without the conversation it named, so `--conversation <id>` can be
 * added: `--conversation X` · `--conversation=X` · `-r X` · `--resume X` · `-c` · `--continue` go. A
 * command line `ps` cannot hand back word for word (quotes, braces) is reduced to plain `agy`.
 */
export function resumableCommand(args: string): string {
    const rest = agyArguments(args)
    if (rest === null || /["'{}\\$`]/.test(args)) return 'agy'
    const kept: string[] = ['agy']
    for (let i = 0; i < rest.length; i++) {
        const word = rest[i]
        if (word === '-c' || word === '--continue') continue
        if (word === '--conversation' || word === '-r' || word === '--resume') {
            i++
            continue
        }
        if (/^--(?:conversation|resume)=/.test(word)) continue
        // a bare word is no option: a first prompt (`agy fix the bug`) would be sent again on every restart
        if (!word.startsWith('-')) continue
        kept.push(word)
        if (VALUE_FLAGS.has(word) && i + 1 < rest.length) kept.push(rest[++i])
    }
    return kept.join(' ')
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

function readProcesses(): Promise<AgyProcess[]> {
    return new Promise((resolve) => {
        execFile('ps', ['-axww', '-o', 'pid=,ppid=,args='], { maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
            if (error) return resolve([])
            const rows: AgyProcess[] = []
            for (const line of stdout.split('\n')) {
                const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
                if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), args: match[3] })
            }
            resolve(rows)
        })
    })
}

function readOpenFiles(pid: number): Promise<string[]> {
    return new Promise((resolve) => {
        execFile('lsof', ['-a', '-p', String(pid), '-Fn'], { maxBuffer: 8 * 1024 * 1024 }, (_error, stdout) => {
            // lsof exits 1 when some descriptors could not be read: what it printed still counts
            resolve((stdout ?? '').split('\n').filter((line) => line.startsWith('n')).map((line) => line.slice(1)))
        })
    })
}

/**
 * The stored start command, when it is one `resumableCommand` could have made: `agy` and plain flags.
 * Anything else (it is typed into the shell on restart) falls back to plain `agy`.
 */
export function agyStartCommand(stored: string | undefined): string {
    // single spaces only: `\s` would take a newline, and the shell runs what follows it (review 11-25)
    return stored && /^agy(?: [A-Za-z0-9_.:=/@+,-]+)*$/.test(stored.trim()) ? stored.trim() : 'agy'
}
