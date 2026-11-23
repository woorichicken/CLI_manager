import { test, expect, type CDPSession, type ElectronApplication, type Locator, type Page, _electron as electron } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { closeApp, launchAppWithWorkspaces, type LaunchResult, REPO_ROOT, resizeMainWindow, waitForBufferText } from './helpers'

/**
 * T135 — a colour per quick reply (report 93bd4834, fb-1114b).
 *
 * Settings › Chat: each reply gets one of a few fixed colours (or none). The Mac Chat's
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

/** The person's own list (fb-1117): wide enough to need a second line in a 1280 window. */
const LONG_LIST = ['컴팩트하게', '진행하자 / 계속해줘', '이해를 못했어.', '남은 todo는?', '회고 할만한 포인트가 있나?', '답장 초안은?', '/t135skill + 남은 투두는?', '$t135skill 로 설명해줘']
const CODEX = 't135-codex'
const CODEX_ID = '00000000-0000-4000-8000-00000000c13c'
const SHOTS = process.env.T135_SHOTS
const SHOT_LABEL = process.env.T135_LABEL ?? 'after'
/** T135_BEFORE=1: the captures only (the old code wraps the row and converts nothing) — the review's «before» */
const SHOTS_ONLY = process.env.T135_BEFORE === '1'

/** The row's chips: their tops (one line = one value) and how far the row scrolls. */
const rowState = (root: Page): Promise<{ tops: number[]; scrollWidth: number; clientWidth: number; scrollLeft: number; hidden: string | null }> =>
    root.evaluate(() => {
        // the shown session's row (the others are hidden with their chat)
        const row = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="chat-quick-replies"]')).find((r) => r.offsetParent !== null)!
        const tops = Array.from(row.querySelectorAll('button')).map((b) => Math.round(b.getBoundingClientRect().top))
        return { tops: [...new Set(tops)], scrollWidth: row.scrollWidth, clientWidth: row.clientWidth, scrollLeft: row.scrollLeft, hidden: row.getAttribute('data-hidden') }
    })

