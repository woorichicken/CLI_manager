import { test, expect, type CDPSession, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { closeApp, launchAppWithWorkspaces, LaunchResult, REPO_ROOT, resizeMainWindow, termText, waitForBufferText, writeToTerminal } from './helpers'

/**
 * T81 — the phone and Chat screen fixes of the ovis cross-review (fixes/ui, 11-05), each on a touch
 * phone (CDP touch emulation, 390×844, scale 3) against the real app and its phone server:
 *
 *  F13 terminal Send while the socket is down: disabled, and the line is never lost
 *  F14 another session's terminal does not inherit this one's draft · Type · Ctrl
 *  F15 a password prompt gets a password field (DOM only), and its value goes straight to the pty
 *  F16 a first /me that failed is tried again without a reload
 *  F17 one dropped file is one attachment (the composer and the chat both caught the drop)
 *  F19 a queued message's Edit restores the text only after the withdrawal was confirmed
 *  F20 a question on screen: a number + the Send button picks that option
 *  G1  a new Claude session with no conversation file yet: an empty state, not an error
 *  G2  the View | Type switch draws no focus ring on a touch screen
 *  N01 (round 2) a queued message's Edit, answered after the phone moved to another session, goes
 *      back to its own session's draft — never into the other session's box
 *  N02 (round 2) a password typed for one prompt is wiped when another prompt takes its place
 */

const MOCK = path.join(REPO_ROOT, 'scripts/mock-cli/chat-mock.cjs')
const AGENT_ID = '00000000-0000-4000-8000-00000000c81a'
const NEW_ID = '00000000-0000-4000-8000-00000000c81b'
const AGENT = 't81-claude'
const NEW = 't81-claude-new'
const SHELL_A = 't81-shell-a'
const SHELL_B = 't81-shell-b'
const OWNER = 'owner@example.com'
const DPR = 3
const T81_PORT = 47881
const claudeProjectSlug = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, '-')

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

async function launch(): Promise<{ app: ElectronApplication; page: Page; base: string }> {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'climanager-t81-'))
    const project = path.join(home, 'project')
    fs.mkdirSync(project)
    const claudeDir = path.join(home, 'claude')
    const folder = path.join(claudeDir, 'projects', claudeProjectSlug(project))
    fs.mkdirSync(folder, { recursive: true })
    const transcript = path.join(folder, `${AGENT_ID}.jsonl`)
    fs.writeFileSync(transcript, '')
    // NEW's file is not there yet: Claude writes it with the first message
    const newTranscript = path.join(folder, `${NEW_ID}.jsonl`)
    const statusFile = path.join(home, 'tailscale-status.json')
    fs.writeFileSync(statusFile, JSON.stringify({ BackendState: 'Running', Self: { UserID: 42, DNSName: 'mac.tail1234.ts.net.', TailscaleIPs: ['100.100.1.1'] }, User: { '42': { LoginName: OWNER } } }))
    result = await launchAppWithWorkspaces(
        [
            {
                id: 'w-t81',
                name: 'T81 project',
                path: project,
                sessions: [
                    { id: AGENT, name: 'T81 Claude', cliSessionId: AGENT_ID, cliToolName: 'claude', cliCommand: `node ${MOCK} --transcript ${transcript} --work-ms 15000` },
                    // started fresh (no resume): the app clears a conversation id whose file is missing at launch
                    { id: NEW, name: 'T81 Claude new', initialCommand: `node ${MOCK} --transcript ${newTranscript} --work-ms 300` },
                    { id: SHELL_A, name: 'T81 Shell A' },
                    { id: SHELL_B, name: 'T81 Shell B' }
                ]
            }
        ],
        { settings: { phone: { enabled: true, port: T81_PORT } }, env: { CLAUDE_CONFIG_DIR: claudeDir, CLIMANAGER_PHONE_TAILSCALE_STATUS: statusFile } }
    )
    const { app, page } = result
    await resizeMainWindow(app, 1280, 800)
    await waitForBufferText(page, AGENT, 'Claude Code', 30_000)
    await waitForBufferText(page, NEW, 'Claude Code', 30_000)
    // what the app records when a new Claude starts in a session: its conversation id, before any file
    expect(await page.evaluate((o) => window.api.updateSessionCliInfo('w-t81', o.id, o.cli, 'claude', o.command), { id: NEW, cli: NEW_ID, command: `node ${MOCK}` })).toBe(true)
    const state = await page.evaluate(() => window.api.getPhoneState())
    expect(state.running).toBe(true)
    return { app, page, base: `http://127.0.0.1:${state.port}` }
}

