// After ovis (https://github.com/devswha/ovis, 175d24c) — MIT, Copyright (c) 2026 devswha. Modified.
// Source: server/opencode.ts (withStore, storeFlavor, loadSession1, sessionView1, MAX_V1_ROWS,
// opencodeSessionsTitled, the 1.x tool-output and image lookups). bun:sqlite → Node's built-in node:sqlite.
//
// Reads OpenCode 1.x's store read-only, one session at a time. The file holds every conversation of every
// project on this Mac: nothing here lists or returns another session's rows, except the ids `sessionsIn`
// names for binding a terminal to its session.
import { existsSync } from 'fs'
import { createRequire } from 'module'
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite'
import { OPENCODE_IMAGE_REF, OPENCODE_SESSION_ID, OPENCODE_TOOL_REF, opencodeImages, opencodeTerminalTitle, opencodeTitleStart, opencodeToolText, type OpencodeMessage } from './opencodeTranscript'

type Row = Record<string, unknown>

/** A session larger than this is left to the terminal rather than read whole on the main thread (ovis MAX_V1_ROWS). */
export const MAX_SESSION_ROWS = 10_000
/** …or larger than this in bytes (ovis: four 16MB windows). The largest session on this Mac: 4.1MB, read in 100ms. */
export const MAX_SESSION_BYTES = 64 * 1024 * 1024
/** OpenCode writes while the chat reads (WAL): wait this long for a lock, then try on the next poll. */
const BUSY_TIMEOUT_MS = 250

export type SessionRead =
    | { kind: 'session'; messages: OpencodeMessage[]; end: number; signature: string }
    | { kind: 'unchanged'; signature: string }
    | { kind: 'missing' }
    | { kind: 'too_large' }

/**
 * node:sqlite, loaded when first needed: Node prints an ExperimentalWarning on load, and an app that never
 * reads an OpenCode store should not pay for it (Electron 39's Node 22 has it; measured 2026-11-27).
 */
