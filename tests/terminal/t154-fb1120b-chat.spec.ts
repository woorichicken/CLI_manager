import { test, expect, type Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { closeApp, launchAppWithWorkspaces, LaunchResult, REPO_ROOT, resizeMainWindow, waitForBufferText } from './helpers'

/**
 * T154 — fb-1120b Chat and thread fixes.
 *
 *  - 800cf922: app shortcuts work while the chat's message box has the caret (⌘] goes to the next session),
 *    and the box keeps the keys it edits with (⌘A selects the draft, the session stays).
 *  - 551ee952: a fork's «Show» opens its thread panel beside the chat instead of jumping to the session.
 *  - c04532a6: the panel shows the reply it hangs on in the chat's own text colour (a message, not a grey quote).
 *  - b808043e: a click on the panel's name renames the thread session (Enter saves, Escape keeps).
 *  - 66e5ad19: no «your last message» bar inside the thread, nor over a chat whose thread is open.
 *
 * T154_SHOTS=<dir> (+ T154_LABEL) saves captures before the checks.
 */

const PARENT = 't154-parent'
const SHELL = 't154-shell'
const CLAUDE_ID = '00000000-0000-4000-8000-00000000f154'
const MOCK = path.join(REPO_ROOT, 'scripts/mock-cli/chat-mock.cjs')
const FIXTURES = path.join(__dirname, 'fixtures/transcripts')
const LABEL = process.env.T154_LABEL ?? 'run'
const claudeProjectSlug = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, '-')

let result: LaunchResult | null = null
test.afterEach(async () => {
    if (result) await closeApp(result)
    result = null
})

async function shot(page: Page, name: string): Promise<void> {
    const dir = process.env.T154_SHOTS
    if (!dir) return
    fs.mkdirSync(dir, { recursive: true })
    await page.waitForTimeout(400)
    await page.screenshot({ path: path.join(dir, `${name}-${LABEL}.png`) })
}

async function launch(): Promise<Page> {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'climanager-t154-'))
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
                id: 'w-t154',
                name: 'T154 project',
                path: project,
                sessions: [
                    { id: PARENT, name: 'T154 Claude', cliSessionId: CLAUDE_ID, cliToolName: 'claude', cliCommand: `node ${MOCK} --transcript ${transcript} --fresh-transcript ${fresh} --copy-transcript --work-ms 400` },
                    { id: SHELL, name: 'T154 Shell' }
                ]
            }
        ],
        { env: { CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: path.join(home, 'codex'), CLIMANAGER_HOME: path.join(home, 'clim') } }
    )
    await resizeMainWindow(result.app, 1280, 800)
    await waitForBufferText(result.page, PARENT, 'Claude Code (mock)', 20_000)
    return result.page
}

const macChat = (page: Page) => page.locator('[data-testid="chat-view"][data-session-id]:not([data-thread-embedded]):visible')
const visibleSessions = (page: Page): Promise<string[]> =>
    page.evaluate(() => Array.from(document.querySelectorAll('[data-session-id]')).filter((el) => getComputedStyle(el).visibility === 'visible').map((el) => el.getAttribute('data-session-id') ?? ''))
const sessionName = (id: string): string | undefined =>
    (JSON.parse(fs.readFileSync(path.join(result!.userDataDir, 'config.json'), 'utf8')) as { workspaces: { sessions: { id: string; name: string }[] }[] })
        .workspaces.flatMap((w) => w.sessions).find((s) => s.id === id)?.name

async function openParentChat(page: Page) {
    await page.getByText('T154 Claude', { exact: true }).first().click()
    await page.getByTestId('view-toggle-chat').click()
    const view = macChat(page)
    await expect(view.locator('[data-testid="chat-turn"][data-role="assistant"]').last()).toBeVisible({ timeout: 15_000 })
    return view
}

