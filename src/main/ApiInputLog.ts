import { createHash } from 'crypto'
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs'
import path from 'path'
import type { ConversationTurn } from '../shared/conversation'

/**
 * What the Control API typed into each session (fb-1128 efa3932b) — so the Chat can tell a message another session
 * sent (`clim send`, `send_input`, an `open_session` prompt) from one the person typed. The agent's own record has no
 * such mark: both are plain user turns. Kept per session, newest last:
 *
 *  - only a hash of the words (normalised), when, and who sent it (the caller session's id and name, the client) —
 *    never the words themselves; the file is 0600 in userData
 *  - at most MAX_PER_SESSION entries a session; a closed session's entries go with it (forget)
 *
 * The person's own paths — Chat send, the phone, the inbox Reply (ControlApiService.typeForChat) — are not recorded.
 */

export interface ApiInputEntry {
    /** the words' hash (inputHash) */
    h: string
    /** when it was typed (ms) */
    at: number
    /** the session that sent it (X-Caller-Session), and its name then */
    from?: string
    fromName?: string
    /** X-Client-Name / the MCP client, `autocron` for a scheduled run */
    client?: string
}

export interface ApiInputOrigin {
    callerId?: string
    callerName?: string
    client?: string
}

interface Saved {
    version: 1
    sessions: Record<string, ApiInputEntry[]>
}

export const MAX_PER_SESSION = 200
/**
 * A message typed while the agent works is written to its record when the agent takes it — minutes later in a long
 * turn. Past this an entry no longer matches: an entry whose words the record changed would otherwise wait forever
 * and take a later message the person typed with the same words.
 */
export const MATCH_WINDOW_MS = 6 * 60 * 60 * 1000
/**
 * The agent records a prompt while it is typed, on this same machine's clock: a little slack only. A wide one lets an
 * entry take the person's identical turn written just before it (review r2 #3: 10 s swapped the labels).
 */
export const CLOCK_SKEW_MS = 2_000
const SAVE_DELAY_MS = 500

/** Spacing and line breaks are not the words: the record keeps a paste's lines, the API may have sent them as one. */
export function normaliseWords(text: string): string {
    return text.replace(/\s+/g, ' ').trim()
}

/**
 * Whether an API typing is a message to remember (review r2 #2): words, submitted with Enter, and taken out of the input
 * box. Not text left in the box (`submitted: false` — the person may change or send it), not `force` (typed into a
 * question or menu, which is no prompt). Either would wait as an entry and take the person's same words later.
 */
export function isApiMessage(input: { text?: string; submit?: boolean; force?: boolean }, submitted: boolean): boolean {
    return Boolean(input.text?.trim()) && input.submit !== false && input.force !== true && submitted
}

export function inputHash(text: string): string {
    return createHash('sha256').update(normaliseWords(text)).digest('hex').slice(0, 32)
}

/**
 * A turn's hash, once. The reader's snapshot is a fresh copy on every read (structuredClone), so the key is the turn's
 * time and its words' length, not the object. Bounded: cleared past TURN_HASH_CACHE_MAX keys.
 */
const TURN_HASH_CACHE_MAX = 20_000
const turnHashes = new Map<string, string | null>()
let hashesComputed = 0
/** How many turn hashes were computed (tests: a turn outside every entry's window is not hashed). */
export function turnHashCount(): number {
    return hashesComputed
}
function turnHash(turn: ConversationTurn, ts: string): string | null {
    const words = turnWords(turn)
    const key = `${ts}\0${words.length}`
    let hash = turnHashes.get(key)
    if (hash === undefined) {
        hashesComputed++
        hash = normaliseWords(words) ? inputHash(words) : null
        if (turnHashes.size >= TURN_HASH_CACHE_MAX) turnHashes.clear()
        turnHashes.set(key, hash)
    }
    return hash
}

/**
 * A paste Claude Code recorded whole: `\n\n<pasted_content id="d93e">\n<the words>\n</pasted_content id="d93e">\n` (measured
 * 2.1.332, a 31-line `clim send`; the id 4 hex, the same on both tags). The parser's unwrapPastes already takes the words
 * out; this is the same rule here, so a record that reaches the matcher wrapped still matches. Only a wrapper around the
 * whole text — words the person typed around a paste are the person's message.
 */
const WHOLE_PASTE = /^\s*<pasted_content id="([0-9a-f]{1,64})">\r?\n([\s\S]*?)\r?\n<\/pasted_content id="\1">\s*$/

/** The person's seat words of a user turn: its text parts (the «stopped» marker is no one's message). */
function turnWords(turn: ConversationTurn): string {
    const words = turn.parts
        .flatMap((part) => (part.kind === 'text' && !/^\[Request interrupted by user(?: for tool use)?\]$/.test(part.text.trim()) ? [part.text] : []))
        .join('\n\n')
    return WHOLE_PASTE.exec(words)?.[2] ?? words
}

/**
 * Marks the user turns the API typed: each entry, in the order sent, takes the first user turn with the same words
 * written after it (within MATCH_WINDOW_MS); a turn takes one entry at most. Unmatched turns are the person's. The
 * turns given are not changed — a marked turn is a copy with `via`.
 */
