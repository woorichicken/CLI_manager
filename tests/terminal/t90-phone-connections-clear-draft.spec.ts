import { test, expect, type CDPSession, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { closeApp, launchAppWithWorkspaces, LaunchResult, REPO_ROOT, resizeMainWindow, waitForBufferText, writeToTerminal } from './helpers'

/**
 * T90 — phone-fixes C (11-05), against the real app and its phone server.
 *
 *  - C-2 Settings › Phone lists the phones connected now: the owner's phone over Tailscale (never
 *    paired, so «Paired devices (0)» alone looked like nothing) and a paired phone straight to
 *    127.0.0.1 (a USB cable with adb reverse), each with its route and browser.
 *  - C-1 a Chat send refused because the Mac's terminal input line holds text shows that text and
 *    offers «Clear and send…» → a second press → main clears the box (Ctrl+K, Ctrl+U) and sends.
 *    The session is a renamed Claude (chat-mock --name): its box's top rule carries the name (A).
 *
 * T90_SHOTS=<dir> saves captures, named with T90_LABEL (before/after), before the checks run, so an
 * old build gives its «before» in the same run.
 */

const SHELL = 't90-shell'
const CLAUDE = 't90-claude'
const CLAUDE_ID = '00000000-0000-4000-8000-00000000c90a'
const OWNER = 'owner-t90@example.com'
const PORT = 47890
const DPR = 3
const MOCK = path.join(REPO_ROOT, 'scripts/mock-cli/chat-mock.cjs')
const ANDROID_CHROME = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36'
const LABEL = process.env.T90_LABEL ?? 'run'

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
    const dir = process.env.T90_SHOTS
    if (!dir) return
    fs.mkdirSync(dir, { recursive: true })
    await page.waitForTimeout(400)
    await page.screenshot({ path: path.join(dir, `${name}-${LABEL}.png`), ...(clip ? { clip } : {}) })
}

async function launch(): Promise<{ app: ElectronApplication; page: Page; base: string; home: string }> {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'climanager-t90-'))
    const project = path.join(home, 'project')
    fs.mkdirSync(project, { recursive: true })
    const statusFile = path.join(home, 'tailscale-status.json')
    fs.writeFileSync(statusFile, JSON.stringify({ BackendState: 'Running', Self: { UserID: 42, DNSName: 'mac.tail1234.ts.net.', TailscaleIPs: ['100.100.1.1'] }, User: { '42': { LoginName: OWNER } } }))
    const transcript = path.join(home, 'claude', 'projects', 'x', `${CLAUDE_ID}.jsonl`)
    fs.mkdirSync(path.dirname(transcript), { recursive: true })
    fs.writeFileSync(transcript, '')
    result = await launchAppWithWorkspaces(
        [{
            id: 'w-t90',
            name: 'T90 project',
            path: project,
            sessions: [
                { id: CLAUDE, name: 'T90 Claude', cliSessionId: CLAUDE_ID, cliToolName: 'claude', cliCommand: `node ${MOCK} --transcript ${transcript} --work-ms 400 --name t90-renamed` },
                { id: SHELL, name: 'T90 Shell' }
            ]
        }],
        { settings: { phone: { enabled: true, port: PORT } }, env: { CLIMANAGER_PHONE_TAILSCALE_STATUS: statusFile, CLAUDE_CONFIG_DIR: path.join(home, 'claude') } }
    )
    const { app, page } = result
    await resizeMainWindow(app, 1280, 800)
    const state = await page.evaluate(() => window.api.getPhoneState())
    expect(state.running).toBe(true)
    return { app, page, base: `http://127.0.0.1:${state.port}`, home }
}

/**
 * A phone window in its own cookie jar. `owner`: let in as this Mac's owner the way `tailscale serve`
 * does it (login + X-Forwarded-For); without it the window is a phone on a USB cable (127.0.0.1).
 */
async function openPhone(app: ElectronApplication, url: string, partition: string, owner: boolean): Promise<{ phone: Page; cdp: CDPSession }> {
    const opened = app.waitForEvent('window')
    await app.evaluate(({ BrowserWindow, session }, o) => {
        const jar = session.fromPartition(o.partition)
        jar.setUserAgent(o.ua)
        if (o.owner) {
            jar.webRequest.onBeforeSendHeaders((details, callback) => {
                callback({ requestHeaders: { ...details.requestHeaders, 'Tailscale-User-Login': o.owner!, 'X-Forwarded-For': '100.101.102.103' } })
            })
        }
        const win = new BrowserWindow({ width: 390, height: 844, useContentSize: true, show: false, webPreferences: { partition: o.partition, backgroundThrottling: false } })
        void win.loadURL(o.url)
    }, { url, partition, owner: owner ? OWNER : null, ua: ANDROID_CHROME })
    const phone = await opened
    await phone.waitForLoadState('domcontentloaded')
    const cdp = await phone.context().newCDPSession(phone)
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: DPR, mobile: true, screenOrientation: { type: 'portraitPrimary', angle: 0 } })
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
    await phone.reload()
    await phone.waitForLoadState('domcontentloaded')
    return { phone, cdp }
}

async function openPhoneSettings(page: Page): Promise<void> {
    await page.locator('[title^="Settings"]').first().click()
    await page.getByTestId('settings-category-phone').click()
    await expect(page.getByTestId('phone-settings')).toBeVisible()
}

