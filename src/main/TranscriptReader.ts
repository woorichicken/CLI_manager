import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync, statSync } from 'fs'
import { open as openFile } from 'fs/promises'
import { join } from 'path'
import type { ConversationAgent, ConversationMeta, ConversationTurn } from '../shared/conversation'
import { CLAUDE_IMAGE_REF } from './transcript/claudeTranscript'
import { inlineImageType } from './transcript/images'
import { foldMetadata } from './transcript/metadata'
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
    /** model · effort · context as the records read so far name them */
    meta: ConversationMeta | null
}

/** Chunk of a backward search for one record (`findRecord`). */
const FIND_CHUNK_BYTES = 4 * 1024 * 1024
/** A record longer than this is not looked for (a line that long would be a corrupt file). */
const MAX_RECORD_BYTES = 64 * 1024 * 1024
/** Whole tool output handed back at most (the rest is in the file). */
const MAX_TOOL_OUTPUT_CHARS = 2_000_000

export interface TranscriptReaderDeps {
    claudeConfigDir: () => string
    codexHome: () => string
    /** Tests shrink it; the app uses MAX_FIRST_READ_BYTES. */
    firstReadBytes?: number
    /** Tests shrink it so a record straddles chunks; the app uses FIND_CHUNK_BYTES. */
    findChunkBytes?: number
}

interface FileCursor {
    path: string
    offset: number
    /** bytes after the last newline: a line still being written */
    carry: Buffer
    /**
     * What was read last, to tell an append from a replacement: the file's inode and modification
     * time, and the bytes just before `offset`. A file replaced by one of the same length (or
     * rewritten in place, longer) passes a size check alone (F12).
     */
    ino?: number
    mtimeMs?: number
    mark?: Buffer
}

/** Bytes before the read position compared on the next read (`FileCursor.mark`). */
const MARK_BYTES = 64

