import { test, expect, type CDPSession, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { closeApp, launchAppWithWorkspaces, LaunchResult, REPO_ROOT, resizeMainWindow, termText, waitForBufferText, writeToTerminal } from './helpers'

/**
 * T78 — the phone page's quality pass against ovis (quality-phone, 11-04), on a touch phone:
 * Chrome's own touch emulation (CDP) at 390×844, scale 3, portrait — `(pointer: coarse)` true,
 * fingers sent as CDP touch events (Input.dispatchTouchEvent), never synthetic DOM events.
 *
 *  1. in-app alert (ovis droplet): another session's question shows a pill under the header and a
 *     badge on ☰; tapping the pill opens that session's chat.
 *  2. chat on a touch screen (ovis Composer: Return breaks the line, Send sends): opening a chat
 *     leaves the keyboard down (no focus), Return is a new line, Send sends both lines.
 *  3. key bar hold-repeat (ovis keyRepeat): holding ↑ sends it again and again; a tap once.
 *  4. «Wrap to screen» (ovis mirror fold): the Mac's 103-column screen drawn at 13px in the
 *     phone's width, no sideways scroll, rules cut to one line, remembered on reload — and the
 *     Mac's pty still the same size with no `resized` event.
 * PHONE_SHOTS=<folder> saves captures (device pixels).
 */

const MOCK = path.join(REPO_ROOT, 'scripts/mock-cli/chat-mock.cjs')
const FIXTURES = path.join(__dirname, 'fixtures/transcripts')
const SCREEN_SCRIPT = path.join(__dirname, 'fixtures/phone-screen/claude-screen.cjs')
const A_ID = '00000000-0000-4000-8000-00000000c78a'
const B_ID = '00000000-0000-4000-8000-00000000c78b'
const AGENT_A = 't78-claude-a'
const AGENT_B = 't78-claude-b'
const SHELL = 't78-shell'
const SCREEN = 't78-screen'
const OWNER = 'owner@example.com'
const DPR = 3
const READY = 'IDE disconnected'
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

async function ptyState(page: Page, id: string): Promise<{ size: { cols: number; rows: number } | null; resized: number }> {
    const context = await page.evaluate((sessionId) => window.api.feedbackTerminalContext(sessionId), id)
    const events = context.terminal?.events ?? []
    return { size: context.terminal?.size ?? null, resized: events.filter((e) => e.kind === 'resized').length }
}

/** A phone window in its own cookie jar, let in as this Mac's owner the way `tailscale serve` does it. */
async function openOwnerPhone(app: ElectronApplication, url: string, partition: string): Promise<Page> {
    const opened = app.waitForEvent('window')
    await app.evaluate(({ BrowserWindow, session }, o) => {
        session.fromPartition(o.partition).webRequest.onBeforeSendHeaders((details, callback) => {
            callback({ requestHeaders: { ...details.requestHeaders, 'Tailscale-User-Login': o.owner, 'X-Forwarded-For': '100.101.102.103' } })
        })
        const win = new BrowserWindow({ width: 390, height: 844, useContentSize: true, show: false, webPreferences: { partition: o.partition, backgroundThrottling: false } })
        void win.loadURL(o.url)
    }, { url, partition, owner: OWNER })
    const page = await opened
    await page.waitForLoadState('domcontentloaded')
    return page
}

/** A touch phone: 390×844, scale 3, portrait, touch on — then a reload so the page reads `(pointer: coarse)` from the start. */
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

/** A finger down for `ms`, then up — through Chrome's input pipeline, as a real touch arrives. */
async function touch(cdp: CDPSession, page: Page, at: { x: number; y: number }, ms = 60): Promise<void> {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: at.x, y: at.y }] })
    await page.waitForTimeout(ms)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
}

async function capture(cdp: CDPSession, name: string): Promise<void> {
    const dir = process.env.PHONE_SHOTS
    if (!dir) return
    fs.mkdirSync(dir, { recursive: true })
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(path.join(dir, name), Buffer.from(data, 'base64'))
}

const count = (text: string, needle: string): number => text.split(needle).length - 1

