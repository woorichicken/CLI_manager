import { test, expect, type CDPSession, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { closeApp, launchAppWithWorkspaces, LaunchResult, REPO_ROOT, resizeMainWindow, waitForBufferText, writeToTerminal } from './helpers'

/**
 * T143 — Claude's dim next-prompt suggestion in the Chat box (ba2ae0cb, spec 2026-11-16 · mockup P-3).
 *
 *  - Mac: the empty box shows the suggestion dim with «Tab to use»; typing hides it; Tab fills the box
 *    (nothing is sent), Enter sends it and the agent gets exactly that text; a new suggestion follows
 *    within 3 s of the turn's end; text typed at the terminal hides it, and it comes back when cleared
 *  - phone (CDP 390, touch): a long suggestion is one line cut with …, the Use pill does not cover Send,
 *    Use fills the box and Send sends it
 *
 * The session runs chat-mock `--suggest` (Claude Code's drawing: the cursor inverse on the first letter,
 * the rest dim). T143_SHOTS + T143_LABEL save captures before the checks.
 */

const CLAUDE = 't143-claude'
const OWNER = 'owner-t143@example.com'
const PORT = 47943
const MOCK = path.join(REPO_ROOT, 'scripts/mock-cli/chat-mock.cjs')
const LABEL = process.env.T143_LABEL ?? 'run'
const FIRST = 'run the tests and show me what failed'
const LONG = 'look through the failing parser cases again and list the inputs that still break it'
/** the spec's bound: a changed suggestion shows within 3 s */
const FOLLOW_MS = 3000

let result: LaunchResult | null = null
test.afterEach(async () => {
    if (result) {
        const done = result
        const closed = await Promise.race([closeApp(done).then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 20_000))])
        if (!closed) {
            done.app.process().kill('SIGKILL')
            fs.rmSync(done.userDataDir, { recursive: true, force: true })
        }
    }
    result = null
})

async function shot(page: Page, name: string, clip?: { x: number; y: number; width: number; height: number }): Promise<void> {
    const dir = process.env.T143_SHOTS
    if (!dir) return
    fs.mkdirSync(dir, { recursive: true })
    await page.waitForTimeout(400)
    await page.screenshot({ path: path.join(dir, `${name}-${LABEL}.png`), ...(clip ? { clip } : {}) })
}

async function launch(suggestion: string): Promise<{ app: ElectronApplication; page: Page; base: string }> {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'climanager-t143-'))
    const project = path.join(home, 'project')
    fs.mkdirSync(project, { recursive: true })
    const statusFile = path.join(home, 'tailscale-status.json')
    fs.writeFileSync(statusFile, JSON.stringify({ BackendState: 'Running', Self: { UserID: 42, DNSName: 'mac.tail1234.ts.net.', TailscaleIPs: ['100.100.1.1'] }, User: { '42': { LoginName: OWNER } } }))
    const claudeDir = path.join(home, 'claude')
    const transcript = path.join(claudeDir, 'projects', 'x', '00000000-0000-4000-8000-0000000c1430.jsonl')
    fs.mkdirSync(path.dirname(transcript), { recursive: true })
    fs.writeFileSync(transcript, '')
    result = await launchAppWithWorkspaces(
        [{
            id: 'w-t143',
            name: 'T143 project',
            path: project,
            sessions: [{
                id: CLAUDE,
                name: 'T143 Claude',
                cliSessionId: '00000000-0000-4000-8000-0000000c1430',
                cliToolName: 'claude',
                cliCommand: `node ${MOCK} --transcript ${transcript} --work-ms 300 --suggest '${suggestion}'`
            }]
        }],
        {
            settings: { phone: { enabled: true, port: PORT } },
            env: { CLIMANAGER_PHONE_TAILSCALE_STATUS: statusFile, CLAUDE_CONFIG_DIR: claudeDir }
        }
    )
    const { app, page } = result
    await resizeMainWindow(app, 1280, 800)
    await waitForBufferText(page, CLAUDE, 'Claude Code (mock)', 20_000)
    const state = await page.evaluate(() => window.api.getPhoneState())
    return { app, page, base: `http://127.0.0.1:${state.port}` }
}