interface ReadState {
    agent: ConversationAgent
    id: string
    files: FileCursor[]
    locatedAt: number
    parser: TranscriptParser
    truncated: boolean
    turns: ConversationTurn[] | null
    meta: ConversationMeta | null
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
        return { turns: state.turns, truncated: state.truncated, changed, meta: state.meta }
    }

    /**
     * A picture the transcript holds inline, by the ref the parser gave it (`<entry uuid>:<block>`
     * for a prompt's picture, `<entry uuid>:<block>:<part>` for one a tool returned), as a data: URL.
     * Claude only: the Codex reader names no pictures it can read back. Null when not found.
     */
    async image(key: string, ref: string): Promise<string | null> {
        const state = this.states.get(key)
        const match = CLAUDE_IMAGE_REF.exec(ref)
        if (!state || state.agent !== 'claude' || !match) return null
        const [, uuid, first, second] = match
        const entry = await this.findRecord(state.files.map((cursor) => cursor.path), `"${uuid}"`, (value) => value.uuid === uuid)
        const content = asRecord(entry?.message).content
        if (!Array.isArray(content)) return null
        let block: unknown = content[Number(first)]
        if (second !== undefined) {
            const inner = asRecord(block).content
            block = Array.isArray(inner) ? inner[Number(second)] : undefined
        }
        const source = asRecord(asRecord(block).source)
        const type = inlineImageType(source.media_type, source.data)
        return type && typeof source.data === 'string' ? `data:${type};base64,${source.data}` : null
    }

    /**
     * The whole output of a tool call the chat cut (`output_ref`: Claude's `tool_use_id`, Codex's
     * `call_id`). Null when not found.
     */
    async toolOutput(key: string, ref: string): Promise<string | null> {
        const state = this.states.get(key)
        if (!state || !/^[\w.:-]{1,200}$/.test(ref)) return null
        const files = state.files.map((cursor) => cursor.path)
        let text: string | null = null
        if (state.agent === 'claude') {
            const entry = await this.findRecord(files, `"${ref}"`, (value) => {
                const content = asRecord(value.message).content
                return Array.isArray(content) && content.some((block) => asRecord(block).tool_use_id === ref)
            })
            const content = asRecord(entry?.message).content
            const block = Array.isArray(content) ? content.find((item) => asRecord(item).tool_use_id === ref) : undefined
            text = resultText(asRecord(block).content)
        } else {
            const entry = await this.findRecord(files, `"${ref}"`, (value) => {
                const payload = asRecord(value.payload)
                return payload.call_id === ref && typeof payload.type === 'string' && payload.type.endsWith('_output')
            })
            const output = asRecord(entry?.payload).output
            text = typeof output === 'string' ? output : resultText(asRecord(output).content ?? output)
        }
        if (text === null) return null
        return text.length > MAX_TOOL_OUTPUT_CHARS ? `${text.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n… (${text.length.toLocaleString()} characters in all)` : text
    }

    /**
     * The newest record holding `needle` (a quoted id — written with or without a space after the
     * key's colon) that `accept` takes, searched from the end of the last
     * file backwards (the chat asks for recent things). Reads in 4MB chunks off the main thread's
     * event loop; a 200MB transcript is about a second when the record is at its start.
     */
    private async findRecord(files: string[], needle: string, accept: (value: Record<string, unknown>) => boolean): Promise<Record<string, unknown> | null> {
        const wanted = Buffer.from(needle)
        for (let fileIndex = files.length - 1; fileIndex >= 0; fileIndex--) {
            let handle
            try {
                handle = await openFile(files[fileIndex], 'r')
            } catch {
                continue
            }
            try {
                let position = (await handle.stat()).size
                // bytes of a line that started before the chunk now read
                let tail = Buffer.alloc(0)
                while (position > 0) {
                    const start = Math.max(0, position - (this.deps.findChunkBytes ?? FIND_CHUNK_BYTES))
                    const chunk = Buffer.alloc(position - start)
                    await handle.read(chunk, 0, chunk.length, start)
                    position = start
                    const data = tail.length > 0 ? Buffer.concat([chunk, tail]) : chunk
                    let complete = data
                    if (start > 0) {
                        const newline = data.indexOf(0x0a)
                        if (newline < 0) {
                            if (data.length > MAX_RECORD_BYTES) return null
                            tail = data
                            continue
                        }
                        complete = data.subarray(newline + 1)
                        tail = data.subarray(0, newline + 1)
                    } else {
                        tail = Buffer.alloc(0)
                    }
                    // newest line first
                    let end = complete.length
                    while (end > 0) {
                        const lineStart = complete.lastIndexOf(0x0a, end - 1)
                        const line = complete.subarray(lineStart + 1, end)
                        end = lineStart < 0 ? 0 : lineStart
                        if (line.indexOf(wanted) < 0) continue
                        try {
                            const value = asRecord(JSON.parse(line.toString('utf8')))
                            if (accept(value)) return value
                        } catch {
                            // a cut or corrupt line: keep looking
                        }
                    }
                }
            } finally {
                await handle.close()
            }
        }
        return null
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
            turns: null,
            meta: null
        }
    }

    /** Feeds every file's new complete lines to the parser. True when anything was fed. */
    private advance(state: ReadState): boolean {
        let fed = false
        const firstRead = state.files.every((cursor) => cursor.offset === 0)
        // On a first read, only the newest MAX_FIRST_READ_BYTES of the whole thread are taken.
        let budget = firstRead ? this.deps.firstReadBytes ?? MAX_FIRST_READ_BYTES : Infinity
        const stats = state.files.map((cursor) => (existsSync(cursor.path) ? statSync(cursor.path) : null))
        const sizes = stats.map((stat) => stat?.size ?? 0)
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
            const stat = stats[i]
            if (size < cursor.offset || (stat && cursor.offset > 0 && this.replaced(cursor, stat))) {
                const error = new Error('transcript shrank or was replaced') as NodeJS.ErrnoException
                error.code = 'SHRUNK'
                throw error
            }
            if (stat) {
                cursor.ino = stat.ino
                cursor.mtimeMs = stat.mtimeMs
            }
            if (size === cursor.offset) continue
            const text = this.readLines(cursor, size)
            this.keepMark(cursor)
            if (text.length > 0) {
                state.parser.write(text)
                state.meta = foldMetadata(text, state.agent, state.meta)
                fed = true
            } else if (cursor.carry.length > 0) {
                // only a partial line arrived: the snapshot's preview shows it
                fed = true
            }
        }
        return fed
    }

    /**
     * The file at the cursor's path is not the one read so far: another inode, or — changed since —
     * the bytes before the read position differ (rewritten in place).
     */
    private replaced(cursor: FileCursor, stat: { ino: number; mtimeMs: number }): boolean {
        if (cursor.ino !== undefined && stat.ino !== cursor.ino) return true
        if (cursor.mtimeMs === stat.mtimeMs || !cursor.mark || cursor.mark.length === 0) return false
        const now = Buffer.alloc(cursor.mark.length)
        const fd = openSync(cursor.path, 'r')
        try {
            const length = readSync(fd, now, 0, now.length, cursor.offset - cursor.mark.length)
            return length !== now.length || !now.equals(cursor.mark)
        } finally {
            closeSync(fd)
        }
    }

    /** Keeps the bytes before the cursor, for `replaced`. */
    private keepMark(cursor: FileCursor): void {
        const length = Math.min(MARK_BYTES, cursor.offset)
        const mark = Buffer.alloc(length)
        if (length === 0) {
            cursor.mark = mark
            return
        }
        const fd = openSync(cursor.path, 'r')
        try {
            const read = readSync(fd, mark, 0, length, cursor.offset - length)
            cursor.mark = mark.subarray(0, read)
        } finally {
            closeSync(fd)
        }
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

const asRecord = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

/** A tool result's words: a string, or the text blocks of a content list. */
function resultText(content: unknown): string | null {
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) return null
    return content.map((block) => (typeof asRecord(block).text === 'string' ? (asRecord(block).text as string) : '')).join('')
}
