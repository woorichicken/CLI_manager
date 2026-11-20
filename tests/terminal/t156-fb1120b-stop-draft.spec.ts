import { test, expect } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { closeApp, launchAppWithWorkspaces, LaunchResult, REPO_ROOT, resizeMainWindow, waitForBufferText } from './helpers'

/**
 * T156 — fb-1120b 682ea4de: Stop in Chat before Claude answered.
 *
 * Claude Code, stopped early, puts the sent prompt back in its input box. Chat now takes it into its own
 * message box (and empties the terminal's), as switching views would — before, the words sat in the
 * terminal and the next Chat send was refused with «The terminal input line already has text».
 * chat-mock `--restore-on-esc` does what Claude does on Esc.
 */

const ID = 't156-claude'
const CLAUDE_ID = '00000000-0000-4000-8000-00000000f156'
const MOCK = path.join(REPO_ROOT, 'scripts/mock-cli/chat-mock.cjs')
const FIXTURES = path.join(__dirname, 'fixtures/transcripts')
const claudeProjectSlug = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, '-')

let result: LaunchResult | null = null
test.afterEach(async () => {
    if (result) await closeApp(result)
    result = null
})

test('T156 682ea4de: Stop before the answer brings the prompt back to the Chat box', async () => {
    test.setTimeout(120_000)
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'climanager-t156-'))
    const project = path.join(home, 'project')
    fs.mkdirSync(project)
    const claudeDir = path.join(home, 'claude')
    const transcript = path.join(claudeDir, 'projects', claudeProjectSlug(project), `${CLAUDE_ID}.jsonl`)
    fs.mkdirSync(path.dirname(transcript), { recursive: true })
    fs.copyFileSync(path.join(FIXTURES, 'claude/tools.jsonl'), transcript)
    result = await launchAppWithWorkspaces(
        [{ id: 'w-t156', name: 'T156 project', path: project, sessions: [
            { id: ID, name: 'T156 Claude', cliSessionId: CLAUDE_ID, cliToolName: 'claude', cliCommand: `node ${MOCK} --transcript ${transcript} --restore-on-esc --work-ms 8000` }
        ] }],
        { env: { CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: path.join(home, 'codex'), CLIMANAGER_HOME: path.join(home, 'clim') } }
    )
    const { app, page } = result
    await resizeMainWindow(app, 1280, 800)
    await waitForBufferText(page, ID, 'Claude Code (mock)', 20_000)
    await page.getByText('T156 Claude', { exact: true }).first().click()
    await page.getByTestId('view-toggle-chat').click()
    const chat = page.locator('[data-testid="chat-view"][data-session-id]:visible')
    const composer = chat.getByTestId('chat-composer')
    await expect(composer).toBeVisible({ timeout: 15_000 })
    await composer.fill('compare the pricing tiers')
    await composer.press('Enter')
    await waitForBufferText(page, ID, 'ANSWER[1]: compare the pricing tiers', 10_000)
    await expect(composer).toHaveValue('')
    await chat.getByTestId('chat-stop').click({ timeout: 10_000 })
    await waitForBufferText(page, ID, 'INTERRUPTED', 10_000)
    // the words come back to the Chat box, and leave the terminal's
    await expect(composer).toHaveValue('compare the pricing tiers', { timeout: 6000 })
    // the terminal's box was emptied: the next send goes through whole (before: refused as «already has text»)
    await composer.fill('just list them')
    await composer.press('Enter')
    await waitForBufferText(page, ID, 'ANSWER[2]: just list them', 10_000)
})
