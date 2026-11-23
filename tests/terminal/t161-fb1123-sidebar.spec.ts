import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { closeApp, launchAppWithWorkspaces, LaunchResult, REPO_ROOT, resizeMainWindow, waitForBufferText } from './helpers'

/**
 * T161 — fb-1123 sidebar reports.
 *
 *  - 91fce7bf: the macOS traffic lights get a strip of their own above both panels. The lights are
 *    native and never in a capture, so the check reads where main put them (getWindowButtonPosition)
 *    and asserts no panel — sidebar or main, with the sidebar open or closed — starts above their
 *    bottom edge, and that the strip over the panels drags the window.
 *  - 78a79526: a button with a shortcut says the shortcut and, on a second line, what it does — the
 *    description Settings › Keyboard shows. The first line stays "Label (keys)", so `title^=` selectors
 *    keep working. Labels that already say what the button does (Related) carry no second line.
 *  - 5f9002d5: an inbox request can be answered from the popover. The reply goes through the Chat
 *    view's send (no AI mark, the same refusals): it reaches the mock agent (`ANSWER[n]`), a question
 *    on screen refuses it inline, the request stays unread, and a session with no agent has no box.
 *
 * T161_SHOTS=<dir> + T161_LABEL saves captures before the checks (the old build's "before").
 */

const CLAUDE = 's-t161-claude'
const SHELL = 's-t161-shell'
const MOCK = path.join(REPO_ROOT, 'scripts/mock-cli/chat-mock.cjs')
const LABEL = process.env.T161_LABEL ?? 'run'
/** A generous box for the three lights from their top-left corner (macOS 26: ~13px buttons, ~9px apart). */
const LIGHTS = { width: 70, height: 16 }

let result: LaunchResult | null = null
const temps: string[] = []
test.afterEach(async () => {
    if (result) await closeApp(result)
    result = null
    for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
    temps.push(dir)
    return dir
}

async function shot(page: Page, name: string): Promise<void> {
    const dir = process.env.T161_SHOTS
    if (!dir) return
    fs.mkdirSync(dir, { recursive: true })
    await page.waitForTimeout(400)
    await page.screenshot({ path: path.join(dir, `${name}-${LABEL}.png`) })
}

async function launch(): Promise<{ app: ElectronApplication; page: Page; home: string }> {
    const home = tempDir('climanager-t161-')
    const project = path.join(home, 'project')
    fs.mkdirSync(project, { recursive: true })
    const transcript = path.join(home, 'claude', 'projects', 'x', '00000000-0000-4000-8000-0000000c1590.jsonl')
    fs.mkdirSync(path.dirname(transcript), { recursive: true })
    fs.writeFileSync(transcript, '')
    result = await launchAppWithWorkspaces(
        [{
            id: 'w-t161',
            name: 'T161 project',
            path: project,
            sessions: [
                {
                    id: CLAUDE,
                    name: 'T161 Claude',
                    cliSessionId: '00000000-0000-4000-8000-0000000c1590',
                    cliToolName: 'claude',
                    cliCommand: `node ${MOCK} --transcript ${transcript} --work-ms 300`
                },
                { id: SHELL, name: 'T161 Shell' }
            ]
        }],
        {
            settings: { controlApi: { enabled: true, port: 0 }, showHomeWorkspace: false },
            env: { CLIMANAGER_HOME: home, CLAUDE_CONFIG_DIR: path.join(home, 'claude') }
        }
    )
    await resizeMainWindow(result.app, 1280, 800)
    return { app: result.app, page: result.page, home }
}

const lightsBox = (app: ElectronApplication): Promise<{ x: number; y: number } | null> =>
    app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getWindowButtonPosition?.() ?? null)

/** Top edges of every panel on screen (sidebar card, main card). */
const panelTops = (page: Page): Promise<number[]> =>
    page.evaluate(() => Array.from(document.querySelectorAll('.glass-panel')).map((el) => el.getBoundingClientRect().top))

