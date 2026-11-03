import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync, statSync } from 'fs'
import { join } from 'path'
import type { ConversationAgent, ConversationTurn } from '../shared/conversation'
import { createClaudeTranscriptParser } from './transcript/claudeTranscript'
import { createCodexTranscriptParser } from './transcript/codexTranscript'
import type { TranscriptParser } from './transcript/records'

/**
 * Reads an agent's own transcript file into chat turns, and keeps reading it
 * from where it stopped.
 *
 * Which file: the session's stored conversation id (`cliSessionId`, kept current
 * by the hook / `ClaudeSessionSync` / `CodexSessionLocator`). Claude writes
 * `<config dir>/projects/<cwd slug>/<id>.jsonl`; Codex writes
 * `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl`, and newer Codex
 * splits one thread over several `…-<id>_<segment>.jsonl` files.
 *
 * Only the bytes added since the last read are parsed: a turn's appends cost
 * what they add, not the file's size. The first read of a very large file
 * (transcripts of 200MB exist on this Mac) starts `MAX_FIRST_READ_BYTES` from
 * its end, so the chat opens in about a second; the turns before are reported
 * as missing (`truncated`), not guessed.
 */

/** How much of a file the first read takes, from its end. */
export const MAX_FIRST_READ_BYTES = 16 * 1024 * 1024
/** One read() call's buffer. */
const CHUNK_BYTES = 1024 * 1024
/** Codex can start a new rollout segment mid-thread: look for new files this often. */
const RELOCATE_MS = 10_000

export interface TranscriptRead {
    /** every turn the parser holds, oldest first */
    turns: ConversationTurn[]
    truncated: boolean
    /** the parser took new bytes (or started over) since the previous read */
    changed: boolean
}

export interface TranscriptReaderDeps {
    claudeConfigDir: () => string
    codexHome: () => string
    /** Tests shrink it; the app uses MAX_FIRST_READ_BYTES. */
    firstReadBytes?: number
}

interface FileCursor {
    path: string
    offset: number
    /** bytes after the last newline: a line still being written */
    carry: Buffer
}

interface ReadState {
    agent: ConversationAgent
    id: string
    files: FileCursor[]
    locatedAt: number
    parser: TranscriptParser
    truncated: boolean
    turns: ConversationTurn[] | null
}

/** Claude's folder name for a project: every character that is not a letter or digit becomes "-". */
export function claudeProjectSlug(cwd: string): string {
    return cwd.replace(/[^A-Za-z0-9]/g, '-')
}

const UUID_LIKE = /^[0-9A-Za-z-]{8,64}$/

export class TranscriptReader {
    private readonly states = new Map<string, ReadState>()
    /** id → files, so a scan of every project folder happens once per conversation */
    private readonly located = new Map<string, string[]>()

    constructor(private readonly deps: TranscriptReaderDeps) {}

    /** The transcript files of a conversation, in order; [] when none is on disk. */
    locate(agent: ConversationAgent, id: string, cwd?: string): string[] {
        if (!UUID_LIKE.test(id)) return []
        const key = `${agent}:${id}`
        const cached = this.located.get(key)
        if (cached && cached.length > 0 && cached.every((file) => existsSync(file))) {
            if (agent === 'claude') return cached
        }
        const files = agent === 'claude' ? this.locateClaude(id, cwd) : this.locateCodex(id)
        if (files.length > 0) this.located.set(key, files)
        return files
    }

    /**
     * The conversation's turns, reading only what was added since the last call
     * for this `key` (a terminal session id). Null when no file is found.
     */
    read(key: string, agent: ConversationAgent, id: string, cwd?: string): TranscriptRead | null {
        let state = this.states.get(key)
        if (!state || state.agent !== agent || state.id !== id) {
            const files = this.locate(agent, id, cwd)
            if (files.length === 0) {
                this.states.delete(key)
                return null
            }
            state = this.freshState(agent, id, files)
            this.states.set(key, state)
        } else if (agent === 'codex' && Date.now() - state.locatedAt > RELOCATE_MS) {
            this.located.delete(`${agent}:${id}`)
            const files = this.locate(agent, id, cwd)
            state.locatedAt = Date.now()
            for (const file of files) {
                if (!state.files.some((cursor) => cursor.path === file)) state.files.push({ path: file, offset: 0, carry: Buffer.alloc(0) })
            }
        }

        let changed = false
        try {
            changed = this.advance(state)
        } catch (error) {
            // The file was replaced or cut (a rewrite, a /clear on another build): start over once.
            const code = (error as NodeJS.ErrnoException).code
            if (code !== 'SHRUNK') throw error
            const files = this.locate(agent, id, cwd)
            if (files.length === 0) {
                this.states.delete(key)
                return null
            }
            state = this.freshState(agent, id, files)
            this.states.set(key, state)
            this.advance(state)
            changed = true
        }
        if (changed || state.turns === null) {
            const tail = state.files.map((cursor) => cursor.carry.toString('utf8')).join('')
            state.turns = state.parser.snapshot(tail)
            changed = true
        }
        return { turns: state.turns, truncated: state.truncated, changed }
    }

    forget(key: string): void {
        this.states.delete(key)
    }

    private freshState(agent: ConversationAgent, id: string, files: string[]): ReadState {
        return {
            agent,
            id,
            files: files.map((path) => ({ path, offset: 0, carry: Buffer.alloc(0) })),
            locatedAt: Date.now(),
            parser: agent === 'claude' ? createClaudeTranscriptParser() : createCodexTranscriptParser(),
            truncated: false,
            turns: null
        }
    }

