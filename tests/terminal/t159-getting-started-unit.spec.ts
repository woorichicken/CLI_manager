import { test, expect } from '@playwright/test'
import {
    BUILTIN_AGENT_TEMPLATES,
    agentOfCommand,
    beginGettingStarted,
    builtinTemplatesFor,
    gettingStartedVisible,
    isProjectFolder,
    latchGettingStarted,
    readGettingStartedState,
    type GettingStartedState
} from '../../src/shared/gettingStarted'
import { AgentCliChecker, GettingStarted, checkAgentClis, parseAgentCliFake, type ShellRunner } from '../../src/main/GettingStarted'
import type { Workspace } from '../../src/shared/types'

/**
 * T159 Getting started (fb-1120b) — the rules without Electron: which built-in rows the "+" menu
 * shows, what counts as a project folder, latching, the store reader, the main-side check with
 * fake process and conversation readers, and the claude/codex install check with a fake shell.
 */

const workspace = (over: Partial<Workspace>): Workspace => ({ id: 'w', name: 'w', path: '/tmp/w', sessions: [], createdAt: 0, ...over } as Workspace)

test.describe('built-in agent rows', () => {
    test('both rows, Claude first, when there are no templates', () => {
        expect(builtinTemplatesFor([]).map((t) => t.name)).toEqual(['Claude Code', 'Codex'])
        expect(BUILTIN_AGENT_TEMPLATES.map((t) => t.command)).toEqual(['claude', 'codex'])
    })

    test('a template of the person that starts the same program hides that row only', () => {
        const own = [{ id: 'a', name: 'My Claude', icon: 'code', description: '', command: 'claude --model opus' }]
        expect(builtinTemplatesFor(own).map((t) => t.agent)).toEqual(['codex'])
        const path = [{ id: 'b', name: 'X', icon: 'code', description: '', command: '/opt/bin/codex resume' }]
        expect(builtinTemplatesFor(path).map((t) => t.agent)).toEqual(['claude'])
        // an alias is not recognised: both rows stay
        expect(builtinTemplatesFor([{ id: 'c', name: 'cldy', icon: 'code', description: '', command: 'cldy' }])).toHaveLength(2)
    })

    test('agentOfCommand reads the first word only', () => {
        expect(agentOfCommand('claude')).toBe('claude')
        expect(agentOfCommand('  codex  --full-auto')).toBe('codex')
        expect(agentOfCommand('echo claude')).toBeNull()
        expect(agentOfCommand('claude-squad')).toBeNull()
        expect(agentOfCommand(undefined)).toBeNull()
    })
})

test.describe('checklist rules', () => {
    test('a project folder is one the person added', () => {
        expect(isProjectFolder(workspace({}))).toBe(true)
        expect(isProjectFolder(workspace({ isHome: true }))).toBe(false)
        expect(isProjectFolder(workspace({ isPlayground: true }))).toBe(false)
        expect(isProjectFolder(workspace({ parentWorkspaceId: 'p' }))).toBe(false)
        expect(isProjectFolder(workspace({ aiRegistration: { client: 'x', since: 1 } } as Partial<Workspace>))).toBe(false)
    })

    test('a step once done stays done; nothing new returns the same object', () => {
        const start = beginGettingStarted(null, 100)
        expect(start).toEqual({ startedAt: 100, dismissed: false, done: {} })
        const one = latchGettingStarted(start, { folder: true, agent: false })
        expect(one.done).toEqual({ folder: true })
        expect(latchGettingStarted(one, { folder: false })).toBe(one)
        expect(latchGettingStarted(one, {})).toBe(one)
    })

    test('a replay shows the card again and keeps what was done', () => {
        const before: GettingStartedState = { startedAt: 1, dismissed: true, done: { folder: true } }
        const again = beginGettingStarted(before, 2)
        expect(again).toEqual({ startedAt: 2, dismissed: false, done: { folder: true } })
        expect(gettingStartedVisible(again)).toBe(true)
        expect(gettingStartedVisible({ ...again, done: { folder: true, agent: true, chat: true } })).toBe(false)
        expect(gettingStartedVisible(before)).toBe(false)
        expect(gettingStartedVisible(null)).toBe(false)
    })

    test('the stored value is read defensively', () => {
        expect(readGettingStartedState(undefined)).toBeNull()
        expect(readGettingStartedState('x')).toBeNull()
        expect(readGettingStartedState({ dismissed: true })).toBeNull()
        expect(readGettingStartedState({ startedAt: 5, dismissed: 'yes', done: { folder: true, agent: 'yes', other: true } }))
            .toEqual({ startedAt: 5, dismissed: false, done: { folder: true } })
    })
})

