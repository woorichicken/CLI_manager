// ovis's 1.x store builder (server/opencode.test.ts `storeV1`, 175d24c — MIT, Copyright (c) 2026 devswha),
// with node:sqlite for bun:sqlite. Shared by the ported cases (ovis-port/opencode.ts) and T194.
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createRequire } from 'module'
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite'

const { DatabaseSync } = createRequire(__filename)('node:sqlite') as { DatabaseSync: typeof DatabaseSyncType }
export const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-port-'))
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }))

let stores = 0
let ids = 0
export const T0 = Date.parse('2026-10-07T09:00:00Z')
export const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

// OpenCode 1.x's own tables, as its service creates them (columns the reader never touches left out).
const SCHEMA_V1 = `
CREATE TABLE session (
  id text PRIMARY KEY, project_id text NOT NULL, parent_id text, slug text NOT NULL, directory text NOT NULL,
  title text NOT NULL, version text NOT NULL, revert text, model text,
  time_created integer NOT NULL, time_updated integer NOT NULL
);
CREATE TABLE message (
  id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL
);
CREATE INDEX message_session_time_created_id_idx ON message (session_id, time_created, id);
CREATE TABLE part (
  id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL
);
CREATE INDEX part_message_id_id_idx ON part (message_id, id);
CREATE INDEX part_session_idx ON part (session_id);
`

/** ovis `storeV1` */
export function storeV1(session = 'ses_old1', dir = root) {
    const file = path.join(dir, `opencode-v1-${++stores}.db`)
    const db = new DatabaseSync(file)
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = OFF')
    db.exec(SCHEMA_V1)
    db.prepare("INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (?, 'global', 'slug', ?, 'Old', '1.18.32', ?, ?)").run(session, root, T0, T0)
    let clock = T0
    let parts = 0
    const message = (role: string, data: Record<string, unknown>): string => {
        const id = `msg_${(++ids).toString().padStart(6, '0')}V1`
        clock += 1
        db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)').run(id, session, clock, clock, JSON.stringify({ role, time: { created: clock }, ...data }))
        return id
    }
    const part = (messageId: string, data: Record<string, unknown>): void => {
        clock += 1
        db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)').run(`prt_${(++parts).toString().padStart(6, '0')}V1`, messageId, session, clock, clock, JSON.stringify(data))
    }
    const user = (text: string): string => {
        const id = message('user', { agent: 'build', model: { modelID: 'deepseek-v4.1-flash', providerID: 'opencode-go' }, summary: { diffs: [] } })
        part(id, { type: 'text', text })
        return id
    }
    const assistant = (blocks: Record<string, unknown>[], extra: Record<string, unknown> = {}): string => {
        const id = message('assistant', { modelID: 'deepseek-v4.1-flash', providerID: 'opencode-go', ...extra })
        for (const block of blocks) part(id, block)
        return id
    }
    return { path: file, db, session, message, part, user, assistant }
}