test('T78 phone quality: in-app alert, touch chat, key hold-repeat, wrap to screen — the Mac pty never resized', async () => {
    test.setTimeout(240_000)
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'climanager-t78-'))
    const project = path.join(home, 'project')
    fs.mkdirSync(project)
    const claudeDir = path.join(home, 'claude')
    const transcriptA = path.join(claudeDir, 'projects', claudeProjectSlug(project), `${A_ID}.jsonl`)
    fs.mkdirSync(path.dirname(transcriptA), { recursive: true })
    fs.copyFileSync(path.join(FIXTURES, 'claude/tools.jsonl'), transcriptA)
    const transcriptB = path.join(path.dirname(transcriptA), `${B_ID}.jsonl`)
    fs.writeFileSync(transcriptB, '')
    const statusFile = path.join(home, 'tailscale-status.json')
    fs.writeFileSync(statusFile, JSON.stringify({ BackendState: 'Running', Self: { UserID: 42, DNSName: 'mac.tail1234.ts.net.', TailscaleIPs: ['100.100.1.1'] }, User: { '42': { LoginName: OWNER } } }))

    result = await launchAppWithWorkspaces(
        [
            {
                id: 'w-t78',
                name: 'T78 project',
                path: project,
                sessions: [
                    { id: AGENT_A, name: 'T78 Claude A', cliSessionId: A_ID, cliToolName: 'claude', cliCommand: `node ${MOCK} --transcript ${transcriptA} --work-ms 800` },
                    { id: AGENT_B, name: 'T78 Claude B', cliSessionId: B_ID, cliToolName: 'claude', cliCommand: `node ${MOCK} --transcript ${transcriptB} --work-ms 800` },
                    { id: SHELL, name: 'T78 Shell' },
                    { id: SCREEN, name: 'T78 Claude screen', initialCommand: `node '${SCREEN_SCRIPT}'` }
                ]
            }
        ],
        { settings: { phone: { enabled: true, port: 0 } }, env: { CLAUDE_CONFIG_DIR: claudeDir, CLIMANAGER_PHONE_TAILSCALE_STATUS: statusFile } }
    )
    const { app, page } = result
    await resizeMainWindow(app, 1280, 800)
    await page.locator(`[data-session-item="${SCREEN}"]`).first().click()
    await waitForBufferText(page, SCREEN, READY, 30_000)
    await waitForBufferText(page, AGENT_B, 'Claude Code', 30_000)
    // what the Mac itself did to its ptys before any phone came: the phone must add nothing to it
    const baseline = new Map<string, number>()
    for (const id of [AGENT_A, AGENT_B, SHELL, SCREEN]) baseline.set(id, (await ptyState(page, id)).resized)
    const state = await page.evaluate(() => window.api.getPhoneState())
    expect(state.running).toBe(true)
    const base = `http://127.0.0.1:${state.port}`

    // ---- 2. chat on a touch screen ------------------------------------------------------------
    const phone = await openOwnerPhone(app, `${base}/?session=${AGENT_A}&view=chat`, 't78-phone')
    const cdp = await becomePhone(phone)
    expect(await phone.evaluate(() => window.matchMedia('(pointer: coarse)').matches)).toBe(true)
    const box = phone.locator('.chat-composer textarea')
    await expect(box).toBeVisible({ timeout: 15_000 })
    await phone.waitForTimeout(600) // past the desktop's focus delay (150 ms)
    expect(await phone.evaluate(() => document.activeElement?.tagName)).not.toBe('TEXTAREA')
    await expect(box).toHaveAttribute('placeholder', 'Message Claude')
    await touch(cdp, phone, await (async () => {
        const b = await box.boundingBox()
        return { x: b!.x + 40, y: b!.y + b!.height / 2 }
    })())
    await phone.keyboard.type('first line')
    await phone.keyboard.press('Enter')
    await phone.keyboard.type('second line')
    await expect(box).toHaveValue('first line\nsecond line')
    expect(await termText(page, AGENT_A)).not.toContain('first line')
    await capture(cdp, 't78-chat-touch-return.png')
    await touch(cdp, phone, await centerOf(phone, 'chat-send'))
    await waitForBufferText(page, AGENT_A, 'second line', 15_000)
    await expect(box).toHaveValue('')

    // ---- 1. in-app alert --------------------------------------------------------------------
    await writeToTerminal(page, AGENT_B, 'ASK')
    await page.waitForTimeout(200)
    await writeToTerminal(page, AGENT_B, '\r')
    const droplet = phone.getByTestId('phone-droplet')
    await expect(droplet).toBeVisible({ timeout: 15_000 })
    await expect(droplet).toHaveAttribute('data-session-id', AGENT_B)
    await expect(droplet).toContainText('T78 Claude B')
    await expect(droplet).toContainText('needs you')
    await expect(phone.getByTestId('phone-menu-badge')).toHaveText('1')
    await capture(cdp, 't78-droplet.png')
    // on top of the chat: the pill's centre is the pill, not the chat under it
    const pillAt = await centerOf(phone, 'phone-droplet-open')
    expect(await phone.evaluate(({ x, y }) => Boolean(document.elementFromPoint(x, y)?.closest('[data-testid="phone-droplet"]')), pillAt)).toBe(true)
    await touch(cdp, phone, pillAt)
    await expect(phone.getByTestId('phone-session-title')).toHaveText('T78 Claude B')
    expect(new URL(phone.url()).searchParams.get('session')).toBe(AGENT_B)
    expect(new URL(phone.url()).searchParams.get('view')).toBe('chat')
    await expect(droplet).toHaveCount(0)
    await expect(phone.getByTestId('phone-menu-badge')).toHaveCount(0)
    // answer it from the Mac so B stops waiting
    await writeToTerminal(page, AGENT_B, '\r')

    // ---- 3. key bar hold-repeat -------------------------------------------------------------
    await writeToTerminal(page, SHELL, 'cat -v\r')
    await page.waitForTimeout(800)
    await phone.goto(`${base}/?session=${SHELL}&view=terminal`)
    await expect(phone.getByTestId('phone-terminal')).toHaveAttribute('data-status', 'live', { timeout: 15_000 })
    await touch(cdp, phone, await centerOf(phone, 'phone-terminal-type'))
    await expect(phone.getByTestId('phone-key-bar')).toBeVisible()
    const up = phone.locator('.phone-key[data-key="ArrowUp"]')
    const upBox = await up.boundingBox()
    const upAt = { x: upBox!.x + upBox!.width / 2, y: upBox!.y + upBox!.height / 2 }
    const before = count(await termText(page, SHELL), '^[[A')
    // a tap: exactly one
    await touch(cdp, phone, upAt, 60)
    await expect.poll(async () => count(await termText(page, SHELL), '^[[A') - before, { timeout: 5000 }).toBe(1)
    await page.waitForTimeout(400)
    expect(count(await termText(page, SHELL), '^[[A') - before).toBe(1)
    // a hold of 900 ms: 400 ms, then every 50 ms — about ten, and the lift adds none
    await touch(cdp, phone, upAt, 900)
    await page.waitForTimeout(500)
    const held = count(await termText(page, SHELL), '^[[A') - before - 1
    expect(held).toBeGreaterThanOrEqual(5)
    expect(held).toBeLessThanOrEqual(14)
    // Esc does not repeat: a hold sends one
    const escBefore = count(await termText(page, SHELL), '^[')
    await touch(cdp, phone, await (async () => {
        const b = await phone.locator('.phone-key[data-key="Escape"]').boundingBox()
        return { x: b!.x + b!.width / 2, y: b!.y + b!.height / 2 }
    })(), 900)
    await page.waitForTimeout(500)
    expect(count(await termText(page, SHELL), '^[') - escBefore).toBe(1)
    await writeToTerminal(page, SHELL, '\x03')

    // ---- 4. wrap to screen ------------------------------------------------------------------
    const mac = await ptyState(page, SCREEN)
    expect(mac.size).not.toBeNull()
    await phone.goto(`${base}/?session=${SCREEN}&view=terminal`)
    await expect(phone.getByTestId('phone-terminal')).toHaveAttribute('data-status', 'live', { timeout: 15_000 })
    await expect(phone.getByTestId('phone-terminal')).toHaveAttribute('data-wrap', 'off') // the default is still fit
    await expect(phone.getByTestId('phone-terminal')).toHaveAttribute('data-zoom', 'fit')
    await touch(cdp, phone, await centerOf(phone, 'phone-terminal-wrap'))
    await expect(phone.getByTestId('phone-terminal')).toHaveAttribute('data-wrap', 'on')
    const fold = phone.getByTestId('phone-terminal-fold')
    await expect(fold).toContainText(READY, { timeout: 10_000 })
    const folded = await fold.evaluate((element) => ({
        fontPx: parseFloat(getComputedStyle(element).fontSize),
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
        width: element.getBoundingClientRect().width,
        lines: element.children.length,
        rules: element.querySelectorAll('[data-rule]').length,
        rulesOneLine: Array.from(element.querySelectorAll<HTMLElement>('[data-rule]')).every((rule) => rule.offsetHeight <= parseFloat(getComputedStyle(rule).lineHeight) + 1),
        atEnd: element.scrollTop + element.clientHeight >= element.scrollHeight - 2
    }))
    expect(folded.fontPx).toBe(13)
    expect(folded.width).toBe(390)
    expect(folded.scrollWidth).toBeLessThanOrEqual(folded.clientWidth)
    expect(folded.lines).toBeGreaterThan(5)
    expect(folded.rules).toBeGreaterThan(0)
    expect(folded.rulesOneLine).toBe(true)
    expect(folded.atEnd).toBe(true)
    await capture(cdp, 't78-wrap.png')
    // remembered on this phone
    await phone.reload()
    await expect(phone.getByTestId('phone-terminal')).toHaveAttribute('data-wrap', 'on', { timeout: 15_000 })
    await expect(phone.getByTestId('phone-terminal-fold')).toContainText(READY, { timeout: 10_000 })
    // and off again: the grid as it was (fit)
    await touch(cdp, phone, await centerOf(phone, 'phone-terminal-wrap'))
    await expect(phone.getByTestId('phone-terminal')).toHaveAttribute('data-wrap', 'off')
    await expect(phone.getByTestId('phone-terminal-fold')).toHaveCount(0)
    expect(await phone.evaluate(() => localStorage.getItem('phone-terminal-wrap'))).toBeNull()

    // the Mac's pty: same size, never resized by any of it
    const after = await ptyState(page, SCREEN)
    expect(after.size).toEqual(mac.size)
    expect(after.resized).toBe(mac.resized)
    for (const id of [AGENT_A, AGENT_B, SHELL, SCREEN]) expect((await ptyState(page, id)).resized).toBe(baseline.get(id))
    await phone.close()
})
