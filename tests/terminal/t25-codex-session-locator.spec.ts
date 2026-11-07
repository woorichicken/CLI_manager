import { test, expect } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { CodexSessionLocator, isInteractiveCodex, parseCodexResume } from '../../src/main/CodexSessionLocator'
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

    test('idle ticks do not launch ps or lsof; new valid candidates alone trigger them', async () => {
        const f = fixture()
        let processReads = 0
        let fileReads = 0
        const locator = new CodexSessionLocator(f.home, { pollMs: 10, findProcess: async () => { processReads++; return { pid: 123, startedAt: f.started } }, heldRollouts: async () => { fileReads++; return [] }, isAlive: () => true })
        const found: string[] = []
        const stop = locator.watch(f.folder, f.started, (id) => found.push(id), { terminalId: 'a', shellPid: 100 })
        try {
            writeRollout(f.home, IDS[0], f.folder, f.started + 1_000, 'exec')
            await new Promise((resolve) => setTimeout(resolve, 60))
            expect([processReads, fileReads]).toEqual([0, 0])
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
})