test('T154 800cf922: app shortcuts reach past the chat message box, its editing keys stay its own', async () => {
    test.setTimeout(120_000)
    const page = await launch()
    const view = await openParentChat(page)
    const composer = view.locator(':scope > .chat-main').getByTestId('chat-composer')
    await composer.fill('a draft to keep')
    await composer.focus()
    await shot(page, 't154-1-composer')
    // ⌘A stays the box's: the whole draft selected, the same session
    await page.keyboard.press('Meta+a')
    expect(await composer.evaluate((box: HTMLTextAreaElement) => [box.selectionStart, box.selectionEnd])).toEqual([0, 'a draft to keep'.length])
    expect(await visibleSessions(page)).toContain(PARENT)
    // ⌘] from the box: the next session in sidebar order (before: nothing happened)
    await composer.focus()
    await page.keyboard.press('Meta+]')
    await expect.poll(() => visibleSessions(page), { timeout: 5000 }).toContain(SHELL)
    expect(await visibleSessions(page)).not.toContain(PARENT)
    // and back, the draft untouched
    await page.keyboard.press('Meta+[')
    await expect.poll(() => visibleSessions(page), { timeout: 5000 }).toContain(PARENT)
    await expect(composer).toHaveValue('a draft to keep')
})

test('T154 551ee952 · c04532a6 · b808043e · 66e5ad19: Show opens the thread, its reply reads as a message, its name renames', async () => {
    test.setTimeout(180_000)
    const page = await launch()
    const view = await openParentChat(page)
    const reply = view.locator('[data-testid="chat-turn"][data-role="assistant"]').first()
    await reply.hover()
    await reply.getByTestId('chat-fork').click()
    const notice = page.getByTestId('chat-fork-notice')
    await expect(notice).toHaveAttribute('data-state', 'forked', { timeout: 90_000 })
    // 551ee952: Show → the thread panel beside this chat, the parent still in front
    await notice.getByTestId('chat-fork-show').click()
    const panel = page.getByTestId('chat-thread-panel')
    await expect(panel).toBeVisible({ timeout: 10_000 })
    await expect(macChat(page)).toHaveAttribute('data-session-id', PARENT)
    const childId = (await panel.getAttribute('data-session-id'))!
    expect(childId).not.toBe(PARENT)
    await shot(page, 't154-2-thread-shown')

    // c04532a6: the reply in the chat's text colour and at least the chat's small size, not the dim 0.8em quote
    const quote = panel.getByTestId('chat-thread-quote')
    await expect(quote).toContainText('Here is the summary.')
    await expect(quote).toContainText('Replying to Claude')
    const looks = await quote.evaluate((element) => {
        const text = element.querySelector('.chat-thread-quote-text') as HTMLElement
        const turn = document.querySelector('.chat-turn-assistant .chat-markdown, .chat-turn-assistant p') as HTMLElement | null
        return { color: getComputedStyle(text).color, turnColor: turn ? getComputedStyle(turn).color : null, border: getComputedStyle(text).borderLeftWidth }
    })
    if (looks.turnColor) expect(looks.color).toBe(looks.turnColor)
    expect(looks.border).toBe('0px')

    // 66e5ad19: no pinned last message inside the thread
    await expect(panel.getByTestId('chat-pinned-last')).toHaveCount(0)

    // b808043e: click the name, Escape keeps it, Enter saves it
    const oldName = sessionName(childId)!
    await panel.getByTestId('chat-thread-rename').click()
    const field = panel.getByTestId('chat-thread-rename-input')
    await expect(field).toBeFocused()
    await field.fill('not this')
    await field.press('Escape')
    await expect(panel).toBeVisible()
    await expect(panel.getByTestId('chat-thread-rename')).toHaveText(oldName)
    await panel.getByTestId('chat-thread-rename').click()
    await field.fill('Pricing follow-up')
    await field.press('Enter')
    await expect(panel.getByTestId('chat-thread-rename')).toHaveText('Pricing follow-up')
    await expect.poll(() => sessionName(childId), { timeout: 5000 }).toBe('Pricing follow-up')
    // The sidebar lists no thread rows since 1b965ad1 (T163); its search finds the thread by the new name.
    await page.getByTestId('sidebar-search-toggle').click()
    await page.getByPlaceholder('Search projects and sessions').fill('Pricing follow')
    await expect(page.locator(`[data-testid="sidebar-search-results"] [data-session-item="${childId}"]`).first()).toContainText('Pricing follow-up', { timeout: 5000 })
    await page.getByTestId('sidebar-search-toggle').click()
    await shot(page, 't154-3-renamed')
})
