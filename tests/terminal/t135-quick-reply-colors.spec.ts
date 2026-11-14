import { test, expect, type CDPSession, type ElectronApplication, type Locator, type Page, _electron as electron } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { closeApp, launchAppWithWorkspaces, type LaunchResult, REPO_ROOT, resizeMainWindow, waitForBufferText } from './helpers'

/**
 * T135 — a colour per quick reply (report 93bd4834, fb-1114b).
 *
 * Settings › Terminal › Chat view: each reply gets one of a few fixed colours (or none). The Mac Chat's
 * chips and the phone's chips (390×844, scale 3, owner header — the T96 way) wear that colour, readable on
 * the dark chat (contrast ≥ 4.5 against the chip's own background over the chat's). The stored list stays a
 * list of strings — a saved value from before (strings only) opens as it was, and `/me` still sends strings,
 * so an older phone page keeps working. Judged on computed styles, config.json and a restart.
 */

const MOCK = path.join(REPO_ROOT, 'scripts/mock-cli/chat-mock.cjs')
const SESSION = 't135-claude'
const SESSION_ID = '00000000-0000-4000-8000-00000000c135'
const OWNER = 'owner-t135@example.com'
const PORT = 47935
const PHRASES = ['계속 진행', '좋아', '다시 해 줘']
/** the dark theme's chip text, per colour (chat.css) */
const DARK_FG = { green: 'rgb(134, 239, 172)', red: 'rgb(252, 165, 165)' }

let result: LaunchResult | null = null
let relaunched: ElectronApplication | null = null
const dirs: string[] = []
test.afterEach(async () => {
    if (relaunched) await relaunched.close().catch(() => undefined)
    relaunched = null
    if (result) await closeApp(result)
    result = null
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function seed(): { project: string; claudeDir: string; transcript: string; statusFile: string } {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'climanager-t135-'))
    dirs.push(home)
    const project = path.join(home, 'project')
    fs.mkdirSync(project, { recursive: true })
    const claudeDir = path.join(home, 'claude')
    const transcript = path.join(claudeDir, 'projects', project.replace(/[^a-zA-Z0-9]/g, '-'), `${SESSION_ID}.jsonl`)
    fs.mkdirSync(path.dirname(transcript), { recursive: true })
    fs.writeFileSync(transcript, '')
    const statusFile = path.join(home, 'tailscale-status.json')
    fs.writeFileSync(statusFile, JSON.stringify({ BackendState: 'Running', Self: { UserID: 42, DNSName: 'mac.tail1234.ts.net.', TailscaleIPs: ['100.100.1.1'] }, User: { '42': { LoginName: OWNER } } }))
    return { project, claudeDir, transcript, statusFile }
}

const readSettings = (dir: string): { chat?: { quickReplies?: unknown; quickReplyColors?: Record<string, string> } } =>
    JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).settings

const chip = (root: Page | Locator, reply: string): Locator =>
    root.getByTestId('chat-quick-replies').getByRole('button', { name: reply, exact: true })

/** WCAG contrast of the chip's text against its own background laid over the chat's. */
async function chipContrast(page: Page, reply: string): Promise<number> {
    return page.evaluate((text) => {
        const button = Array.from(document.querySelectorAll('[data-testid="chat-quick-replies"] button')).find((b) => b.textContent?.trim() === text) as HTMLElement
        const parse = (value: string): number[] => (value.match(/[\d.]+/g) ?? []).map(Number)
        let under = [0, 0, 0]
        for (let el: HTMLElement | null = button.parentElement; el; el = el.parentElement) {
            const [r, g, b, a = 1] = parse(getComputedStyle(el).backgroundColor)
            if (a > 0) { under = [r, g, b]; break }
        }
        const [br, bg, bb, ba = 1] = parse(getComputedStyle(button).backgroundColor)
        const back = [br, bg, bb].map((c, i) => c * ba + under[i] * (1 - ba))
        const fore = parse(getComputedStyle(button).color).slice(0, 3)
        const lum = (rgb: number[]): number => {
            const [r, g, b] = rgb.map((c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 })
            return 0.2126 * r + 0.7152 * g + 0.0722 * b
        }
        const [hi, lo] = [lum(fore), lum(back)].sort((a, b) => b - a)
        return (hi + 0.05) / (lo + 0.05)
    }, reply)
}