const terminalLines = (page: Page, id: string): Promise<string> =>
    page.evaluate((sessionId) => window.api.feedbackTerminalContext(sessionId).then((c) => (c.terminal?.recentLines ?? []).join('\n')), id)

const macChat = (page: Page) => page.locator('[data-testid="chat-view"][data-session-id]:visible')

test('T143 Mac: the suggestion shows dim in the empty box, Tab fills it, Enter sends exactly it, and it follows the terminal', async () => {
    test.setTimeout(180_000)
    const { page } = await launch(FIRST)
    await page.getByText('T143 Claude', { exact: true }).first().click()
    await page.waitForTimeout(400)
    await page.getByTestId('view-toggle-chat').click()
    const chat = macChat(page)
    const composer = chat.getByTestId('chat-composer')
    await expect(composer).toBeVisible({ timeout: 15_000 })
    await shot(page, 't143-mac-1-suggestion', { x: 0, y: 0, width: 1280, height: 800 })

    const suggestion = chat.getByTestId('chat-suggestion')
    await expect(suggestion).toHaveText(FIRST, { timeout: FOLLOW_MS + 5000 })
    await expect(chat.getByTestId('chat-suggestion-use')).toContainText('Tab')
    // it stands in for the placeholder, it is not text in the box
    await expect(composer).toHaveAttribute('placeholder', '')
    await expect(composer).toHaveValue('')

    // typing hides it, an empty box brings it back
    await composer.focus()
    await page.keyboard.type('x')
    await expect(suggestion).toBeHidden()
    await page.keyboard.press('Backspace')
    await expect(suggestion).toHaveText(FIRST)

    // a new turn's suggestion follows within 3 s of the turn's end
    await composer.fill('SUGGEST check the logs please')
    await page.keyboard.press('Enter')
    await expect.poll(() => terminalLines(page, CLAUDE), { timeout: 10_000 }).toContain('⏺ Here is a next step.')
    await expect(suggestion).toHaveText('check the logs please', { timeout: FOLLOW_MS })

    // Tab fills the box and sends nothing
    await composer.focus()
    await page.keyboard.press('Tab')
    await expect(composer).toHaveValue('check the logs please')
    await expect(composer).toBeFocused()
    await expect(suggestion).toBeHidden()
    await shot(page, 't143-mac-2-tab', { x: 0, y: 0, width: 1280, height: 800 })
    await page.waitForTimeout(600)
    expect(await terminalLines(page, CLAUDE)).not.toContain('ANSWER[2]')
    // Enter sends: the agent gets exactly the suggestion
    await page.keyboard.press('Enter')
    await expect.poll(() => terminalLines(page, CLAUDE), { timeout: 10_000 }).toContain('ANSWER[2]: check the logs please')
    // the agent dropped it with the new turn: so does the chat
    await expect(suggestion).toBeHidden({ timeout: FOLLOW_MS })

    // typed at the terminal: it goes from the chat; cleared there: it comes back
    await composer.fill('SUGGEST alpha beta gamma')
    await page.keyboard.press('Enter')
    await expect(suggestion).toHaveText('alpha beta gamma', { timeout: 10_000 })
    await writeToTerminal(page, CLAUDE, 'z')
    await expect(suggestion).toBeHidden({ timeout: FOLLOW_MS })
    await writeToTerminal(page, CLAUDE, '\x7f')
    await expect(suggestion).toHaveText('alpha beta gamma', { timeout: FOLLOW_MS })

    // Tab without a suggestion keeps its old job: the box does not fill
    await composer.fill('SUGGEST')
    await page.keyboard.press('Enter')
    await expect.poll(() => terminalLines(page, CLAUDE), { timeout: 10_000 }).toContain('⏺ Nothing to suggest.')
    await expect(suggestion).toBeHidden({ timeout: FOLLOW_MS })
    await composer.focus()
    await page.keyboard.press('Tab')
    await expect(composer).toHaveValue('')
})

