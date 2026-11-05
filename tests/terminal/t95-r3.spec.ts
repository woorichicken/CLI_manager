import { test, expect, type CDPSession, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { closeApp, launchAppWithWorkspaces, LaunchResult, REPO_ROOT, resizeMainWindow, waitForBufferText } from './helpers'

/**
 * T95 — phone-fixes round 3 (11-05) in the app.
 *
 *  - A: the sidebar's «Phone on» ✕ asks first (Cancel focused); Turn off then switches it off
 *  - 4359b4ee: a Claude Code 2.1.318 turn (chat-mock --spinner 318: no "esc to interrupt") shows «working»
 *  - c21d4b5a · 574c78e4: `/` after other words opens the skill menu (skills only) and picks one
 *  - b2020233: a `climanager://session/…` link in an answer shows that session — Mac and phone
 *  - 1b92a570: the phone's session list searches
 *
 * T95_SHOTS + T95_LABEL save captures before the checks (so an old build leaves its «before»).
 */

const CLAUDE = 'a95c1a0d-0000-4000-8000-00000000c95a'
const SHELL = 'b95e1100-0000-4000-8000-00000000c95b'
const OWNER = 'owner-t95@example.com'
const PORT = 47895
const MOCK = path.join(REPO_ROOT, 'scripts/mock-cli/chat-mock.cjs')
const LABEL = process.env.T95_LABEL ?? 'run'

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
    const dir = process.env.T95_SHOTS
    if (!dir) return
    fs.mkdirSync(dir, { recursive: true })
    await page.waitForTimeout(400)
    await page.screenshot({ path: path.join(dir, `${name}-${LABEL}.png`), ...(clip ? { clip } : {}) })
}
const FULL = { x: 0, y: 0, width: 1280, height: 800 }

