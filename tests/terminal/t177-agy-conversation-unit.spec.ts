import { test, expect } from '@playwright/test'
import { mkdirSync, mkdtempSync, writeFileSync, appendFileSync, realpathSync, rmSync, utimesSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createAgyTranscriptParser, agyUserText, agyModelOf } from '../../src/main/transcript/agyTranscript'
import { foldMetadata } from '../../src/main/transcript/metadata'
import { TranscriptReader } from '../../src/main/TranscriptReader'
import { AgySessionSync, agyStartCommand, isInteractiveAgy, lockedConversation, resumableCommand, type AgyProcess } from '../../src/main/AgySessionSync'

/**
 * T177 — Antigravity CLI (agy) conversations, without Electron: the step ledger as chat turns, the
 * reader that finds and follows it, and the sync that names the conversation a terminal's agy shows.
 *
 * The ledger lines are synthetic, in the shape agy 1.5.16 writes (keys and types measured on real
 * ledgers 2026-11-25: step_index · source · type · status · created_at · content · model · tokens ·
 * thinking · tool_calls{name,args}; GENERIC = a tool's result without a call id, opening with its
 * `Created At:` / `Completed At:` lines; SYSTEM_MESSAGE = agy's note to the model).
 */

const ID = '00000000-0000-4000-8000-0000000000a1'
const line = (value: Record<string, unknown>): string => JSON.stringify(value) + '\n'
const user = (index: number, text: string): string =>
    line({ step_index: index, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: `2026-11-25T03:00:${String(index).padStart(2, '0')}Z`, content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-11-25T12:00:00+09:00.\n</ADDITIONAL_METADATA>` })
const planner = (index: number, content: string, extra: Record<string, unknown> = {}): string =>
    line({ step_index: index, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: `2026-11-25T03:00:${String(index).padStart(2, '0')}Z`, model: 'gemini-3.8-flash-low', input_tokens: 100, output_tokens: 5, content, ...extra })
const generic = (index: number, content: string, status = 'DONE'): string =>
    line({ step_index: index, source: 'MODEL', type: 'GENERIC', status, created_at: `2026-11-25T03:00:${String(index).padStart(2, '0')}Z`, content: `Created At: 2026-11-25T12:00:00+09:00\nCompleted At: 2026-11-25T12:00:01+09:00\n${content}` })
const system = (index: number): string =>
    line({ step_index: index, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', status: 'DONE', created_at: '2026-11-25T03:01:00Z', content: 'The following is a <SYSTEM_MESSAGE> not actually sent by the user.' })

function parse(text: string, tail = '') {
    const parser = createAgyTranscriptParser()
    parser.write(text)
    return parser.snapshot(tail)
}

test.describe('T177 agy ledger → chat turns', () => {
    test('prompt and answer, the request wrapper removed', () => {
        const turns = parse(user(0, 'Reply with exactly one word: hi') + planner(1, 'hi'))
        expect(turns.map((turn) => [turn.role, turn.parts.map((part) => (part.kind === 'text' ? part.text : part.kind))])).toEqual([
            ['user', ['Reply with exactly one word: hi']],
            ['assistant', ['hi']]
        ])
        expect(turns[0].ts).toBe('2026-11-25T03:00:00Z')
    })

    test('a tool call takes the next GENERIC result as its output, without the timing lines', () => {
        const turns = parse(
            user(0, 'Run ls') +
            planner(1, '', { tool_calls: [{ name: 'run_command', args: { CommandLine: 'ls -la', toolSummary: 'list files' } }] }) +
            generic(2, 'total 0\nnotes.txt') +
            planner(3, 'Done.')
        )
        expect(turns).toHaveLength(2)
        const [tool, answer] = turns[1].parts
        expect(tool).toMatchObject({ kind: 'tool', name: 'run_command', summary: 'list files', output: 'total 0\nnotes.txt' })
        expect(tool.kind === 'tool' && tool.state).toBeUndefined()
        expect(answer).toEqual({ kind: 'text', text: 'Done.' })
        expect(turns[1].end_ts).toBe('2026-11-25T03:00:03Z')
    })

    test('a result still RUNNING leaves its call pending', () => {
        const turns = parse(user(0, 'Run sleep') + planner(1, '', { tool_calls: [{ name: 'run_command', args: { CommandLine: 'sleep 30' } }] }) + generic(2, '', 'RUNNING'))
        expect(turns[1].parts[0]).toMatchObject({ kind: 'tool', summary: 'sleep 30', state: 'pending' })
    })

    test("agy's 1.5.16 file argument (`Path`) is the summary; thinking is a thinking part; SYSTEM_MESSAGE is not shown", () => {
        const turns = parse(
            user(0, 'Read it') +
            planner(1, '', { thinking: 'Looking at the file.', tool_calls: [{ name: 'read_file', args: { Path: '/w/notes.txt', StartLine: 1, EndLine: 9 } }] }) +
            generic(2, 'hello') +
            system(3) +
            planner(4, 'It says hello.')
        )
        expect(turns[1].parts.map((part) => part.kind)).toEqual(['thinking', 'tool', 'text'])
        expect(turns[1].parts[1]).toMatchObject({ summary: '/w/notes.txt' })
    })

    test('a line whose step_index is not past the last replaces it and what follows', () => {
        const first = user(0, 'one') + planner(1, 'first answer')
        // the step rewritten, then a new prompt after it
        const turns = parse(first + planner(1, 'rewritten answer') + user(2, 'two') + planner(3, 'second'))
        expect(turns.map((turn) => (turn.parts[0].kind === 'text' ? turn.parts[0].text : ''))).toEqual(['one', 'rewritten answer', 'two', 'second'])
        // a rewind back to step 0 drops everything after it
        expect(parse(first + user(2, 'two') + user(0, 'again')).map((turn) => turn.parts[0].kind === 'text' && turn.parts[0].text)).toEqual(['again'])
    })

    test('a long result is cut with a ref to its step', () => {
        const turns = parse(user(0, 'x') + planner(1, '', { tool_calls: [{ name: 'run_command', args: { CommandLine: 'seq 9999' } }] }) + generic(2, 'y'.repeat(9000)))
        expect(turns[1].parts[0]).toMatchObject({ output_ref: 'agy-step:2', output_size: 9000 })
    })

    test('an unfinished last line shows in the snapshot without being kept', () => {
        const parser = createAgyTranscriptParser()
        parser.write(user(0, 'x'))
        expect(parser.snapshot(planner(1, 'partial').trimEnd())).toHaveLength(2)
        expect(parser.snapshot()).toHaveLength(1)
    })

    test('agyUserText keeps text that is not the wrapper', () => {
        expect(agyUserText('plain')).toBe('plain')
        expect(agyUserText('<USER_REQUEST>\nhi\n</USER_REQUEST>')).toBe('hi')
        expect(agyUserText('<USER_REQUEST>\nhi\n</USER_REQUEST> and more')).toBe('<USER_REQUEST>\nhi\n</USER_REQUEST> and more')
    })

    test('the model chip: model and effort from the last planner response', () => {
        expect(agyModelOf('gemini-3.8-flash-low')).toEqual({ model: 'gemini-3.8-flash', effort: 'low' })
        expect(agyModelOf('gemini-pro-orchestrator')).toEqual({ model: 'gemini-pro-orchestrator', effort: null })
        const meta = foldMetadata(user(0, 'x') + planner(1, 'y') + planner(2, 'z', { model: 'claude-sonnet-5-5-high' }), 'agy', null)
        expect(meta).toEqual({ model: 'claude-sonnet-5-5', effort: 'high' })
    })
})

test.describe('T177 TranscriptReader on agy', () => {
    let home: string
    test.beforeEach(() => {
        home = mkdtempSync(join(tmpdir(), 't177-agy-'))
    })
    test.afterEach(() => rmSync(home, { recursive: true, force: true }))

    const ledger = (): string => join(home, 'brain', ID, '.system_generated', 'logs', 'transcript_full.jsonl')

    test('finds the ledger, follows appends, and fetches a cut output back', async () => {
        mkdirSync(join(home, 'brain', ID, '.system_generated', 'logs'), { recursive: true })
        writeFileSync(ledger(), user(0, 'hello') + planner(1, 'hi'))
        const reader = new TranscriptReader({ claudeConfigDir: () => '/nonexistent', codexHome: () => '/nonexistent', agyHome: () => home })
        expect(reader.locate('agy', ID)).toEqual([ledger()])
        const first = reader.read('s1', 'agy', ID)
        expect(first?.turns).toHaveLength(2)
        expect(first?.meta).toEqual({ model: 'gemini-3.8-flash', effort: 'low' })
        appendFileSync(ledger(), user(2, 'long') + planner(3, '', { tool_calls: [{ name: 'run_command', args: { CommandLine: 'seq' } }] }) + generic(4, 'z'.repeat(9000)))
        const next = reader.read('s1', 'agy', ID)
        expect(next?.changed).toBe(true)
        expect(next?.turns).toHaveLength(4)
        expect(await reader.toolOutput('s1', 'agy-step:4')).toBe('z'.repeat(9000))
        expect(await reader.toolOutput('s1', 'agy-step:9')).toBeNull()
    })

    test('no data folder, no ledger, a bad id: nothing found', () => {
        expect(new TranscriptReader({ claudeConfigDir: () => '/x', codexHome: () => '/x' }).locate('agy', ID)).toEqual([])
        const reader = new TranscriptReader({ claudeConfigDir: () => '/x', codexHome: () => '/x', agyHome: () => home })
        expect(reader.locate('agy', ID)).toEqual([])
        expect(reader.locate('agy', '../etc')).toEqual([])
        expect(reader.read('s1', 'agy', ID)).toBeNull()
    })
})

test.describe('T177 AgySessionSync', () => {
    let home: string
    test.beforeEach(() => {
        home = mkdtempSync(join(tmpdir(), 't177-sync-'))
        mkdirSync(join(home, 'presence'))
    })
    test.afterEach(() => rmSync(home, { recursive: true, force: true }))

    function harness(rows: AgyProcess[], files: Record<number, string[]>) {
        const seen: Array<[string, string, string]> = []
        const calls = { ps: 0, lsof: 0 }
        const sync = new AgySessionSync({
            dataDir: () => home,
            ptyPids: () => new Map([[100, 'term-a'], [200, 'term-b']]),
            onConversation: (terminalId, id, command) => void seen.push([terminalId, id, command]),
            fullScanMs: 30_000,
            processes: async () => (calls.ps++, rows),
            openFiles: async (pid) => (calls.lsof++, files[pid] ?? [])
        })
        return { sync, seen, calls }
    }
    const lock = (id: string): string => join(home, 'presence', `${id}.lock`)

    test('reports the conversation whose lock the agy under a terminal holds, once', async () => {
        const rows = [
            { pid: 100, ppid: 1, args: '-zsh' },
            { pid: 101, ppid: 100, args: 'agy --model gemini-3.8-flash-low' },
            { pid: 102, ppid: 101, args: 'npm exec figma-developer-mcp --stdio' }
        ]
        const { sync, seen, calls } = harness(rows, { 101: ['/dev/ttys001', lock(ID), join(home, 'conversations', `${ID}.db`)] })
        await sync.tick(1_000)
        expect(seen).toEqual([['term-a', ID, 'agy --model gemini-3.8-flash-low']])
        // the folder did not change: no process table, no lsof
        await sync.tick(2_000)
        expect(calls).toEqual({ ps: 1, lsof: 1 })
        // past the full-scan interval it looks again, and the same id is not reported twice
        await sync.tick(40_000)
        expect(calls.ps).toBe(2)
        expect(seen).toHaveLength(1)
    })

    test('a changed presence folder triggers a scan; a new lock is a new conversation', async () => {
        const other = '00000000-0000-4000-8000-0000000000b2'
        const files: Record<number, string[]> = { 201: [lock(ID)] }
        const { sync, seen } = harness([{ pid: 200, ppid: 1, args: 'zsh' }, { pid: 201, ppid: 200, args: '/Users/x/.local/bin/agy --conversation=' + ID }], files)
        await sync.tick(1_000)
        files[201] = [lock(other)]
        utimesSync(join(home, 'presence'), new Date(), new Date(Date.now() + 5_000))
        await sync.tick(2_000)
        expect(seen).toEqual([['term-b', ID, 'agy'], ['term-b', other, 'agy']])
    })

    test('not reported: no lock, two locks, a lock outside presence, an agy outside our terminals, a subcommand', async () => {
        const rows = [
            { pid: 100, ppid: 1, args: 'zsh' },
            { pid: 110, ppid: 100, args: 'agy' },
            { pid: 111, ppid: 100, args: 'agy' },
            { pid: 112, ppid: 100, args: 'agy' },
            { pid: 113, ppid: 100, args: 'agy models' },
            { pid: 300, ppid: 1, args: 'agy' }
        ]
        const { sync, seen } = harness(rows, {
            110: [],
            111: [lock(ID), lock('00000000-0000-4000-8000-0000000000c3')],
            112: [join(home, 'elsewhere', `${ID}.lock`)],
            113: [lock(ID)],
            300: [lock(ID)]
        })
        await sync.tick(1_000)
        expect(seen).toEqual([])
    })

    test('no agy data folder: nothing runs', async () => {
        rmSync(join(home, 'presence'), { recursive: true })
        const { sync, calls } = harness([], {})
        await sync.tick(1_000)
        expect(calls).toEqual({ ps: 0, lsof: 0 })
    })

    test('command helpers', () => {
        expect(isInteractiveAgy('agy')).toBe(true)
        expect(isInteractiveAgy('/opt/bin/agy --dangerously-skip-permissions')).toBe(true)
        expect(isInteractiveAgy('node /tmp/bin/agy --model x')).toBe(true)
        expect(isInteractiveAgy('agy -p "hi"')).toBe(false)
        expect(isInteractiveAgy('agy acp')).toBe(false)
        expect(isInteractiveAgy('pagy')).toBe(false)
        expect(resumableCommand('agy --dangerously-skip-permissions --conversation X --model m')).toBe('agy --dangerously-skip-permissions --model m')
        expect(resumableCommand('agy -r X -c --resume=Y --effort high')).toBe('agy --effort high')
        expect(resumableCommand('agy --settings {"a":1}')).toBe('agy')
        expect(agyStartCommand('agy --model gemini-4-neon-high')).toBe('agy --model gemini-4-neon-high')
        expect(agyStartCommand('agy; rm -rf ~')).toBe('agy')
        expect(agyStartCommand(undefined)).toBe('agy')
        expect(lockedConversation([lock(ID.toUpperCase())], join(home, 'presence'))).toBe(ID)
    })

    test('the data folder under a symlink: lsof names the resolved path, the lock still counts', async () => {
        // macOS tmpdir is /var/folders/… → /private/var/folders/…; lsof prints the second
        const real = realpathSync(home)
        expect(real).not.toBe(home)
        const { sync, seen } = harness([{ pid: 100, ppid: 1, args: 'zsh' }, { pid: 101, ppid: 100, args: 'agy' }], { 101: [join(real, 'presence', `${ID}.lock`)] })
        await sync.tick(1_000)
        expect(seen).toEqual([['term-a', ID, 'agy']])
    })
})