async function openPhone(app: ElectronApplication, url: string): Promise<{ phone: Page; cdp: CDPSession }> {
    const opened = app.waitForEvent('window')
    await app.evaluate(({ BrowserWindow, session }, o) => {
        const jar = session.fromPartition(o.partition)
        jar.webRequest.onBeforeSendHeaders((details, callback) => {
            callback({ requestHeaders: { ...details.requestHeaders, 'Tailscale-User-Login': o.owner, 'X-Forwarded-For': '100.101.102.103' } })
        })
        const win = new BrowserWindow({ width: 390, height: 844, useContentSize: true, show: false, webPreferences: { partition: o.partition, backgroundThrottling: false } })
        void win.loadURL(o.url)
    }, { url, partition: 't135-phone', owner: OWNER })
    const phone = await opened
    await phone.waitForLoadState('domcontentloaded')
    const cdp = await phone.context().newCDPSession(phone)
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true, screenOrientation: { type: 'portraitPrimary', angle: 0 } })
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
    await phone.reload()
    await phone.waitForLoadState('domcontentloaded')
    return { phone, cdp }
}

/** The chip's border colour, plain and with :hover forced through DevTools (no pointer on a touch page). */
async function borderPlainAndHovered(page: Page, cdp: CDPSession, reply: string): Promise<[string, string]> {
    const selector = `[data-testid="chat-quick-replies"] button[title="Send “${reply}”"], [data-testid="chat-quick-replies"] button[title="Sending…"]`
    const read = (): Promise<string> => page.evaluate(({ sel, text }) => {
        const button = Array.from(document.querySelectorAll(sel)).find((b) => b.textContent?.trim() === text) as HTMLElement
        return getComputedStyle(button).borderTopColor
    }, { sel: selector, text: reply })
    const plain = await read()
    await cdp.send('DOM.enable')
    await cdp.send('CSS.enable')
    const { root } = await cdp.send('DOM.getDocument', { depth: -1 })
    const { nodeIds } = await cdp.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector: '[data-testid="chat-quick-replies"] button' })
    const texts = await page.evaluate(() => Array.from(document.querySelectorAll('[data-testid="chat-quick-replies"] button')).map((b) => b.textContent?.trim()))
    const nodeId = nodeIds[texts.indexOf(reply)]
    await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['hover'] })
    const hovered = await read()
    await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] })
    return [plain, hovered]
}

async function openMacChat(page: Page): Promise<void> {
    await page.getByText('T135 Claude', { exact: true }).first().click()
    await page.getByTestId('view-toggle-chat').click()
    await expect(page.locator('[data-testid="chat-view"][data-session-id]:visible').getByTestId('chat-composer')).toBeVisible()
}