test('T135 quick replies stay on one line and scroll sideways (29993485); a skill reply follows the agent, / or $ (e624ef79)', async () => {
    test.setTimeout(200_000)
    const { project, claudeDir, transcript, statusFile } = seed()
    const home = path.dirname(project)
    const codexDir = path.join(home, 'codex')
    const rollout = path.join(codexDir, 'sessions', '2026', '11', '03', `rollout-2026-11-03T10-00-00-${CODEX_ID}.jsonl`)
    fs.mkdirSync(path.dirname(rollout), { recursive: true })
    fs.copyFileSync(path.join(__dirname, 'fixtures/transcripts/codex/rollout-2026-11-03T10-00-00-00000000-0000-4000-8000-0000000000c1.jsonl'), rollout)
    // the same skill, installed for both agents (one folder linked to both on the person's Mac)
    for (const root of [path.join(claudeDir, 'skills'), path.join(codexDir, 'skills')]) {
        fs.mkdirSync(path.join(root, 't135skill'), { recursive: true })
        fs.writeFileSync(path.join(root, 't135skill', 'SKILL.md'), '---\nname: t135skill\ndescription: Explain it simply\n---\nbody\n')
    }
    result = await launchAppWithWorkspaces(
        [{
            id: 'w-t135',
            name: 'T135 project',
            path: project,
            sessions: [
                { id: SESSION, name: 'T135 Claude', cliSessionId: SESSION_ID, cliToolName: 'claude', cliCommand: `node ${MOCK} --transcript ${transcript} --work-ms 300 --mode-row none` },
                { id: CODEX, name: 'T135 Codex', cliSessionId: CODEX_ID, cliToolName: 'codex', cliCommand: `node ${MOCK} --agent codex --transcript ${rollout} --work-ms 300` }
            ]
        }],
        {
            settings: { phone: { enabled: true, port: PORT }, chat: { showQuickReplies: true, quickReplies: LONG_LIST } },
            env: { CLIMANAGER_PHONE_TAILSCALE_STATUS: statusFile, CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: codexDir }
        }
    )
    const { app, page } = result
    await resizeMainWindow(app, 1280, 800)
    await waitForBufferText(page, SESSION, 'Claude Code (mock)', 20_000)

    // --- Claude: the skill reply reads as Claude runs it, before the tap ---------
    await openMacChat(page)
    const macChat = page.locator('[data-testid="chat-view"][data-session-id]:visible')
    await expect(chip(macChat, '컴팩트하게')).toBeVisible({ timeout: 15_000 })
    if (SHOTS) {
        fs.mkdirSync(SHOTS, { recursive: true })
        await page.waitForTimeout(1000)
        await page.screenshot({ path: path.join(SHOTS, `quick-row-mac-${SHOT_LABEL}-1280.png`) })
    }
    if (SHOTS_ONLY) {
        const state = await page.evaluate(() => window.api.getPhoneState())
        const { phone } = await openPhone(app, `http://127.0.0.1:${state.port}/?session=${SESSION}&view=chat`)
        await expect(chip(phone, '컴팩트하게')).toBeVisible({ timeout: 15_000 })
        await phone.waitForTimeout(1000)
        await phone.screenshot({ path: path.join(SHOTS!, `quick-row-phone-${SHOT_LABEL}-390.png`) })
        return
    }
    await expect(chip(macChat, '/t135skill 로 설명해줘')).toBeVisible()
    await expect(chip(macChat, '/t135skill + 남은 투두는?')).toBeVisible()
    // one line, wider than the box: it scrolls, the far end fades
    const before = await rowState(page)
    expect(before.tops, 'every chip on one line').toHaveLength(1)
    expect(before.scrollWidth).toBeGreaterThan(before.clientWidth)
    expect(before.hidden).toBe('end')
    // a mouse wheel's up/down moves it sideways
    const box = (await macChat.getByTestId('chat-quick-replies').boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.wheel(0, 240)
    await expect.poll(async () => (await rowState(page)).scrollLeft).toBeGreaterThan(0)
    await expect.poll(async () => (await rowState(page)).hidden).toMatch(/^(both|start)$/)
    // the tap sends what the chip says
    await chip(macChat, '/t135skill 로 설명해줘').click()
    await waitForBufferText(page, SESSION, 'ANSWER[1]: /t135skill 로 설명해줘', 15_000)

    // --- Codex: the same saved reply goes as $ -----------------------------------
    await page.getByText('T135 Codex', { exact: true }).first().click()
    await page.getByTestId('view-toggle-chat').click()
    const codexChat = page.locator('[data-testid="chat-view"][data-session-id]:visible')
    await expect(chip(codexChat, '$t135skill + 남은 투두는?')).toBeVisible({ timeout: 15_000 })
    await chip(codexChat, '$t135skill + 남은 투두는?').click()
    await waitForBufferText(page, CODEX, 'ANSWER[1]: $t135skill + 남은 투두는?', 15_000)
    expect((await rowState(page)).tops).toHaveLength(1)

    // --- The phone (390): one line too, swiped sideways --------------------------
    const state = await page.evaluate(() => window.api.getPhoneState())
    const { phone } = await openPhone(app, `http://127.0.0.1:${state.port}/?session=${SESSION}&view=chat`)
    await expect(chip(phone, '컴팩트하게')).toBeVisible({ timeout: 15_000 })
    if (SHOTS) {
        await phone.waitForTimeout(1000)
        await phone.screenshot({ path: path.join(SHOTS, `quick-row-phone-${SHOT_LABEL}-390.png`) })
    }
    const onPhone = await rowState(phone)
    expect(onPhone.tops, 'one line on the phone').toHaveLength(1)
    expect(onPhone.scrollWidth).toBeGreaterThan(onPhone.clientWidth)
    expect(onPhone.hidden).toBe('end')
})

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
    await page.getByTestId('settings-category-chat').click()
    const settings = page.getByTestId('chat-view-settings')
    await settings.scrollIntoViewIfNeeded()
    // each row's colour dot pops its colours (c44bf0af — one list)
    await settings.getByTestId('quick-reply-color-0').click()
    await page.getByTestId('quick-reply-color-0-green').click()
    await settings.getByTestId('quick-reply-color-1').click()
    await page.getByTestId('quick-reply-color-1-red').click()
    await expect(settings.getByTestId('quick-reply-color-0')).toHaveAttribute('data-color', 'green')
    await expect(settings.getByTestId('quick-reply-color-2')).not.toHaveAttribute('data-color', /.+/)
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

    // --- The keyboard: a radio group per row — ← / → move the choice, Tab stops once per group (PR #139 review) ----
    // the group pops from the row's colour dot (c44bf0af); Enter on the dot opens it on the chosen colour
    await page2.locator('button[title^="Settings"]').first().click()
    await page2.getByTestId('settings-category-chat').click()
    await page2.getByTestId('quick-reply-color-0').focus()
    await page2.keyboard.press('Enter')
    const row0 = page2.getByTestId('quick-reply-color-popover')
    await expect(row0.getByRole('radiogroup')).toHaveCount(1)
    await expect(row0.locator('[aria-pressed]')).toHaveCount(0)
    await expect(row0.locator('[tabindex="0"]')).toHaveCount(1)
    await expect(page2.getByTestId('quick-reply-color-0-green')).toBeFocused()
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
    // Tab leaves the group (it closes) for the row's text, not the next swatch
    await page2.keyboard.press('Tab')
    await expect(row0).toHaveCount(0)
    await expect(page2.getByTestId('quick-reply-text-0')).toBeFocused()
    await expect(page2.getByTestId('quick-reply-color-0')).toHaveAttribute('data-color', 'green')
    await page2.getByRole('button', { name: 'Cancel', exact: true }).click()

    // --- Editing the list drops colours of replies that are gone ---------------------
    await page2.locator('button[title^="Settings"]').first().click()
    await page2.getByTestId('settings-category-chat').click()
    // the green reply goes; the same phrase twice is saved once (one chip)
    await page2.getByTestId('quick-reply-delete-0').click()
    await page2.getByTestId('quick-reply-add').click()
    await page2.keyboard.type(PHRASES[1])
    await expect(page2.getByTestId('quick-reply-row-2')).toHaveAttribute('data-duplicate', 'true')
    // the red reply moved to the first row and kept its colour
    await expect(page2.getByTestId('quick-reply-color-0')).toHaveAttribute('data-color', 'red')
    await page2.getByRole('button', { name: 'Save', exact: true }).click()
    await expect.poll(() => readSettings(keptDir).chat?.quickReplyColors).toEqual({ [PHRASES[1]]: 'red' })
    expect(readSettings(keptDir).chat?.quickReplies).toEqual([PHRASES[1], PHRASES[2]])
})