test('T161 91fce7bf: the traffic lights sit in their own strip — no panel starts under them, open or closed sidebar', async () => {
    const { app, page } = await launch()
    await expect(page.getByText('T161 Shell', { exact: true }).first()).toBeVisible({ timeout: 15_000 })
    await shot(page, 't161-lights-open')

    const lights = await lightsBox(app)
    expect(lights, 'main reports the traffic light position').not.toBeNull()
    const lightsBottom = lights!.y + LIGHTS.height

    // The sidebar title starts where it always did — the strip takes height, not the header's width.
    const tops = await panelTops(page)
    expect(tops.length).toBeGreaterThanOrEqual(2)
    for (const top of tops) expect(top, `panel top ${top} clears the lights (bottom ${lightsBottom})`).toBeGreaterThanOrEqual(lightsBottom)

    // The strip above the panels drags the window like the headers do.
    const region = await page.evaluate(([x, y]) => {
        const el = document.elementFromPoint(x, y) as HTMLElement | null
        return el ? getComputedStyle(el).getPropertyValue('-webkit-app-region') || getComputedStyle(el).getPropertyValue('app-region') : 'none'
    }, [600, 4])
    expect(region).toBe('drag')

    // Sidebar closed: the main header's first button (Open Sidebar) is the one under the lights before.
    await page.locator('button[title^="Close Sidebar"]').click()
    const open = page.locator('button[title^="Open Sidebar"]')
    await expect(open).toBeVisible()
    await shot(page, 't161-lights-closed')
    const openBox = (await open.boundingBox())!
    expect(openBox.y, 'Open Sidebar is below the lights').toBeGreaterThanOrEqual(lightsBottom)
    for (const top of await panelTops(page)) expect(top).toBeGreaterThanOrEqual(lightsBottom)

    // A full-window overlay over the strip opts out of the drag band, or its top row (Settings'
    // close button in a short window) would move the window instead of taking the click.
    await page.locator('button[title^="Settings"]').click()
    const overlay = page.locator('.fixed.inset-0').filter({ has: page.getByTestId('settings-category-sidebar') }).first()
    await expect(overlay).toBeVisible()
    expect(await overlay.evaluate((el) => getComputedStyle(el).getPropertyValue('-webkit-app-region') || getComputedStyle(el).getPropertyValue('app-region'))).toBe('no-drag')
})