/**
 * A phone window in its own cookie jar, let in as this Mac's owner the way `tailscale serve` does it.
 * Requests whose path holds a word in `globalThis.__t81Block` (main process) fail like a dropped network.
 */
async function openOwnerPhone(app: ElectronApplication, url: string, partition: string): Promise<Page> {
    const opened = app.waitForEvent('window')
    await app.evaluate(({ BrowserWindow, session }, o) => {
        const g = globalThis as unknown as { __t81Block?: string[]; __t81Hold?: string[]; __t81Held?: Array<() => void> }
        g.__t81Block = g.__t81Block ?? []
        g.__t81Hold = g.__t81Hold ?? []
        g.__t81Held = g.__t81Held ?? []
        const jar = session.fromPartition(o.partition)
        jar.webRequest.onBeforeSendHeaders((details, callback) => {
            callback({ requestHeaders: { ...details.requestHeaders, 'Tailscale-User-Login': o.owner, 'X-Forwarded-For': '100.101.102.103' } })
        })
        jar.webRequest.onBeforeRequest((details, callback) => {
            const blocked = (g.__t81Block ?? []).some((word) => details.url.includes(word))
            // held: the request waits until `release` (a slow network), then goes through
            if (!blocked && (g.__t81Hold ?? []).some((word) => details.url.includes(word))) {
                g.__t81Held!.push(() => callback({}))
                return
            }
            callback({ cancel: blocked })
        })
        const win = new BrowserWindow({ width: 390, height: 844, useContentSize: true, show: false, webPreferences: { partition: o.partition, backgroundThrottling: false } })
        void win.loadURL(o.url)
    }, { url, partition, owner: OWNER })
    const page = await opened
    await page.waitForLoadState('domcontentloaded')
    return page
}

async function block(app: ElectronApplication, words: string[]): Promise<void> {
    await app.evaluate((_electron, list) => {
        ;(globalThis as unknown as { __t81Block?: string[] }).__t81Block = list
    }, words)
}

/** Requests whose path holds a word in `words` wait (see openOwnerPhone) until `release`. */
async function hold(app: ElectronApplication, words: string[]): Promise<void> {
    await app.evaluate((_electron, list) => {
        ;(globalThis as unknown as { __t81Hold?: string[] }).__t81Hold = list
    }, words)
}

/** Lets the held requests go; returns how many there were. */
async function release(app: ElectronApplication): Promise<number> {
    return app.evaluate(() => {
        const g = globalThis as unknown as { __t81Hold?: string[]; __t81Held?: Array<() => void> }
        g.__t81Hold = []
        const held = g.__t81Held ?? []
        g.__t81Held = []
        for (const go of held) go()
        return held.length
    })
}

async function becomePhone(phone: Page): Promise<CDPSession> {
    const cdp = await phone.context().newCDPSession(phone)
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: DPR, mobile: true, screenOrientation: { type: 'portraitPrimary', angle: 0 } })
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
    await phone.reload()
    await phone.waitForLoadState('domcontentloaded')
    return cdp
}

async function centerOf(page: Page, testId: string, nth = 0): Promise<{ x: number; y: number }> {
    const box = await page.getByTestId(testId).nth(nth).boundingBox()
    expect(box).not.toBeNull()
    return { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 }
}

