import { test, expect } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { CodexSessionLocator, isInteractiveCodex, parseCodexResume, parseAgentProcesses, classifyAgentProcess, selectForegroundAgentProcess, findCodexProcess, readAgentProcesses, heldCodexRollouts } from '../../src/main/CodexSessionLocator'
import { CLISessionTracker } from '../../src/main/CLISessionTracker'

const IDS = Array.from({ length: 8 }, (_, n) => `00000000-0000-0000-0000-${String(n + 1).padStart(12, '0')}`)
function writeRollout(home: string, id: string, cwd: string, startedAt: number, source: unknown = 'cli', suffix = ''): string {
    const date = new Date(startedAt)
    const pad = (n: number): string => String(n).padStart(2, '0')
    const dir = path.join(home, 'sessions', String(date.getFullYear()), pad(date.getMonth() + 1), pad(date.getDate()))
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `rollout-${date.toISOString().slice(0, 19).replace(/:/g, '-')}-${id}${suffix}.jsonl`)
    const meta = { timestamp: date.toISOString(), type: 'session_meta', payload: { id, timestamp: date.toISOString(), cwd, source, originator: 'codex-tui', instructions: 'x'.repeat(20_000) } }
    fs.writeFileSync(file, JSON.stringify(meta) + '\n')
    return file
}

function fixture() {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'climanger-t25-d4-'))
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'climanger-t25-work-'))
    const stops: Array<() => void> = []
    const started = Date.now()
    let now = started
    let alive = true
    const locator = new CodexSessionLocator(home, {
        pollMs: 10,
        findProcess: async (pid) => ({ pid, startedAt: started + (pid - 100) * 20_000 }),
        heldRollouts: async () => [],
        isAlive: () => alive,
        now: () => now
    })
    const found: Record<string, string> = {}
    return {
        home, folder, started, locator, found,
        advance(ms: number) { now += ms },
        die() { alive = false },
        watch(id: string, at = started, shellPid = 100) {
            stops.push(locator.watch(folder, at, (value) => { found[id] = value }, { terminalId: id, shellPid }))
        },
        cleanup() { stops.forEach((stop) => stop()); fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(folder, { recursive: true, force: true }) }
    }
}

