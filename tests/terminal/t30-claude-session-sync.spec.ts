import { test, expect } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { launchAppWithWorkspaces, closeApp, termText, writeToTerminal, LaunchResult } from './helpers'

/**
 * T30 — the remembered conversation follows the one Claude is actually on.
 *
 * The app records a conversation id once, when it starts Claude with
 * `--session-id`. `/resume` inside Claude moves to another conversation under
 * a new id, and the injected one never gets a transcript (measured on Claude
 * Code 2.1.296). Startup then drops the id as stale and a template session
 * runs its start command again — a fresh conversation instead of the one the
 * user was in.
 *
 * Claude Code writes `<config>/sessions/<pid>.json` for each running process.
 * The app reads it and keeps the stored id in step. Here `sleep` processes
 * started from the terminal's shell stand in for Claude, with registry files
 * written by the test.
 */

const STORED_ID = '30303030-0000-0000-0000-000000000001'
const NESTED_ID = '30303030-0000-0000-0000-000000000002'
const ACTUAL_ID = '30303030-0000-0000-0000-000000000003'

function storedSession(userDataDir: string): { cliSessionId?: string; cliToolName?: string; cliCommand?: string } {
    const config = JSON.parse(fs.readFileSync(path.join(userDataDir, 'config.json'), 'utf8'))
    for (const workspace of config.workspaces) {
        for (const session of workspace.sessions) if (session.id === 's-claude') return session
    }
    return {}
}

function writeRegistry(configDir: string, pid: number, sessionId: string): void {
    const dir = path.join(configDir, 'sessions')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `${pid}.json`), JSON.stringify({ pid, sessionId, startedAt: Date.now(), kind: 'interactive' }))
}

test.describe('T30 Claude conversation sync', () => {
    let ctx: LaunchResult | null = null
    const temps: string[] = []

    test.afterEach(async () => {
        if (ctx) {
            // The stand-in processes belong to the shell and die with it, but do not wait on that.
            await writeToTerminal(ctx.page, 's-claude', 'kill %1 %2 2>/dev/null\r').catch(() => undefined)
            await closeApp(ctx)
        }
        ctx = null
        for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
    })

    test('the stored id moves to the conversation the shell-level Claude reports', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'climanger-t30-'))
        const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'climanger-t30-claude-'))
        temps.push(dir, configDir)
        // Startup keeps a stored id only when its transcript exists.
        fs.mkdirSync(path.join(configDir, 'projects', 'p'), { recursive: true })
        fs.writeFileSync(path.join(configDir, 'projects', 'p', `${STORED_ID}.jsonl`), '{}\n')

        ctx = await launchAppWithWorkspaces([{
            id: 'ws', name: 'T30WS', path: dir,
            sessions: [{
                id: 's-claude',
                name: 'T30CLAUDE',
                cliSessionId: STORED_ID,
                cliToolName: 'claude',
                // Resuming a stand-in must not start anything real.
                cliCommand: 'echo T30-CLDY'
            }]
        }], { env: { CLAUDE_CONFIG_DIR: configDir, CLIMANAGER_CLAUDE_SYNC_MS: '300' } })

        await ctx.page.locator('[data-session-item="s-claude"]').click()
        await expect.poll(() => termText(ctx!.page, 's-claude'), { timeout: 20_000 }).toContain('T30-CLDY --resume')

        // OUTER is a child of the shell; INNER is a child of OUTER — a Claude
        // started by Claude, say. One level deeper must lose to the outer one.
        await writeToTerminal(
            ctx.page,
            's-claude',
            `sh -c 'sleep 600 & echo T30-INNER=$!; wait' & echo T30-OUTER=$!\r`
        )
        await expect.poll(() => termText(ctx!.page, 's-claude'), { timeout: 10_000 }).toMatch(/T30-INNER=\d+/)
        const text = await termText(ctx.page, 's-claude')
        const outer = Number(text.match(/T30-OUTER=(\d+)/)?.[1])
        const inner = Number(text.match(/T30-INNER=(\d+)/)?.[1])
        expect(outer).toBeGreaterThan(0)
        expect(inner).toBeGreaterThan(0)

        // Only the nested process reports: it is still the closest Claude, so it counts.
        writeRegistry(configDir, inner, NESTED_ID)
        await expect.poll(() => storedSession(ctx!.userDataDir).cliSessionId, { timeout: 10_000 }).toBe(NESTED_ID)

        // The shell-level process reports too: it wins.
        writeRegistry(configDir, outer, ACTUAL_ID)
        await expect.poll(() => storedSession(ctx!.userDataDir).cliSessionId, { timeout: 10_000 }).toBe(ACTUAL_ID)

        const session = storedSession(ctx.userDataDir)
        expect(session.cliToolName).toBe('claude')
        expect(session.cliCommand, 'the start command (an alias like cldy) is kept for the resume').toBe('echo T30-CLDY')
    })

    test('a registry entry from a process outside every terminal changes nothing', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'climanger-t30-'))
        const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'climanger-t30-claude-'))
        temps.push(dir, configDir)
        fs.mkdirSync(path.join(configDir, 'projects', 'p'), { recursive: true })
        fs.writeFileSync(path.join(configDir, 'projects', 'p', `${STORED_ID}.jsonl`), '{}\n')

        ctx = await launchAppWithWorkspaces([{
            id: 'ws', name: 'T30WS2', path: dir,
            sessions: [{ id: 's-claude', name: 'T30OTHER', cliSessionId: STORED_ID, cliToolName: 'claude', cliCommand: 'echo T30-CLDY' }]
        }], { env: { CLAUDE_CONFIG_DIR: configDir, CLIMANAGER_CLAUDE_SYNC_MS: '300' } })

        // This test process is not under any terminal of the app.
        writeRegistry(configDir, process.pid, ACTUAL_ID)
        await ctx.page.waitForTimeout(2000)
        expect(storedSession(ctx.userDataDir).cliSessionId).toBe(STORED_ID)
    })
})