test('T90 C-2 Settings › Phone lists the owner over Tailscale and a paired phone on USB', async () => {
    test.setTimeout(180_000)
    const { app, page, base } = await launch()
    await openPhoneSettings(page)
    await expect(page.getByTestId('phone-listening')).toBeVisible({ timeout: 10_000 })

    // the owner's own phone, through `tailscale serve`
    const owner = await openPhone(app, `${base}/`, 't90-owner', true)
    await expect(owner.phone.getByTestId('phone-session-list')).toBeVisible({ timeout: 15_000 })
    // a second phone on a USB cable: pairs with the Mac's code
    const usb = await openPhone(app, `${base}/`, 't90-usb', false)
    await expect(usb.phone.getByTestId('phone-pair')).toBeVisible({ timeout: 15_000 })
    await page.getByTestId('phone-pair-drive').click()
    const code = (await page.getByTestId('phone-pair-code-mac').textContent())!.replace(/\D/g, '')
    await usb.phone.getByTestId('phone-pair-code').fill(code)
    await usb.phone.getByTestId('phone-pair-label').fill('Galaxy M23')
    await usb.phone.getByTestId('phone-pair-submit').click()
    await expect(usb.phone.getByTestId('phone-session-list')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('phone-device')).toHaveCount(1)
    await page.waitForTimeout(1200)
    // the settings pane scrolls: bring the listening line (connections follow it) to its top
    const clip = await page.getByTestId('phone-listening').evaluate((line) => {
        let pane: HTMLElement | null = line.parentElement
        while (pane && !/(auto|scroll)/.test(getComputedStyle(pane).overflowY)) pane = pane.parentElement
        if (!pane) return null
        pane.scrollTop += line.getBoundingClientRect().top - pane.getBoundingClientRect().top - 120
        const box = pane.getBoundingClientRect()
        return { x: box.x, y: box.y, width: box.width, height: Math.min(box.height, 520) }
    })
    await shot(page, 't90-settings-phone-1280', clip ?? undefined)

    const rows = page.getByTestId('phone-connection')
    await expect(rows).toHaveCount(2, { timeout: 10_000 })
    await expect(page.getByTestId('phone-connections')).toContainText('Connected now (2)')
    const ownerRow = page.locator('[data-testid="phone-connection"][data-kind="owner"]')
    await expect(ownerRow).toHaveAttribute('data-route', 'tailscale')
    await expect(ownerRow).toContainText(OWNER)
    await expect(ownerRow).toContainText('Tailscale')
    await expect(ownerRow).toContainText('Chrome · Android')
    const usbRow = page.locator('[data-testid="phone-connection"][data-kind="device"]')
    await expect(usbRow).toHaveAttribute('data-route', 'local')
    await expect(usbRow).toContainText('Galaxy M23')
    await expect(usbRow).toContainText('USB or this Mac')
    await expect(page.getByTestId('phone-badge')).toContainText('Phone on · 2 connected')

    // disconnecting the paired phone takes it off the list at once, not a minute later
    await page.getByTestId('phone-revoke').click()
    await expect(rows).toHaveCount(1, { timeout: 10_000 })
    await expect(rows.first()).toHaveAttribute('data-kind', 'owner')
})

test('T90 C-1 a send refused for text in the Mac box shows it, and «Clear and send» clears it and sends', async () => {
    test.setTimeout(180_000)
    const { app, page, base } = await launch()
    await waitForBufferText(page, CLAUDE, 'Claude Code (mock)', 20_000)
    await waitForBufferText(page, CLAUDE, 't90-renamed ─', 10_000)
    // someone at the Mac typed and left it
    await writeToTerminal(page, CLAUDE, 'left at the mac')
    await waitForBufferText(page, CLAUDE, '❯ left at the mac', 10_000)

    const { phone } = await openPhone(app, `${base}/?session=${CLAUDE}&view=chat`, 't90-chat', true)
    const box = phone.locator('[data-testid="chat-view"] textarea').first()
    await expect(box).toBeVisible({ timeout: 15_000 })
    await box.fill('hello from the phone')
    await phone.locator('[data-testid="chat-send"]').first().click()
    // refused: the old note, or the new one with the text and the button (an old build may send it on top)
    await expect(phone.locator('[data-testid="chat-composer-note"], [data-testid="chat-input-busy"]').first()).toBeVisible({ timeout: 6_000 }).catch(() => undefined)
    await shot(phone, 't90-input-busy-390')

    await expect(phone.getByTestId('chat-input-busy-draft')).toHaveText('left at the mac')
    await phone.getByTestId('chat-input-busy-clear').click()
    await expect(phone.getByTestId('chat-input-busy')).toHaveAttribute('data-state', 'confirm')
    await expect(phone.getByTestId('chat-input-busy')).toContainText('Someone at the Mac may be typing it')
    await shot(phone, 't90-input-busy-confirm-390')
    // the Mac's box still holds it: nothing cleared before the second press
    await waitForBufferText(page, CLAUDE, '❯ left at the mac', 2_000)
    await phone.getByTestId('chat-input-busy-confirm').click()

    // cleared, then sent: the mock prints what it got, and only that
    await waitForBufferText(page, CLAUDE, 'ANSWER[1]: hello from the phone', 15_000)
    const lines = await page.evaluate((id) => window.api.feedbackTerminalContext(id), CLAUDE)
    const text = (lines.terminal?.recentLines ?? []).join('\n')
    expect(text).not.toContain('left at the machello')
    await expect(phone.getByTestId('chat-input-busy')).toHaveCount(0)
    await shot(phone, 't90-input-busy-sent-390')
})