test.describe('T25 Codex session locator', () => {
    test('only interactive starts count; explicit resumes preserve the base command', () => {
        const split = (s: string): string[] => s.split(/\s+/)
        for (const command of ['codex', 'codex --dangerously-bypass-approvals-and-sandbox', 'codex -m gpt-5 fix the tests', '/opt/homebrew/bin/codex']) expect(isInteractiveCodex(split(command))).toBe(true)
        for (const command of ['codex exec do something', `codex resume ${IDS[0]}`, 'codex --version', '-c model=o3 codex', 'claude']) expect(isInteractiveCodex(split(command))).toBe(false)
        expect(parseCodexResume(split(`codex --model gpt-5 resume ${IDS[0]} --dangerously-bypass-approvals-and-sandbox`))).toEqual({ id: IDS[0], baseCommand: 'codex --model gpt-5 --dangerously-bypass-approvals-and-sandbox' })
        expect(parseCodexResume(split(`codex resume ${IDS[0]} --config resume=true`))).toEqual({ id: IDS[0], baseCommand: 'codex --config resume=true' })
        for (const command of ['codex resume --last', 'codex resume name', 'codex resume invalid;touch', `claude resume ${IDS[0]}`, `codex exec resume ${IDS[0]}`, 'codex --config resume=value', `codex resume ${IDS[0]} extra`, 'codex resume']) expect(parseCodexResume(split(command))).toBeNull()
    })

    test('typed and template resumes report the id without injecting flags', () => {
        const tracker = new CLISessionTracker()
        tracker.setAliases({ cx: 'codex --dangerously-bypass-approvals-and-sandbox' })
        const resumed: unknown[] = []
        tracker.onCodexResumed = (...args) => resumed.push(args)
        const writes: string[] = []
        for (const character of `cx resume ${IDS[0]}\r`) tracker.processInput('term', character, (data) => writes.push(data))
        expect(resumed).toEqual([['term', IDS[0], 'cx']])
        expect(writes).toEqual([])
        expect(tracker.codexResume(`codex -m gpt-5 resume ${IDS[0]}`)).toEqual({ id: IDS[0], baseCommand: 'codex -m gpt-5' })
    })

    test('two starts within ten seconds stay unassigned instead of taking each other’s files', async () => {
        const f = fixture()
        try {
            f.watch('a'); f.watch('b', f.started + 2_000)
            writeRollout(f.home, IDS[0], f.folder, f.started + 3_000)
            await new Promise((resolve) => setTimeout(resolve, 3_100))
            expect(f.found).toEqual({})
            expect(f.locator.exists(IDS[0])).toBe(true)
            expect(f.locator.exists(IDS[7])).toBe(false)
        } finally { f.cleanup() }
    })

    test('silent A does not steal the rollout of B started later in the same folder', async () => {
        const f = fixture()
        try {
            f.watch('a'); f.watch('b', f.started + 20_000, 101)
            writeRollout(f.home, IDS[0], f.folder, f.started + 21_000)
            await expect.poll(() => f.found, { timeout: 800 }).toEqual({ b: IDS[0] })
        } finally { f.cleanup() }
    })

    test('process start times replace equal input times before choosing between terminals', async () => {
        const f = fixture()
        try {
            f.watch('a'); f.watch('b', f.started, 101)
            writeRollout(f.home, IDS[0], f.folder, f.started + 21_000)
            await expect.poll(() => f.found, { timeout: 800 }).toEqual({ b: IDS[0] })
        } finally { f.cleanup() }
    })

    test('a process remains watched when its first rollout arrives sixteen minutes later', async () => {
        const f = fixture()
        try {
            f.watch('late')
            await new Promise((resolve) => setTimeout(resolve, 25))
            f.advance(16 * 60_000)
            writeRollout(f.home, IDS[0], f.folder, f.started + 1_000)
            await expect.poll(() => f.found.late, { timeout: 800 }).toBe(IDS[0])
        } finally { f.cleanup() }
    })

    test('the process holding a candidate wins even when starts are ambiguous', async () => {
        const f = fixture()
        const file = writeRollout(f.home, IDS[0], f.folder, f.started + 3_000)
        const held: number[] = []
        const locator = new CodexSessionLocator(f.home, {
            pollMs: 10,
            findProcess: async (pid) => ({ pid, startedAt: f.started }),
            heldRollouts: async (pid) => { held.push(pid); return pid === 102 ? [file] : [] },
            isAlive: () => true
        })
        const found: Record<string, string> = {}
        const stops = [locator.watch(f.folder, f.started, (id) => { found.a = id }, { terminalId: 'a', shellPid: 100 }), locator.watch(f.folder, f.started, (id) => { found.b = id }, { terminalId: 'b', shellPid: 102 })]
        try {
            await expect.poll(() => found, { timeout: 800 }).toEqual({ b: IDS[0] })
            await new Promise((resolve) => setTimeout(resolve, 40))
            expect(held.length).toBe(2)
        } finally { stops.forEach((stop) => stop()); f.cleanup() }
    })

    test('subagents and exec are ignored, cached files do not repeatedly invoke lsof', async () => {
        const f = fixture()
        const holds: number[] = []
        const locator = new CodexSessionLocator(f.home, { pollMs: 10, findProcess: async () => ({ pid: 123, startedAt: f.started }), heldRollouts: async (pid) => { holds.push(pid); return [] }, isAlive: () => true })
        let found = ''
        const stop = locator.watch(f.folder, f.started, (id) => { found = id }, { terminalId: 'a', shellPid: 100 })
        try {
            writeRollout(f.home, IDS[0], f.folder, f.started + 1_000, { subagent: { parent_thread_id: IDS[4] } })
            writeRollout(f.home, IDS[1], f.folder, f.started + 2_000, 'exec')
            await new Promise((resolve) => setTimeout(resolve, 65))
            expect(found).toBe('')
            writeRollout(f.home, IDS[2], f.folder, f.started + 3_000, 'vscode')
            await expect.poll(() => found, { timeout: 800 }).toBe(IDS[2])
            expect(holds).toEqual([123])
        } finally { stop(); f.cleanup() }
    })

    test('R6 one process lookup is allowed before any file; idle ticks use only PID liveness', async () => {
        const f = fixture()
        let processReads = 0
        let fileReads = 0
        const locator = new CodexSessionLocator(f.home, { pollMs: 10, findProcess: async () => { processReads++; return { pid: 123, startedAt: f.started } }, heldRollouts: async () => { fileReads++; return [] }, isAlive: () => true })
        const found: string[] = []
        const stop = locator.watch(f.folder, f.started, (id) => found.push(id), { terminalId: 'a', shellPid: 100 })
        try {
            writeRollout(f.home, IDS[0], f.folder, f.started + 1_000, 'exec')
            await new Promise((resolve) => setTimeout(resolve, 60))
            expect([processReads, fileReads]).toEqual([1, 0])
            writeRollout(f.home, IDS[1], f.folder, f.started + 2_000)
            await expect.poll(() => found, { timeout: 800 }).toEqual([IDS[1]])
            expect([processReads, fileReads]).toEqual([1, 1])
        } finally { stop(); f.cleanup() }
    })

    test('dead processes stop watching and suffixed rollout names still exist', async () => {
        const f = fixture()
        try {
            f.watch('dead')
            await new Promise((resolve) => setTimeout(resolve, 25))
            f.die()
            await new Promise((resolve) => setTimeout(resolve, 25))
            writeRollout(f.home, IDS[0], f.folder, f.started + 1_000, 'cli', '_chunk')
            await new Promise((resolve) => setTimeout(resolve, 45))
            expect(f.found).toEqual({})
            expect(f.locator.exists(IDS[0])).toBe(true)
        } finally { f.cleanup() }
    })

    test('one interval is shared and stops when the last watcher is removed', () => {
        const f = fixture()
        const realSet = global.setInterval
        const realClear = global.clearInterval
        let created = 0
        let cleared = 0
        global.setInterval = ((...args: Parameters<typeof setInterval>) => { created++; return realSet(...args) }) as typeof setInterval
        global.clearInterval = ((...args: Parameters<typeof clearInterval>) => { cleared++; return realClear(...args) }) as typeof clearInterval
        try {
            f.watch('a'); f.watch('b', f.started + 20_000, 101)
            expect(created).toBe(1)
            f.cleanup()
            expect(cleared).toBe(1)
        } finally { global.setInterval = realSet; global.clearInterval = realClear; f.cleanup() }
    })
    test('R4 null process lookup retries boundedly and never assigns an unrelated file', async () => {
        const f = fixture()
        let calls = 0
        let now = f.started
        const found: string[] = []
        const locator = new CodexSessionLocator(f.home, { pollMs: 10, findProcess: async () => { calls++; return null }, isAlive: () => true, heldRollouts: async () => [], now: () => now })
        const stop = locator.watch(f.folder, f.started, (id) => found.push(id), { terminalId: 'quit', shellPid: 100 })
        try {
            await new Promise((resolve) => setTimeout(resolve, 55))
            expect(calls).toBeGreaterThan(1)
            writeRollout(f.home, IDS[0], f.folder, f.started + 5_000)
            await new Promise((resolve) => setTimeout(resolve, 55))
            expect(found).toEqual([])
            now += 15 * 60_000 + 1
            await new Promise((resolve) => setTimeout(resolve, 30))
            const stoppedAt = calls
            await new Promise((resolve) => setTimeout(resolve, 30))
            expect(calls).toBe(stoppedAt)
        } finally { stop(); f.cleanup() }
    })

    test('R5 ambiguous files remain excluded after one process exits and another watch starts', async () => {
        const f = fixture()
        let aAlive = true
        const found: string[] = []
        const locator = new CodexSessionLocator(f.home, { pollMs: 10, findProcess: async (pid) => ({ pid, startedAt: f.started + (pid === 100 ? 0 : 3_000) }), isAlive: (pid) => pid !== 100 || aAlive, heldRollouts: async () => [] })
        const a = locator.watch(f.folder, f.started, (id) => found.push(id), { terminalId: 'a', shellPid: 100 })
        const b = locator.watch(f.folder, f.started + 3_000, (id) => found.push(id), { terminalId: 'b', shellPid: 101 })
        let c = () => {}
        try {
            writeRollout(f.home, IDS[0], f.folder, f.started + 4_000)
            writeRollout(f.home, IDS[1], f.folder, f.started + 5_000)
            await new Promise((resolve) => setTimeout(resolve, 60))
            expect(found).toEqual([])
            aAlive = false
            await new Promise((resolve) => setTimeout(resolve, 60))
            expect(found).toEqual([])
            a(); b()
            c = locator.watch(f.folder, f.started + 3_000, (id) => found.push(id), { terminalId: 'c', shellPid: 101 })
            await new Promise((resolve) => setTimeout(resolve, 60))
            expect(found).toEqual([])
        } finally { a(); b(); c(); f.cleanup() }
    })

    test('R10 lsof failure postpones every time fallback and retries without another ps', async () => {
        const f = fixture()
        const file = writeRollout(f.home, IDS[0], f.folder, f.started + 13_000)
        const found: Record<string, string> = {}
        let processReads = 0
        let first = true
        let fileReads = 0
        const locator = new CodexSessionLocator(f.home, { pollMs: 10, findProcess: async (pid) => { processReads++; return { pid, startedAt: f.started + (pid === 100 ? 0 : 12_000) } }, isAlive: () => true,
            heldRollouts: async (pid) => { fileReads++; if (pid === 100 && first) { first = false; return null } return pid === 100 ? [file] : [] }
        })
        const stops = [locator.watch(f.folder, f.started, (id) => { found.a = id }, { terminalId: 'a', shellPid: 100 }), locator.watch(f.folder, f.started + 12_000, (id) => { found.b = id }, { terminalId: 'b', shellPid: 101 })]
        try {
            await expect.poll(() => found, { timeout: 800 }).toEqual({ a: IDS[0] })
            expect(processReads).toBe(2)
            expect(fileReads).toBe(3)
        } finally { stops.forEach((stop) => stop()); f.cleanup() }
    })

    test('a process that exits without any rollout stops without rerunning ps', async () => {
        const f = fixture()
        let alive = true
        let reads = 0
        const found: string[] = []
        const locator = new CodexSessionLocator(f.home, { pollMs: 10, findProcess: async () => { reads++; return { pid: 123, startedAt: f.started } }, isAlive: () => alive, heldRollouts: async () => [] })
        const stop = locator.watch(f.folder, f.started, (id) => found.push(id), { terminalId: 'gone', shellPid: 100 })
        try {
            await new Promise((resolve) => setTimeout(resolve, 40))
            expect(reads).toBe(1)
            alive = false
            await new Promise((resolve) => setTimeout(resolve, 40))
            alive = true
            writeRollout(f.home, IDS[0], f.folder, f.started + 1_000)
            await new Promise((resolve) => setTimeout(resolve, 40))
            expect(found).toEqual([])
            expect(reads).toBe(1)
        } finally { stop(); f.cleanup() }
    })

    for (const [label, offset] of [['older than the lower window', -2_001], ['newer than the upper window', 30_001], ['other working directory', 1_000]] as const) {
        test(`the locator rejects ${label}`, async () => {
            const f = fixture()
            try {
                f.watch('a')
                writeRollout(f.home, IDS[0], label === 'other working directory' ? f.folder + '-other' : f.folder, f.started + offset)
                await new Promise((resolve) => setTimeout(resolve, 75))
                expect(f.found).toEqual({})
            } finally { f.cleanup() }
        })
    }

    test('stored ids supplied by isClaimed are excluded before choosing a newer candidate', async () => {
        const f = fixture()
        let fileReads = 0
        const locator = new CodexSessionLocator(f.home, { pollMs: 10, findProcess: async () => ({ pid: 123, startedAt: f.started }), isAlive: () => true, heldRollouts: async () => { fileReads++; return [] }, isClaimed: (id) => id === IDS[0] })
        const found: string[] = []
        const stop = locator.watch(f.folder, f.started, (id) => found.push(id), { terminalId: 'new', shellPid: 100 })
        try {
            writeRollout(f.home, IDS[0], f.folder, f.started + 1_000)
            writeRollout(f.home, IDS[1], f.folder, f.started + 2_000)
            await expect.poll(() => found, { timeout: 800 }).toEqual([IDS[1]])
            expect(fileReads).toBe(1)
        } finally { stop(); f.cleanup() }
    })

    test('an internally claimed id cannot be handed to a second watcher even when it holds the file', async () => {
        const f = fixture()
        const file = writeRollout(f.home, IDS[0], f.folder, f.started + 6_000)
        const locator = new CodexSessionLocator(f.home, { pollMs: 10, findProcess: async (pid) => ({ pid, startedAt: f.started + (pid === 100 ? 0 : 5_000) }), isAlive: () => true, heldRollouts: async () => [file] })
        const found: string[] = []
        const first = locator.watch(f.folder, f.started, (id) => found.push(id), { terminalId: 'first', shellPid: 100 })
        let second = () => {}
        try {
            await expect.poll(() => found.length, { timeout: 800 }).toBe(1)
            second = locator.watch(f.folder, f.started + 5_000, (id) => found.push(id), { terminalId: 'second', shellPid: 101 })
            await new Promise((resolve) => setTimeout(resolve, 60))
            expect(found).toEqual([IDS[0]])
        } finally { first(); second(); f.cleanup() }
    })

    test('R7 paste resumes are only candidates and never rewrite terminal input', () => {
        for (const chunks of [[...'codex resume ', IDS[0], '\r'], [`codex resume ${IDS[0]}\r`], ['\x1b[200~', `codex resume ${IDS[0]}`, '\x1b[201~', '\r']]) {
            const tracker = new CLISessionTracker()
            const seen: unknown[] = []
            const writes: string[] = []
            tracker.onCodexResumed = (...args) => seen.push(args)
            for (const chunk of chunks) expect(tracker.processInput('t', chunk, (value) => writes.push(value))).toBe(false)
            expect(seen).toEqual([['t', IDS[0], 'codex']])
            expect(writes).toEqual([])
        }
    })

    test('R7c resume flag values preserve their position and aliases remain resolvable', () => {
        const tracker = new CLISessionTracker()
        tracker.setAliases({ cx: 'codex --dangerously-bypass-approvals-and-sandbox' })
        expect(tracker.codexResume(`codex -m resume resume ${IDS[0]}`)).toEqual({ id: IDS[0], baseCommand: 'codex -m resume' })
        expect(tracker.codexResume(`cx -m resume resume ${IDS[0]}`)).toEqual({ id: IDS[0], baseCommand: 'cx -m resume' })
        expect(tracker.resolveAlias('cx')).toBe('codex --dangerously-bypass-approvals-and-sandbox')
    })

    test('pending input retains paste and marks cursor edits uncertain until submit or interrupt', () => {
        const tracker = new CLISessionTracker()
        tracker.processInput('t', 'half written', () => {})
        expect(tracker.getPendingInput('t')).toEqual({ text: 'half written', uncertain: false })
        tracker.processInput('t', '\x1b[D', () => {})
        tracker.processInput('t', '\x15', () => {})
        expect(tracker.getPendingInput('t').uncertain).toBe(true)
        tracker.processInput('t', '\x03', () => {})
        expect(tracker.getPendingInput('t')).toEqual({ text: '', uncertain: false })
    })

    test('terminal protocol replies leave empty pending input clean while real editing remains uncertain', () => {
        const tracker = new CLISessionTracker()
        for (const reply of ['\x1b[I', '\x1b[O', '\x1b[1;1R', '\x1b[?12;30R', '\x1b[?1;2c', '\x1b[>0;276;0c']) {
            tracker.processInput('t', reply, () => {})
            expect(tracker.getPendingInput('t')).toEqual({ text: '', uncertain: false })
            expect(tracker.hasReceivedInput('t')).toBe(false)
        }
        tracker.processInput('t', 'draft', () => {})
        tracker.processInput('t', '\x1b[I\x1b[1;1R', () => {})
        expect(tracker.getPendingInput('t')).toEqual({ text: 'draft', uncertain: false })
        expect(tracker.hasReceivedInput('t')).toBe(true)
        for (const edit of ['\x1b[D', '\x1b[A']) {
            tracker.processInput('t', edit, () => {})
            expect(tracker.getPendingInput('t').uncertain).toBe(true)
            tracker.processInput('t', '\x03', () => {})
            tracker.processInput('t', '\r', () => {})
            expect(tracker.hasReceivedInput('t')).toBe(true)
        }
        tracker.cleanup('t')
        expect(tracker.hasReceivedInput('t')).toBe(false)
    })

    test('actual ps and lsof parsers select the native foreground agent and distinguish failures', async () => {
        const ps = `100 1 100 200 Fri Nov  7 12:00:00 2025 /bin/zsh -l\n200 100 200 200 Fri Nov  7 12:00:01 2025 node /opt/npm/bin/codex.js --model resume resume ${IDS[0]}\n201 200 200 200 Fri Nov  7 12:00:02 2025 /opt/vendor/codex/codex --model resume resume ${IDS[0]}\n300 100 300 200 Fri Nov  7 12:00:03 2025 vim codex\n301 100 301 200 Fri Nov  7 12:00:04 2025 less claude\n`
        const rows = parseAgentProcesses(ps)
        expect(rows).toHaveLength(5)
        expect(classifyAgentProcess(rows![3])).toBeNull()
        expect(classifyAgentProcess(rows![4])).toBeNull()
        expect(classifyAgentProcess({ ...rows![1], argv: 'node -e codex' })).toBeNull()
        expect(classifyAgentProcess({ ...rows![1], argv: 'node --require /tmp/codex.js /tmp/other.js' })).toBeNull()
        expect(classifyAgentProcess(rows![1])).toBe('codex')
        expect(selectForegroundAgentProcess(rows!, 100)?.pid).toBe(201)
        const commands: Array<{ file: string; args: string[] }> = []
        const run = async (file: string, args: string[]) => { commands.push({ file, args }); return { stdout: file.endsWith('/ps') ? ps : `p201\nn/tmp/rollout-${IDS[0]}.jsonl\nn/tmp/rollout-${IDS[0]}.jsonl.langfuse\n` } }
        expect(await findCodexProcess(100, run)).toEqual({ pid: 201, startedAt: Date.parse('Fri Nov  7 12:00:02 2025') })
        expect(await heldCodexRollouts(201, run)).toEqual([`/tmp/rollout-${IDS[0]}.jsonl`])
        expect(commands[1].args).toContain('-nP')
        const failing = async () => { throw new Error('probe timed out') }
        expect(await readAgentProcesses(failing)).toBeNull()
        expect(await heldCodexRollouts(201, failing)).toBeNull()
    })

    test('N1 a process that starts after a null probe is found without assigning while the shell waits', async () => {
        const f = fixture()
        let checks = 0
        let ready = false
        const found: string[] = []
        const locator = new CodexSessionLocator(f.home, { pollMs: 10, findProcess: async (pid) => { checks++; return ready ? { pid, startedAt: f.started + 1_000 } : null }, isAlive: () => true, heldRollouts: async () => [] })
        const stop = locator.watch(f.folder, f.started, (id) => found.push(id), { terminalId: 'late', shellPid: 100 })
        try {
            writeRollout(f.home, IDS[0], f.folder, f.started + 2_000)
            await new Promise((resolve) => setTimeout(resolve, 45))
            expect(found).toEqual([])
            ready = true
            await expect.poll(() => found, { timeout: 800 }).toEqual([IDS[0]])
            expect(checks).toBeGreaterThan(1)
            const confirmedAt = checks
            await new Promise((resolve) => setTimeout(resolve, 30))
            expect(checks).toBe(confirmedAt)
        } finally { stop(); f.cleanup() }
    })

    test('N8 replacing the same terminal does not leave its own old start as an ambiguity', async () => {
        const f = fixture()
        const found: string[] = []
        const locator = new CodexSessionLocator(f.home, { pollMs: 10, findProcess: async (pid) => ({ pid, startedAt: f.started + 5_000 }), isAlive: () => true, heldRollouts: async () => [] })
        locator.watch(f.folder, f.started, () => {}, { terminalId: 'same', shellPid: 100 })()
        const stop = locator.watch(f.folder, f.started + 5_000, (id) => found.push(id), { terminalId: 'same', shellPid: 100 })
        try {
            writeRollout(f.home, IDS[0], f.folder, f.started + 6_000)
            await expect.poll(() => found, { timeout: 800 }).toEqual([IDS[0]])
        } finally { stop(); f.cleanup() }
    })

    test('N8 a held new parent file wins over an older unheld file inside the start slack', async () => {
        const f = fixture()
        const old = writeRollout(f.home, IDS[0], f.folder, f.started + 4_000)
        const current = writeRollout(f.home, IDS[1], f.folder, f.started + 6_000)
        const found: string[] = []
        const locator = new CodexSessionLocator(f.home, { pollMs: 10, findProcess: async (pid) => ({ pid, startedAt: f.started + 5_000 }), isAlive: () => true, heldRollouts: async () => [current] })
        locator.watch(f.folder, f.started, () => {}, { terminalId: 'same', shellPid: 100 })()
        const stop = locator.watch(f.folder, f.started + 5_000, (id) => found.push(id), { terminalId: 'same', shellPid: 100 })
        try {
            expect(old).not.toBe(current)
            await expect.poll(() => found, { timeout: 800 }).toEqual([IDS[1]])
        } finally { stop(); f.cleanup() }
    })

    test('N6 resume verification accepts the same native and node executable names as classification', () => {
        const tracker = new CLISessionTracker()
        for (const prefix of ['codex', '/opt/homebrew/bin/codex', '/x/vendor/codex-aarch64-apple-darwin', 'node /x/bin/codex', 'node /x/bin/codex.js', 'node --inspect /x/bin/codex.js']) {
            const line = `${prefix} -m resume resume ${IDS[0]}`
            expect(tracker.codexResume(line)).toEqual({ id: IDS[0], baseCommand: `${prefix} -m resume` })
        }
        for (const prefix of ['node -e codex', 'node --require /x/bin/codex.js /x/other.js', 'vim codex', 'less /x/bin/codex']) expect(tracker.codexResume(`${prefix} resume ${IDS[0]}`)).toBeNull()
    })

    test('N6 known remote and local-provider option values survive resume parsing', () => {
        const tracker = new CLISessionTracker()
        for (const option of ['--remote ws://localhost:1234', '--remote-auth-token-env TOKEN_VAR', '--local-provider ollama', '--local-provider resume']) {
            for (const prefix of ['codex', 'node /x/bin/codex.js']) {
                expect(tracker.codexResume(`${prefix} ${option} resume ${IDS[0]}`)).toEqual({ id: IDS[0], baseCommand: `${prefix} ${option}` })
            }
        }
    })

    test('N3 complete and split OSC/DCS replies preserve pending drafts and leave no protocol text', () => {
        for (const chunks of [
            ['\x1b]11;rgb:ffff/ffff/ffff\x07'],
            ['\x1b]11;rgb:', 'ffff/ffff/ffff', '\x07'],
            ['\x1b', ']11;rgb:ffff/ffff/ffff', '\x1b', '\\'],
            ['\x1bP1$r0m', '\x1b', '\\'],
            ['\x9d11;rgb:ffff/ffff/ffff', '\x9c'],
            ['\x1b', '[?12;', '30R']
        ]) {
            const tracker = new CLISessionTracker()
            tracker.processInput('t', 'draft', () => {})
            for (const chunk of chunks) tracker.processInput('t', chunk, () => {})
            expect(tracker.getPendingInput('t')).toEqual({ text: 'draft', uncertain: false })
            tracker.processInput('t', '\x1b[D', () => {})
            expect(tracker.getPendingInput('t').uncertain).toBe(true)
        }
    })

    test('N3 unfinished protocol responses stay uncertain and Ctrl+C restores clean input', () => {
        const tracker = new CLISessionTracker()
        tracker.processInput('t', '\x1b]11;rgb:', () => {})
        expect(tracker.getPendingInput('t')).toEqual({ text: '', uncertain: true })
        tracker.processInput('t', '\x03', () => {})
        expect(tracker.getPendingInput('t')).toEqual({ text: '', uncertain: false })
    })

})