test.describe('main-side check', () => {
    const make = (workspaces: Workspace[], options: { running?: Map<string, 'claude' | 'codex'> | null; talked?: Set<string> } = {}) => {
        let stored: unknown = undefined
        const calls = { ps: 0, read: 0 }
        const service = new GettingStarted({
            load: () => stored,
            save: (state) => { stored = JSON.parse(JSON.stringify(state)) },
            workspaces: () => workspaces,
            foregroundAgents: async () => { calls.ps++; return options.running === undefined ? new Map() : options.running },
            hasConversation: (id) => { calls.read++; return options.talked?.has(id) ?? false },
            now: () => 42
        })
        return { service, calls, stored: () => stored }
    }

    test('nothing is checked before the welcome screen was accepted', async () => {
        const { service, calls } = make([workspace({})])
        expect(await service.check()).toBeNull()
        expect(calls).toEqual({ ps: 0, read: 0 })
    })

    test('folder, then agent from the process list, then the first message', async () => {
        const sessions = [{ id: 's1', name: 's', cwd: '/tmp', type: 'regular', cliSessionId: 'c1', cliToolName: 'claude' }]
        const home = workspace({ id: 'home', isHome: true })
        const project = workspace({ id: 'p', sessions: sessions as Workspace['sessions'] })
        const running = new Map<string, 'claude' | 'codex'>()
        const talked = new Set<string>()
        const { service, stored } = make([home, project], { running, talked })
        service.begin()
        expect((await service.check())!.done).toEqual({ folder: true })
        running.set('s1', 'claude')
        expect((await service.check())!.done).toEqual({ folder: true, agent: true })
        running.clear() // the agent exited: the step stays done
        expect((await service.check())!.done).toEqual({ folder: true, agent: true })
        talked.add('s1')
        const last = await service.check()
        expect(last!.done).toEqual({ folder: true, agent: true, chat: true })
        expect(gettingStartedVisible(last)).toBe(false)
        expect(stored()).toEqual({ startedAt: 42, dismissed: false, done: { folder: true, agent: true, chat: true } })
    })

    test('a conversation proves the agent ran even if no process is seen', async () => {
        const project = workspace({ sessions: [{ id: 's1', name: 's', cwd: '/tmp', type: 'regular', cliSessionId: 'c1' }] as Workspace['sessions'] })
        const { service, calls } = make([project], { running: null, talked: new Set(['s1']) })
        service.begin()
        expect((await service.check())!.done).toEqual({ folder: true, agent: true, chat: true })
        expect(calls.ps).toBe(0)
    })

    test('only Home: the folder step stays open; a session without a conversation id is not read', async () => {
        const home = workspace({ isHome: true, sessions: [{ id: 's', name: 's', cwd: '/', type: 'regular' }] as Workspace['sessions'] })
        const { service, calls } = make([home])
        service.begin()
        expect((await service.check())!.done).toEqual({})
        expect(calls.read).toBe(0)
    })

    test('a closed card does no work', async () => {
        const { service, calls } = make([workspace({})])
        service.begin()
        service.dismiss()
        expect((await service.check())!.dismissed).toBe(true)
        expect(calls).toEqual({ ps: 0, read: 0 })
    })
})

test.describe('claude / codex install check', () => {
    const shell = (answers: Record<string, string | Error>): { run: ShellRunner; asked: string[][] } => {
        const asked: string[][] = []
        return {
            asked,
            run: async (_shell, args) => {
                asked.push(args)
                const answer = answers[args.slice(0, -1).join(' ')]
                if (answer instanceof Error) throw answer
                return answer ?? ''
            }
        }
    }

    test('found in the login shell: one shell only', async () => {
        const { run, asked } = shell({ '-l -c': 'Last login\nCLIM_FOUND_claude\nCLIM_FOUND_codex\n' })
        expect(await checkAgentClis('/bin/zsh', run)).toEqual({ claude: 'installed', codex: 'installed' })
        expect(asked).toHaveLength(1)
    })

    test('missing in the login shell is asked again in an interactive one (PATH set in .zshrc)', async () => {
        const { run, asked } = shell({
            '-l -c': 'CLIM_FOUND_claude\nCLIM_MISSING_codex\n',
            '-i -l -c': 'CLIM_FOUND_codex\n'
        })
        expect(await checkAgentClis('/bin/zsh', run)).toEqual({ claude: 'installed', codex: 'installed' })
        expect(asked[1].at(-1)).toContain('command -v codex')
        expect(asked[1].at(-1)).not.toContain('claude')
    })

    test('missing only when both shells say so; a failed or silent check is unknown', async () => {
        expect(await checkAgentClis('/bin/zsh', shell({ '-l -c': 'CLIM_MISSING_claude CLIM_MISSING_codex', '-i -l -c': 'CLIM_MISSING_claude CLIM_MISSING_codex' }).run))
            .toEqual({ claude: 'missing', codex: 'missing' })
        expect(await checkAgentClis('/bin/zsh', shell({ '-l -c': 'CLIM_MISSING_claude CLIM_MISSING_codex', '-i -l -c': new Error('timeout') }).run))
            .toEqual({ claude: 'unknown', codex: 'unknown' })
        expect(await checkAgentClis('/bin/zsh', shell({ '-l -c': new Error('timeout'), '-i -l -c': 'CLIM_MISSING_claude' }).run))
            .toEqual({ claude: 'unknown', codex: 'unknown' })
    })

    test('the test stand-in and the one-minute cache', async () => {
        expect(parseAgentCliFake('claude=installed, codex=missing')).toEqual({ claude: 'installed', codex: 'missing' })
        expect(parseAgentCliFake('')).toEqual({ claude: 'unknown', codex: 'unknown' })
        expect(parseAgentCliFake('claude=yes,gemini=installed')).toEqual({ claude: 'unknown', codex: 'unknown' })

        let now = 0
        let runs = 0
        const checker = new AgentCliChecker(async () => { runs++; return { claude: 'installed', codex: 'missing' } }, () => now)
        await Promise.all([checker.get(), checker.get()])
        expect(runs).toBe(1)
        now = 59_000
        await checker.get()
        expect(runs).toBe(1)
        now = 61_000
        await checker.get()
        expect(runs).toBe(2)
        const failing = new AgentCliChecker(async () => { throw new Error('x') })
        expect(await failing.get()).toEqual({ claude: 'unknown', codex: 'unknown' })
    })
})