async function tap(cdp: CDPSession, page: Page, testId: string, nth = 0): Promise<void> {
    await tapAt(cdp, page, await centerOf(page, testId, nth))
}

async function tapAt(cdp: CDPSession, page: Page, at: { x: number; y: number }): Promise<void> {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: at.x, y: at.y }] })
    await page.waitForTimeout(60)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
}

async function openPhone(app: ElectronApplication, base: string, query: string, partition: string): Promise<{ phone: Page; cdp: CDPSession }> {
    const phone = await openOwnerPhone(app, `${base}/?${query}`, partition)
    const cdp = await becomePhone(phone)
    return { phone, cdp }
}

async function openTerminal(phone: Page, cdp: CDPSession): Promise<void> {
    await expect(phone.getByTestId('phone-terminal')).toHaveAttribute('data-status', 'live', { timeout: 15_000 })
    await tap(cdp, phone, 'phone-terminal-type')
    await expect(phone.getByTestId('phone-key-bar')).toBeVisible()
}

test('T81 F13 terminal Send while the socket is down: disabled, and the line stays', async () => {
    test.setTimeout(120_000)
    const { app, page, base } = await launch()
    const { phone, cdp } = await openPhone(app, base, `session=${SHELL_A}&view=terminal`, 't81-f13')
    await openTerminal(phone, cdp)
    const line = phone.getByTestId('phone-terminal-line')
    await line.fill('echo kept-$((40+2))')
    await page.evaluate(() => window.api.setPhoneEnabled(false))
    await expect(phone.getByTestId('phone-terminal')).toHaveAttribute('data-status', 'closed', { timeout: 10_000 })
    // the keyboard's own send (form submit) while down: nothing sent, nothing lost
    await line.press('Enter')
    await expect(line).toHaveValue('echo kept-$((40+2))')
    await expect(phone.getByTestId('phone-terminal-send')).toBeDisabled()
    await page.evaluate(() => window.api.setPhoneEnabled(true))
    await expect(phone.getByTestId('phone-terminal')).toHaveAttribute('data-status', 'live', { timeout: 20_000 })
    await expect(phone.getByTestId('phone-terminal-send')).toBeEnabled()
    await tap(cdp, phone, 'phone-terminal-send')
    await waitForBufferText(page, SHELL_A, 'kept-42', 10_000)
    await expect(line).toHaveValue('')
    await phone.close()
})

test('T81 F14 another session’s terminal starts clean; coming back brings this one’s draft', async () => {
    test.setTimeout(120_000)
    const { app, page, base } = await launch()
    const { phone, cdp } = await openPhone(app, base, `session=${SHELL_A}&view=terminal`, 't81-f14')
    await openTerminal(phone, cdp)
    await phone.getByTestId('phone-terminal-line').fill('echo for-a-only')
    const ctrlKey = phone.locator('.phone-key[data-key="ctrl"]')
    const ctrlBox = (await ctrlKey.boundingBox())!
    await tapAt(cdp, phone, { x: ctrlBox.x + ctrlBox.width / 2, y: ctrlBox.y + ctrlBox.height / 2 })
    await expect(ctrlKey).toHaveAttribute('aria-pressed', 'true')
    // to B through the list, the page not reloaded
    await tap(cdp, phone, 'phone-menu-button')
    await phone.locator(`[data-testid="phone-session-row"][data-session-id="${SHELL_B}"]`).click()
    await expect(phone.getByTestId('phone-session-title')).toHaveText('T81 Shell B')
    await expect(phone.getByTestId('phone-terminal')).toHaveAttribute('data-status', 'live', { timeout: 15_000 })
    // B opens in View, its line empty and Ctrl up
    await expect(phone.getByTestId('phone-key-bar')).toHaveCount(0)
    await tap(cdp, phone, 'phone-terminal-type')
    await expect(phone.getByTestId('phone-terminal-line')).toHaveValue('')
    await expect(ctrlKey).toHaveAttribute('aria-pressed', 'false')
    await tap(cdp, phone, 'phone-terminal-send')
    await page.waitForTimeout(500)
    expect(await termText(page, SHELL_B)).not.toContain('for-a-only')
    // back to A: its draft is where it was left
    await tap(cdp, phone, 'phone-menu-button')
    await phone.locator(`[data-testid="phone-session-row"][data-session-id="${SHELL_A}"]`).click()
    await expect(phone.getByTestId('phone-session-title')).toHaveText('T81 Shell A')
    await expect(phone.getByTestId('phone-terminal')).toHaveAttribute('data-status', 'live', { timeout: 15_000 })
    await tap(cdp, phone, 'phone-terminal-type')
    await expect(phone.getByTestId('phone-terminal-line')).toHaveValue('echo for-a-only')
    await phone.close()
})

