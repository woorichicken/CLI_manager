import { test, expect } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { CodexSessionLocator, isInteractiveCodex } from '../../src/main/CodexSessionLocator'

/**
 * T23 — finding the conversation a Codex terminal started.
 *
 * Codex takes no session id from us; it writes a rollout file whose first line
 * names the conversation, its folder and its start time. These cases pin how
 * a terminal is matched to its rollout. Pure Node, no app.
 */
function writeRollout(home: string, id: string, cwd: string, startedAt: Date): void {
    const pad = (n: number): string => String(n).padStart(2, '0')
    const dir = path.join(home, 'sessions', String(startedAt.getFullYear()), pad(startedAt.getMonth() + 1), pad(startedAt.getDate()))
    fs.mkdirSync(dir, { recursive: true })
    // Shaped like codex-cli 0.155.1's session_meta, which runs past 8KB because it carries instructions.
    const meta = { timestamp: startedAt.toISOString(), ordinal: 0, type: 'session_meta', payload: { session_id: id, id, timestamp: startedAt.toISOString(), cwd, instructions: 'x'.repeat(20_000) } }
    fs.writeFileSync(path.join(dir, `rollout-${startedAt.toISOString().slice(0, 19).replace(/:/g, '-')}-${id}.jsonl`), JSON.stringify(meta) + '\n')
}

test.describe('T23 Codex session locator', () => {
    test('only an interactive codex start counts', () => {
        const split = (s: string): string[] => s.split(/\s+/)
        expect(isInteractiveCodex(split('codex'))).toBe(true)
        expect(isInteractiveCodex(split('codex --dangerously-bypass-approvals-and-sandbox'))).toBe(true)
        expect(isInteractiveCodex(split('codex -m gpt-5 fix the tests'))).toBe(true)
        expect(isInteractiveCodex(split('/opt/homebrew/bin/codex'))).toBe(true)
        expect(isInteractiveCodex(split('codex exec do something'))).toBe(false)
        expect(isInteractiveCodex(split('codex resume 01a0f528-7f14-7591-8327-a29f6c191685'))).toBe(false)
        expect(isInteractiveCodex(split('codex --version'))).toBe(false)
        expect(isInteractiveCodex(split('-c model=o3 codex'))).toBe(false)
        expect(isInteractiveCodex(split('claude'))).toBe(false)
    })

    test('the earliest new rollout in the same folder is the one, and each goes to one terminal', async () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'climanger-t23-'))
        const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'climanger-t23-work-'))
        const other = fs.mkdtempSync(path.join(os.tmpdir(), 'climanger-t23-other-'))
        try {
            const started = Date.now()
            writeRollout(home, '00000000-0000-0000-0000-00000000000a', folder, new Date(started - 3_600_000))  // an older conversation
            writeRollout(home, '00000000-0000-0000-0000-00000000000b', other, new Date(started + 1_000))       // another folder
            writeRollout(home, '00000000-0000-0000-0000-00000000000c', folder, new Date(started + 2_000))
            writeRollout(home, '00000000-0000-0000-0000-00000000000d', folder, new Date(started + 4_000))

            const locator = new CodexSessionLocator(home)
            const found: string[] = []
            const stops = [locator.watch(folder, started, (id) => found.push(id)), locator.watch(folder, started, (id) => found.push(id))]
            await expect.poll(() => found.length, { timeout: 10_000 }).toBe(2)
            stops.forEach((stop) => stop())
            expect(found.sort()).toEqual(['00000000-0000-0000-0000-00000000000c', '00000000-0000-0000-0000-00000000000d'])

            expect(locator.exists('00000000-0000-0000-0000-00000000000a')).toBe(true)
            expect(locator.exists('00000000-0000-0000-0000-0000000000ff')).toBe(false)
        } finally {
            for (const dir of [home, folder, other]) fs.rmSync(dir, { recursive: true, force: true })
        }
    })
})
