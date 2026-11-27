import { test, expect } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite'
import { opencodeMeta, opencodeTurns } from '../../src/main/transcript/opencodeTranscript'
import { readSession, sessionsIn } from '../../src/main/transcript/opencodeStore'
import { TranscriptReader } from '../../src/main/TranscriptReader'
import { etimeSeconds, isInteractiveOpencode, namedSession, OpencodeSessionSync, opencodeStartCommand, parseOpenFiles, resumableCommand, type OpencodeProcess } from '../../src/main/OpencodeSessionSync'
import { storeV1 } from './ovis-port/opencodeStoreV1'

/**
 * T194 — OpenCode conversations and sessions, without Electron.
 *
 * `opencode-1.18.15-session.json` is a real opencode 1.18.15 store's rows (recorded 2026-11-27 in a scratch
 * data folder, the folder renamed): a prompt answered with a bash call, a question answered, a long prompt
 * interrupted with Esc. The synthetic and compaction cases are this Mac's 1.18.15 row shapes, rebuilt with
 * neutral words (54 synthetic text parts, all in user messages; 18 summary steps and 12 compaction parts).
 */

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-t194-'))
test.afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

/** The recorded rows in a fresh store with OpenCode's 1.x tables. */
function recordedStore(): { file: string; db: DatabaseSyncType; session: string; directory: string } {
    const rows = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'opencode', 'opencode-1.18.15-session.json'), 'utf8'))
    const s = storeV1('ses_unused', fs.mkdtempSync(path.join(root, 'rec-')))
    s.db.exec("DELETE FROM session")
    for (const row of rows.session) {
        s.db.prepare('INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, revert, model, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(row.id, row.project_id, row.parent_id, row.slug, row.directory, row.title, row.version, row.revert, row.model, row.time_created, row.time_updated)
    }
    for (const row of rows.message) s.db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)').run(row.id, row.session_id, row.time_created, row.time_updated, row.data)
    for (const row of rows.part) s.db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)').run(row.id, row.message_id, row.session_id, row.time_created, row.time_updated, row.data)
    return { file: s.path, db: s.db, session: rows.session[0].id, directory: rows.session[0].directory }
}