async function launch(workMs = 300): Promise<{ app: ElectronApplication; page: Page; base: string }> {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'climanager-t95-'))
    const project = path.join(home, 'project')
    fs.mkdirSync(project, { recursive: true })
    const statusFile = path.join(home, 'tailscale-status.json')
    fs.writeFileSync(statusFile, JSON.stringify({ BackendState: 'Running', Self: { UserID: 42, DNSName: 'mac.tail1234.ts.net.', TailscaleIPs: ['100.100.1.1'] }, User: { '42': { LoginName: OWNER } } }))
    const claudeDir = path.join(home, 'claude')
    for (const skill of ['climanager-session', 'progress-report']) {
        fs.mkdirSync(path.join(claudeDir, 'skills', skill), { recursive: true })
        fs.writeFileSync(path.join(claudeDir, 'skills', skill, 'SKILL.md'), `---\nname: ${skill}\ndescription: The ${skill} skill\n---\n`)
    }
    const transcript = path.join(claudeDir, 'projects', 'x', '00000000-0000-4000-8000-00000000c95a.jsonl')
    fs.mkdirSync(path.dirname(transcript), { recursive: true })
    fs.writeFileSync(transcript, '')
    result = await launchAppWithWorkspaces(
        [{
            id: 'w-t95',
            name: 'T95 project',
            path: project,
            sessions: [
                { id: CLAUDE, name: 'T95 Claude', cliSessionId: '00000000-0000-4000-8000-00000000c95a', cliToolName: 'claude', cliCommand: `node ${MOCK} --transcript ${transcript} --work-ms ${workMs} --spinner 318` },
                { id: SHELL, name: 'T95 Shell target' }
            ]
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

const macChat = (page: Page) => page.locator('[data-testid="chat-view"][data-session-id]:visible')
const visibleTerminal = (page: Page, id: string) => page.locator(`[data-session-id="${id}"] .xterm`).first()

async function openChat(page: Page) {
    await page.getByText('T95 Claude', { exact: true }).first().click()
    await page.waitForTimeout(400)
    await page.getByTestId('view-toggle-chat').click()
    const composer = macChat(page).getByTestId('chat-composer')
    await expect(composer).toBeVisible({ timeout: 15_000 })
    return composer
}

test('T95 Mac: the ✕ on «Phone on» asks first; Cancel, Esc and outside keep it on', async () => {
    test.setTimeout(120_000)
    const { page } = await launch()
    const badge = page.getByTestId('phone-badge')
    await expect(badge).toBeVisible({ timeout: 15_000 })
    await page.getByTestId('phone-badge-off').click()
    await shot(page, 't95-badge-1-after-x', FULL)
    const confirm = page.getByTestId('phone-off-confirm')
    await expect(confirm).toBeVisible()
    await expect(confirm).toContainText('Turn the phone connection off?')
    await expect(confirm).toContainText('No phone is connected now.')
    await expect(page.getByTestId('phone-off-confirm-cancel')).toBeFocused()
    await page.keyboard.press('Enter') // the focused Cancel
    await expect(confirm).toHaveCount(0)
    await expect(badge).toBeVisible()
    await page.getByTestId('phone-badge-off').click()
    await page.keyboard.press('Escape')
    await expect(confirm).toHaveCount(0)
    await page.getByTestId('phone-badge-off').click()
    await page.mouse.click(640, 60)
    await expect(confirm).toHaveCount(0)
    await expect(badge).toBeVisible()
    expect((await page.evaluate(() => window.api.getPhoneState())).running).toBe(true)
    await page.getByTestId('phone-badge-off').click()
    await page.getByTestId('phone-off-confirm-confirm').click()
    await expect(badge).toHaveCount(0)
    expect((await page.evaluate(() => window.api.getPhoneState())).running).toBe(false)
})

test('T95 Mac: a Claude Code 2.1.318 turn shows «working» (4359b4ee)', async () => {
    test.setTimeout(120_000)
    const { page } = await launch(6000)
    const composer = await openChat(page)
    await composer.fill('think for a while')
    await composer.press('Enter')
    // the screen's spinner row is `✳ Galloping… (Ns · ↓ N tokens)` — no "esc to interrupt"
    await expect.poll(async () => (await page.evaluate((id) => window.api.feedbackTerminalContext(id), CLAUDE)).terminal?.recentLines.join('\n') ?? '', { timeout: 10_000 }).toContain('Galloping…')
    await page.waitForTimeout(1500)
    await shot(page, 't95-working-1280', FULL)
    await expect(macChat(page).getByTestId('chat-working')).toBeVisible({ timeout: 5_000 })
    await expect(macChat(page).getByTestId('chat-stop')).toBeVisible()
    // and it ends with the turn
    await expect(macChat(page).getByTestId('chat-working')).toHaveCount(0, { timeout: 15_000 })
})

test('T95 Mac: `/` after other words opens the skill menu (c21d4b5a · 574c78e4)', async () => {
    test.setTimeout(120_000)
    const { page } = await launch()
    const composer = await openChat(page)
    await composer.click()
    await composer.pressSequentially('1번 /cl')
    const menu = macChat(page).getByTestId('chat-complete')
    await shot(page, 't95-inline-skill-1280', FULL)
    await expect(menu).toBeVisible({ timeout: 10_000 })
    await expect(menu).toContainText('/climanager-session')
    // a built-in only runs at the start: `/clear` is not offered mid-line
    await expect(menu).not.toContainText('/clear')
    await composer.press('Enter')
    await expect(composer).toHaveValue('1번 /climanager-session ')
    // the second line of a longer message too
    await composer.fill('어떻게 해결한거야?\n\n그리고 키는 /pro')
    await composer.press('End')
    await expect(menu).toContainText('/progress-report')
})

test('T95 Mac: a session link in an answer shows that session (b2020233)', async () => {
    test.setTimeout(120_000)
    const { page } = await launch()
    const composer = await openChat(page)
    await composer.fill(`LINK ${SHELL}`)
    await composer.press('Enter')
    const links = macChat(page).getByTestId('chat-session-link')
    await expect(macChat(page)).toContainText(`climanager://session/${SHELL.slice(0, 8)}`, { timeout: 15_000 })
    await shot(page, 't95-session-link-1280', FULL)
    await expect(links).toHaveCount(2)
    await expect(visibleTerminal(page, SHELL)).toBeHidden()
    await links.first().click()
    await expect(visibleTerminal(page, SHELL)).toBeVisible({ timeout: 10_000 })
    await shot(page, 't95-session-link-opened-1280', FULL)
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

async function tap(cdp: CDPSession, page: Page, selector: string): Promise<void> {
    const box = await page.locator(selector).first().boundingBox()
    expect(box, selector).not.toBeNull()
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 }] })
    await page.waitForTimeout(60)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
}

test('T95 phone: the session list searches; a session link in the chat opens that session (1b92a570 · b2020233)', async () => {
    test.setTimeout(180_000)
    const { app, page, base } = await launch()
    const { phone, cdp } = await openPhone(app, `${base}/`, 't95-phone')
    const rows = phone.getByTestId('phone-session-row')
    await expect(rows.first()).toBeVisible({ timeout: 15_000 })
    const all = await rows.count()
    await shot(phone, 't95-phone-list-390')
    await tap(cdp, phone, '[data-testid="phone-list-search-toggle"]')
    const box = phone.getByTestId('phone-list-search')
    await expect(box).toBeFocused()
    await box.fill('shell tar')
    await shot(phone, 't95-phone-search-390')
    await expect(rows).toHaveCount(1)
    await expect(rows.first()).toHaveAttribute('data-session-id', SHELL)
    await box.fill('없는 세션')
    await expect(phone.getByTestId('phone-list-search-empty')).toBeVisible()
    await box.fill('t95')
    await expect(rows).toHaveCount(2)
    await tap(cdp, phone, '[data-testid="phone-list-search-toggle"]')
    await expect(rows).toHaveCount(all)
    // Return opens the first match
    await tap(cdp, phone, '[data-testid="phone-list-search-toggle"]')
    await box.fill('claude')
    await box.press('Enter')
    await expect(phone.getByTestId('phone-session')).toHaveAttribute('data-session-id', CLAUDE, { timeout: 10_000 })

    // a session link the agent wrote, tapped in the phone's chat
    const composer = phone.getByTestId('chat-composer')
    await expect(composer).toBeVisible({ timeout: 15_000 })
    await composer.fill(`LINK ${SHELL}`)
    await tap(cdp, phone, '[data-testid="chat-send"]')
    const link = phone.getByTestId('chat-session-link').first()
    await expect(phone.getByTestId('chat-view')).toContainText(`climanager://session/${SHELL.slice(0, 8)}`, { timeout: 15_000 })
    await shot(phone, 't95-phone-link-390')
    await expect(link).toBeVisible()
    await tap(cdp, phone, '[data-testid="chat-session-link"]')
    await expect(phone.getByTestId('phone-session')).toHaveAttribute('data-session-id', SHELL, { timeout: 10_000 })
    await shot(phone, 't95-phone-link-opened-390')

    // A with a phone on: the Mac's ✕ names it, and Cancel leaves it connected
    await expect(page.getByTestId('phone-badge')).toContainText('1 connected', { timeout: 15_000 })
    await page.getByTestId('phone-badge-off').click()
    await expect(page.getByTestId('phone-off-confirm')).toContainText('The 1 connected phone will be cut off.')
    await shot(page, 't95-badge-2-one-phone', FULL)
    await page.getByTestId('phone-off-confirm-cancel').click()
    await expect(page.getByTestId('phone-badge')).toContainText('1 connected')
})