export function markApiTurns(turns: ConversationTurn[], entries: readonly ApiInputEntry[], nameOf: (sessionId: string) => string | undefined = () => undefined): ConversationTurn[] {
    if (entries.length === 0) return turns
    const pending = [...entries].sort((a, b) => a.at - b.at)
    // the entries of each hash, oldest first: a turn looks only at its own words' entries
    const byHash = new Map<string, number[]>()
    pending.forEach((entry, at) => byHash.set(entry.h, [...(byHash.get(entry.h) ?? []), at]))
    const used = new Set<number>()
    // a turn no entry could take is not hashed at all: before the oldest send, or past the newest send's window
    const earliest = pending[0].at - CLOCK_SKEW_MS
    const latest = pending[pending.length - 1].at + MATCH_WINDOW_MS
    let out: ConversationTurn[] | null = null
    for (let index = 0; index < turns.length; index++) {
        const turn = turns[index]
        if (turn.role !== 'user' || turn.ts === null || used.size === pending.length) continue
        const ts = Date.parse(turn.ts)
        if (!Number.isFinite(ts) || ts < earliest || ts > latest) continue
        const hash = turnHash(turn, turn.ts)
        if (hash === null) continue
        const match = byHash.get(hash)?.find((at) => !used.has(at) && pending[at].at <= ts + CLOCK_SKEW_MS && ts - pending[at].at <= MATCH_WINDOW_MS)
        if (match === undefined) continue
        used.add(match)
        const entry = pending[match]
        const from = (entry.from && nameOf(entry.from)) || entry.fromName
        out ??= turns.slice()
        out[index] = { ...turn, via: { kind: 'api', ...(from ? { from } : {}), ...(entry.client ? { client: entry.client } : {}) } }
    }
    return out ?? turns
}

export class ApiInputLog {
    private readonly sessions = new Map<string, ApiInputEntry[]>()
    private saveTimer: NodeJS.Timeout | null = null

    /** `file`: where the entries are kept across restarts; null keeps them in memory (tests). */
    constructor(private readonly file: string | null, private readonly now: () => number = Date.now) {
        if (!file) return
        try {
            const saved = JSON.parse(readFileSync(file, 'utf8')) as Saved
            if (saved?.version !== 1 || typeof saved.sessions !== 'object' || saved.sessions === null) return
            for (const [sessionId, list] of Object.entries(saved.sessions)) {
                if (!Array.isArray(list)) continue
                // every field checked: a hand-edited value would reach the Chat's label (an object there breaks the view)
                const optionalText = (value: unknown): boolean => value === undefined || typeof value === 'string'
                const entries = list.filter((entry): entry is ApiInputEntry =>
                    typeof entry?.h === 'string' && typeof entry?.at === 'number' && Number.isFinite(entry.at) &&
                    optionalText(entry.from) && optionalText(entry.fromName) && optionalText(entry.client)).slice(-MAX_PER_SESSION)
                if (entries.length > 0) this.sessions.set(sessionId, entries)
            }
        } catch {
            // no file yet, or one that cannot be read: start empty
        }
    }

    /** The API typed `text` into a session (and pressed Enter), starting at `at`. Empty words are no message. */
    note(sessionId: string, text: string, origin: ApiInputOrigin = {}, at: number = this.now()): void {
        if (!normaliseWords(text)) return
        const entry: ApiInputEntry = {
            h: inputHash(text),
            at,
            ...(origin.callerId && origin.callerId !== sessionId ? { from: origin.callerId } : {}),
            ...(origin.callerName && origin.callerId !== sessionId ? { fromName: origin.callerName.slice(0, 120) } : {}),
            ...(origin.client ? { client: origin.client.slice(0, 60) } : {})
        }
        const list = this.sessions.get(sessionId) ?? []
        list.push(entry)
        if (list.length > MAX_PER_SESSION) list.splice(0, list.length - MAX_PER_SESSION)
        this.sessions.set(sessionId, list)
        this.scheduleSave()
    }

    entries(sessionId: string): readonly ApiInputEntry[] {
        return this.sessions.get(sessionId) ?? []
    }

    /** The session's turns with the API's marked (markApiTurns); the same array when it has no entries. */
    mark(sessionId: string, turns: ConversationTurn[], nameOf?: (sessionId: string) => string | undefined): ConversationTurn[] {
        return markApiTurns(turns, this.entries(sessionId), nameOf)
    }

    /** The session is gone for good. */
    forget(sessionId: string): void {
        if (this.sessions.delete(sessionId)) this.scheduleSave()
    }

    /** Keep only these sessions (app start: sessions closed while the app was not running). */
    prune(liveIds: Iterable<string>): void {
        const live = new Set(liveIds)
        let changed = false
        for (const id of [...this.sessions.keys()]) {
            if (!live.has(id)) {
                this.sessions.delete(id)
                changed = true
            }
        }
        if (changed) this.scheduleSave()
    }

    /** Writes now (app quit); a pending timer is dropped. */
    flush(): void {
        if (this.saveTimer) clearTimeout(this.saveTimer)
        this.saveTimer = null
        if (!this.file) return
        const saved: Saved = { version: 1, sessions: Object.fromEntries(this.sessions) }
        try {
            mkdirSync(path.dirname(this.file), { recursive: true })
            // a crash mid-write leaves the old file whole: write beside it, then swap
            const temp = `${this.file}.tmp`
            writeFileSync(temp, JSON.stringify(saved), { mode: 0o600 })
            renameSync(temp, this.file)
        } catch (error) {
            console.error('[api-inputs] save failed', error)
        }
    }

    private scheduleSave(): void {
        if (!this.file || this.saveTimer) return
        this.saveTimer = setTimeout(() => this.flush(), SAVE_DELAY_MS)
        this.saveTimer.unref?.()
    }
}