test.describe('T194 OpenCode conversation', () => {
    test('a recorded 1.18.15 session: three prompts, a tool, a question answered, an interrupted turn', () => {
        const { file, session } = recordedStore()
        const read = readSession(file, session)
        if (read.kind !== 'session') throw new Error(read.kind)
        const turns = opencodeTurns(read.messages, read.end)
        expect(turns.map((turn) => turn.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant'])
        const prompts = turns.filter((turn) => turn.role === 'user').map((turn) => (turn.parts[0] as { text: string }).text)
        expect(prompts[0]).toContain('Run the shell command `ls -1`')
        expect(prompts[1]).toContain('Use the question tool')
        const first = turns[1].parts
        expect(first.map((part) => part.kind)).toEqual(['thinking', 'tool', 'thinking', 'text'])
        expect(first[1]).toMatchObject({ kind: 'tool', name: 'bash', state: 'ok', output: 'notes.txt\nREADME.md\n' })
        expect(first[3]).toMatchObject({ kind: 'text', phase: 'final_answer' })
        expect(turns[3].parts[1]).toMatchObject({ kind: 'tool', name: 'question', state: 'ok' })
        // Esc: no «Error: …» for a step the person interrupted
        expect(turns[5].parts.some((part) => part.kind === 'text' && part.text.startsWith('Error'))).toBe(false)
        expect(opencodeMeta(read.messages, read.end)).toMatchObject({ model: 'big-pickle', effort: null })
    })

    test("OpenCode's own text next to a prompt (synthetic) is no part of what was typed", () => {
        const s = storeV1()
        const id = s.message('user', { agent: 'build' })
        s.part(id, { type: 'text', text: 'read @notes.txt please' })
        s.part(id, { type: 'text', text: 'Called the Read tool with the following input: {"filePath":"notes.txt"}', synthetic: true })
        s.part(id, { type: 'file', mime: 'text/plain', filename: 'notes.txt', url: 'file:///tmp/notes.txt' })
        const read = readSession(s.path, s.session)
        if (read.kind !== 'session') throw new Error(read.kind)
        expect(opencodeTurns(read.messages)[0].parts).toEqual([{ kind: 'text', text: 'read @notes.txt please' }])
    })

    test('a compaction shows its summary once, not the request OpenCode made for it', () => {
        const s = storeV1()
        s.user('first')
        s.assistant([{ type: 'text', text: 'answer' }], { finish: 'stop' })
        const ask = s.message('user', { agent: 'compaction' })
        s.part(ask, { type: 'compaction', auto: true, overflow: false })
        s.assistant([{ type: 'text', text: 'Summary of the work so far.' }], { finish: 'stop', summary: true, mode: 'compaction' })
        const next = s.message('user', { agent: 'build' })
        s.part(next, { type: 'text', text: 'Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.', synthetic: true })
        s.assistant([{ type: 'text', text: 'continuing' }], { finish: 'stop' })
        const read = readSession(s.path, s.session)
        if (read.kind !== 'session') throw new Error(read.kind)
        const turns = opencodeTurns(read.messages)
        expect(turns.map((turn) => [turn.role, turn.parts.map((part) => part.kind).join(',')])).toEqual([
            ['user', 'text'],
            ['assistant', 'text'],
            ['user', 'compact'],
            ['assistant', 'text']
        ])
        expect(turns[2].parts[0]).toEqual({ kind: 'compact', text: 'Summary of the work so far.' })
        // the model and usage are the working steps', not the summary's
        expect(opencodeMeta(read.messages)?.model).toBe('deepseek-v4.1-flash')
    })

    test('an unchanged session is answered from memory; a step rewritten in place is read again', () => {
        const s = storeV1()
        s.user('go')
        const step = s.assistant([{ type: 'text', text: 'partial' }], {})
        const first = readSession(s.path, s.session)
        if (first.kind !== 'session') throw new Error(first.kind)
        expect(readSession(s.path, s.session, first.signature)).toEqual({ kind: 'unchanged', signature: first.signature })
        s.db.prepare("UPDATE part SET data = ?, time_updated = time_updated + 5 WHERE message_id = ?").run(JSON.stringify({ type: 'text', text: 'partial, then whole' }), step)
        const again = readSession(s.path, s.session, first.signature)
        expect(again.kind).toBe('session')
    })

    test('the reader: a session read once, then unchanged; a missing store, a 2.x store and a missing session read nothing; no side files made', () => {
        const s = storeV1()
        s.user('hello')
        s.assistant([{ type: 'text', text: 'hi' }], { finish: 'stop' })
        const reader = new TranscriptReader({ claudeConfigDir: () => root, codexHome: () => root, opencodeStore: () => s.path })
        const a = reader.read('t1', 'opencode', s.session)
        expect(a?.changed).toBe(true)
        expect(a?.turns.map((turn) => turn.role)).toEqual(['user', 'assistant'])
        const b = reader.read('t1', 'opencode', s.session)
        expect(b?.changed).toBe(false)
        expect(reader.locate('opencode', s.session)).toEqual([s.path])
        expect(reader.read('t2', 'opencode', 'ses_missing')).toBeNull()
        expect(reader.read('t3', 'opencode', '../ses_x')).toBeNull()
        const absent = path.join(root, 'absent', 'opencode.db')
        expect(new TranscriptReader({ claudeConfigDir: () => root, codexHome: () => root, opencodeStore: () => absent }).read('t4', 'opencode', s.session)).toBeNull()
        expect(fs.existsSync(absent)).toBe(false)
        const v2 = storeV1()
        v2.db.exec('CREATE TABLE session_v2 (id text PRIMARY KEY)')
        expect(new TranscriptReader({ claudeConfigDir: () => root, codexHome: () => root, opencodeStore: () => v2.path }).read('t5', 'opencode', v2.session)).toBeNull()
    })

    test('sessionsIn: top-level sessions of the folder among the ids, newest first; a subagent session never', () => {
        const { file, db, session, directory } = recordedStore()
        db.prepare("INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated) VALUES ('ses_child1', 'p', ?, 's', ?, 'child', '1.18.15', 1, 99999999999999)").run(session, directory)
        expect(sessionsIn(file, [directory], [session, 'ses_child1']).map((row) => row.id)).toEqual([session])
        expect(sessionsIn(file, ['/elsewhere'], [session])).toEqual([])
    })
})

test.describe('T194 OpenCode command lines', () => {
    test('which opencode runs a session in its TUI', () => {
        for (const args of ['opencode', '/opt/homebrew/Cellar/opencode/1.18.15/libexec/lib/node_modules/opencode-ai/bin/opencode.exe', 'opencode -m anthropic/claude-sonnet-4-5', 'opencode ~/work', 'opencode --session ses_abc', 'node /usr/local/bin/opencode -c']) {
            expect(isInteractiveOpencode(args), args).toBe(true)
        }
        for (const args of ['opencode run "hi"', 'opencode serve --port 4096', 'opencode session list', 'opencode --version', 'opencode -h', 'opencode-helper', 'vim opencode.json', 'opencode models']) {
            expect(isInteractiveOpencode(args), args).toBe(false)
        }
    })

    test('the session a command line names', () => {
        expect(namedSession('opencode --session ses_AbC123')).toBe('ses_AbC123')
        expect(namedSession('opencode -s ses_AbC123 -m x/y')).toBe('ses_AbC123')
        expect(namedSession('opencode --session=ses_AbC123')).toBe('ses_AbC123')
        expect(namedSession('opencode --session ../x')).toBeNull()
        expect(namedSession('opencode -c')).toBeNull()
    })

    test('a restart command keeps plain options, drops the session, the first prompt and a folder', () => {
        expect(resumableCommand('opencode')).toBe('opencode')
        expect(resumableCommand('opencode -m anthropic/claude-sonnet-4-5 --session ses_a')).toBe('opencode -m anthropic/claude-sonnet-4-5')
        expect(resumableCommand('opencode -c --fork --agent plan')).toBe('opencode --agent plan')
        expect(resumableCommand('opencode --prompt hello --session=ses_a ~/work')).toBe('opencode')
        expect(resumableCommand('opencode --prompt "fix the bug"')).toBe('opencode')
        expect(resumableCommand('/opt/homebrew/bin/opencode.exe --print-logs')).toBe('opencode --print-logs')
        expect(opencodeStartCommand('opencode -m a/b')).toBe('opencode -m a/b')
        expect(opencodeStartCommand('opencode\nrm -rf ~')).toBe('opencode')
        expect(opencodeStartCommand('opencode; echo hi')).toBe('opencode')
        expect(opencodeStartCommand(undefined)).toBe('opencode')
    })

    test('ps etime and lsof -Ffn', () => {
        expect(etimeSeconds('05:07')).toBe(307)
        expect(etimeSeconds('01:02:03')).toBe(3723)
        expect(etimeSeconds('2-01:00:00')).toBe(176400)
        expect(etimeSeconds('junk')).toBe(0)
        // recorded: lsof of a running opencode 1.18.15 (the folder renamed)
        expect(parseOpenFiles('p35205\nfcwd\nn/private/tmp/oc-sandbox/project\nftxt\nn/opt/homebrew/Cellar/opencode/1.18.15/libexec/lib/node_modules/opencode-ai/bin/opencode.exe\nf13\nn/private/tmp/oc-sandbox/data/opencode/opencode.db\nf14\nn/private/tmp/oc-sandbox/data/opencode/opencode.db-wal\n')).toEqual({
            cwd: '/private/tmp/oc-sandbox/project',
            files: ['/opt/homebrew/Cellar/opencode/1.18.15/libexec/lib/node_modules/opencode-ai/bin/opencode.exe', '/private/tmp/oc-sandbox/data/opencode/opencode.db', '/private/tmp/oc-sandbox/data/opencode/opencode.db-wal']
        })
    })
})

test.describe('T194 OpenCode session sync', () => {
    function harness(options: { title: string | null; args?: string; age?: number; cwd?: string; extraTerminal?: boolean }) {
        const { file, db, session, directory } = recordedStore()
        const reported: [string, string, string][] = []
        const titles = new Map<string, string | null>([['term-1', options.title]])
        let processes: OpencodeProcess[] = [
            { pid: 100, ppid: 1, age: 9999, args: 'login' },
            { pid: 200, ppid: 100, age: 9999, args: '-zsh' },
            { pid: 300, ppid: 200, age: options.age ?? 60, args: options.args ?? 'opencode' }
        ]
        const ptys = new Map<number, string>([[200, 'term-1']])
        if (options.extraTerminal) {
            ptys.set(400, 'term-2')
            titles.set('term-2', options.title)
            processes = [...processes, { pid: 400, ppid: 100, age: 9999, args: '-zsh' }, { pid: 500, ppid: 400, age: options.age ?? 60, args: 'opencode' }]
        }
        let opened = 0
        const sync = new OpencodeSessionSync({
            defaultStore: () => file,
            ptyPids: () => ptys,
            title: (id) => titles.get(id) ?? null,
            onSession: (terminal, id, command) => reported.push([terminal, id, command]),
            processes: async () => processes,
            openFiles: async () => {
                opened++
                return { cwd: options.cwd ?? directory, files: [file, `${file}-wal`] }
            }
        })
        return { sync, reported, titles, db, session, directory, file, opened: () => opened }
    }
    // the recorded session was last written at this time
    const UPDATED = 1795787473344

    test('a terminal titled `OC | <title>` in that folder: bound, once', async () => {
        const h = harness({ title: 'OC | Counting folder entries with ls -1' })
        await h.sync.tick(UPDATED + 1000)
        await h.sync.tick(UPDATED + 60_000)
        expect(h.reported).toEqual([['term-1', h.session, 'opencode']])
    })

    test('the home screen (`OpenCode`) or no title yet: not bound', async () => {
        for (const title of ['OpenCode', null]) {
            const h = harness({ title })
            await h.sync.tick(UPDATED + 1000)
            expect(h.reported).toEqual([])
        }
    })

    test('another folder: not bound', async () => {
        const h = harness({ title: 'OC | Counting folder entries with ls -1', cwd: '/somewhere/else' })
        await h.sync.tick(UPDATED + 1000)
        expect(h.reported).toEqual([])
    })

    test('`--session <id>` names it, and the restart command keeps the other options', async () => {
        // the recorded session's id, named on the command line (no title needed)
        const s = harness({ title: null, args: 'opencode -m a/b --session ses_de2ba62b2ffeWjO9LBV13XqX3l' })
        await s.sync.tick(UPDATED + 1000)
        expect(s.reported).toEqual([['term-1', s.session, 'opencode -m a/b']])
        const missing = harness({ title: null, args: 'opencode --session ses_notThere' })
        await missing.sync.tick(UPDATED + 1000)
        expect(missing.reported).toEqual([])
    })

    test('two sessions with the same title in the folder: the one used since the process started, or none', async () => {
        const h = harness({ title: 'OC | Counting folder entries with ls -1', age: 10 })
        h.db.prepare("INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated) VALUES ('ses_older1', 'p', NULL, 's', ?, 'Counting folder entries with ls -1', '1.18.15', 1, 2)").run(h.directory)
        // started 10s before the recorded session was last written: that one is its own
        await h.sync.tick(UPDATED + 5_000)
        expect(h.reported).toEqual([['term-1', h.session, 'opencode']])
        const old = harness({ title: 'OC | Counting folder entries with ls -1', age: 10 })
        old.db.prepare("INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated) VALUES ('ses_older1', 'p', NULL, 's', ?, 'Counting folder entries with ls -1', '1.18.15', 1, 2)").run(old.directory)
        // started long after both were last written: neither is told apart
        await old.sync.tick(UPDATED + 3_600_000)
        expect(old.reported).toEqual([])
    })

    test('two terminals showing one session: only one is bound to it', async () => {
        const h = harness({ title: 'OC | Counting folder entries with ls -1', extraTerminal: true })
        await h.sync.tick(UPDATED + 1000)
        expect(h.reported.length).toBe(1)
    })

    test('a quiet store and the same titles: no ps, no lsof until the full scan', async () => {
        const h = harness({ title: 'OC | Counting folder entries with ls -1' })
        await h.sync.tick(UPDATED + 1000)
        const after = h.opened()
        await h.sync.tick(UPDATED + 2000)
        expect(h.opened()).toBe(after)
        h.titles.set('term-1', 'OC | Something else')
        await h.sync.tick(UPDATED + 3000)
        expect(h.opened()).toBe(after + 1)
        await h.sync.tick(UPDATED + 3000 + 31_000)
        expect(h.opened()).toBe(after + 2)
    })
})
