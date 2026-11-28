import { test, expect } from '@playwright/test'
import {
    AI_CONTROL_API_DOCS_URL,
    BUILTIN_AGENT_TEMPLATES,
    SKILL_INSTALL_COMMAND,
    agentOfCommand,
    beginGettingStarted,
    builtinTemplatesFor,
    gettingStartedReplayedDone,
    gettingStartedVisible,
    isProjectFolder,
    latchGettingStarted,
    readGettingStartedState,
    skillInstallPaths,
    stepsOf,
    type GettingStartedState
} from '../../src/shared/gettingStarted'
import { AgentCliChecker, GettingStarted, checkAgentClis, isSkillInstalled, parseAgentCliFake, type ShellRunner } from '../../src/main/GettingStarted'
import type { Workspace } from '../../src/shared/types'

/**
 * T159 Getting started (fb-1120b) — the rules without Electron: which built-in rows the "+" menu
 * shows, what counts as a project folder, latching, the store reader, the main-side check with
 * fake process and conversation readers, and the claude/codex install check with a fake shell.
 */

const workspace = (over: Partial<Workspace>): Workspace => ({ id: 'w', name: 'w', path: '/tmp/w', sessions: [], createdAt: 0, ...over } as Workspace)

test.describe('built-in agent rows', () => {
    test('every row, Claude first, when there are no templates', () => {
        expect(builtinTemplatesFor([]).map((t) => t.name)).toEqual(['Claude Code', 'Codex', 'Antigravity'])
        expect(BUILTIN_AGENT_TEMPLATES.map((t) => t.command)).toEqual(['claude', 'codex', 'agy'])
        expect(BUILTIN_AGENT_TEMPLATES.map((t) => t.id)).toEqual(['builtin-claude-code', 'builtin-codex', 'builtin-antigravity'])
    })

    test('a template of the person that starts the same program hides that row only', () => {
        const own = [{ id: 'a', name: 'My Claude', icon: 'code', description: '', command: 'claude --model opus' }]
        expect(builtinTemplatesFor(own).map((t) => t.agent)).toEqual(['codex', 'agy'])
        const path = [{ id: 'b', name: 'X', icon: 'code', description: '', command: '/opt/bin/codex resume' }]
        expect(builtinTemplatesFor(path).map((t) => t.agent)).toEqual(['claude', 'agy'])
        const agy = [{ id: 'd', name: 'Gemini', icon: 'code', description: '', command: 'agy --model gemini-3.8-flash-low' }]
        expect(builtinTemplatesFor(agy).map((t) => t.agent)).toEqual(['claude', 'codex'])
        // an alias is not recognised: every row stays
        expect(builtinTemplatesFor([{ id: 'c', name: 'cldy', icon: 'code', description: '', command: 'cldy' }])).toHaveLength(3)
    })

    test('agentOfCommand reads the first word only', () => {
        expect(agentOfCommand('claude')).toBe('claude')
        expect(agentOfCommand('  codex  --full-auto')).toBe('codex')
        expect(agentOfCommand('agy --conversation 1')).toBe('agy')
        expect(agentOfCommand('agyx')).toBeNull()
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
        expect(start).toEqual({ startedAt: 100, dismissed: false, done: {}, alreadyDone: [], withAiStep: true })
        const one = latchGettingStarted(start, { folder: true, agent: false })
        expect(one.done).toEqual({ folder: true })
        expect(latchGettingStarted(one, { folder: false })).toBe(one)
        expect(latchGettingStarted(one, {})).toBe(one)
    })

    test('a replay shows the card again and keeps what was done', () => {
        const before: GettingStartedState = { startedAt: 1, dismissed: true, done: { folder: true }, alreadyDone: [], withAiStep: true }
        const again = beginGettingStarted(before, 2)
        expect(again).toEqual({ startedAt: 2, dismissed: false, done: { folder: true }, alreadyDone: ['folder'], withAiStep: true })
        expect(gettingStartedVisible(again)).toBe(true)
        // finishing the rest during the replay still hides the card
        expect(gettingStartedVisible({ ...again, done: { folder: true, agent: true, chat: true, ai: true } })).toBe(false)
        // three of four is not enough any more
        expect(gettingStartedVisible({ ...again, done: { folder: true, agent: true, chat: true } })).toBe(true)
        expect(gettingStartedVisible(before)).toBe(false)
        expect(gettingStartedVisible(null)).toBe(false)
    })

    test('a replay after all four were done shows an «all done» card until ✕', () => {
        const finished: GettingStartedState = { startedAt: 1, dismissed: false, done: { folder: true, agent: true, chat: true, ai: true }, alreadyDone: [], withAiStep: true }
        expect(gettingStartedVisible(finished)).toBe(false)
        const again = beginGettingStarted(finished, 2)
        expect(again.alreadyDone).toEqual(['folder', 'agent', 'chat', 'ai'])
        expect(gettingStartedReplayedDone(again)).toBe(true)
        expect(gettingStartedVisible(again)).toBe(true)
        expect(gettingStartedVisible({ ...again, dismissed: true })).toBe(false)
    })

    test('the stored value is read defensively', () => {
        expect(readGettingStartedState(undefined)).toBeNull()
        expect(readGettingStartedState('x')).toBeNull()
        expect(readGettingStartedState({ dismissed: true })).toBeNull()
        expect(readGettingStartedState({ startedAt: 5, dismissed: 'yes', done: { folder: true, agent: 'yes', other: true } }))
            .toEqual({ startedAt: 5, dismissed: false, done: { folder: true }, alreadyDone: [] })
        // the four-step marker is kept only when it is exactly true; the live `ai` reading is never read back from the store
        expect(readGettingStartedState({ startedAt: 5, withAiStep: true, ai: { apiOn: true, skillFound: true } }))
            .toEqual({ startedAt: 5, dismissed: false, done: {}, alreadyDone: [], withAiStep: true })
        expect(readGettingStartedState({ startedAt: 5, withAiStep: 'yes' })!.withAiStep).toBeUndefined()
        // an «already done» step must also be done; anything else in the list is dropped
        expect(readGettingStartedState({ startedAt: 5, done: { folder: true }, alreadyDone: ['folder', 'agent', 'x'] })!.alreadyDone).toEqual(['folder'])
    })
})

