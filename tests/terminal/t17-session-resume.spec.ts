import { test, expect } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { launchAppWithWorkspaces, closeApp, termText, LaunchResult } from './helpers'

/**
 * Startup drops any session id whose Claude transcript is gone, so a seeded id
 * only survives if the matching file exists. CLAUDE_CONFIG_DIR points that scan
 * at a temp directory instead of the real ~/.claude.
 */
function seedClaudeTranscript(sessionId: string): string {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'climanger-t17-claude-'))
    const projectDir = path.join(configDir, 'projects', 'seeded-project')
    fs.mkdirSync(projectDir, { recursive: true })
    fs.writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), '{"type":"seed"}\n')
    return configDir
}

/**
 * T17 — a restart resumes the conversation, with the command that started it.
 *
 * The app injects `--session-id` when an agent starts so the next launch can
 * `--resume` the same conversation. Two things had to hold and only one did:
 * the id has to be captured (T9 covers that), and the resume has to repeat the
 * *original* command. Rebuilding it as `claude --resume …` drops whatever an
 * alias carried — `cldy` is `claude --dangerously-skip-permissions`, so the
 * resumed session would start asking for approvals the user had opted out of.
 *
 * The terminal is driven with `echo` stand-ins: this is about which command
 * line the app types, not about Claude Code itself.
 */
test.describe('T17 session resume', () => {
    let ctx: LaunchResult
    const temps: string[] = []
    const tempDir = (): string => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'climanger-t17-'))
        temps.push(dir)
        return dir
    }

    test.afterEach(async () => {
        if (ctx) await closeApp(ctx)
        for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
    })

    test('a tracked session resumes with its own command, not a rebuilt one', async () => {
        const dir = tempDir()
        const sessionId = '11111111-2222-3333-4444-555555555555'
        const claudeConfigDir = seedClaudeTranscript(sessionId)
        temps.push(claudeConfigDir)

        ctx = await launchAppWithWorkspaces([{
            id: 'ws', name: 'T17WS', path: dir,
            sessions: [{
                id: 's-resume',
                name: 'T17RESUME',
                // What a template session looks like after the app tracked it.
                initialCommand: 'echo T17-FRESH-START',
                cliSessionId: sessionId,
                cliToolName: 'claude',
                cliCommand: 'echo T17-CLDY'
            }]
        }], { env: { CLAUDE_CONFIG_DIR: claudeConfigDir } })

        await ctx.page.locator('[data-session-item="s-resume"]').click()
        await expect
            .poll(() => termText(ctx.page, 's-resume'), { timeout: 20_000 })
            .toContain(`T17-CLDY --resume ${sessionId}`)

        const text = await termText(ctx.page, 's-resume')
        expect(text, 'a resumed session must not re-run its start command').not.toContain('T17-FRESH-START')
    })

    test('an untracked session just runs its start command', async () => {
        const dir = tempDir()
        ctx = await launchAppWithWorkspaces([{
            id: 'ws', name: 'T17WS2', path: dir,
            sessions: [{ id: 's-fresh', name: 'T17FRESH', initialCommand: 'echo T17-NO-SESSION-ID' }]
        }])

        await ctx.page.locator('[data-session-item="s-fresh"]').click()
        await expect
            .poll(() => termText(ctx.page, 's-fresh'), { timeout: 20_000 })
            .toContain('T17-NO-SESSION-ID')
    })
})
