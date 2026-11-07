import { test, expect } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { AgentConversations, normalizeAgentCommand, commandAgent } from '../../src/main/agentConversations'
import { decideAgentCommand } from '../../src/shared/agentCommand'
import { claudeProjectSlug } from '../../src/main/TranscriptReader'
import type { AgentConversationFront } from '../../src/shared/conversation'
import type { TerminalSession } from '../../src/shared/types'

const uuid = (n: number): string => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`
const now = Date.now()
let root: string
let cwd: string
let sessions: TerminalSession[]
let front: AgentConversationFront
let writes: string[]
let service: AgentConversations
let resumeError: Error | null
let resumeReady: boolean
let startupChecks: number
function codex(n: number, options: { cwd?: string; source?: unknown; originator?: string; text?: string; at?: number; extension?: string; padding?: number } = {}): string {
    const at = options.at ?? now - n * 1000
    const day = new Date(at)
    const dir = path.join(root, 'codex/sessions', String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0'))
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `rollout-${day.toISOString().slice(0, 19).replace(/:/g, '-')}-${uuid(n)}${options.extension ?? '.jsonl'}`)
    const records = [
        { type: 'session_meta', timestamp: day.toISOString(), payload: { id: uuid(n), timestamp: day.toISOString(), cwd: options.cwd ?? cwd, source: options.source ?? 'cli', originator: options.originator ?? 'codex-tui', instructions: 'x'.repeat(options.padding ?? 0) } },
        ...(options.text === '' ? [] : [{ type: 'event_msg', timestamp: day.toISOString(), payload: { type: 'user_message', message: options.text ?? `Prompt ${n}` } }])
    ]
    fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n')
    fs.utimesSync(file, new Date(at), new Date(at))
    return file
}
function claude(n: number, folder = cwd, text = `Claude prompt ${n}`): void {
    const dir = path.join(root, 'claude/projects', claudeProjectSlug(folder))
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `${uuid(n)}.jsonl`), JSON.stringify({ type: 'user', cwd: folder, sessionId: uuid(n), timestamp: new Date(now - n * 1000).toISOString(), uuid: uuid(n + 100), message: { role: 'user', content: text } }) + '\n')
}
test.beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'climanger-d4-t103-'))
    cwd = path.join(root, 'work')
    fs.mkdirSync(cwd)
    sessions = [{ id: 'terminal', name: 'Terminal', cwd, type: 'regular' }]
    front = { kind: 'shell', runningId: null, startedAt: null }
    writes = []
    resumeError = null
    resumeReady = true
    startupChecks = 0
    service = new AgentConversations({
        sessions: () => sessions,
        foreground: async () => front,
        update: (id, values) => Object.assign(sessions.find((s) => s.id === id)!, values),
        write: (_id, data) => writes.push(data),
        codexHome: () => path.join(root, 'codex'),
        claudeConfigDir: () => path.join(root, 'claude'),
        now: () => now,
        beforeResume: async () => { if (resumeError) throw resumeError },
        waitForAgent: async () => { startupChecks++; return resumeReady },
        resolveAlias: (name) => name === 'cldy' ? 'claude --dangerously-skip-permissions' : undefined
    })
})
test.afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

test.describe('T103 agent conversations', () => {
    for (const resume of [false, true]) {
        test(`startup restore excludes manual connect before file and foreground checks: resume=${resume}`, async () => {
            codex(1)
            let foregroundChecks = 0
            const connection = new AgentConversations({
                sessions: () => sessions,
                foreground: async () => { foregroundChecks++; return front },
                beforeConnect: () => { throw Object.assign(new Error('Startup restore is in progress.'), { status: 409, code: 'input_busy' }) },
                beforeResume: async () => {},
                update: (_id, values) => Object.assign(sessions[0], values),
                write: (_id, text) => writes.push(text),
                codexHome: () => path.join(root, 'codex'),
                claudeConfigDir: () => path.join(root, 'claude')
            })
            await expect(connection.connect('terminal', { agent: 'codex', id: uuid(1), resume })).rejects.toMatchObject({ code: 'input_busy', status: 409 })
            expect(foregroundChecks).toBe(0)
            expect(sessions[0].cliSessionId).toBeUndefined()
            expect(writes).toEqual([])
        })
    }
    test('manual resume types no Enter and returns immediately without a startup poll', async () => {
        codex(1)
        const result = await service.connect('terminal', { agent: 'codex', id: uuid(1), resume: true })
        expect(writes.join('')).toBe(`codex resume ${uuid(1)}`)
        expect(writes.join('')).not.toMatch(/[\r\n]/)
        expect(result).toMatchObject({ typed: true, resumed: false })
        expect(startupChecks).toBe(0)
    })
    test('N11 option arity agrees with the captured real Claude help declarations', () => {
        const help = fs.readFileSync(path.join(__dirname, 'fixtures/claude-help-options.txt'), 'utf8')
        expect(help).toContain('Version: 2.1.319 (Claude Code)')
        const arity = new Map<string, boolean>()
        for (const line of help.split('\n')) {
            const declaration = /^  (.+?)\s+<([^>]+)>/.exec(line)
            if (!declaration) continue
            for (const name of declaration[1].split(/,\s*/)) arity.set(name, declaration[2].endsWith('...'))
        }
        for (const flag of ['--plugin-dir', '--tools', '--add-dir', '--file', '--allowedTools', '--disallowedTools', '--betas', '--mcp-config']) {
            expect(arity.has(flag), `Missing real --help definition for ${flag}`).toBe(true)
            const command = `claude ${flag} first second`
            const expected = arity.get(flag) ? command : `claude ${flag} first`
            expect(decideAgentCommand(command, 'claude').inputCommand, flag).toBe(expected)
        }
    })
    test('N11 a plugin directory takes one value and the following first prompt is excluded', async () => {
        claude(1)
        const original = 'claude --plugin-dir ./p "REPLAY_plugin_prompt"'
        const base = 'claude --plugin-dir ./p'
        expect(decideAgentCommand(original, 'claude').inputCommand).toBe(base)
        sessions[0].cliToolName = 'claude'
        sessions[0].cliCommand = original
        await service.connect('terminal', { agent: 'claude', id: uuid(1), resume: true })
        expect(writes.join('')).toBe(`${base} --resume ${uuid(1)}`)
        expect(writes.join('')).not.toContain('REPLAY_plugin_prompt')
    })
    for (const [agent, command] of [
        ['codex', 'codex --remote ws://host:1'],
        ['codex', 'codex --remote-auth-token-env TOKEN_NAME'],
        ['codex', 'codex --oss --local-provider ollama'],
        ['claude', 'claude --fallback-model sonnet --dangerously-skip-permissions'],
        ['claude', 'claude --plugin-dir ./p'],
        ['claude', 'claude -n work'],
        ['claude', 'claude --name work'],
        ['claude', 'claude --max-budget-usd 5'],
        ['claude', 'claude --tools Bash Read'],
        ['claude', 'claude --file file_1:a.txt file_2:b.txt'],
        ['claude', 'claude --output-format json'],
        ['claude', 'FOO=$(cat k) claude --model opus'],
        ['claude', 'source "$HOME/.env" && claude --model opus']
    ] as const) {
        test(`N2 N7 known complete values and preparation survive: ${command}`, async () => {
            expect(normalizeAgentCommand(command, agent)).toBe(command)
            if (agent === 'codex') codex(1); else claude(1)
            sessions[0].cliToolName = agent
            sessions[0].cliCommand = command
            await service.connect('terminal', { agent, id: uuid(1), resume: true })
            expect(sessions[0].cliCommand).toBe(command)
            expect(writes.join('')).toBe(`${command} ${agent === 'codex' ? 'resume' : '--resume'} ${uuid(1)}`)
        })
    }
    for (const command of ['codex --future-option option-value user words', 'codex --future-boolean', 'codex --model']) {
        test(`N2 uncertain commands preserve storage but cannot emit dangling flags: ${command}`, async () => {
            codex(1)
            sessions[0].cliToolName = 'codex'
            sessions[0].cliCommand = command
            await service.connect('terminal', { agent: 'codex', id: uuid(1), resume: true })
            expect(sessions[0].cliCommand).toBe(command)
            expect(writes.join('')).toBe(`codex resume ${uuid(1)}`)
        })
    }
    test('N2 shared policy preserves exact undecidable source without mutating it at replay time', () => {
        for (const original of ['  codex --future-option "value with spaces" user prompt  ', 'codex --model --full-auto', 'codex --future-boolean', 'codex --future=value']) {
            const decision = decideAgentCommand(original, 'codex')
            expect(decision).toMatchObject({ storedCommand: original, inputCommand: 'codex', recognized: true, confident: false })
            expect(original).toBe(decision.storedCommand)
        }
        const original = 'FOO=$(cat k)  claude --model "opus" first prompt'
        expect(decideAgentCommand(original, 'claude')).toMatchObject({ storedCommand: 'FOO=$(cat k)  claude --model "opus"', inputCommand: 'FOO=$(cat k)  claude --model "opus"', confident: true, stripped: true })
        expect(decideAgentCommand("claude --tools ''", 'claude').inputCommand).toBe("claude --tools ''")
    })
    test('normalization recognizes commands without mistaking quoted control tokens for operators', () => {
        expect(normalizeAgentCommand('codex -m resume resume ' + uuid(1), 'codex')).toBe('codex -m resume')
        expect(normalizeAgentCommand('codex -m "model with spaces" "opening prompt"', 'codex')).toBe('codex -m "model with spaces"')
        expect(normalizeAgentCommand('codex "&&" codex "delete the build folder"', 'codex')).toBe('codex')
        expect(normalizeAgentCommand('codex --config "$(touch /tmp/injected)"', 'codex')).toBe('codex')
        expect(normalizeAgentCommand('cldy', 'claude', () => 'claude -p unsafe')).toBe('claude')
        expect(normalizeAgentCommand('claude -p"opening prompt"', 'claude')).toBe('claude')
        expect(commandAgent('codex "unterminated prompt')).toBe('codex')
        expect(commandAgent('vim codex')).toBeNull()
        expect(commandAgent('echo "quoted; codex"')).toBeNull()
    })
    test('unknown foreground state is read-only even with force', async () => {
        codex(1)
        front = { kind: 'unknown', runningId: null, startedAt: null }
        await expect(service.connect('terminal', { agent: 'codex', id: uuid(1), force: true })).rejects.toMatchObject({ code: 'foreground_unknown' })
        expect(sessions[0].cliSessionId).toBeUndefined()
    })
    test('beforeWrite runs only after guards and explicit base command overrides are normalized', async () => {
        codex(1)
        sessions[0].cliToolName = 'codex'
        sessions[0].cliCommand = 'codex --model stale'
        let marked = false
        const hooks = { beforeWrite: () => { marked = true }, baseCommand: 'codex --model fresh old prompt' }
        resumeError = Object.assign(new Error('Input occupied.'), { code: 'input_busy', status: 409 })
        await expect(service.connect('terminal', { agent: 'codex', id: uuid(1), resume: true }, hooks)).rejects.toMatchObject({ code: 'input_busy' })
        expect(marked).toBe(false)
        resumeError = null
        const result = await service.connect('terminal', { agent: 'codex', id: uuid(1), resume: true }, hooks)
        expect(marked).toBe(true)
        expect(result.cliCommand).toBe('codex --model fresh')
    })
    test('R1 Claude has its own discovery budget after unrelated Codex files exhaust theirs', async () => {
        for (let i = 1; i <= 2001; i++) codex(i, { cwd: root })
        claude(5000)
        const result = await service.list('terminal')
        expect(result.items.map((item) => item.agent)).toEqual(['claude'])
        expect(result.truncated).toBe(true)
    })
    test('R2 force cannot switch an unheld running Codex to a Claude conversation', async () => {
        claude(1)
        front = { kind: 'codex', runningId: null, startedAt: now }
        await expect(service.connect('terminal', { agent: 'claude', id: uuid(1), force: true })).rejects.toMatchObject({ code: 'agent_running' })
        expect(sessions[0].cliSessionId).toBeUndefined()
    })
    for (const [agent, command, expected] of [
        ['codex', 'codex -m gpt-5 fix the tests', 'codex -m gpt-5'],
        ['codex', 'codex "delete the build folder"', 'codex'],
        ['codex', 'codex exec "delete the build folder"', 'codex'],
        ['claude', 'claude -p "delete the build folder"', 'claude'],
        ['claude', 'claude --print "delete the build folder"', 'claude']
    ] as const) {
        for (const source of ['initialCommand', 'cliCommand'] as const) {
            test(`R3 ${source} strips prompts and noninteractive commands: ${command}`, async () => {
                if (agent === 'codex') codex(1); else claude(1)
                sessions[0][source] = command
                if (source === 'cliCommand') sessions[0].cliToolName = agent
                const result = await service.connect('terminal', { agent, id: uuid(1), resume: true })
                const isNoninteractive = command.includes(' exec ') || command.includes(' -p ') || command.includes(' --print ')
                expect(result.cliCommand).toBe(isNoninteractive ? command : expected)
                expect(writes.join('')).toBe(`${expected} ${agent === 'codex' ? 'resume' : '--resume'} ${uuid(1)}`)
            })
        }
    }
    test('R11 aliases are classified using the tracker and preserved when the expansion is safe', async () => {
        claude(1)
        sessions[0].initialCommand = 'cldy'
        const result = await service.connect('terminal', { agent: 'claude', id: uuid(1), resume: true })
        expect(result.cliCommand).toBe('cldy')
        expect(writes.join('')).toBe(`cldy --resume ${uuid(1)}`)
    })
    for (const code of ['awaiting_input', 'input_busy']) {
        test(`resume guard ${code} leaves human input and metadata untouched`, async () => {
            codex(1)
            resumeError = Object.assign(new Error('Input is occupied.'), { code, status: 409 })
            await expect(service.connect('terminal', { agent: 'codex', id: uuid(1), resume: true })).rejects.toMatchObject({ code })
            expect(writes).toEqual([])
            expect(sessions[0].cliSessionId).toBeUndefined()
        })
    }
    test('a typed command is not a resumed agent until startup is observed', async () => {
        codex(1)
        resumeReady = false
        const result = await service.connect('terminal', { agent: 'codex', id: uuid(1), resume: true })
        expect(result).toMatchObject({ resumed: false, typed: true })
        expect(writes.join('')).not.toContain('\x15')
    })
    test('R8 unrelated long Codex heads are filtered before transcript JSON parsing', async () => {
        for (let i = 1; i <= 200; i++) codex(i, { cwd: root, padding: 400_000 })
        const parse = JSON.parse
        let largeParses = 0
        JSON.parse = ((text: string, ...args: unknown[]) => { if (text.length > 8192) largeParses++; return parse(text, ...args as []) }) as typeof JSON.parse
        try { await service.list('terminal') } finally { JSON.parse = parse }
        expect(largeParses).toBe(0)
    })
    test('lists only same-folder interactive conversations with a masked first prompt and no transcript path', async () => {
        const token = ['sk-', 'x'.repeat(24)].join('')
        codex(1, { text: `Fix this token=${token}\nnext line` })
        codex(2, { source: 'exec' })
        codex(3, { source: { subagent: 'worker' } })
        codex(4, { originator: 'codex-exec' })
        codex(5, { text: '' })
        codex(6, { cwd: path.join(root, 'other') })
        codex(7, { extension: '.jsonl.langfuse' })
        codex(8, { source: 'vscode', padding: 270_000 })
        claude(9)
        const result = await service.list('terminal')
        expect(result.items.map((item) => item.id).sort()).toEqual([uuid(1), uuid(8), uuid(9)])
        const item = result.items.find((entry) => entry.id === uuid(1))!
        expect(item.firstMessage).toContain('[REDACTED]')
        expect(item.firstMessage).not.toContain(token)
        expect(item.firstMessage).not.toContain('\n')
        expect(JSON.stringify(result.items)).not.toContain('rollout-')
        expect(result.front).toEqual({ kind: 'shell', runningId: null, startedAt: null })
    })
    test('caps and sorts merged results, marks linked conversations, and truncates first messages', async () => {
        for (let i = 1; i <= 35; i++) codex(i, { text: 'x'.repeat(250) })
        sessions.push({ id: 'other', name: 'Other', cwd, type: 'regular', cliToolName: 'codex', cliSessionId: uuid(1) })
        const result = await service.list('terminal')
        expect(result.items).toHaveLength(30)
        expect(result.truncated).toBe(true)
        expect(result.items[0].linkedTo).toEqual({ sessionId: 'other', name: 'Other' })
        expect(result.items.every((item) => item.firstMessage.length <= 200)).toBe(true)
        expect(result.items.every((item, index) => !index || item.updatedAt <= result.items[index - 1].updatedAt)).toBe(true)
    })
    test('marks startedHere in the -2 to +30 second window and resolves real paths', async () => {
        const linked = path.join(root, 'work-link')
        fs.symlinkSync(cwd, linked)
        codex(1, { cwd: linked, at: now + 2000 })
        codex(2, { at: now + 31_000 })
        front = { kind: 'codex', runningId: null, startedAt: now }
        const result = await service.list('terminal')
        expect(result.items.find((item) => item.id === uuid(1))?.startedHere).toBe(true)
        expect(result.items.find((item) => item.id === uuid(2))?.startedHere).toBe(false)
    })
    test('connects from shell and resumes using saved flags, stripping an old resume id', async () => {
        codex(1)
        sessions[0].cliToolName = 'codex'
        sessions[0].cliCommand = `codex --dangerously-bypass-approvals-and-sandbox resume ${uuid(8)}`
        const result = await service.connect('terminal', { agent: 'codex', id: uuid(1), resume: true })
        expect(result).toEqual({ status: 'connected', resumed: false, typed: true, cliCommand: 'codex --dangerously-bypass-approvals-and-sandbox' })
        expect(sessions[0].cliSessionId).toBe(uuid(1))
        expect(sessions[0].cliToolName).toBe('codex')
        expect(writes.join('')).toBe(`codex --dangerously-bypass-approvals-and-sandbox resume ${uuid(1)}`)
    })
    test('preserves compatible initial command and ignores a different agent command', async () => {
        claude(1)
        sessions[0].initialCommand = 'claude --dangerously-skip-permissions'
        expect((await service.connect('terminal', { agent: 'claude', id: uuid(1) })).cliCommand).toBe('claude --dangerously-skip-permissions')
        codex(2)
        expect((await service.connect('terminal', { agent: 'codex', id: uuid(2) })).cliCommand).toBe('codex')
    })
    test('an agent name in arguments is not an initial agent command', async () => {
        codex(1)
        for (const command of ['echo codex', 'node chat-mock.cjs --agent codex', 'claude --print codex', 'echo "quoted; codex --model test"']) {
            sessions[0].cliCommand = undefined
            sessions[0].initialCommand = command
            expect((await service.connect('terminal', { agent: 'codex', id: uuid(1) })).cliCommand).toBe('codex')
        }
        sessions[0].cliCommand = undefined
        sessions[0].initialCommand = 'prepare-env && codex --model gpt-test'
        expect((await service.connect('terminal', { agent: 'codex', id: uuid(1) })).cliCommand).toBe('prepare-env && codex --model gpt-test')
    })
    test('process argv never replays a prompt or shell syntax as a resume command', async () => {
        codex(1, { at: now + 1000 })
        front = { kind: 'codex', runningId: null, startedAt: now, argv: 'codex --model gpt-6.1 hello $(touch /tmp/unsafe)' }
        expect((await service.connect('terminal', { agent: 'codex', id: uuid(1) })).cliCommand).toBe('codex --model gpt-6.1')
        sessions[0].cliCommand = undefined
        front.argv = 'node /usr/local/bin/codex --model $(touch /tmp/unsafe)'
        expect((await service.connect('terminal', { agent: 'codex', id: uuid(1) })).cliCommand).toBe(front.argv)
        expect(decideAgentCommand(front.argv, 'codex').inputCommand).toBe('codex')
    })
    test('does not inspect heads after the 2000-file or 90-day discovery budget', async () => {
        codex(1, { at: now - 91 * 86_400_000 })
        expect((await service.list('terminal')).truncated).toBe(true)
        expect((await service.list('terminal')).items).toEqual([])
        for (let i = 2; i <= 2003; i++) codex(i, { source: 'exec' })
        const result = await service.list('terminal')
        expect(result.truncated).toBe(true)
        expect(result.items).toEqual([])
    })
    test('rejects invalid ids before terminal input and unknown sessions', async () => {
        await expect(service.connect('terminal', { agent: 'codex', id: 'x; echo unsafe', resume: true })).rejects.toMatchObject({ code: 'invalid_id', status: 400 })
        await expect(service.list('missing')).rejects.toMatchObject({ code: 'unknown_session', status: 404 })
        await expect(service.connect('terminal', { agent: 'codex', id: uuid(1) })).rejects.toMatchObject({ code: 'not_found', status: 404 })
        expect(writes).toEqual([])
    })
    test('rejects cwd mismatch and linking to another terminal with conflict details', async () => {
        codex(1, { cwd: root })
        await expect(service.connect('terminal', { agent: 'codex', id: uuid(1) })).rejects.toMatchObject({ code: 'cwd_mismatch', status: 409 })
        codex(2)
        sessions.push({ id: 'other', name: 'Other', cwd, type: 'regular', cliToolName: 'codex', cliSessionId: uuid(2) })
        await expect(service.connect('terminal', { agent: 'codex', id: uuid(2), force: true })).rejects.toMatchObject({ code: 'linked_elsewhere', details: { linkedTo: { sessionId: 'other', name: 'Other' } } })
    })
    test('Claude in front cannot be overridden even with force', async () => {
        codex(1)
        front = { kind: 'claude', runningId: uuid(2), startedAt: now }
        await expect(service.connect('terminal', { agent: 'codex', id: uuid(1), force: true })).rejects.toMatchObject({ code: 'agent_running', details: { runningId: uuid(2) } })
        expect(sessions[0].cliSessionId).toBeUndefined()
    })
    test('a held Codex can only connect its own id and never a Claude conversation', async () => {
        codex(1)
        codex(2)
        claude(3)
        front = { kind: 'codex', runningId: uuid(1), startedAt: now }
        await expect(service.connect('terminal', { agent: 'codex', id: uuid(2), force: true })).rejects.toMatchObject({ code: 'agent_running' })
        await expect(service.connect('terminal', { agent: 'claude', id: uuid(3), force: true })).rejects.toMatchObject({ code: 'agent_running' })
        expect((await service.connect('terminal', { agent: 'codex', id: uuid(1) })).resumed).toBe(false)
    })
    test('an unheld Codex requires timing or explicit force and other programs save without typing', async () => {
        codex(1, { at: now - 60_000 })
        front = { kind: 'codex', runningId: null, startedAt: now }
        await expect(service.connect('terminal', { agent: 'codex', id: uuid(1) })).rejects.toMatchObject({ code: 'not_started_here' })
        await service.connect('terminal', { agent: 'codex', id: uuid(1), force: true })
        front = { kind: 'other', runningId: null, startedAt: now }
        await service.connect('terminal', { agent: 'codex', id: uuid(1) })
        expect(writes).toEqual([])
    })
    test('rechecks shell immediately before input and leaves the store untouched on failure', async () => {
        codex(1)
        let calls = 0
        service = new AgentConversations({
            sessions: () => sessions,
            foreground: async () => ++calls === 1 ? front : { kind: 'other', runningId: null, startedAt: now },
            update: (_id, values) => Object.assign(sessions[0], values), write: (_id, data) => writes.push(data),
            codexHome: () => path.join(root, 'codex'), claudeConfigDir: () => path.join(root, 'claude'), now: () => now, beforeResume: async () => {}
        })
        await expect(service.connect('terminal', { agent: 'codex', id: uuid(1), resume: true })).rejects.toMatchObject({ code: 'not_shell' })
        expect(sessions[0].cliSessionId).toBeUndefined()
        expect(writes).toEqual([])
    })
    test('refuses discovery-only sources when directly connecting and does not follow transcript symlinks', async () => {
        codex(1, { source: 'exec' })
        await expect(service.connect('terminal', { agent: 'codex', id: uuid(1) })).rejects.toMatchObject({ code: 'not_found' })
        const file = codex(2)
        const moved = path.join(root, 'outside.jsonl')
        fs.renameSync(file, moved)
        fs.symlinkSync(moved, file)
        expect((await service.list('terminal')).items).toEqual([])
    })
})