test.describe('main-side check', () => {
    const make = (workspaces: Workspace[], options: { running?: Map<string, 'claude' | 'codex'> | null; talked?: Set<string>; started?: boolean; api?: { on: boolean }; skill?: { found: boolean }; stored?: unknown } = {}) => {
        let stored: unknown = options.stored
        const calls = { ps: 0, read: 0, api: 0, skill: 0 }
        const service = new GettingStarted({
            load: () => stored,
            save: (state) => { stored = JSON.parse(JSON.stringify(state)) },
            workspaces: () => workspaces,
            foregroundAgents: async () => { calls.ps++; return options.running === undefined ? new Map() : options.running },
            agentStarted: () => options.started ?? true,
            hasConversation: (id) => { calls.read++; return options.talked?.has(id) ?? false },
            controlApiRunning: () => { calls.api++; return options.api?.on ?? false },
            skillInstalled: () => { calls.skill++; return options.skill?.found ?? false },
            now: () => 42
        })
        return { service, calls, stored: () => stored }
    }

    test('nothing is checked before the welcome screen was accepted', async () => {
        const { service, calls } = make([workspace({})])
        expect(await service.check()).toBeNull()
        expect(calls).toMatchObject({ ps: 0, read: 0 })
    })

    test('folder, then agent from the process list, then the first message', async () => {
        const sessions = [{ id: 's1', name: 's', cwd: '/tmp', type: 'regular', cliSessionId: 'c1', cliToolName: 'claude' }]
        const home = workspace({ id: 'home', isHome: true })
        const project = workspace({ id: 'p', sessions: sessions as Workspace['sessions'] })
        const running = new Map<string, 'claude' | 'codex'>()
        const talked = new Set<string>()
        const api = { on: false }
        const skill = { found: false }
        const { service, stored } = make([home, project], { running, talked, api, skill })
        await service.begin()
        expect((await service.check())!.done).toEqual({ folder: true })
        running.set('s1', 'claude')
        expect((await service.check())!.done).toEqual({ folder: true, agent: true })
        running.clear() // the agent exited: the step stays done
        expect((await service.check())!.done).toEqual({ folder: true, agent: true })
        talked.add('s1')
        const three = await service.check()
        expect(three!.done).toEqual({ folder: true, agent: true, chat: true })
        // the fourth step is still open: the card stays up
        expect(gettingStartedVisible(three)).toBe(true)
        api.on = true // one condition is not enough
        expect((await service.check())!.done.ai).toBeUndefined()
        skill.found = true
        const last = await service.check()
        expect(last!.done).toEqual({ folder: true, agent: true, chat: true, ai: true })
        expect(gettingStartedVisible(last)).toBe(false)
        expect(stored()).toEqual({ startedAt: 42, dismissed: false, done: { folder: true, agent: true, chat: true, ai: true }, alreadyDone: [], withAiStep: true })
    })

    test('a conversation proves the agent ran even if no process is seen', async () => {
        const project = workspace({ sessions: [{ id: 's1', name: 's', cwd: '/tmp', type: 'regular', cliSessionId: 'c1' }] as Workspace['sessions'] })
        const { service, calls } = make([project], { running: null, talked: new Set(['s1']) })
        await service.begin()
        expect((await service.check())!.done).toEqual({ folder: true, agent: true, chat: true })
        expect(calls.ps).toBe(0)
    })

    test('the AI step needs the API running and the skill installed, and latches', async () => {
        const api = { on: false }
        const skill = { found: false }
        const { service, stored } = make([], { api, skill })
        const first = await service.begin()
        expect(first!.ai).toEqual({ apiOn: false, skillFound: false })
        api.on = true
        expect((await service.check())!.ai).toEqual({ apiOn: true, skillFound: false })
        skill.found = true
        const done = await service.check()
        expect(done!.done.ai).toBe(true)
        // the live reading is for the card only: it is not saved, and a finished step stops being read
        expect(done!.ai).toBeUndefined()
        expect(JSON.stringify(stored())).not.toContain('apiOn')
        api.on = false
        skill.found = false
        const after = await service.check()
        expect(after!.done.ai).toBe(true)
    })

    test('a finished AI step, a closed card and a legacy card read neither the API nor the skill folder', async () => {
        const open = make([], { api: { on: true }, skill: { found: true } })
        await open.service.begin()
        open.calls.api = 0
        open.calls.skill = 0
        await open.service.check() // ai already latched by begin()
        expect(open.calls).toMatchObject({ api: 0, skill: 0 })

        const closed = make([], { api: { on: true }, skill: { found: true } })
        await closed.service.begin()
        closed.service.dismiss()
        closed.calls.api = 0
        closed.calls.skill = 0
        await closed.service.check()
        expect(closed.calls).toMatchObject({ api: 0, skill: 0 })

        const legacy = make([workspace({})], { stored: { startedAt: 1, dismissed: false, done: {}, alreadyDone: [] } })
        const result = await legacy.service.check()
        expect(result!.ai).toBeUndefined()
        expect(legacy.calls).toMatchObject({ api: 0, skill: 0 })
    })

    test('a card stored before the AI step keeps three steps: a finished or closed one never comes back', async () => {
        const finished = { startedAt: 1, dismissed: false, done: { folder: true, agent: true, chat: true }, alreadyDone: [] }
        expect(stepsOf(readGettingStartedState(finished)!)).toHaveLength(3)
        expect(gettingStartedVisible(readGettingStartedState(finished))).toBe(false)
        const closed = make([workspace({})], { stored: { ...finished, done: {}, dismissed: true } })
        expect(gettingStartedVisible(await closed.service.check())).toBe(false)
        // in progress: it finishes on the original three, and the API is never asked about
        const partway = make([workspace({})], { stored: { startedAt: 1, dismissed: false, done: { agent: true, chat: true }, alreadyDone: [] } })
        const checked = await partway.service.check()
        expect(checked!.done).toEqual({ folder: true, agent: true, chat: true })
        expect(gettingStartedVisible(checked)).toBe(false)
        // «Show Again» turns the fourth step on and marks the three as already done
        const replay = await partway.service.begin()
        expect(replay!.withAiStep).toBe(true)
        expect(replay!.alreadyDone).toEqual(['folder', 'agent', 'chat'])
        expect(gettingStartedVisible(replay)).toBe(true)
    })

    test('«Show Again» with the API already on and the skill installed still shows an all-done card', async () => {
        // the person who set everything up before this step existed: the replay's first look finds the fourth step done
        const finished = { startedAt: 1, dismissed: false, done: { folder: true, agent: true, chat: true }, alreadyDone: [] }
        const { service, stored } = make([workspace({})], { stored: finished, api: { on: true }, skill: { found: true } })
        const replay = await service.begin()
        expect(replay!.done).toEqual({ folder: true, agent: true, chat: true, ai: true })
        expect(replay!.alreadyDone).toEqual(['folder', 'agent', 'chat', 'ai'])
        expect(gettingStartedReplayedDone(replay!)).toBe(true)
        expect(gettingStartedVisible(replay)).toBe(true)
        expect(replay!.ai).toBeUndefined()
        expect(JSON.stringify(stored())).not.toContain('apiOn')
        // a first run is not a replay: what is already true is ticked, not marked «Already done»
        const first = make([workspace({})], { api: { on: true }, skill: { found: true }, started: false })
        const fresh = await first.service.begin()
        expect(fresh!.done).toEqual({ folder: true, ai: true })
        expect(fresh!.alreadyDone).toEqual([])
    })

    test('the skill folder is looked for under Claude Code, the shared agents folder and Codex', () => {
        expect(skillInstallPaths('/h')).toEqual([
            '/h/.claude/skills/climanager-session/SKILL.md',
            '/h/.agents/skills/climanager-session/SKILL.md',
            '/h/.codex/skills/climanager-session/SKILL.md'
        ])
        expect(isSkillInstalled('/h', () => false)).toBe(false)
        for (const path of skillInstallPaths('/h')) expect(isSkillInstalled('/h', (p) => p === path)).toBe(true)
        expect(isSkillInstalled('/h', (p) => p === '/h/.claude/skills/other/SKILL.md')).toBe(false)
    })

    test('the install command and docs address are the published ones', () => {
        expect(SKILL_INSTALL_COMMAND).toBe('npx skills add woorichicken/climanager-session@climanager-session -g')
        expect(AI_CONTROL_API_DOCS_URL).toBe('https://climanager.solhun.com/docs/ai-control-api')
    })

    test('only Home: the folder step stays open; a session without a conversation id is not read', async () => {
        const home = workspace({ isHome: true, sessions: [{ id: 's', name: 's', cwd: '/', type: 'regular' }] as Workspace['sessions'] })
        const { service, calls } = make([home])
        await service.begin()
        expect((await service.check())!.done).toEqual({})
        expect(calls.read).toBe(0)
    })

    test('no agent started yet: the process list is not read', async () => {
        const { service, calls } = make([workspace({})], { started: false, running: new Map([['x', 'claude']]) })
        expect((await service.begin())!.done).toEqual({ folder: true })
        expect(calls.ps).toBe(0)
    })

    test('a replay after everything was done costs no ps and no read', async () => {
        const { service, calls } = make([workspace({})])
        await service.begin()
        await service.check()
        const store = (service as unknown as { deps: { save(s: GettingStartedState): void } }).deps
        store.save({ startedAt: 1, dismissed: true, done: { folder: true, agent: true, chat: true, ai: true }, alreadyDone: [], withAiStep: true })
        const again = await service.begin()
        expect(again!.alreadyDone).toEqual(['folder', 'agent', 'chat', 'ai'])
        calls.ps = 0
        calls.read = 0
        expect(gettingStartedVisible(await service.check())).toBe(true)
        expect(calls).toMatchObject({ ps: 0, read: 0 })
    })

    test('a closed card does no work', async () => {
        const { service, calls } = make([workspace({})])
        await service.begin()
        service.dismiss()
        calls.ps = 0
        calls.read = 0
        expect((await service.check())!.dismissed).toBe(true)
        expect(calls).toMatchObject({ ps: 0, read: 0 })
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
        const { run, asked } = shell({ '-l -c': 'Last login\nCLIM_FOUND_claude\nCLIM_FOUND_codex\nCLIM_FOUND_agy\n' })
        expect(await checkAgentClis('/bin/zsh', run)).toEqual({ claude: 'installed', codex: 'installed', agy: 'installed' })
        expect(asked).toHaveLength(1)
    })

    test('missing in the login shell is asked again in an interactive one (PATH set in .zshrc)', async () => {
        const { run, asked } = shell({
            '-l -c': 'CLIM_FOUND_claude\nCLIM_MISSING_codex\nCLIM_FOUND_agy\n',
            '-i -l -c': 'CLIM_FOUND_codex\n'
        })
        expect(await checkAgentClis('/bin/zsh', run)).toEqual({ claude: 'installed', codex: 'installed', agy: 'installed' })
        expect(asked[1].at(-1)).toContain('command -v codex')
        expect(asked[1].at(-1)).not.toContain('claude')
    })

    test('missing only when both shells say so; a failed or silent check is unknown', async () => {
        const allMissing = 'CLIM_MISSING_claude CLIM_MISSING_codex CLIM_MISSING_agy'
        expect(await checkAgentClis('/bin/zsh', shell({ '-l -c': allMissing, '-i -l -c': allMissing }).run))
            .toEqual({ claude: 'missing', codex: 'missing', agy: 'missing' })
        expect(await checkAgentClis('/bin/zsh', shell({ '-l -c': allMissing, '-i -l -c': new Error('timeout') }).run))
            .toEqual({ claude: 'unknown', codex: 'unknown', agy: 'unknown' })
        expect(await checkAgentClis('/bin/zsh', shell({ '-l -c': new Error('timeout'), '-i -l -c': 'CLIM_MISSING_claude' }).run))
            .toEqual({ claude: 'unknown', codex: 'unknown', agy: 'unknown' })
    })

    test('the test stand-in and the one-minute cache', async () => {
        expect(parseAgentCliFake('claude=installed, codex=missing, agy=missing')).toEqual({ claude: 'installed', codex: 'missing', agy: 'missing' })
        expect(parseAgentCliFake('')).toEqual({ claude: 'unknown', codex: 'unknown', agy: 'unknown' })
        expect(parseAgentCliFake('claude=yes,gemini=installed')).toEqual({ claude: 'unknown', codex: 'unknown', agy: 'unknown' })

        let now = 0
        let runs = 0
        const checker = new AgentCliChecker(async () => { runs++; return { claude: 'installed', codex: 'missing', agy: 'installed' } }, () => now)
        await Promise.all([checker.get(), checker.get()])
        expect(runs).toBe(1)
        now = 59_000
        await checker.get()
        expect(runs).toBe(1)
        now = 61_000
        await checker.get()
        expect(runs).toBe(2)
        const failing = new AgentCliChecker(async () => { throw new Error('x') })
        expect(await failing.get()).toEqual({ claude: 'unknown', codex: 'unknown', agy: 'unknown' })
    })
})