test('T81 F15 a password prompt gets a password field, sent straight to the pty', async () => {
    test.setTimeout(120_000)
    const { app, page, base } = await launch()
    const { phone, cdp } = await openPhone(app, base, `session=${SHELL_A}&view=terminal`, 't81-f15')
    await openTerminal(phone, cdp)
    await expect(phone.getByTestId('phone-terminal-secret')).toHaveCount(0)
    await writeToTerminal(page, SHELL_A, "printf 'Password: '; stty -echo; read t81pw; stty echo; echo; echo got-$t81pw\r")
    const secret = phone.getByTestId('phone-terminal-secret')
    await expect(secret).toBeVisible({ timeout: 10_000 })
    await expect(secret).toHaveAttribute('type', 'password')
    await expect(phone.getByTestId('phone-terminal-line')).toHaveCount(0)
    await secret.fill('hunter2')
    await secret.press('Enter')
    await waitForBufferText(page, SHELL_A, 'got-hunter2', 10_000)
    // the prompt is gone: back to the ordinary line, the field empty
    await expect(phone.getByTestId('phone-terminal-secret')).toHaveCount(0, { timeout: 10_000 })
    await expect(phone.getByTestId('phone-terminal-line')).toBeVisible()
    // a prompt left open, then the page hidden: what was typed is wiped
    await writeToTerminal(page, SHELL_A, "printf 'Password: '; stty -echo; read t81pw; stty echo; echo; echo again-$t81pw\r")
    await expect(secret).toBeVisible({ timeout: 10_000 })
    await secret.fill('half-typed')
    await phone.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
        document.dispatchEvent(new Event('visibilitychange'))
    })
    await expect(secret).toHaveValue('')
    await phone.close()
})

test('T81 F16 a first /me that failed is tried again without a reload', async () => {
    test.setTimeout(120_000)
    const { app, base } = await launch()
    await block(app, ['/api/phone/me'])
    const phone = await openOwnerPhone(app, `${base}/?session=${SHELL_A}&view=terminal`, 't81-f16')
    await expect(phone.getByText('The Mac is not answering', { exact: false })).toBeVisible({ timeout: 15_000 })
    await block(app, [])
    // no tap, no reload: it comes back by itself
    await expect(phone.getByTestId('phone-app')).toBeVisible({ timeout: 15_000 })
    await expect(phone.getByTestId('phone-session-title')).toHaveText('T81 Shell A', { timeout: 15_000 })
    // and the Retry button works at once
    await block(app, ['/api/phone/me'])
    await phone.reload()
    await expect(phone.getByTestId('phone-retry')).toBeVisible({ timeout: 15_000 })
    await block(app, [])
    await phone.getByTestId('phone-retry').click()
    await expect(phone.getByTestId('phone-app')).toBeVisible({ timeout: 5_000 })
    await phone.close()
})

