import { execFile } from 'child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import path from 'path'

/**
 * Keeps each terminal's remembered Claude conversation id in step with the
 * conversation actually running there.
 *
 * The app learns the id once, when it injects `--session-id` at start. Inside
 * Claude the conversation can change after that — `/resume` switches to another
 * one under a new id (measured on 2.1.296: the injected id never got a
 * transcript, the new one did). A restart then resumes nothing: startup drops
 * the id because its transcript does not exist, and a template session runs
 * its start command again as a fresh conversation.
 *
 * Claude Code writes `<config>/sessions/<pid>.json` for every running process,
 * with the conversation it is on. That file is read here; hooks are not
 * required, so it works for users who never installed them.
 */

/** Cheap enough to run often: a directory listing and a stat per file. */
const DEFAULT_INTERVAL_MS = 10_000

/**
 * Claude started from the terminal's shell is its child or grandchild (a
 * wrapper script). Deeper ones are Claude processes started by Claude — a
 * subagent, a tool running `claude` — and are not the session's conversation.
 */
const MAX_DEPTH = 3

interface RegistryEntry {
    pid: number
    sessionId: string
    /** Distinguishes a reused pid from the process the cache saw before. */
    startedAt: number
}

interface Placement {
    terminalId: string
    depth: number
}

export interface ClaudeSessionSyncDeps {
    /** Where Claude Code keeps its state (CLAUDE_CONFIG_DIR or ~/.claude). */
    configDir: () => string
    /** Pid of each terminal's shell → terminal id. */
    ptyPids: () => Map<number, string>
    /** The conversation running in `terminalId` is `sessionId`. Called only on change. */
    onConversation: (terminalId: string, sessionId: string) => void
    intervalMs?: number
}

export class ClaudeSessionSync {
    private timer: NodeJS.Timeout | null = null
    private running = false
    /** file name → mtime of the last read, so unchanged files are not parsed again. */
    private readonly seen = new Map<string, number>()
    private readonly entries = new Map<string, RegistryEntry>()
    /** `${pid}:${startedAt}` → where that process sits, or null when not under any terminal. */
    private readonly placements = new Map<string, Placement | null>()
    /** Last id reported per terminal, so a steady state reports nothing. */
    private readonly reported = new Map<string, string>()

    constructor(private readonly deps: ClaudeSessionSyncDeps) {}

    start(): void {
        if (this.timer) return
        this.timer = setInterval(() => void this.tick(), this.deps.intervalMs ?? DEFAULT_INTERVAL_MS)
        this.timer.unref?.()
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer)
        this.timer = null
    }

    async tick(): Promise<void> {
        if (this.running) return
        this.running = true
        try {
            await this.sync()
        } catch (e) {
            console.warn('[ClaudeSessionSync] sync failed:', e)
        } finally {
            this.running = false
        }
    }

    private async sync(): Promise<void> {
        this.readRegistry()

        const ptyPids = this.deps.ptyPids()
        if (ptyPids.size === 0) return

        const live = [...this.entries.values()].filter((entry) => isAlive(entry.pid))
        const liveKeys = new Set(live.map(placementKey))
        for (const key of [...this.placements.keys()]) {
            if (!liveKeys.has(key)) this.placements.delete(key)
        }
        const unplaced = live.filter((entry) => !this.placements.has(placementKey(entry)))
        if (unplaced.length > 0) {
            // One process table per tick, and only when a new Claude process appeared.
            const parents = await readParents()
            // `ps` failed: try again next tick rather than caching "not ours" for good.
            if (parents.size === 0) return
            for (const entry of unplaced) {
                this.placements.set(placementKey(entry), place(entry.pid, parents, ptyPids))
            }
        }

        const terminals = new Set(ptyPids.values())
        const best = new Map<string, { sessionId: string; depth: number; tied: boolean }>()
        for (const entry of live) {
            const placement = this.placements.get(placementKey(entry))
            if (!placement || !terminals.has(placement.terminalId)) continue
            const current = best.get(placement.terminalId)
            if (!current || placement.depth < current.depth) {
                best.set(placement.terminalId, { sessionId: entry.sessionId, depth: placement.depth, tied: false })
            } else if (placement.depth === current.depth && entry.sessionId !== current.sessionId) {
                current.tied = true
            }
        }

        for (const [terminalId, choice] of best) {
            // Two Claude processes side by side in one shell: no way to tell which is "the" session.
            if (choice.tied) continue
            if (this.reported.get(terminalId) === choice.sessionId) continue
            this.reported.set(terminalId, choice.sessionId)
            this.deps.onConversation(terminalId, choice.sessionId)
        }
    }

    private readRegistry(): void {
        const dir = path.join(this.deps.configDir(), 'sessions')
        if (!existsSync(dir)) return

        const present = new Set<string>()
        for (const name of readdirSync(dir)) {
            if (!/^\d+\.json$/.test(name)) continue
            present.add(name)
            const file = path.join(dir, name)
            let mtime: number
            try {
                mtime = statSync(file).mtimeMs
            } catch {
                continue
            }
            if (this.seen.get(name) === mtime) continue
            this.seen.set(name, mtime)

            const entry = parseEntry(file)
            if (entry) this.entries.set(name, entry)
            else this.entries.delete(name)
        }
        for (const name of [...this.entries.keys()]) {
            if (present.has(name)) continue
            this.entries.delete(name)
            this.seen.delete(name)
        }
    }
}

function parseEntry(file: string): RegistryEntry | null {
    try {
        const raw = JSON.parse(readFileSync(file, 'utf8')) as {
            pid?: unknown
            sessionId?: unknown
            startedAt?: unknown
            kind?: unknown
        }
        // A one-shot `claude -p` run is not a conversation anyone resumes.
        if (raw.kind !== undefined && raw.kind !== 'interactive') return null
        if (typeof raw.pid !== 'number' || typeof raw.sessionId !== 'string' || !raw.sessionId) return null
        return { pid: raw.pid, sessionId: raw.sessionId, startedAt: typeof raw.startedAt === 'number' ? raw.startedAt : 0 }
    } catch {
        // Claude rewrites the file in place; a half-written read is retried at the next change.
        return null
    }
}

function placementKey(entry: RegistryEntry): string {
    return `${entry.pid}:${entry.startedAt}`
}

function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0)
        return true
    } catch (e) {
        // EPERM: alive but someone else's — not ours either way, but not dead.
        return (e as NodeJS.ErrnoException).code === 'EPERM'
    }
}

/** Walks up from `pid` to the first terminal shell, within MAX_DEPTH steps. */
function place(pid: number, parents: Map<number, number>, ptyPids: Map<number, string>): Placement | null {
    let current = pid
    for (let depth = 1; depth <= MAX_DEPTH; depth++) {
        const parent = parents.get(current)
        if (parent === undefined || parent <= 1) return null
        const terminalId = ptyPids.get(parent)
        if (terminalId) return { terminalId, depth }
        current = parent
    }
    return null
}

function readParents(): Promise<Map<number, number>> {
    return new Promise((resolve) => {
        execFile('ps', ['-axo', 'pid=,ppid='], { maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
            const parents = new Map<number, number>()
            if (error) {
                resolve(parents)
                return
            }
            for (const line of stdout.split('\n')) {
                const [pid, ppid] = line.trim().split(/\s+/).map(Number)
                if (pid > 0 && ppid >= 0) parents.set(pid, ppid)
            }
            resolve(parents)
        })
    })
}
