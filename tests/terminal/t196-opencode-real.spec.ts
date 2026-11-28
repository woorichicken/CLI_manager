import { test, expect, type Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { closeApp, launchAppWithWorkspaces, LaunchResult, termText, waitForBufferText, writeToTerminal } from './helpers'

/**
 * T196 — the real OpenCode in the app (opt-in: REAL_OPENCODE=1; REAL_OPENCODE_MODEL=<provider/model> to pick
 * one, else OpenCode's default). It runs this Mac's `opencode` with four short prompts: found after its first
 * answer names the session, read in the Chat, sent to from the Chat, stopped (two Esc), resumed after a
 * restart. What T195's mock stands in for, checked against OpenCode itself when it changes version.
 *
 * OpenCode's store is a temporary data folder (XDG_DATA_HOME), with the sign-in file copied in (0600, removed
 * after): the person's own conversations are never written. HOME is the real one (OpenCode's config).
 */

const REAL = process.env.REAL_OPENCODE === '1'
const MODEL = process.env.REAL_OPENCODE_MODEL
const SHOTS = process.env.T196_SHOTS
const COMMAND = MODEL ? `opencode -m ${MODEL}` : 'opencode'

const chat = (page: Page) => page.locator(`[data-testid="chat-view"][data-session-id]:visible`)

function sessionIn(userDataDir: string, id: string): Record<string, unknown> | undefined {
    const config = JSON.parse(fs.readFileSync(path.join(userDataDir, 'config.json'), 'utf8'))
    return (config.workspaces as Array<{ sessions: Array<Record<string, unknown>> }>).flatMap((workspace) => workspace.sessions).find((session) => session.id === id)
}

async function shot(page: Page, name: string): Promise<void> {
    if (!SHOTS) return
    fs.mkdirSync(SHOTS, { recursive: true })
    await page.screenshot({ path: path.join(SHOTS, `t196-${name}.png`) })
}

test.skip(!REAL, 'opt-in: REAL_OPENCODE=1 [REAL_OPENCODE_MODEL=<provider/model>]')

let result: LaunchResult | null = null
let root: string | null = null
test.afterEach(async ({}, testInfo) => {
    // a real model can stall (a free tier's limit, a retry): what the terminal showed says which
    if (result && testInfo.status !== testInfo.expectedStatus) {
        const screen = await termText(result.page, 't196').catch((error) => String(error))
        await testInfo.attach('terminal', { body: screen.split('\n').slice(-40).join('\n'), contentType: 'text/plain' })
        console.log(`[T196] terminal at failure:\n${screen.split('\n').slice(-40).join('\n')}`)
    }
    if (result) await closeApp(result)
    result = null
    if (root) fs.rmSync(root, { recursive: true, force: true })
    root = null
})

test('T196 real opencode: found, read, sent to, stopped, resumed', async () => {
    test.setTimeout(420_000)
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't196-')))
    const project = path.join(root, 'project')
    const data = path.join(root, 'xdg-data')
    fs.mkdirSync(project, { recursive: true })
    fs.mkdirSync(path.join(data, 'opencode'), { recursive: true })
    fs.writeFileSync(path.join(project, 'notes.txt'), 'alpha\n')
    const signIn = path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json')
    if (fs.existsSync(signIn)) fs.copyFileSync(signIn, path.join(data, 'opencode', 'auth.json'))
    fs.chmodSync(path.join(data, 'opencode'), 0o700)
    const env = { XDG_DATA_HOME: data, XDG_STATE_HOME: path.join(root, 'xdg-state'), OPENCODE_DISABLE_AUTOUPDATE: '1', CLIMANAGER_OPENCODE_SYNC_MS: '500' }
    const workspace = { id: 'w-t196', name: 'T196 real opencode', path: project }
    result = await launchAppWithWorkspaces([{ ...workspace, sessions: [{ id: 't196', name: 'T196 opencode', initialCommand: COMMAND }] }], { env })
    let { page, userDataDir } = result
    await page.getByText('T196 opencode', { exact: true }).first().click()
    await waitForBufferText(page, 't196', 'ctrl+p commands', 90_000)

    // the first answer names the session (`OC | <title>`): bound then, with its folder
    await writeToTerminal(page, 't196', 'Reply with exactly one word: hi')
    await page.waitForTimeout(800)
    await writeToTerminal(page, 't196', '\r')
    await expect.poll(() => sessionIn(userDataDir, 't196')?.cliToolName, { timeout: 120_000 }).toBe('opencode')
    const id = sessionIn(userDataDir, 't196')?.cliSessionId as string
    expect(id).toMatch(/^ses_[A-Za-z0-9]+$/)
    expect(sessionIn(userDataDir, 't196')?.cliCommand).toBe(COMMAND)

    await page.getByTestId('view-toggle-chat').click()
    const view = chat(page)
    await expect(view.locator('[data-testid="chat-turn"][data-role="user"]').first()).toContainText('Reply with exactly one word: hi', { timeout: 30_000 })
    await expect(view.locator('[data-testid="chat-answer"]').last()).toContainText(/hi/i, { timeout: 90_000 })
    await expect(view.getByTestId('chat-model-chip')).toHaveAttribute('data-readonly', 'true')

    // sent from the Chat (its idle composer shows a grey hint: no typed text)
    const composer = view.getByTestId('chat-composer')
    await composer.fill('Reply with exactly one word: pong')
    await composer.press('Enter')
    await expect(view.locator('[data-testid="chat-answer"]', { hasText: /pong/i })).toBeVisible({ timeout: 120_000 })
    await expect(view.getByTestId('chat-working')).toHaveCount(0, { timeout: 60_000 })
    await shot(page, 'chat')

    // stopped from the Chat: OpenCode wants Esc twice
    await composer.fill('Count from 1 to 400, one number per line, nothing else.')
    await composer.press('Enter')
    await expect(view.getByTestId('chat-working')).toBeVisible({ timeout: 60_000 })
    await view.getByTestId('chat-stop').click()
    await waitForBufferText(page, 't196', 'interrupted', 30_000)
    await expect(view.getByTestId('chat-working')).toHaveCount(0, { timeout: 30_000 })

    // a restart resumes the same session with the same command
    await closeApp(result)
    result = await launchAppWithWorkspaces([{ ...workspace, sessions: [{ id: 't196', name: 'T196 opencode', cliToolName: 'opencode', cliSessionId: id, cliCommand: COMMAND }] }], { env })
    ;({ page, userDataDir } = result)
    await page.getByText('T196 opencode', { exact: true }).first().click()
    await waitForBufferText(page, 't196', 'ctrl+p commands', 90_000)
    await page.getByTestId('view-toggle-chat').click()
    await expect(chat(page).locator('[data-testid="chat-answer"]', { hasText: /pong/i })).toBeVisible({ timeout: 30_000 })
    await shot(page, 'resumed')
    expect(sessionIn(userDataDir, 't196')).toMatchObject({ cliToolName: 'opencode', cliSessionId: id })
})
