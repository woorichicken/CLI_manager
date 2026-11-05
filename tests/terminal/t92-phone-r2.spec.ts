import { test, expect, type CDPSession, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { closeApp, launchAppWithWorkspaces, LaunchResult, REPO_ROOT, resizeMainWindow, waitForBufferText } from './helpers'

/**
 * T92 — phone-fixes round 2 (11-05): what a person reported using the phone, against the real app.
 * Touch phone (CDP 390×844, scale 3), let in as the owner the way `tailscale serve` does it.
 *
 *  - ede4906a the drawer is opaque · b85fc49b it opens where it was scrolled
 *  - 2be8b580 a wide table scrolls sideways instead of squeezing words to letters
 *  - 4030a994 a skill typed in the box reads blue · d50fe2b7 the `/` menu puts Claude's most used first
 *  - b6b1b6b6 · 69340cc2 · 847da0aa the phone's own settings: Return sends, quick replies (the Mac's list)
 *  - e05bf978 · 24ab5ab1 back on the page after a while away: «Refreshing…» and a fresh chat socket
 *
 * T92_SHOTS=<dir> + T92_LABEL saves captures before the checks.
 */

const CLAUDE = 't92-claude'
const CLAUDE_ID = '00000000-0000-4000-8000-00000000c92a'
const OWNER = 'owner-t92@example.com'
const PORT = 47892
const DPR = 3
const SHELLS = 24
const MOCK = path.join(REPO_ROOT, 'scripts/mock-cli/chat-mock.cjs')
const LABEL = process.env.T92_LABEL ?? 'run'
const QUICK = ['컴팩트하게 진행하자', 'yes']

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

async function shot(page: Page, name: string): Promise<void> {
    const dir = process.env.T92_SHOTS
    if (!dir) return
    fs.mkdirSync(dir, { recursive: true })
    await page.waitForTimeout(400)
    await page.screenshot({ path: path.join(dir, `${name}-${LABEL}.png`) })
}

async function launch(): Promise<{ app: ElectronApplication; page: Page; base: string }> {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'climanager-t92-'))
    const project = path.join(home, 'project')
    fs.mkdirSync(project, { recursive: true })
    const statusFile = path.join(home, 'tailscale-status.json')
    fs.writeFileSync(statusFile, JSON.stringify({ BackendState: 'Running', Self: { UserID: 42, DNSName: 'mac.tail1234.ts.net.', TailscaleIPs: ['100.100.1.1'] }, User: { '42': { LoginName: OWNER } } }))
    const claudeDir = path.join(home, 'claude')
    for (const name of ['alpha', 'progress-report', 'zeta']) {
        fs.mkdirSync(path.join(claudeDir, 'skills', name), { recursive: true })
        fs.writeFileSync(path.join(claudeDir, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} skill\n---\n`)
    }
    // Claude's own count: run 41 times in the terminal, never picked in this chat
    fs.writeFileSync(path.join(claudeDir, '.claude.json'), JSON.stringify({ skillUsage: { 'progress-report': { usageCount: 41, lastUsedAt: 1 } } }))
    const transcript = path.join(claudeDir, 'projects', 'x', `${CLAUDE_ID}.jsonl`)
    fs.mkdirSync(path.dirname(transcript), { recursive: true })
    fs.writeFileSync(transcript, '')
    const shells = Array.from({ length: SHELLS }, (_, index) => ({ id: `t92-shell-${index}`, name: `T92 Shell ${String(index).padStart(2, '0')}` }))
    result = await launchAppWithWorkspaces(
        [{
            id: 'w-t92',
            name: 'T92 project',
            path: project,
            sessions: [{ id: CLAUDE, name: 'T92 Claude', cliSessionId: CLAUDE_ID, cliToolName: 'claude', cliCommand: `node ${MOCK} --transcript ${transcript} --work-ms 300` }, ...shells]
        }],
        {
            settings: { phone: { enabled: true, port: PORT }, chat: { quickReplies: QUICK } },
            env: { CLIMANAGER_PHONE_TAILSCALE_STATUS: statusFile, CLAUDE_CONFIG_DIR: claudeDir }
        }
    )
    const { app, page } = result
    await resizeMainWindow(app, 1280, 800)
    const state = await page.evaluate(() => window.api.getPhoneState())
    expect(state.running).toBe(true)
    await waitForBufferText(page, CLAUDE, 'Claude Code (mock)', 20_000)
    return { app, page, base: `http://127.0.0.1:${state.port}` }
}

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
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: DPR, mobile: true, screenOrientation: { type: 'portraitPrimary', angle: 0 } })
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

