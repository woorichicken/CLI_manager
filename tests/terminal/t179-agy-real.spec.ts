import { test, expect, type Page } from '@playwright/test'
import fs from 'fs'
import path from 'path'
import { closeApp, launchAppWithWorkspaces, LaunchResult, waitForBufferText, writeToTerminal } from './helpers'

/**
 * T179 — the real Antigravity CLI in the app (opt-in: REAL_AGY=1 REAL_AGY_CWD=<a folder agy already
 * trusts>). It runs the signed-in `agy` of this Mac with the cheapest model and four short prompts:
 * found after its first prompt, read in the Chat, sent to from the Chat, stopped, resumed after a
 * restart. What T178's mock stands in for, checked against agy itself when agy changes version.
 * The app's own store is a temporary folder; HOME is the real one (agy needs its sign-in).
 */

const REAL = process.env.REAL_AGY === '1'
const CWD = process.env.REAL_AGY_CWD ?? ''
const MODEL = process.env.REAL_AGY_MODEL ?? 'gemini-3.8-flash-low'
const SHOTS = process.env.T179_SHOTS

const chat = (page: Page) => page.locator(`[data-testid="chat-view"][data-session-id]:visible`)

function sessionIn(userDataDir: string, id: string): Record<string, unknown> | undefined {
    const config = JSON.parse(fs.readFileSync(path.join(userDataDir, 'config.json'), 'utf8'))
    return (config.workspaces as Array<{ sessions: Array<Record<string, unknown>> }>).flatMap((workspace) => workspace.sessions).find((session) => session.id === id)
}

async function shot(page: Page, name: string): Promise<void> {
    if (!SHOTS) return
    fs.mkdirSync(SHOTS, { recursive: true })
    await page.screenshot({ path: path.join(SHOTS, `t179-${name}.png`) })
}

test.skip(!REAL || !CWD, 'opt-in: REAL_AGY=1 REAL_AGY_CWD=<trusted folder>')

let result: LaunchResult | null = null
test.afterEach(async () => {
    if (result) await closeApp(result)
    result = null
})

test('T179 real agy: found, read, sent to, stopped, resumed', async () => {
    test.setTimeout(300_000)
    const workspace = { id: 'w-t169', name: 'T179 real agy', path: CWD }
    result = await launchAppWithWorkspaces([{ ...workspace, sessions: [{ id: 't169', name: 'T179 agy', initialCommand: `agy --model ${MODEL}` }] }], { env: { CLIMANAGER_AGY_SYNC_MS: '500' } })
    let { page, userDataDir } = result
    await page.getByText('T179 agy', { exact: true }).first().click()
    await waitForBufferText(page, 't169', '? for shortcuts', 60_000)

    // the first prompt makes the conversation: its lock names it
    await writeToTerminal(page, 't169', 'Reply with exactly one word: hi')
    await page.waitForTimeout(800)
    await writeToTerminal(page, 't169', '\r')
    await expect.poll(() => sessionIn(userDataDir, 't169')?.cliToolName, { timeout: 60_000 }).toBe('agy')
    const id = sessionIn(userDataDir, 't169')?.cliSessionId as string
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    expect(sessionIn(userDataDir, 't169')?.cliCommand).toBe(`agy --model ${MODEL}`)

    await page.getByTestId('view-toggle-chat').click()
    const view = chat(page)
    await expect(view.locator('[data-testid="chat-turn"][data-role="user"]').first()).toContainText('Reply with exactly one word: hi', { timeout: 30_000 })
    await expect(view.locator('[data-testid="chat-answer"]').last()).toContainText(/hi/i, { timeout: 60_000 })
    await expect(view.getByTestId('chat-model-chip')).toHaveAttribute('data-readonly', 'true')

    // sent from the Chat
    const composer = view.getByTestId('chat-composer')
    await composer.fill('Reply with exactly one word: pong')
    await composer.press('Enter')
    await expect(view.locator('[data-testid="chat-answer"]', { hasText: /pong/i })).toBeVisible({ timeout: 90_000 })
    await expect(view.getByTestId('chat-working')).toHaveCount(0, { timeout: 60_000 })
    await shot(page, 'chat')

    // stopped from the Chat
    await composer.fill('Count from 1 to 300, one number per line, nothing else.')
    await composer.press('Enter')
    await expect(view.getByTestId('chat-working')).toBeVisible({ timeout: 30_000 })
    await view.getByTestId('chat-stop').click()
    await expect(view.getByTestId('chat-working')).toHaveCount(0, { timeout: 30_000 })

    // a restart resumes the same conversation with the same command
    await closeApp(result)
    result = await launchAppWithWorkspaces([{ ...workspace, sessions: [{ id: 't169', name: 'T179 agy', cliToolName: 'agy', cliSessionId: id, cliCommand: `agy --model ${MODEL}` }] }], { env: { CLIMANAGER_AGY_SYNC_MS: '500' } })
    ;({ page, userDataDir } = result)
    await page.getByText('T179 agy', { exact: true }).first().click()
    // agy redraws the whole screen and drops the typed command from the scrollback (measured): what shows
    // the resume is the earlier conversation on screen
    await waitForBufferText(page, 't169', 'Reply with exactly one word: pong', 60_000)
    await waitForBufferText(page, 't169', '? for shortcuts', 60_000)
    await page.getByTestId('view-toggle-chat').click()
    await expect(chat(page).locator('[data-testid="chat-answer"]', { hasText: /pong/i })).toBeVisible({ timeout: 30_000 })
    await shot(page, 'resumed')
    expect(sessionIn(userDataDir, 't169')).toMatchObject({ cliToolName: 'agy', cliSessionId: id })
})