test('T81 F17 one dropped file is one attachment', async () => {
    test.setTimeout(120_000)
    const { app, base } = await launch()
    const { phone } = await openPhone(app, base, `session=${AGENT}&view=chat`, 't81-f17')
    await expect(phone.locator('.chat-composer textarea')).toBeVisible({ timeout: 15_000 })
    await phone.evaluate(() => {
        const card = document.querySelector('.chat-composer-card')!
        const data = new DataTransfer()
        data.items.add(new File(['t81 notes'], 't81-notes.txt', { type: 'text/plain' }))
        card.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }))
    })
    await expect(phone.getByTestId('chat-attachment')).toHaveCount(1)
    await expect(phone.getByTestId('chat-attachment')).toHaveAttribute('data-state', 'ready', { timeout: 10_000 })
    await phone.waitForTimeout(800)
    await expect(phone.getByTestId('chat-attachment')).toHaveCount(1)
    await phone.close()
})

test('T81 F19 a queued message’s Edit restores it only once it is withdrawn', async () => {
    test.setTimeout(120_000)
    const { app, page, base } = await launch()
    const { phone, cdp } = await openPhone(app, base, `session=${AGENT}&view=chat`, 't81-f19')
    const box = phone.locator('.chat-composer textarea')
    await expect(box).toBeVisible({ timeout: 15_000 })
    await box.fill('first job')
    await tap(cdp, phone, 'chat-send')
    await waitForBufferText(page, AGENT, 'ANSWER[1]: first job', 10_000)
    await phone.waitForTimeout(800) // the chat has seen the turn working
    await box.fill('queued job')
    await tap(cdp, phone, 'chat-send')
    await expect(phone.getByTestId('chat-queued-item')).toHaveCount(1, { timeout: 10_000 })
    await expect(box).toHaveValue('')
    // the withdrawal does not get through: the text stays queued, not also in the box
    await block(app, ['discard-queued'])
    await tap(cdp, phone, 'chat-queued-edit')
    await expect(phone.getByTestId('chat-queued-error')).toBeVisible({ timeout: 5_000 })
    await expect(box).toHaveValue('')
    await expect(phone.getByTestId('chat-queued-item')).toHaveCount(1)
    // it gets through: now the box has it and the queue does not
    await block(app, [])
    await tap(cdp, phone, 'chat-queued-edit')
    await expect(box).toHaveValue('queued job', { timeout: 5_000 })
    await expect(phone.getByTestId('chat-queued-item')).toHaveCount(0, { timeout: 5_000 })
    await phone.close()
})

test('T81 F20 a question on screen: a number and the Send button pick that option', async () => {
    test.setTimeout(120_000)
    const { app, page, base } = await launch()
    const { phone, cdp } = await openPhone(app, base, `session=${NEW}&view=chat`, 't81-f20')
    await writeToTerminal(page, NEW, 'ASK')
    await page.waitForTimeout(200)
    await writeToTerminal(page, NEW, '\r')
    await expect(phone.getByTestId('chat-prompt-card')).toBeVisible({ timeout: 15_000 })
    const box = phone.locator('.chat-composer textarea')
    await box.fill('2')
    await tap(cdp, phone, 'chat-send')
    await expect(phone.getByTestId('chat-prompt-picked')).toBeVisible({ timeout: 5_000 })
    await expect(phone.getByTestId('chat-composer-note')).toHaveCount(0)
    await expect(box).toHaveValue('')
    await tap(cdp, phone, 'chat-send')
    await waitForBufferText(page, NEW, 'CHOSE:', 10_000)
    await phone.close()
})

test('T81 G1 a new Claude session with no conversation file yet shows an empty chat, not an error', async () => {
    test.setTimeout(120_000)
    const { app, page, base } = await launch()
    const { phone, cdp } = await openPhone(app, base, `session=${NEW}&view=chat`, 't81-g1')
    await expect(phone.getByTestId('chat-no-turns-yet')).toBeVisible({ timeout: 15_000 })
    await expect(phone.getByTestId('chat-no-turns-yet')).toContainText('No conversation yet')
    await expect(phone.getByTestId('chat-unavailable')).toHaveCount(0)
    const box = phone.locator('.chat-composer textarea')
    await box.fill('hello there')
    await tap(cdp, phone, 'chat-send')
    await waitForBufferText(page, NEW, 'ANSWER[1]: hello there', 10_000)
    await expect(phone.getByTestId('chat-no-turns-yet')).toHaveCount(0, { timeout: 10_000 })
    await phone.close()
})