/** The scrim's right edge: its middle is under the drawer (86% wide), where a tap opens a session. */
async function tapScrim(cdp: CDPSession, page: Page): Promise<void> {
    const box = (await page.getByTestId('phone-scrim').boundingBox())!
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + box.width - 12, y: box.y + box.height / 2 }] })
    await page.waitForTimeout(60)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
}

const terminalText = (page: Page, id: string): Promise<string> =>
    page.evaluate((sessionId) => window.api.feedbackTerminalContext(sessionId).then((c) => (c.terminal?.recentLines ?? []).join('\n')), id)

test('T92 the drawer is opaque and opens where it was scrolled (ede4906a · b85fc49b)', async () => {
    test.setTimeout(180_000)
    const { app, base } = await launch()
    const { phone, cdp } = await openPhone(app, `${base}/?session=${CLAUDE}&view=chat`, 't92-drawer')
    await expect(phone.getByTestId('phone-session')).toBeVisible({ timeout: 15_000 })
    await tap(cdp, phone, '[data-testid="phone-menu-button"]')
    const list = phone.getByTestId('phone-session-list')
    await expect(list).toBeVisible()
    // the sessions seeded here, and the app's own Home session
    await expect.poll(() => phone.locator('[data-testid="phone-session-row"]').count(), { timeout: 15_000 }).toBeGreaterThan(SHELLS)
    await list.evaluate((el) => {
        el.scrollTop = 420
        el.dispatchEvent(new Event('scroll'))
    })
    await shot(phone, 't92-drawer-390')
    const background = await phone.getByTestId('phone-sidebar').evaluate((el) => getComputedStyle(el).backgroundColor)
    expect(background, 'no see-through drawer').toBe('rgb(15, 15, 20)')

    // close (the scrim) and open again: the same place, not the top
    await tapScrim(cdp, phone)
    await expect(phone.getByTestId('phone-sidebar')).toHaveCount(0)
    await tap(cdp, phone, '[data-testid="phone-menu-button"]')
    await expect(list).toBeVisible()
    await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBeGreaterThan(400)
})

test('T92 a wide table scrolls sideways; a skill reads blue and the most used one leads the menu (2be8b580 · 4030a994 · d50fe2b7)', async () => {
    test.setTimeout(180_000)
    const { app, page, base } = await launch()
    const { phone } = await openPhone(app, `${base}/?session=${CLAUDE}&view=chat`, 't92-chat')
    const box = phone.getByTestId('chat-composer')
    await expect(box).toBeVisible({ timeout: 15_000 })
    await box.fill('TABLE')
    await phone.getByTestId('chat-send').click()
    await waitForBufferText(page, CLAUDE, 'ANSWER[1]: TABLE', 15_000)
    const wrap = phone.locator('.chat-md-table-wrap').last()
    await expect(wrap).toBeVisible({ timeout: 15_000 })
    await wrap.scrollIntoViewIfNeeded()
    await shot(phone, 't92-table-390')
    const sizes = await wrap.evaluate((el) => {
        const cells = Array.from(el.querySelectorAll('td')).map((cell) => cell.getBoundingClientRect().width)
        return { scroll: el.scrollWidth, client: el.clientWidth, narrowest: Math.min(...cells), fontSize: parseFloat(getComputedStyle(el.querySelector('td')!).fontSize) }
    })
    expect(sizes.scroll, 'wider than the chat: it scrolls').toBeGreaterThan(sizes.client)
    expect(sizes.narrowest, 'no column squeezed to a few letters').toBeGreaterThanOrEqual(6.5 * sizes.fontSize - 1)
    // «lightsoft» stays one word on one line (its text's line boxes, not the cell — the row is as tall as its longest cell)
    const lines = await phone.locator('.chat-md-table-wrap td', { hasText: 'lightsoft' }).last().evaluate((cell) => {
        const range = document.createRange()
        range.selectNodeContents(cell)
        return new Set(Array.from(range.getClientRects()).map((rect) => Math.round(rect.top))).size
    })
    expect(lines).toBe(1)

    // the `/` menu: Claude's own count puts progress-report first
    await box.fill('/')
    const rows = phone.getByTestId('chat-complete-row')
    await expect(rows.first()).toBeVisible({ timeout: 10_000 })
    await expect(rows.first()).toContainText('/progress-report')
    await shot(phone, 't92-skill-menu-390')
    await box.fill('/progress-report')
    await expect(box).toHaveAttribute('data-command', 'true')
    expect(await box.evaluate((el) => getComputedStyle(el).color)).toBe('rgb(147, 197, 253)')
    await box.fill('plain words')
    await expect(box).not.toHaveAttribute('data-command', 'true')
})

