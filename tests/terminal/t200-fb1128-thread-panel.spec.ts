import { test, expect, type Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { closeApp, launchAppWithWorkspaces, LaunchResult, REPO_ROOT, resizeMainWindow, waitForBufferText } from './helpers'

/**
 * T200 — fb-1128 thread panel.
 *
 *  - 8d1fe130: «Reply in thread» names the new session «<name> · thread», the notice speaks of a thread, and the
 *    panel's head shows the name without that tail (the full name in its tooltip).
 *  - 271a1e32: the reply the thread hangs on is the first item of the thread's own conversation — it scrolls away
 *    with the replies; the panel's head (name, status, Open as session, ✕) stays.
 *  - bda9e39b: a visible gap between the chat and the thread panel (≥ 8px at 1280), the resize handle inside it.
 *
 * T200_SHOTS=<dir> (+ T200_LABEL) saves captures before the checks.
 */

const PARENT = 't200-parent'
const CLAUDE_ID = '00000000-0000-4000-8000-00000000f200'
const MOCK = path.join(REPO_ROOT, 'scripts/mock-cli/chat-mock.cjs')
const FIXTURES = path.join(__dirname, 'fixtures/transcripts')
const LABEL = process.env.T200_LABEL ?? 'run'
const claudeProjectSlug = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, '-')

let result: LaunchResult | null = null
test.afterEach(async () => {
    if (result) await closeApp(result)
    result = null
})

async function shot(page: Page, name: string): Promise<void> {
    const dir = process.env.T200_SHOTS
    if (!dir) return
    fs.mkdirSync(dir, { recursive: true })
    await page.waitForTimeout(400)
    await page.screenshot({ path: path.join(dir, `${name}-${LABEL}.png`) })
}

async function launch(): Promise<Page> {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'climanager-t200-'))
    const project = path.join(home, 'project')
    fs.mkdirSync(project)
    const claudeDir = path.join(home, 'claude')
    const transcript = path.join(claudeDir, 'projects', claudeProjectSlug(project), `${CLAUDE_ID}.jsonl`)
    fs.mkdirSync(path.dirname(transcript), { recursive: true })
    fs.copyFileSync(path.join(FIXTURES, 'claude/tools.jsonl'), transcript)
    const fresh = path.join(home, 'fork-records.jsonl')
    result = await launchAppWithWorkspaces(
        [
            {
                id: 'w-t200',
                name: 'T200 project',
                path: project,
                sessions: [{ id: PARENT, name: 'T200 Claude', cliSessionId: CLAUDE_ID, cliToolName: 'claude', cliCommand: `node ${MOCK} --transcript ${transcript} --fresh-transcript ${fresh} --copy-transcript --work-ms 300` }]
            }
        ],
        { env: { CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: path.join(home, 'codex'), CLIMANAGER_HOME: path.join(home, 'clim') } }
    )
    await resizeMainWindow(result.app, 1280, 760)
    await waitForBufferText(result.page, PARENT, 'Claude Code (mock)', 20_000)
    return result.page
}

const macChat = (page: Page) => page.locator('[data-testid="chat-view"][data-session-id]:not([data-thread-embedded]):visible')
const sessionName = (id: string): string | undefined =>
    (JSON.parse(fs.readFileSync(path.join(result!.userDataDir, 'config.json'), 'utf8')) as { workspaces: { sessions: { id: string; name: string }[] }[] })
        .workspaces.flatMap((w) => w.sessions).find((s) => s.id === id)?.name