test('T161 78a79526: buttons with a shortcut name the keys and say what they do on a second line', async () => {
    const { page } = await launch()
    await expect(page.getByText('T161 Shell', { exact: true }).first()).toBeVisible({ timeout: 15_000 })
    await page.getByText('T161 Shell', { exact: true }).first().click()
    await page.locator('button[title^="Session Memo"]:visible').click()
    await expect(page.getByTestId('session-memo-new-page')).toBeVisible()

    const titleOf = (selector: string) => page.locator(selector).first().getAttribute('title')
    const titles = {
        settings: await titleOf('button[title^="Settings"]'),
        closeSidebar: await titleOf('button[title^="Close Sidebar"]'),
        memo: await titleOf('button[title^="Session Memo"]:visible'),
        memoNewPage: await page.getByTestId('session-memo-new-page').getAttribute('title'),
        memoCopy: await page.getByTestId('session-memo-copy').getAttribute('title'),
        related: await titleOf(`[data-related-button="${SHELL}"]`)
    }
    const dir = process.env.T161_SHOTS
    if (dir) {
        fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(path.join(dir, `t161-titles-${LABEL}.json`), JSON.stringify(titles, null, 2))
    }

    const lines = (title: string | null) => (title ?? '').split('\n')
    expect(lines(titles.settings)[0]).toMatch(/^Settings \(/)
    expect(lines(titles.settings)[1]).toBe('Open or close settings')
    expect(lines(titles.closeSidebar)[0]).toMatch(/^Close Sidebar \(/)
    expect(lines(titles.closeSidebar)[1]).toBe('Show or hide the sidebar')
    expect(lines(titles.memo)[1]).toBe('Open or close session memo')
    expect(lines(titles.memoNewPage)[0]).toMatch(/^New page \(/)
    expect(lines(titles.memoNewPage)[1]).toBe('Add a page to the memo (opens it if closed)')
    expect(lines(titles.memoCopy)[1]).toBe('Copy the page shown to the clipboard')
    // A label that is already a sentence keeps one line.
    expect(lines(titles.related)).toHaveLength(1)
})

interface Discovery { url: string; token: string }

async function apiFor(home: string) {
    const discoveryPath = path.join(home, 'control-api.json')
    await expect.poll(() => fs.existsSync(discoveryPath), { timeout: 15_000 }).toBe(true)
    const discovery = JSON.parse(fs.readFileSync(discoveryPath, 'utf-8')) as Discovery
    return async (method: string, route: string, body: unknown, caller: string): Promise<number> => {
        const res = await fetch(discovery.url + route, {
            method,
            headers: { Authorization: `Bearer ${discovery.token}`, 'Content-Type': 'application/json', 'X-Client-Name': 't161', 'X-Caller-Session': caller },
            body: JSON.stringify(body)
        })
        return res.status
    }
}

const terminalLines = (page: Page, id: string): Promise<string> =>
    page.evaluate((sessionId) => window.api.feedbackTerminalContext(sessionId).then((c) => (c.terminal?.recentLines ?? []).join('\n')), id)

const sessionRole = (page: Page, id: string) =>
    page.locator(`[data-session-item="${id}"][data-session-role]`).first().getAttribute('data-session-role')

test('T161 5f9002d5: reply to an inbox request from the popover — it reaches the agent, a question refuses it, the request stays unread', async () => {
    test.setTimeout(180_000)
    const { page, home } = await launch()
    await waitForBufferText(page, CLAUDE, 'Claude Code (mock)', 20_000)
    const api = await apiFor(home)
    expect(await api('POST', '/v1/inbox', { kind: 'question', text: 'Which port should the dev server use?' }, CLAUDE)).toBe(200)
    expect(await api('POST', '/v1/inbox', { kind: 'login', text: 'Sign in to the staging site' }, SHELL)).toBe(200)

    const bell = page.locator('[data-testid="inbox-button"][data-inbox-placement="sidebar"]')
    await expect(bell).toHaveAttribute('data-unread', '2', { timeout: 10_000 })
    const roleBefore = await sessionRole(page, CLAUDE)
    await bell.click()
    const popover = page.getByTestId('inbox-popover')
    await expect(popover).toBeVisible()
    await shot(page, 't161-inbox-open')

    const claudeItem = popover.locator('li').filter({ has: page.locator('[data-inbox-request]', { hasText: 'Which port' }) })
    const shellItem = popover.locator('li').filter({ has: page.locator('[data-inbox-request]', { hasText: 'Sign in to the staging' }) })

    // No agent in the shell session: Reply is there but off, and says why.
    const shellReply = shellItem.getByTestId('inbox-reply-toggle')
    await expect(shellReply).toBeDisabled()
    await expect(shellReply).toHaveAttribute('title', /no agent/i)

    // Reply: real keys, Enter sends; the popover stays and the row stays unread.
    await claudeItem.getByTestId('inbox-reply-toggle').click()
    const box = claudeItem.getByTestId('inbox-reply-input')
    await expect(box).toBeFocused()
    await page.keyboard.type('use port 4100')
    await shot(page, 't161-inbox-reply')
    await page.keyboard.press('Enter')
    await expect(claudeItem.getByTestId('inbox-reply-status')).toHaveAttribute('data-state', 'sent', { timeout: 10_000 })
    await expect.poll(() => terminalLines(page, CLAUDE), { timeout: 10_000 }).toContain('ANSWER[1]: use port 4100')
    await expect(box).toHaveValue('')
    await expect(popover).toBeVisible()
    await expect(claudeItem.locator('[data-inbox-request]')).toHaveAttribute('data-read', 'false')
    await expect(bell).toHaveAttribute('data-unread', '2')
    expect(await sessionRole(page, CLAUDE)).toBe(roleBefore)

    // A question on the agent's screen: the reply is refused inline and its text is kept.
    await page.keyboard.type('ASK')
    await page.keyboard.press('Enter')
    await expect(claudeItem.getByTestId('inbox-reply-status')).toHaveAttribute('data-state', 'sent', { timeout: 10_000 })
    await expect.poll(() => terminalLines(page, CLAUDE), { timeout: 10_000 }).toContain('Do you want to proceed?')
    await box.focus()
    await page.keyboard.type('second answer')
    await page.keyboard.press('Enter')
    const status = claudeItem.getByTestId('inbox-reply-status')
    await expect(status).toHaveAttribute('data-state', 'rejected', { timeout: 10_000 })
    await expect(status).toContainText('asking a question')
    await expect(box).toHaveValue('second answer')
    await shot(page, 't161-inbox-refused')
    expect(await terminalLines(page, CLAUDE)).not.toContain('second answer')

    // Esc closes the reply box, not the popover; a second Esc closes the popover.
    await page.keyboard.press('Escape')
    await expect(box).toHaveCount(0)
    await expect(popover).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(popover).toHaveCount(0)
})