test('T92 the phone\'s own settings: quick replies from the Mac\'s list, Return sends (b6b1b6b6 · 847da0aa · 69340cc2)', async () => {
    test.setTimeout(180_000)
    const { app, page, base } = await launch()
    const { phone, cdp } = await openPhone(app, `${base}/?session=${CLAUDE}&view=chat`, 't92-settings')
    const box = phone.getByTestId('chat-composer')
    await expect(box).toBeVisible({ timeout: 15_000 })
    // default: Return is a new line, no chips
    await box.fill('line one')
    await box.press('Enter')
    await expect(box).toHaveValue('line one\n')
    await box.fill('')
    await expect(phone.getByTestId('chat-quick-replies')).toHaveCount(0)

    await tap(cdp, phone, '[data-testid="phone-menu-button"]')
    await tap(cdp, phone, '[data-testid="phone-settings-button"]')
    const menu = phone.getByTestId('phone-settings-menu')
    await expect(menu).toBeVisible()
    await expect(menu).toContainText(QUICK.join(' · '))
    await shot(phone, 't92-phone-settings-390')
    await phone.getByTestId('phone-setting-quick-replies').check()
    await phone.getByTestId('phone-setting-return-sends').check()
    await tapScrim(cdp, phone)

    const chips = phone.getByTestId('chat-quick-replies')
    await expect(chips).toBeVisible()
    await expect(chips).toContainText(QUICK[0])
    await shot(phone, 't92-quick-replies-390')
    await chips.getByRole('button', { name: QUICK[0] }).click()
    await waitForBufferText(page, CLAUDE, `ANSWER[1]: ${QUICK[0]}`, 15_000)

    await expect.poll(async () => (await terminalText(page, CLAUDE)).includes('Echo:'), { timeout: 15_000 }).toBe(true)
    await page.waitForTimeout(800)
    await box.fill('sent with return')
    await box.press('Enter')
    await waitForBufferText(page, CLAUDE, 'ANSWER[2]: sent with return', 15_000)

    // kept on this phone across a reload
    await phone.reload()
    await expect(phone.getByTestId('chat-quick-replies')).toBeVisible({ timeout: 15_000 })
})

test('T92 back on the page after a while away: «Refreshing…» and a fresh chat socket (e05bf978 · 24ab5ab1)', async () => {
    test.setTimeout(180_000)
    const { app, base } = await launch()
    const { phone } = await openPhone(app, `${base}/?session=${CLAUDE}&view=chat`, 't92-away')
    await expect(phone.getByTestId('chat-composer')).toBeVisible({ timeout: 15_000 })
    // count chat sockets the page opens from here on
    await phone.evaluate(() => {
        const g = window as unknown as { __t92Sockets: string[]; WebSocket: typeof WebSocket }
        g.__t92Sockets = []
        const Original = g.WebSocket
        g.WebSocket = class extends Original {
            constructor(url: string | URL, protocols?: string | string[]) {
                super(url, protocols)
                g.__t92Sockets.push(String(url))
            }
        } as typeof WebSocket
    })
    const setVisibility = (state: 'hidden' | 'visible'): Promise<void> =>
        phone.evaluate((value) => {
            Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value })
            document.dispatchEvent(new Event('visibilitychange'))
        }, state)
    await setVisibility('hidden')
    await phone.waitForTimeout(5_400)
    await setVisibility('visible')
    await expect(phone.getByTestId('phone-header-refreshing')).toBeVisible({ timeout: 2_000 })
    await shot(phone, 't92-refreshing-390')
    await expect.poll(() => phone.evaluate(() => (window as unknown as { __t92Sockets: string[] }).__t92Sockets.filter((url) => url.includes('/events')).length)).toBeGreaterThanOrEqual(1)
    await expect(phone.getByTestId('phone-header-refreshing')).toHaveCount(0, { timeout: 10_000 })
    // a short look away is not «away»
    await setVisibility('hidden')
    await phone.waitForTimeout(800)
    await setVisibility('visible')
    await phone.waitForTimeout(300)
    await expect(phone.getByTestId('phone-header-refreshing')).toHaveCount(0)
})