    /** Feeds every file's new complete lines to the parser. True when anything was fed. */
    private advance(state: ReadState): boolean {
        let fed = false
        const firstRead = state.files.every((cursor) => cursor.offset === 0)
        // On a first read, only the newest MAX_FIRST_READ_BYTES of the whole thread are taken.
        let budget = firstRead ? this.deps.firstReadBytes ?? MAX_FIRST_READ_BYTES : Infinity
        const sizes = state.files.map((cursor) => (existsSync(cursor.path) ? statSync(cursor.path).size : 0))
        if (firstRead) {
            // Spend the budget from the last file backwards.
            const skipTo = new Map<number, number>()
            for (let i = state.files.length - 1; i >= 0; i--) {
                const size = sizes[i]
                if (budget >= size) {
                    budget -= size
                    continue
                }
                skipTo.set(i, size - budget)
                for (let j = i - 1; j >= 0; j--) skipTo.set(j, sizes[j])
                budget = 0
                break
            }
            for (const [index, start] of skipTo) {
                state.files[index].offset = start
                // Mid-line start: the bytes up to the next newline are a cut record.
                state.files[index].carry = Buffer.alloc(0)
                if (start > 0 && start < sizes[index]) this.skipToNextLine(state.files[index])
                state.truncated = true
            }
        }

        for (let i = 0; i < state.files.length; i++) {
            const cursor = state.files[i]
            const size = sizes[i]
            if (size < cursor.offset) {
                const error = new Error('transcript shrank') as NodeJS.ErrnoException
                error.code = 'SHRUNK'
                throw error
            }
            if (size === cursor.offset) continue
            const text = this.readLines(cursor, size)
            if (text.length > 0) {
                state.parser.write(text)
                fed = true
            } else if (cursor.carry.length > 0) {
                // only a partial line arrived: the snapshot's preview shows it
                fed = true
            }
        }
        return fed
    }

    /** Moves the cursor past the next newline. */
    private skipToNextLine(cursor: FileCursor): void {
        const fd = openSync(cursor.path, 'r')
        try {
            const buffer = Buffer.alloc(64 * 1024)
            for (;;) {
                const length = readSync(fd, buffer, 0, buffer.length, cursor.offset)
                if (length <= 0) return
                const newline = buffer.subarray(0, length).indexOf(0x0a)
                if (newline >= 0) {
                    cursor.offset += newline + 1
                    return
                }
                cursor.offset += length
            }
        } finally {
            closeSync(fd)
        }
    }

    /** The complete lines between the cursor and `size`; the unfinished rest stays in `carry`. */
    private readLines(cursor: FileCursor, size: number): string {
        const fd = openSync(cursor.path, 'r')
        const parts: Buffer[] = [cursor.carry]
        try {
            const end = Math.min(size, fstatSync(fd).size)
            while (cursor.offset < end) {
                const buffer = Buffer.alloc(Math.min(CHUNK_BYTES, end - cursor.offset))
                const length = readSync(fd, buffer, 0, buffer.length, cursor.offset)
                if (length <= 0) break
                parts.push(buffer.subarray(0, length))
                cursor.offset += length
            }
        } finally {
            closeSync(fd)
        }
        const all = Buffer.concat(parts)
        // Split on the byte, not the decoded text: a multi-byte character may straddle a read.
        const lastNewline = all.lastIndexOf(0x0a)
        if (lastNewline < 0) {
            cursor.carry = all
            return ''
        }
        cursor.carry = all.subarray(lastNewline + 1)
        return all.subarray(0, lastNewline + 1).toString('utf8')
    }

    private locateClaude(id: string, cwd?: string): string[] {
        const projects = join(this.deps.claudeConfigDir(), 'projects')
        if (cwd) {
            const direct = join(projects, claudeProjectSlug(cwd), `${id}.jsonl`)
            if (existsSync(direct)) return [direct]
        }
        if (!existsSync(projects)) return []
        try {
            for (const dir of readdirSync(projects)) {
                const file = join(projects, dir, `${id}.jsonl`)
                if (existsSync(file)) return [file]
            }
        } catch {
            // an unreadable folder: nothing found
        }
        return []
    }

    private locateCodex(id: string): string[] {
        const sessions = join(this.deps.codexHome(), 'sessions')
        if (!existsSync(sessions)) return []
        const found: string[] = []
        const lower = id.toLowerCase()
        const matches = (name: string): boolean => {
            const file = name.toLowerCase()
            return file.endsWith('.jsonl') && (file.endsWith(`-${lower}.jsonl`) || file.includes(`-${lower}_`))
        }
        try {
            for (const year of readdirSync(sessions)) {
                const yearDir = join(sessions, year)
                if (!statSync(yearDir).isDirectory()) continue
                for (const month of readdirSync(yearDir)) {
                    const monthDir = join(yearDir, month)
                    if (!statSync(monthDir).isDirectory()) continue
                    for (const day of readdirSync(monthDir)) {
                        const dayDir = join(monthDir, day)
                        if (!statSync(dayDir).isDirectory()) continue
                        for (const name of readdirSync(dayDir)) if (matches(name)) found.push(join(dayDir, name))
                    }
                }
            }
        } catch {
            // an unreadable folder: what was found so far
        }
        // `rollout-<time>-…`: the name sorts by start time; segments of one thread follow it.
        return found.sort((a, b) => a.split('/').pop()!.localeCompare(b.split('/').pop()!))
    }
}
