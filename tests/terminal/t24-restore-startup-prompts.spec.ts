import { test, expect } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { launchAppWithWorkspaces, closeApp, termText, LaunchResult, REPO_ROOT } from './helpers'
import { startupPromptAnswer } from '../../src/renderer/src/utils/startupPrompts'

/**
 * T24 — a restored Claude session gets past the folder-trust question.
 *
 * Claude Code asks whether to trust a folder it has no record for, and never
 * keeps one for the home folder, so a session restored there stops on the
 * question after every update or restart. The cursor starts on "No, exit".
 * The mock agent draws the same dialog (--claude-trust) and prints TRUSTED or
 * EXITED, so the outcome is read from what the program printed.
 */
const MOCK = `node ${path.join(REPO_ROOT, 'scripts/mock-cli/agent-mock.cjs')} --claude-trust`

function seedClaudeTranscript(sessionId: string): string {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'climanger-t22-claude-'))
    const projectDir = path.join(configDir, 'projects', 'seeded-project')
    fs.mkdirSync(projectDir, { recursive: true })
    fs.writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), '{"type":"seed"}\n')
    return configDir
}

test.describe('T24 restore startup prompts', () => {
    let ctx: LaunchResult
    const temps: string[] = []

    test.afterEach(async () => {
        if (ctx) await closeApp(ctx)
        for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
    })

    test('the answer is computed from the real dialog layout', () => {
        // As Claude Code 2.1.286 drew it on 2026-10-01, with an old prompt line above.
        const screen = [
            '❯ an earlier prompt',
            ' Quick safety check: Is this a project you created or one you trust?',
            ' ❯ No, exit',
            '   Yes, I trust this folder',
            ' Enter to confirm · Esc to cancel'
        ]
        // One key per press: Claude Code ignores arrow + Enter arriving as one chunk.
        expect(startupPromptAnswer(screen)).toEqual(['\x1b[B', '\r'])
        expect(startupPromptAnswer(['   No, exit', ' ❯ Yes, I trust this folder'])).toEqual(['\r'])
        expect(startupPromptAnswer(['❯ hello', 'nothing to answer'])).toBeNull()

        // Codex 0.155.1, 2026-10-01: the update offer has "Update now" highlighted; "2" skips.
        expect(startupPromptAnswer([
            '  ✨  Update available! 0.155.1 -> 0.159.2',
            '› 1. Update now (runs `brew upgrade --cask codex`)',
            '  2. Skip',
            '  3. Skip until next version',
            '  Press enter to continue'
        ])).toEqual(['2'])
        // Its trust question already has Yes highlighted; "1" alone did not confirm, Enter did.
        expect(startupPromptAnswer([
            '> You are in /private/tmp/x',
            '  Do you trust the contents of this directory? Working with untrusted contents',
            '› 1. Yes, continue',
            '  2. No, quit',
            '  Press enter to continue'
        ])).toEqual(['\r'])
    })

    test('a restored session answers Yes; a fresh start is left to the user', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'climanger-t22-'))
        temps.push(dir)
        const sessionId = '22222222-3333-4444-5555-666666666666'
        const claudeConfigDir = seedClaudeTranscript(sessionId)
        temps.push(claudeConfigDir)

        ctx = await launchAppWithWorkspaces([{
            id: 'ws', name: 'T22WS', path: dir,
            sessions: [
                // Restored: resumes with `<cliCommand> --resume <id>`.
                { id: 's-restored', name: 'T22RESTORED', initialCommand: MOCK, cliSessionId: sessionId, cliToolName: 'claude', cliCommand: MOCK },
                // Started fresh: a person may be watching and should decide.
                { id: 's-fresh', name: 'T22FRESH', initialCommand: MOCK }
            ]
        }], { env: { CLAUDE_CONFIG_DIR: claudeConfigDir } })

        await expect.poll(() => termText(ctx.page, 's-restored'), { timeout: 30_000 }).toContain('TRUSTED')
        expect(await termText(ctx.page, 's-restored')).not.toContain('EXITED')

        await expect.poll(() => termText(ctx.page, 's-fresh'), { timeout: 30_000 }).toContain('Yes, I trust this folder')
        await ctx.page.waitForTimeout(1_500)
        const fresh = await termText(ctx.page, 's-fresh')
        expect(fresh).not.toContain('TRUSTED')
        expect(fresh).not.toContain('EXITED')

        expect(ctx.pageErrors).toEqual([])
    })

    test('a restored Codex session resumes with the subcommand and skips the update offer', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'climanger-t22-codex-'))
        temps.push(dir)
        const conversation = '01a0f528-7f14-7591-8327-a29f6c191685'
        // Startup keeps a Codex id only when its rollout still exists under CODEX_HOME.
        const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'climanger-t22-codexhome-'))
        temps.push(codexHome)
        const day = path.join(codexHome, 'sessions', '2026', '10', '01')
        fs.mkdirSync(day, { recursive: true })
        fs.writeFileSync(path.join(day, `rollout-2026-10-01T10-51-07-${conversation}.jsonl`), '{"type":"session_meta"}\n')
        const codexMock = `node ${path.join(REPO_ROOT, 'scripts/mock-cli/agent-mock.cjs')} --codex-update`

        ctx = await launchAppWithWorkspaces([{
            id: 'ws', name: 'T22CODEX', path: dir,
            sessions: [{ id: 's-codex', name: 'T22CODEXS', initialCommand: codexMock, cliSessionId: conversation, cliToolName: 'codex', cliCommand: codexMock }]
        }], { env: { CODEX_HOME: codexHome } })

        await expect.poll(() => termText(ctx.page, 's-codex'), { timeout: 30_000 }).toContain('UPDATE-SKIPPED')
        const text = await termText(ctx.page, 's-codex')
        // The command line wraps at the terminal width.
        expect(text.replace(/\n/g, '')).toContain(`--codex-update resume ${conversation}`)
        expect(text).not.toContain('UPDATE-RUN')
        expect(ctx.pageErrors).toEqual([])
    })
})