/** The editor's reply texts, top to bottom (input values — the list is shown once, as inputs). */
const editorTexts = (root: Page): Promise<string[]> =>
    root.locator('[data-testid^="quick-reply-text-"]').evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value))

/** The Mac Chat's chips, left to right. */
const chipTexts = (chat: Locator): Promise<string[]> => chat.getByTestId('chat-quick-replies').getByRole('button').allTextContents().then((texts) => texts.map((t) => t.trim()))

test('T135 quick replies are one list to edit: add, reorder, delete, a colour per row (c44bf0af)', async () => {
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
            settings: { phone: { enabled: true, port: PORT }, chat: { showQuickReplies: true, quickReplies: PHRASES, quickReplyColors: { [PHRASES[0]]: 'green' } } },
            env: { CLIMANAGER_PHONE_TAILSCALE_STATUS: statusFile, CLAUDE_CONFIG_DIR: claudeDir }
        }
    )
    const { app, page, userDataDir } = result
    await resizeMainWindow(app, 1280, 800)
    await waitForBufferText(page, SESSION, 'Claude Code (mock)', 20_000)

    await page.locator('button[title^="Settings"]').first().click()
    await page.getByTestId('settings-category-chat').click()
    const settings = page.getByTestId('chat-view-settings')
    await expect(settings).toBeVisible()
    if (SHOTS) {
        // taken before any check, so the old build leaves its «before» too
        fs.mkdirSync(SHOTS, { recursive: true })
        // the Quick replies card's bottom in view (the toggle's card, in the old build and the new)
        await page.getByTestId('chat-setting-quick-replies').evaluate((el) => el.closest('div.p-4')?.scrollIntoView({ block: 'end' }))
        await page.waitForTimeout(500)
        await page.screenshot({ path: path.join(SHOTS, `${SHOT_LABEL}.png`) })
    }

    // --- One list: a row per reply, no second «Colour» list under a text box ----------
    const editor = settings.getByTestId('quick-reply-editor')
    await expect(editor).toBeVisible({ timeout: 5_000 })
    await expect(settings.getByTestId('chat-setting-quick-list')).toHaveCount(0)
    await expect(settings.getByTestId('quick-reply-colors')).toHaveCount(0)
    expect(await editorTexts(page)).toEqual(PHRASES)

    // the colour dot is the chat's own chip, in the chip's colour
    const dot0 = editor.getByTestId('quick-reply-color-0')
    await expect(dot0).toHaveAttribute('data-color', 'green')
    await expect(dot0).toHaveClass(/chat-quick-reply/)
    await expect(dot0).toHaveCSS('color', DARK_FG.green)
    await expect(editor.getByTestId('quick-reply-color-1')).not.toHaveAttribute('data-color', /.+/)

    // --- A colour from the dot's popover -------------------------------------------
    await editor.getByTestId('quick-reply-color-1').click()
    const popover = page.getByTestId('quick-reply-color-popover')
    await expect(popover).toBeVisible()
    await expect(popover.getByRole('radiogroup')).toHaveCount(1)
    await popover.getByTestId('quick-reply-color-1-red').click()
    await expect(popover).toHaveCount(0)
    await expect(editor.getByTestId('quick-reply-color-1')).toHaveAttribute('data-color', 'red')

    // --- Renaming a row keeps its colour (the colour is the row's, not the old text's) ------
    const text0 = editor.getByTestId('quick-reply-text-0')
    await text0.fill('계속 진행해 줘')
    await expect(dot0).toHaveAttribute('data-color', 'green')

    // --- + Add reply: a new row at the bottom, its box focused -------------------------
    await editor.getByTestId('quick-reply-add').click()
    await expect(editor.getByTestId('quick-reply-text-3')).toBeFocused()
    await page.keyboard.type('ㅇㅋ 머지')
    // move it up one: the third reply goes below it
    await editor.getByTestId('quick-reply-up-3').click()
    expect(await editorTexts(page)).toEqual(['계속 진행해 줘', PHRASES[1], 'ㅇㅋ 머지', PHRASES[2]])
    // the first one down: its colour goes with it
    await editor.getByTestId('quick-reply-down-0').click()
    expect(await editorTexts(page)).toEqual([PHRASES[1], '계속 진행해 줘', 'ㅇㅋ 머지', PHRASES[2]])
    await expect(editor.getByTestId('quick-reply-color-1')).toHaveAttribute('data-color', 'green')
    await expect(editor.getByTestId('quick-reply-color-0')).toHaveAttribute('data-color', 'red')
    // the ends cannot move further
    await expect(editor.getByTestId('quick-reply-up-0')).toBeDisabled()
    await expect(editor.getByTestId('quick-reply-down-3')).toBeDisabled()

    // --- × deletes the red one; its colour goes with it --------------------------------
    await editor.getByTestId('quick-reply-delete-0').click()
    expect(await editorTexts(page)).toEqual(['계속 진행해 줘', 'ㅇㅋ 머지', PHRASES[2]])

    // an empty row and a repeat are not saved (one chip per text)
    await editor.getByTestId('quick-reply-add').click()
    await editor.getByTestId('quick-reply-add').click()
    await page.keyboard.type('ㅇㅋ 머지')
    await expect(editor.getByTestId('quick-reply-row-4')).toHaveAttribute('data-duplicate', 'true')

    // --- The keyboard: Enter on the dot opens the radio group on the chosen colour; ← / → pick; Esc closes ----
    await editor.getByTestId('quick-reply-color-1').focus()
    await page.keyboard.press('Enter')
    await expect(popover).toBeVisible()
    await expect(popover.getByTestId('quick-reply-color-1-none')).toBeFocused()
    await expect(popover.getByTestId('quick-reply-color-1-none')).toHaveAttribute('aria-checked', 'true')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    await expect(popover.getByTestId('quick-reply-color-1-amber')).toHaveAttribute('aria-checked', 'true')
    await expect(popover.getByTestId('quick-reply-color-1-amber')).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(popover).toHaveCount(0)
    await expect(editor.getByTestId('quick-reply-color-1')).toBeFocused()
    await expect(editor.getByTestId('quick-reply-color-1')).toHaveAttribute('data-color', 'amber')
    // Esc closed the popover only, not Settings
    await expect(settings).toBeVisible()
    if (SHOTS) {
        await editor.getByTestId('quick-reply-color-2').click()
        await expect(popover).toBeVisible()
        await page.waitForTimeout(300)
        await page.screenshot({ path: path.join(SHOTS, `${SHOT_LABEL}-popover.png`) })
        await page.keyboard.press('Escape')
    }

    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(settings).toHaveCount(0)

    // --- Stored as before: a list of strings, colours by text --------------------------
    const saved = ['계속 진행해 줘', 'ㅇㅋ 머지', PHRASES[2]]
    await expect.poll(() => readSettings(userDataDir).chat?.quickReplies).toEqual(saved)
    expect(readSettings(userDataDir).chat?.quickReplyColors).toEqual({ '계속 진행해 줘': 'green', 'ㅇㅋ 머지': 'amber' })

    // --- Mac Chat: that order, those colours --------------------------------------
    await openMacChat(page)
    const macChat = page.locator('[data-testid="chat-view"][data-session-id]:visible')
    await expect(chip(macChat, saved[0])).toBeVisible({ timeout: 15_000 })
    expect(await chipTexts(macChat)).toEqual(saved)
    await expect(chip(macChat, saved[0])).toHaveCSS('color', DARK_FG.green)
    await expect(chip(macChat, saved[1])).toHaveAttribute('data-color', 'amber')
    await expect(chip(macChat, saved[2])).not.toHaveAttribute('data-color', /.+/)

    // --- The phone reads the same list and colours ---------------------------------
    const state = await page.evaluate(() => window.api.getPhoneState())
    const { phone } = await openPhone(app, `http://127.0.0.1:${state.port}/?session=${SESSION}&view=chat`)
    await expect(chip(phone, saved[0])).toBeVisible({ timeout: 15_000 })
    await expect(chip(phone, saved[0])).toHaveCSS('color', DARK_FG.green)
    const me = await phone.evaluate(async () => (await fetch('/api/phone/me')).json()) as { quickReplies?: unknown[]; quickReplyColors?: Record<string, string> }
    expect(me.quickReplies).toEqual(saved)
    expect(me.quickReplyColors).toEqual({ '계속 진행해 줘': 'green', 'ㅇㅋ 머지': 'amber' })

    // --- Up to eight rows: + Add reply stops there ------------------------------------
    await page.locator('button[title^="Settings"]').first().click()
    await page.getByTestId('settings-category-chat').click()
    const editor2 = page.getByTestId('quick-reply-editor')
    for (let i = 3; i < 8; i++) await editor2.getByTestId('quick-reply-add').click()
    await expect(editor2.locator('[data-testid^="quick-reply-row-"]')).toHaveCount(8)
    await expect(editor2.getByTestId('quick-reply-add')).toBeDisabled()
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
})