async function openPhone(app: ElectronApplication, url: string, partition: string): Promise<{ phone: Page; cdp: CDPSession }> {
    const opened = app.waitForEvent('window')
    await app.evaluate(({ BrowserWindow, session }, o) => {
        const jar = session.fromPartition(o.partition)
        jar.webRequest.onBeforeSendHeaders((details, callback) => {
            callback({ requestHeaders: { ...details.requestHeaders, 'Tailscale-User-Login': o.owner, 'X-Forwarded-For': '100.101.102.103' } })
        })
        const win = new BrowserWindow({ width: 390, height: 844, useContentSize: true, show: false, webPreferences: { partition: o.partition, backgroundThrottling: false } })
        void win.loadURL(o.url)
    }, { url, partition, owner: OWNER })
    const phone = await opened
    await phone.waitForLoadState('domcontentloaded')
    const cdp = await phone.context().newCDPSession(phone)
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true, screenOrientation: { type: 'portraitPrimary', angle: 0 } })
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
    await phone.reload()
    await phone.waitForLoadState('domcontentloaded')
    return { phone, cdp }
}

async function tap(cdp: CDPSession, page: Page, testId: string): Promise<void> {
    const box = await page.getByTestId(testId).boundingBox()
    expect(box, testId).not.toBeNull()
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 }] })
    await page.waitForTimeout(60)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
}

test('T143 phone: a long suggestion is one cut line, Use fills the box without covering Send, Send sends it', async () => {
    test.setTimeout(180_000)
    const { app, page, base } = await launch(LONG)
    const { phone, cdp } = await openPhone(app, `${base}/?session=${CLAUDE}&view=chat`, 't143-phone')
    const composer = phone.getByTestId('chat-composer')
    await expect(composer).toBeVisible({ timeout: 15_000 })
    await shot(phone, 't143-phone-1-suggestion')

    const suggestion = phone.getByTestId('chat-suggestion')
    await expect(suggestion).toHaveText(LONG, { timeout: FOLLOW_MS + 5000 })
    const use = phone.getByTestId('chat-suggestion-use')
    await expect(use).toHaveText('Use')

    // one line, cut with …
    const fit = await suggestion.evaluate((element) => {
        const style = getComputedStyle(element)
        return { cut: element.scrollWidth > element.clientWidth, overflow: style.textOverflow, wrap: style.whiteSpace, height: element.getBoundingClientRect().height, line: parseFloat(style.lineHeight) }
    })
    expect(fit.cut).toBe(true)
    expect(fit.overflow).toBe('ellipsis')
    expect(fit.wrap).toBe('nowrap')
    expect(fit.height).toBeLessThan(fit.line * 2)
    // the pill, the text and Send keep apart
    const useBox = (await use.boundingBox())!
    const sendBox = (await phone.getByTestId('chat-send').boundingBox())!
    const textBox = (await suggestion.boundingBox())!
    expect(useBox.x + useBox.width).toBeLessThanOrEqual(sendBox.x)
    expect(textBox.x + textBox.width).toBeLessThanOrEqual(useBox.x + 1)
    expect(useBox.x).toBeGreaterThanOrEqual(0)
    expect(sendBox.x + sendBox.width).toBeLessThanOrEqual(390)

    await tap(cdp, phone, 'chat-suggestion-use')
    await expect(composer).toHaveValue(LONG)
    await expect(suggestion).toBeHidden()
    // the keyboard stays down: Use does not focus the box
    expect(await composer.evaluate((element) => document.activeElement === element)).toBe(false)
    await shot(phone, 't143-phone-2-used')
    await page.waitForTimeout(600)
    expect(await terminalLines(page, CLAUDE)).not.toContain('ANSWER[1]')
    await tap(cdp, phone, 'chat-send')
    await expect.poll(() => terminalLines(page, CLAUDE), { timeout: 10_000 }).toContain(`ANSWER[1]: ${LONG}`)
})