test('T200 8d1fe130 · 271a1e32 · bda9e39b: a thread is named a thread, its quote scrolls, the panel stands apart', async () => {
    test.setTimeout(240_000)
    const page = await launch()
    await page.getByText('T200 Claude', { exact: true }).first().click()
    await page.getByTestId('view-toggle-chat').click()
    const view = macChat(page)
    const reply = view.locator('[data-testid="chat-turn"][data-role="assistant"]').first()
    await expect(reply).toBeVisible({ timeout: 15_000 })
    await reply.hover()
    await reply.getByTestId('chat-fork').click()
    const notice = page.getByTestId('chat-fork-notice')
    await expect(notice).toHaveAttribute('data-state', 'forked', { timeout: 90_000 })

    // 8d1fe130: the notice speaks of a thread, not a fork
    await expect(notice).not.toContainText(/fork/i)
    await expect(notice).toContainText(/thread/i)
    await notice.getByTestId('chat-fork-show').click()
    const panel = page.getByTestId('chat-thread-panel')
    await expect(panel).toBeVisible({ timeout: 10_000 })
    const childId = (await panel.getAttribute('data-session-id'))!
    // the new session's stored name ends in « · thread» (before: « · fork»)
    await expect.poll(() => sessionName(childId), { timeout: 5000 }).toBe('T200 Claude · thread')
    // the panel's head drops the tail — it is a thread panel already — and keeps the full name in the tooltip
    const name = panel.getByTestId('chat-thread-rename')
    await expect(name).toHaveText('T200 Claude')
    expect(await name.getAttribute('title')).toContain('T200 Claude · thread')
    // editing starts from the full stored name, so nothing is dropped without the person seeing it
    await name.click()
    await expect(panel.getByTestId('chat-thread-rename-input')).toHaveValue('T200 Claude · thread')
    await panel.getByTestId('chat-thread-rename-input').press('Escape')
    await expect(name).toHaveText('T200 Claude')

    // bda9e39b: a gap between the chat and the panel (1280: side by side)
    const main = view.locator(':scope > .chat-main')
    const gap = async (): Promise<number> => {
        const mainBox = (await main.boundingBox())!
        const panelBox = (await panel.boundingBox())!
        return panelBox.x - (mainBox.x + mainBox.width)
    }
    await shot(page, 't200-1-thread-1280')
    expect(await gap()).toBeGreaterThanOrEqual(8)
    // the resize handle sits in that gap: between the chat's right edge and the panel's left edge
    const handle = (await panel.getByTestId('chat-thread-panel-resize').boundingBox())!
    const mainRight = (await main.boundingBox())!.x + (await main.boundingBox())!.width
    expect(handle.x).toBeGreaterThanOrEqual(mainRight - 1)
    expect(handle.x + handle.width).toBeLessThanOrEqual((await panel.boundingBox())!.x + 1)

    // 271a1e32: the quoted reply is the thread conversation's first item, inside its scroller
    const childScroll = panel.getByTestId('chat-scroll')
    const quote = panel.getByTestId('chat-thread-quote')
    await expect(childScroll.getByTestId('chat-thread-quote')).toHaveCount(1)
    await expect(quote).toContainText('Here is the summary.')
    // a few tall replies in the thread, then read to the end: the quote scrolls away, the head stays
    const composer = panel.getByPlaceholder('Reply in thread…')
    await waitForBufferText(page, childId, 'Claude Code (mock)', 30_000)
    for (let i = 0; i < 3; i++) {
        await composer.fill('TABLE')
        await composer.press('Enter')
        await waitForBufferText(page, childId, `ANSWER[${i + 1}]: TABLE`, 20_000)
        await expect(panel.locator('[data-testid="chat-turn"][data-role="assistant"]')).toHaveCount(i + 1, { timeout: 30_000 })
    }
    await expect(panel.getByTestId('chat-working')).toHaveCount(0, { timeout: 15_000 })
    await childScroll.evaluate((element) => { element.scrollTop = element.scrollHeight })
    await expect(quote).not.toBeInViewport()
    await expect(panel.getByTestId('chat-thread-rename')).toBeInViewport()
    await expect(panel.getByTestId('chat-thread-panel-close')).toBeInViewport()
    await childScroll.evaluate((element) => { element.scrollTop = 0 })
    await expect(quote).toBeInViewport()
    await shot(page, 't200-2-thread-replies-1280')

    // 390: the panel covers the chat there (no side by side) — it fits the window
    await resizeMainWindow(result!.app, 390, 760)
    await expect(panel).toBeVisible()
    const narrow = (await panel.boundingBox())!
    expect(narrow.x).toBeGreaterThanOrEqual(0)
    expect(narrow.x + narrow.width).toBeLessThanOrEqual(391)
    await shot(page, 't200-3-thread-390')
})