test('T81 G2 the View | Type switch draws no focus ring on a touch screen', async () => {
    test.setTimeout(120_000)
    const { app, base } = await launch()
    const { phone, cdp } = await openPhone(app, base, `session=${SHELL_A}&view=terminal`, 't81-g2')
    await openTerminal(phone, cdp)
    // what a tap leaves (for the report) — the phone's browser may still count it as focus-visible
    const after = await phone.getByTestId('phone-terminal-type').evaluate((el) => ({ focus: el.matches(':focus'), visible: el.matches(':focus-visible') }))
    console.log('[T81 G2] after a tap on Type:', JSON.stringify(after))
    // force the state the Galaxy showed: focused and focus-visible
    await cdp.send('DOM.enable')
    await cdp.send('CSS.enable')
    const { root } = await cdp.send('DOM.getDocument')
    for (const id of ['phone-terminal-type', 'phone-terminal-view']) {
        const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: `[data-testid="${id}"]` })
        await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['focus', 'focus-visible'] })
        const outline = await phone.getByTestId(id).evaluate((el) => {
            const style = getComputedStyle(el)
            return { style: style.outlineStyle, width: style.outlineWidth }
        })
        expect(outline.style === 'none' || outline.width === '0px', `${id} outline ${JSON.stringify(outline)}`).toBe(true)
        await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] })
    }
    await phone.close()
})

/** A phone that is not this Mac's owner: it pairs with a code, as a second person's phone does. */
async function openPairedPhone(app: ElectronApplication, page: Page, url: string, partition: string, role: 'drive' | 'watch'): Promise<Page> {
    const state = await page.evaluate((r) => window.api.startPhonePairing(r), role)
    const code = state.pairing!.code
    const opened = app.waitForEvent('window')
    await app.evaluate(({ BrowserWindow }, o) => {
        const win = new BrowserWindow({ width: 390, height: 844, useContentSize: true, show: false, webPreferences: { partition: o.partition, backgroundThrottling: false } })
        void win.loadURL(o.url)
    }, { url, partition })
    const phone = await opened
    await phone.waitForLoadState('domcontentloaded')
    await phone.getByTestId('phone-pair-code').fill(code)
    await phone.getByTestId('phone-pair-submit').click()
    return phone
}

test('T81 G8 a view-only phone shows no message box, attach, model chip or Type', async () => {
    test.setTimeout(120_000)
    const { app, page, base } = await launch()
    const phone = await openPairedPhone(app, page, `${base}/?session=${AGENT}&view=chat`, 't81-g8', 'watch')
    await expect(phone.getByTestId('chat-view')).toBeVisible({ timeout: 15_000 })
    await expect(phone.getByTestId('chat-read-only')).toBeVisible({ timeout: 10_000 })
    await expect(phone.getByTestId('chat-read-only')).toContainText('View only')
    await expect(phone.getByTestId('chat-composer')).toHaveCount(0)
    await expect(phone.getByTestId('chat-attach')).toHaveCount(0)
    await expect(phone.getByTestId('chat-model-chip')).toHaveCount(0)
    // a question on screen: shown, its options not offered
    await writeToTerminal(page, AGENT, 'ASK')
    await page.waitForTimeout(200)
    await writeToTerminal(page, AGENT, '\r')
    await expect(phone.getByTestId('chat-prompt-card')).toBeVisible({ timeout: 15_000 })
    await expect(phone.getByTestId('chat-prompt-option').first()).toBeDisabled()
    // the terminal: watching only, no Type and no key bar
    await phone.goto(`${base}/?session=${SHELL_A}&view=terminal`)
    await expect(phone.getByTestId('phone-terminal')).toHaveAttribute('data-status', 'live', { timeout: 15_000 })
    await expect(phone.getByTestId('phone-terminal-type')).toHaveCount(0)
    await expect(phone.getByTestId('phone-key-bar')).toHaveCount(0)
    await phone.close()
})