let sqlite: { DatabaseSync: typeof DatabaseSyncType } | null = null
function database(path: string): DatabaseSyncType {
    sqlite ??= createRequire(__filename)('node:sqlite') as { DatabaseSync: typeof DatabaseSyncType }
    const db = new sqlite.DatabaseSync(path, { readOnly: true })
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`)
    return db
}

/** Runs `use` on the store at `path`, read-only; null when there is no store or it has no 1.x tables. */
export function withStore<T>(path: string | null, use: (db: DatabaseSyncType) => T): T | null {
    // opening a path that is not there would create it
    if (path === null || !existsSync(path)) return null
    const db = database(path)
    try {
        // 2.x moved conversations to `session_v2`: that store is not read here, the chat keeps the terminal
        const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('session', 'message', 'part', 'session_v2')").all() as { name: string }[]).map((row) => row.name))
        if (tables.has('session_v2') || !tables.has('session') || !tables.has('message') || !tables.has('part')) return null
        return use(db)
    } finally {
        db.close()
    }
}

function parse(data: unknown): Row {
    if (typeof data !== 'string') return {}
    try {
        const value = JSON.parse(data)
        return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : {}
    } catch {
        return {}
    }
}

/**
 * How many of the session's messages a /undo left (`session.revert` names the first one it took back) and
 * a signature that changes whenever any of its rows does (a step rewritten in place moves `time_updated`).
 */
function view(db: DatabaseSyncType, sessionId: string): { end: number; rows: number; signature: string } | null {
    const session = db.prepare('SELECT revert FROM session WHERE id = ?').get(sessionId) as { revert: string | null } | undefined
    if (!session) return null
    const stats = db
        .prepare('SELECT (SELECT count(*) FROM message WHERE session_id = ?) AS messages, (SELECT max(time_updated) FROM message WHERE session_id = ?) AS updated, (SELECT count(*) FROM part WHERE session_id = ?) AS parts, (SELECT max(time_updated) FROM part WHERE session_id = ?) AS partUpdated')
        .get(sessionId, sessionId, sessionId, sessionId) as { messages: number; updated: number | null; parts: number; partUpdated: number | null }
    let end = stats.messages
    const boundary = parse(session.revert).messageID
    if (typeof boundary === 'string') {
        const row = db.prepare('SELECT time_created FROM message WHERE id = ? AND session_id = ?').get(boundary, sessionId) as { time_created: number } | undefined
        if (row) {
            end = (db.prepare('SELECT count(*) AS n FROM message WHERE session_id = ? AND (time_created < ? OR (time_created = ? AND id < ?))').get(sessionId, row.time_created, row.time_created, boundary) as { n: number }).n
        }
    }
    return { end, rows: stats.messages + stats.parts, signature: `${end}:${stats.messages}:${stats.updated}:${stats.parts}:${stats.partUpdated}` }
}

/** The session's messages with their parts, in OpenCode's own order: (time_created, id) — ids do not sort by time. */
function load(db: DatabaseSyncType, sessionId: string): OpencodeMessage[] {
    const rows = db.prepare('SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created, id').all(sessionId) as { id: string; data: string }[]
    const parts = new Map<string, Row[]>()
    for (const part of db.prepare('SELECT message_id, data FROM part WHERE session_id = ? ORDER BY time_created, id').all(sessionId) as { message_id: string; data: string }[]) {
        const list = parts.get(part.message_id) ?? []
        list.push(parse(part.data))
        parts.set(part.message_id, list)
    }
    return rows.map((row) => ({ id: row.id, data: parse(row.data), parts: parts.get(row.id) ?? [] }))
}

/**
 * The session, read whole — or `unchanged` when its signature is `known`. `missing`: no store, no 1.x store,
 * or no such session. `too_large`: past MAX_SESSION_ROWS / MAX_SESSION_BYTES.
 */
export function readSession(path: string | null, sessionId: string, known?: string): SessionRead {
    if (!OPENCODE_SESSION_ID.test(sessionId)) return { kind: 'missing' }
    const read = withStore(path, (db): SessionRead => {
        const shape = view(db, sessionId)
        if (shape === null) return { kind: 'missing' }
        if (shape.signature === known) return { kind: 'unchanged', signature: shape.signature }
        if (shape.rows > MAX_SESSION_ROWS) return { kind: 'too_large' }
        const bytes = db
            .prepare('SELECT (SELECT coalesce(sum(length(data)), 0) FROM message WHERE session_id = ?) + (SELECT coalesce(sum(length(data)), 0) FROM part WHERE session_id = ?) AS n')
            .get(sessionId, sessionId) as { n: number }
        if (bytes.n > MAX_SESSION_BYTES) return { kind: 'too_large' }
        return { kind: 'session', messages: load(db, sessionId), end: shape.end, signature: shape.signature }
    })
    return read ?? { kind: 'missing' }
}

/** A message of the session not taken back by a /undo, with its parts; null otherwise. */
function liveMessage(db: DatabaseSyncType, sessionId: string, messageId: string): OpencodeMessage | null {
    const shape = view(db, sessionId)
    if (shape === null) return null
    const row = db.prepare('SELECT id, data, time_created FROM message WHERE id = ? AND session_id = ?').get(messageId, sessionId) as { id: string; data: string; time_created: number } | undefined
    if (!row) return null
    const before = (db.prepare('SELECT count(*) AS n FROM message WHERE session_id = ? AND (time_created < ? OR (time_created = ? AND id < ?))').get(sessionId, row.time_created, row.time_created, row.id) as { n: number }).n
    if (before >= shape.end) return null
    const parts = (db.prepare('SELECT data FROM part WHERE message_id = ? AND session_id = ? ORDER BY time_created, id').all(messageId, sessionId) as { data: string }[]).map((part) => parse(part.data))
    return { id: row.id, data: parse(row.data), parts }
}

/** The whole output of a tool block the chat cut (`<message id>:<block>`), from this session only. */
export function toolOutput(path: string | null, sessionId: string, ref: string): string | null {
    const match = OPENCODE_TOOL_REF.exec(ref)
    if (!match || !OPENCODE_SESSION_ID.test(sessionId)) return null
    return withStore(path, (db) => {
        const message = liveMessage(db, sessionId, match[1])
        const block = message?.parts[Number(match[2])]
        return block && block.type === 'tool' ? opencodeToolText(block) : null
    })
}

/** A picture of the session by its ref (`opencode:<message id>:<n>`), from this session only. */
export function image(path: string | null, sessionId: string, ref: string): { mediaType: string; data: string } | null {
    const match = OPENCODE_IMAGE_REF.exec(ref)
    if (!match || !OPENCODE_SESSION_ID.test(sessionId)) return null
    return withStore(path, (db) => {
        const message = liveMessage(db, sessionId, match[1])
        const found = message ? opencodeImages(message)[Number(match[2])] : undefined
        return found ? { mediaType: found.media_type, data: found.data } : null
    })
}

/** Whether the store holds this session. */
export function hasSession(path: string | null, sessionId: string): boolean {
    if (!OPENCODE_SESSION_ID.test(sessionId)) return false
    return withStore(path, (db) => db.prepare('SELECT 1 FROM session WHERE id = ?').get(sessionId) !== undefined) ?? false
}

/** Every session whose terminal title OpenCode would make `terminalTitle` (a cut title stands for several). */
export function sessionsTitled(path: string | null, terminalTitle: string): string[] {
    const start = opencodeTitleStart(terminalTitle)
    if (start === null) return []
    return (
        withStore(path, (db) =>
            (db.prepare('SELECT id, title FROM session WHERE substr(title, 1, length(?)) = ?').all(start, start) as { id: string; title: unknown }[]).flatMap((row) =>
                typeof row.title === 'string' && opencodeTerminalTitle(row.title) === terminalTitle ? [row.id] : []
            )
        ) ?? []
    )
}

/** A top-level session a terminal's OpenCode may show: in its folder, used since `since`. */
export interface SessionCandidate {
    id: string
    title: string
    updated: number
}

/**
 * Top-level sessions in one of `folders` among `ids`, newest first, with when each was last used (ms).
 * Subagent sessions (`parent_id`) are never a terminal's.
 */
export function sessionsIn(path: string | null, folders: readonly string[], ids: readonly string[]): SessionCandidate[] {
    if (folders.length === 0 || ids.length === 0) return []
    const inFolders = folders.map(() => '?').join(', ')
    const inIds = ids.map(() => '?').join(', ')
    return (
        withStore(path, (db) =>
            (db.prepare(`SELECT id, title, time_updated FROM session WHERE parent_id IS NULL AND directory IN (${inFolders}) AND id IN (${inIds}) ORDER BY time_updated DESC`).all(...folders, ...ids) as { id: string; title: unknown; time_updated: number }[]).map((row) => ({
                id: row.id,
                title: typeof row.title === 'string' ? row.title : '',
                updated: row.time_updated
            }))
        ) ?? []
    )
}