test('T135 a colour per quick reply: Settings → Mac Chat → phone, kept across a restart, old string list still reads', async () => {
    test.setTimeout(200_000)
    const { project, claudeDir, transcript, statusFile } = seed()
    result = await launchAppWithWorkspaces(
        [{
            id: 'w-t135',
            name: 'T135 project',
            path: project,
            sessions: [{ id: SESSION, name: 'T135 Claude', cliSessionId: SESSION_ID, cliToolName: 'claude', cliCommand: `node ${MOCK} --transcript ${transcript} --work-ms 300 --mode-row none` }]
        }],
        {
            // saved the way every build so far saved it: a plain list of strings
            settings: { phone: { enabled: true, port: PORT }, chat: { showQuickReplies: true, quickReplies: PHRASES } },
            env: { CLIMANAGER_PHONE_TAILSCALE_STATUS: statusFile, CLAUDE_CONFIG_DIR: claudeDir }
        }
    )
    const { app, page, userDataDir } = result
    await resizeMainWindow(app, 1280, 800)
    await waitForBufferText(page, SESSION, 'Claude Code (mock)', 20_000)

    // --- The old string list opens as it was ---------------------------------
    await openMacChat(page)
    const macChat = page.locator('[data-testid="chat-view"][data-session-id]:visible')
    for (const reply of PHRASES) await expect(chip(macChat, reply)).toBeVisible()
    await expect(chip(macChat, PHRASES[0])).not.toHaveAttribute('data-color', /.+/)

    // --- Settings: green for the first, red for the second ---------------------
    await page.locator('button[title^="Settings"]').first().click()
    await page.getByTestId('settings-category-terminal').click()
    const settings = page.getByTestId('chat-view-settings')
    await settings.scrollIntoViewIfNeeded()
    await settings.getByTestId('quick-reply-color-0-green').click()
    await settings.getByTestId('quick-reply-color-1-red').click()
    await expect(settings.getByTestId('quick-reply-color-0-green')).toHaveAttribute('aria-checked', 'true')
    await expect(settings.getByTestId('quick-reply-color-2-none')).toHaveAttribute('aria-checked', 'true')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByTestId('chat-view-settings')).toHaveCount(0)

    // Stored next to the list, which stays strings — what older builds and phones read.
    await expect.poll(() => readSettings(userDataDir).chat?.quickReplyColors).toEqual({ [PHRASES[0]]: 'green', [PHRASES[1]]: 'red' })
    expect(readSettings(userDataDir).chat?.quickReplies).toEqual(PHRASES)

    // --- Mac Chat chips wear it, readable on the dark chat -----------------------
    await expect(chip(macChat, PHRASES[0])).toHaveAttribute('data-color', 'green')
    await expect(chip(macChat, PHRASES[0])).toHaveCSS('color', DARK_FG.green)
    await expect(chip(macChat, PHRASES[1])).toHaveCSS('color', DARK_FG.red)
    await expect(chip(macChat, PHRASES[2])).not.toHaveAttribute('data-color', /.+/)
    expect(await chipContrast(page, PHRASES[0])).toBeGreaterThanOrEqual(4.5)
    expect(await chipContrast(page, PHRASES[1])).toBeGreaterThanOrEqual(4.5)

    // --- The phone (390) shows the same colours ----------------------------------
    const state = await page.evaluate(() => window.api.getPhoneState())
    const { phone, cdp } = await openPhone(app, `http://127.0.0.1:${state.port}/?session=${SESSION}&view=chat`)
    await expect(chip(phone, PHRASES[0])).toBeVisible({ timeout: 15_000 })
    await expect(chip(phone, PHRASES[0])).toHaveCSS('color', DARK_FG.green)
    await expect(chip(phone, PHRASES[1])).toHaveCSS('color', DARK_FG.red)
    expect(await chipContrast(phone, PHRASES[0])).toBeGreaterThanOrEqual(4.5)
    // An older phone page reads `quickReplies` as strings: still strings, colours beside them.
    const me = await phone.evaluate(async () => (await fetch('/api/phone/me')).json()) as { quickReplies?: unknown[]; quickReplyColors?: Record<string, string> }
    expect(me.quickReplies).toEqual(PHRASES)
    expect(me.quickReplyColors).toEqual({ [PHRASES[0]]: 'green', [PHRASES[1]]: 'red' })

    // --- One reply on its way: the waiting chips do not light up under the pointer (PR #139 review) ----
    // a busy Mac: the send answers after 8 s, so the other chips stay disabled meanwhile
    await phone.evaluate(() => {
        const w = window as unknown as { fetch: typeof fetch }
        const original = w.fetch.bind(window)
        w.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
            if (/\/send$/.test(url) && init?.method === 'POST') await new Promise((resolve) => setTimeout(resolve, 8_000))
            return original(input, init)
        }
    })
    await chip(phone, PHRASES[0]).click()
    await expect(chip(phone, PHRASES[0])).toHaveAttribute('data-sending', 'true')
    await expect(chip(phone, PHRASES[1])).toBeDisabled()
    const [plainDisabled, plainDisabledHover] = await borderPlainAndHovered(phone, cdp, PHRASES[2])
    expect(plainDisabledHover, 'a plain waiting chip keeps its border').toBe(plainDisabled)
    const [redDisabled, redDisabledHover] = await borderPlainAndHovered(phone, cdp, PHRASES[1])
    expect(redDisabledHover, 'a coloured waiting chip keeps its border, as a plain one does').toBe(redDisabled)
    const [, sendingHover] = await borderPlainAndHovered(phone, cdp, PHRASES[0])
    expect(sendingHover, 'the sending chip stays lit').toBe(DARK_FG.green)
    await expect(chip(phone, PHRASES[0])).not.toHaveAttribute('data-sending', 'true', { timeout: 15_000 })

    // --- Restart: the colours stay ------------------------------------------------
    const keptDir = userDataDir
    await app.close()
    dirs.push(keptDir)
    result.userDataDir = path.join(keptDir, '..', 'climanger-t135-unused')
    relaunched = await electron.launch({
        args: [path.join(REPO_ROOT, 'out/main/index.js')],
        env: { ...process.env, CLIMANGER_TEST_USERDATA: keptDir, CLIMANGER_TERM_DEBUG: '1', CLIMANGER_TEST_HEADLESS: '1', CLIMANAGER_PHONE_TAILSCALE_STATUS: statusFile, CLAUDE_CONFIG_DIR: claudeDir } as Record<string, string>
    })
    const page2 = await relaunched.firstWindow()
    await page2.getByText('T135 Claude', { exact: true }).first().waitFor({ timeout: 30_000 })
    await openMacChat(page2)
    const macChat2 = page2.locator('[data-testid="chat-view"][data-session-id]:visible')
    await expect(chip(macChat2, PHRASES[0])).toHaveCSS('color', DARK_FG.green)
    await expect(chip(macChat2, PHRASES[1])).toHaveCSS('color', DARK_FG.red)

    // --- The keyboard: a radio group per row — ← / → move the choice, Tab stops once per row (PR #139 review) ----
    await page2.locator('button[title^="Settings"]').first().click()
    await page2.getByTestId('settings-category-terminal').click()
    const row0 = page2.getByTestId('quick-reply-color-0')
    await expect(row0.getByRole('radiogroup')).toHaveCount(1)
    await expect(row0.locator('[aria-pressed]')).toHaveCount(0)
    await expect(row0.locator('[tabindex="0"]')).toHaveCount(1)
    await page2.getByTestId('quick-reply-color-0-green').focus()
    await page2.keyboard.press('ArrowRight')
    await expect(page2.getByTestId('quick-reply-color-0-amber')).toHaveAttribute('aria-checked', 'true')
    await expect(page2.getByTestId('quick-reply-color-0-amber')).toBeFocused()
    await expect(page2.getByTestId('quick-reply-color-0-green')).toHaveAttribute('aria-checked', 'false')
    // the focus ring shows
    expect(await page2.getByTestId('quick-reply-color-0-amber').evaluate((el) => getComputedStyle(el).boxShadow)).toContain('rgb(96, 165, 250)')
    await page2.keyboard.press('ArrowLeft')
    await page2.keyboard.press('ArrowLeft')
    await expect(page2.getByTestId('quick-reply-color-0-blue')).toHaveAttribute('aria-checked', 'true')
    await page2.keyboard.press('ArrowLeft')
    await page2.keyboard.press('ArrowLeft')
    // past «none» it wraps to the last colour
    await expect(page2.getByTestId('quick-reply-color-0-teal')).toBeFocused()
    await page2.keyboard.press('ArrowRight')
    await expect(page2.getByTestId('quick-reply-color-0-none')).toHaveAttribute('aria-checked', 'true')
    await page2.keyboard.press('ArrowRight')
    await page2.keyboard.press('ArrowRight')
    await expect(page2.getByTestId('quick-reply-color-0-green')).toHaveAttribute('aria-checked', 'true')
    // Tab leaves the row for the next row's chosen colour, not the next swatch
    await page2.keyboard.press('Tab')
    await expect(page2.getByTestId('quick-reply-color-1-red')).toBeFocused()
    await page2.getByRole('button', { name: 'Cancel', exact: true }).click()

    // --- Editing the list drops colours of replies that are gone ---------------------
    await page2.locator('button[title^="Settings"]').first().click()
    await page2.getByTestId('settings-category-terminal').click()
    const list = page2.getByTestId('chat-setting-quick-list')
    // the same phrase twice is saved once (one chip, one row)
    await list.fill([PHRASES[1], PHRASES[2], PHRASES[1]].join('\n'))
    await list.blur()
    await expect(page2.locator('[data-testid$="-none"][role="radio"]')).toHaveCount(2)
    // the red reply moved to the first row and kept its colour
    await expect(page2.getByTestId('quick-reply-color-0-red')).toHaveAttribute('aria-checked', 'true')
    await page2.getByRole('button', { name: 'Save', exact: true }).click()
    await expect.poll(() => readSettings(keptDir).chat?.quickReplyColors).toEqual({ [PHRASES[1]]: 'red' })
    expect(readSettings(keptDir).chat?.quickReplies).toEqual([PHRASES[1], PHRASES[2]])
})