test('T135 the editor\'s colour dots read on the Settings dialog, which stays dark under the light class (c44bf0af)', async () => {
    test.setTimeout(120_000)
    const { project } = seed()
    result = await launchAppWithWorkspaces(
        [{ id: 'w-t135', name: 'T135 project', path: project, sessions: [{ id: 's-t135-light', name: 'T135 shell' }] }],
        { settings: { chat: { showQuickReplies: true, quickReplies: PHRASES, quickReplyColors: { [PHRASES[0]]: 'green' } } } }
    )
    const { app, page } = result
    await resizeMainWindow(app, 1280, 800)
    // The Theme setting is not wired to the page yet (docs/found-defects.md «Theme 을 Light 로 바꿔도…») and the
    // dialog's light rules do not reach it, so Settings is dark either way. chat.css's light-theme chip text is
    // dark green — the dot must not take it, or it would read dark on dark the day the class is put on.
    await page.evaluate(() => document.documentElement.classList.add('light'))
    await page.locator('button[title^="Settings"]').first().click()
    await page.getByTestId('settings-category-chat').click()
    const editor = page.getByTestId('quick-reply-editor')
    await expect(editor).toBeVisible()
    /** WCAG contrast of an element's text against its own background laid over the first opaque one under it. */
    const contrast = (testId: string): Promise<number> => page.evaluate((id) => {
        const el = document.querySelector(`[data-testid="${id}"]`) as HTMLElement
        const parse = (value: string): number[] => (value.match(/[\d.]+/g) ?? []).map(Number)
        let under = [255, 255, 255]
        for (let p: HTMLElement | null = el.parentElement; p; p = p.parentElement) {
            const [r, g, b, a = 1] = parse(getComputedStyle(p).backgroundColor)
            if (a > 0.9) { under = [r, g, b]; break }
        }
        const [br, bg, bb, ba = 1] = parse(getComputedStyle(el).backgroundColor)
        const back = [br, bg, bb].map((c, i) => c * ba + under[i] * (1 - ba))
        const fore = parse(getComputedStyle(el).color).slice(0, 3)
        const lum = (rgb: number[]): number => {
            const [r, g, b] = rgb.map((c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 })
            return 0.2126 * r + 0.7152 * g + 0.0722 * b
        }
        const [hi, lo] = [lum(fore), lum(back)].sort((a, b) => b - a)
        return (hi + 0.05) / (lo + 0.05)
    }, testId)
    await expect(editor.getByTestId('quick-reply-color-0')).toHaveCSS('color', DARK_FG.green)
    expect(await contrast('quick-reply-color-0')).toBeGreaterThanOrEqual(4.5)
    expect(await contrast('quick-reply-color-1')).toBeGreaterThanOrEqual(4.5)
    // the popover is drawn like the dialog it sits in
    await editor.getByTestId('quick-reply-color-1').click()
    const popover = page.getByTestId('quick-reply-color-popover')
    await expect(popover).toBeVisible()
    const dialogBg = await page.locator('div.bg-\\[\\#1e1e20\\]').first().evaluate((el) => getComputedStyle(el).backgroundColor)
    expect(await popover.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(dialogBg)
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
})