test('T81 G9 a path in the chat is plain text on the phone, where nothing can open it', async () => {
    test.setTimeout(120_000)
    const { app, page, base } = await launch()
    const { phone, cdp } = await openPhone(app, base, `session=${NEW}&view=chat`, 't81-g9')
    const box = phone.locator('.chat-composer textarea')
    await expect(box).toBeVisible({ timeout: 15_000 })
    await box.fill('saved to docs/demo.mp4 please')
    await tap(cdp, phone, 'chat-send')
    await waitForBufferText(page, NEW, 'ANSWER[1]: saved to docs/demo.mp4', 10_000)
    await expect(phone.getByTestId('chat-answer').last()).toContainText('docs/demo.mp4', { timeout: 10_000 })
    await expect(phone.getByTestId('chat-user-text').last()).toContainText('docs/demo.mp4')
    await expect(phone.getByTestId('chat-file-link')).toHaveCount(0)
    await phone.close()
})

test('T81 G7 an attached picture shows as a chip in the sent bubble, not the app’s temporary path', async () => {
    test.setTimeout(120_000)
    const { app, page, base } = await launch()
    const { phone, cdp } = await openPhone(app, base, `session=${NEW}&view=chat`, 't81-g7')
    const box = phone.locator('.chat-composer textarea')
    await expect(box).toBeVisible({ timeout: 15_000 })
    await phone.evaluate(() => {
        // a 1×1 PNG
        const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0))
        const data = new DataTransfer()
        data.items.add(new File([bytes], 'photo.png', { type: 'image/png' }))
        document.querySelector('.chat-composer-card')!.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }))
    })
    await expect(phone.getByTestId('chat-attachment').first()).toHaveAttribute('data-state', 'ready', { timeout: 10_000 })
    await box.fill('what is in it')
    await tap(cdp, phone, 'chat-send')
    // the mock cuts its long line at the screen's edge: its start is enough
    await waitForBufferText(page, NEW, 'ANSWER[1]: @/', 10_000)
    const bubble = phone.getByTestId('chat-user-text').last()
    await expect(bubble).toContainText('what is in it', { timeout: 10_000 })
    await expect(bubble).not.toContainText('climanager-chat')
    await expect(bubble.getByTestId('chat-attachment-chip')).toHaveText(/Attached image/)
    // the phone shows no files: the chip says what it was and is not a button
    expect(await bubble.getByTestId('chat-attachment-chip').evaluate((el) => el.tagName)).toBe('SPAN')
    await phone.close()
})

test('T81 G3 the phone terminal draws with its own font: Hangul exactly two Latin cells', async () => {
    test.setTimeout(120_000)
    const { app, base } = await launch()
    const { phone } = await openPhone(app, base, `session=${SHELL_A}&view=terminal`, 't81-g3')
    await expect(phone.getByTestId('phone-terminal')).toHaveAttribute('data-status', 'live', { timeout: 15_000 })
    // the font file came from the phone server (an allowed asset), and xterm switched to it
    await expect
        .poll(() => phone.evaluate(() => document.fonts.check('13px "CLIM Phone Mono"')), { timeout: 10_000 })
        .toBe(true)
    const measured = await phone.evaluate(() => {
        const context = document.createElement('canvas').getContext('2d')!
        context.font = '13px "CLIM Phone Mono"'
        let status: string | null = null
        document.fonts.forEach((face) => {
            if (face.family.replace(/"/g, '') === 'CLIM Phone Mono') status = face.status
        })
        return { latin: context.measureText('A').width, hangul: context.measureText('한').width, status }
    })
    expect(measured.status).toBe('loaded')
    expect(measured.hangul / measured.latin).toBeCloseTo(2, 2)
    // xterm measured its cell with it: two Latin cells hold one syllable with nothing left over
    await expect
        .poll(() => phone.locator('.xterm-rows').evaluate((rows) => getComputedStyle(rows).fontFamily), { timeout: 10_000 })
        .toContain('CLIM Phone Mono')
    await phone.close()
})

test('T81 N01 Edit answered after the phone moved to another session: the text goes to its own session’s draft', async () => {
    test.setTimeout(150_000)
    const { app, page, base } = await launch()
    const { phone, cdp } = await openPhone(app, base, `session=${AGENT}&view=chat`, 't81-n01')
    const box = phone.locator('.chat-composer textarea')
    await expect(box).toBeVisible({ timeout: 15_000 })
    await box.fill('first job')
    await tap(cdp, phone, 'chat-send')
    await waitForBufferText(page, AGENT, 'ANSWER[1]: first job', 10_000)
    await phone.waitForTimeout(800)
    await box.fill('only for the first agent')
    await tap(cdp, phone, 'chat-send')
    await expect(phone.getByTestId('chat-queued-item')).toHaveCount(1, { timeout: 10_000 })
    // Edit, and its withdrawal is slow to come back
    await hold(app, ['discard-queued'])
    await tap(cdp, phone, 'chat-queued-edit')
    await expect.poll(() => app.evaluate(() => ((globalThis as unknown as { __t81Held?: unknown[] }).__t81Held ?? []).length), { timeout: 5_000 }).toBe(1)
    // meanwhile, to the other Claude session's Chat through the list
    await tap(cdp, phone, 'phone-menu-button')
    await phone.locator(`[data-testid="phone-session-row"][data-session-id="${NEW}"]`).click()
    await expect(phone.getByTestId('phone-session-title')).toHaveText('T81 Claude new')
    await expect(box).toBeVisible({ timeout: 15_000 })
    await expect(box).toHaveValue('')
    expect(await release(app)).toBe(1)
    await phone.waitForTimeout(1_000)
    // the other session's box stays empty, and so does its saved draft
    await expect(box).toHaveValue('')
    expect(await phone.evaluate((id) => (JSON.parse(localStorage.getItem('chat-drafts') ?? '{}') as Record<string, string>)[id] ?? '', NEW)).toBe('')
    // back on the first session: the withdrawn text waits in its box
    await tap(cdp, phone, 'phone-menu-button')
    await phone.locator(`[data-testid="phone-session-row"][data-session-id="${AGENT}"]`).click()
    await expect(phone.getByTestId('phone-session-title')).toHaveText('T81 Claude')
    await expect(box).toHaveValue('only for the first agent', { timeout: 10_000 })
    await expect(phone.getByTestId('chat-queued-item')).toHaveCount(0)
    await phone.close()
})

test('T81 N02 a password typed for one prompt is wiped when another prompt takes its place', async () => {
    test.setTimeout(120_000)
    const { app, page, base } = await launch()
    const { phone, cdp } = await openPhone(app, base, `session=${SHELL_A}&view=terminal`, 't81-n02')
    await openTerminal(phone, cdp)
    // the first prompt times out and the second is printed in the same write: the phone never sees no prompt
    await writeToTerminal(page, SHELL_A, "stty -echo; printf \"alice@hosta's password: \"; read -t 6 n02a; printf \"\\r\\nbob@hostb's password: \"; read n02b; stty echo; echo; echo got-$n02b\r")
    const secret = phone.getByTestId('phone-terminal-secret')
    await expect(phone.locator('.phone-secret-prompt')).toHaveText("alice@hosta's password:", { timeout: 10_000 })
    await secret.fill('alice-secret')
    await expect(phone.locator('.phone-secret-prompt')).toHaveText("bob@hostb's password:", { timeout: 15_000 })
    await expect(secret).toHaveValue('')
    await secret.fill('bob-secret')
    await secret.press('Enter')
    await waitForBufferText(page, SHELL_A, 'got-bob-secret', 10_000)
    await phone.close()
})
