import { test, expect, type CDPSession, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { closeApp, launchAppWithWorkspaces, LaunchResult, resizeMainWindow, waitForBufferText } from './helpers'

/**
 * T77 — how big the phone draws the Mac's terminal, measured, before anyone picks a default.
 *
 * One Claude Code-shaped screen at the Mac's size (a 1280×800 window: about 103×43), drawn by
 * a fixture that fills the width (Korean included). The phone is an app window of its own at
 * device scale 3, like an iPhone (CDP device metrics), let in as this Mac's owner the way
 * `tailscale serve` would (its two headers on every request of that window). Three modes:
 *   (a) portrait 390×844, fit the width — today's default
 *   (b) portrait 390×844 at 100% (the phone's 13px, the size people read) — slide sideways
 *   (c) landscape 844×390, fit the width
 * Each: CSS font px × scale, cell px, columns of one line on screen, lines on one screen.
 *
 * Checked: the zoom (−/+/fit) is remembered on the device that chose it and not on another,
 * and through all of it — zooms, reloads, turning the phone — the Mac's pty never changes
 * size (`resized` 0). PHONE_SHOTS=<folder> saves the captures (device pixels) and crops of
 * the text at device pixels, plus t77-measure.json.
 */

const SCREEN = 't77-screen'
const SCREEN_SCRIPT = path.join(__dirname, 'fixtures/phone-screen/claude-screen.cjs')
/** the fixture's last line — on screen means drawn */
const READY = 'IDE disconnected'
const OWNER = 'owner@example.com'
const DPR = 3
/** round 1's Mac size was 103×43 (T76's 1280×800 window): the same width here */
const MAC_COLS = 103
const ZOOM_KEY = 'phone-terminal-zoom'
/** rows of the fixture that hold tool calls, the diff and the Korean answer — what the crops show */
const CROP_FIRST_ROW = 18
const CROP_ROWS = 17

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

interface Measure {
    viewport: { width: number; height: number }
    dpr: number
    cols: number
    rows: number
    scale: number
    zoom: string
    /** the xterm's own font size (CSS px, before the scale) */
    fontPx: number
    /** what the eye gets: fontPx × scale */
    glyphPx: number
    cellWidthPx: number
    cellHeightPx: number
    /** visible columns of one line, and lines on one screen, at this scale */
    visibleCols: number
    visibleRows: number
    sideways: boolean
    scrollerWidth: number
    scrollerHeight: number
    hostLeft: number
    hostTop: number
    /**
     * What the fit was computed from against what is drawn now (intermittent 83 of 103 columns in
     * landscape, 11-05): the screen width the scale used, the scroller width it used, the font xterm
     * was told and whether the bundled one is in. Printed when a fit check fails.
     */
    fit: { naturalWidth: number; screenWidth: number; fitWidth: number; scrollerWidth: number; fontFamily: string; bundledFontLoaded: boolean; at: number }
}

async function ptyState(page: Page, id: string): Promise<{ size: { cols: number; rows: number } | null; resized: number }> {
    const context = await page.evaluate((sessionId) => window.api.feedbackTerminalContext(sessionId), id)
    const events = context.terminal?.events ?? []
    return { size: context.terminal?.size ?? null, resized: events.filter((e) => e.kind === 'resized').length }
}

test('T77 phone terminal text size: fit · 100% · landscape measured at the Mac size; zoom remembered per device; the Mac pty never resized', async () => {
    test.setTimeout(180_000)
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'climanager-t77-'))
    const statusFile = path.join(home, 'tailscale-status.json')
    fs.writeFileSync(statusFile, JSON.stringify({
        BackendState: 'Running',
        Self: { UserID: 42, DNSName: 'mac.tail1234.ts.net.', TailscaleIPs: ['100.100.1.1'] },
        User: { '42': { LoginName: OWNER } }
    }))
    const shots = process.env.PHONE_SHOTS ?? null
    if (shots) fs.mkdirSync(shots, { recursive: true })

    result = await launchAppWithWorkspaces(
        [{ id: 'w-t77', name: 'T77 project', path: home, sessions: [{ id: SCREEN, name: 'T77 Claude screen', initialCommand: `node '${SCREEN_SCRIPT}'` }] }],
        { settings: { phone: { enabled: true, port: 0 } }, env: { CLIMANAGER_PHONE_TAILSCALE_STATUS: statusFile } }
    )
    const { app, page } = result
    await resizeMainWindow(app, 1280, 800)
    // on screen on the Mac, so its pty has the Mac's visible size; the fixture redraws at it
    await page.locator(`[data-session-item="${SCREEN}"]`).first().click()
    await waitForBufferText(page, SCREEN, READY, 30_000)
    await page.waitForTimeout(1000)

    // the Mac's own terminal: its font and cell, for comparison
    const macTerminal = (): Promise<{ fontPx: number; width: number; height: number; dpr: number } | null> => page.evaluate((ready) => {
        const xterm = Array.from(document.querySelectorAll<HTMLElement>('.xterm')).find((el) => el.offsetWidth > 0 && (el.querySelector('.xterm-rows')?.textContent ?? '').includes(ready))
        if (!xterm) return null
        const rows = xterm.querySelector('.xterm-rows') as HTMLElement
        const screen = xterm.querySelector('.xterm-screen') as HTMLElement
        return { fontPx: parseFloat(getComputedStyle(rows).fontSize), width: screen.offsetWidth, height: screen.offsetHeight, dpr: window.devicePixelRatio }
    }, READY)
    // round 1's Mac size (103 columns): the window narrows by the extra columns' width
    const first = await ptyState(page, SCREEN)
    const firstTerminal = await macTerminal()
    expect(first.size).not.toBeNull()
    expect(firstTerminal).not.toBeNull()
    const cellWidth = firstTerminal!.width / first.size!.cols
    let windowWidth = 1280
    let cols = first.size!.cols
    for (let attempt = 0; attempt < 4 && cols !== MAC_COLS; attempt++) {
        windowWidth = Math.round(windowWidth - (cols - MAC_COLS) * cellWidth + (cols > MAC_COLS ? 0 : cellWidth / 2))
        await resizeMainWindow(app, windowWidth, 800)
        await page.waitForTimeout(1200)
        cols = (await ptyState(page, SCREEN)).size?.cols ?? cols
    }
    expect(cols).toBe(MAC_COLS)
    await waitForBufferText(page, SCREEN, READY, 10_000)
    const mac = await ptyState(page, SCREEN)
    const desktop = await macTerminal()
    expect(desktop).not.toBeNull()

    const state = await page.evaluate(() => window.api.getPhoneState())
    expect(state.running).toBe(true)
    const base = `http://127.0.0.1:${state.port}`
    const address = `${base}/?session=${SCREEN}&view=terminal`

    // --- the phone: device scale 3, portrait ---
    const phone = await openOwnerPhone(app, address, 't77-phone-a')
    const cdp = await phone.context().newCDPSession(phone)
    await turn(app, cdp, base, 390, 844)
    const live = async (target: Page): Promise<void> => {
        await expect(target.getByTestId('phone-terminal')).toHaveAttribute('data-status', 'live', { timeout: 15_000 })
        await expect(target.getByTestId('phone-terminal-host')).toContainText(READY, { timeout: 10_000 })
    }
    await live(phone)
    await expect(phone.getByTestId('phone-terminal-size')).toHaveText(`${mac.size!.cols}×${mac.size!.rows}`)

    // (a) portrait, fit the width — today's default
    await expect(phone.getByTestId('phone-terminal')).toHaveAttribute('data-zoom', 'fit')
    const a = await measure(phone)
    expect(a.dpr).toBe(DPR)
    expect(a.scale).toBeLessThan(1)
    await expectAllColumns(phone, a)
    expect(a.sideways).toBe(false)
    await capture(cdp, shots, 't77-a-portrait-fit.png')
    await capture(cdp, shots, 't77-a-portrait-fit-crop.png', crop(a))

    // the zoom is remembered on this device: + once, reload, same scale
    await phone.getByTestId('phone-terminal-zoom-in').click()
    await expect(phone.getByTestId('phone-terminal')).toHaveAttribute('data-zoom', 'zoomed')
    const zoomed = Number(await phone.getByTestId('phone-terminal').getAttribute('data-scale'))
    expect(zoomed).toBeCloseTo(a.scale * 1.25, 3)
    expect(Number(await phone.evaluate((key) => localStorage.getItem(key), ZOOM_KEY))).toBeCloseTo(zoomed, 3)
    await phone.reload()
    await turn(app, cdp, base, 390, 844)
    await live(phone)
    await expect(phone.getByTestId('phone-terminal')).toHaveAttribute('data-zoom', 'zoomed')
    expect(Number(await phone.getByTestId('phone-terminal').getAttribute('data-scale'))).toBeCloseTo(zoomed, 3)

    // (b) portrait at 100% — the phone's 13px — and the line slides sideways
    await phone.evaluate((key) => localStorage.setItem(key, '1'), ZOOM_KEY)
    await phone.reload()
    await turn(app, cdp, base, 390, 844)
    await live(phone)
    await expect(phone.getByTestId('phone-terminal')).toHaveAttribute('data-scale', '1.0000')
    const b = await measure(phone)
    expect(b.glyphPx).toBe(b.fontPx)
    expect(b.sideways).toBe(true)
    expect(b.visibleCols).toBeLessThan(b.cols)
    await capture(cdp, shots, 't77-b-portrait-100.png')
    await capture(cdp, shots, 't77-b-portrait-100-crop.png', crop(b))
    // slid to the right end: the rest of the same lines
    await phone.getByTestId('phone-terminal-scroller').evaluate((scroller) => {
        scroller.scrollLeft = scroller.scrollWidth
    })
    await phone.waitForTimeout(300)
    await capture(cdp, shots, 't77-b-portrait-100-right.png')

    // another phone has its own: it opens at the default (fit), whatever the first one chose
    const other = await openOwnerPhone(app, address, 't77-phone-b')
    const otherCdp = await other.context().newCDPSession(other)
    await turn(app, otherCdp, base, 390, 844, 1)
    await live(other)
    await expect(other.getByTestId('phone-terminal')).toHaveAttribute('data-zoom', 'fit')
    await other.close()

    // (c) landscape, fit the width (the fit button also forgets the zoom on this device)
    await turn(app, cdp, base, 844, 390)
    await phone.getByTestId('phone-terminal-fit').click()
    await expect(phone.getByTestId('phone-terminal')).toHaveAttribute('data-zoom', 'fit')
    expect(await phone.evaluate((key) => localStorage.getItem(key), ZOOM_KEY)).toBeNull()
    const c = await measure(phone)
    await expectAllColumns(phone, c)
    await capture(cdp, shots, 't77-c-landscape-fit.png')
    await capture(cdp, shots, 't77-c-landscape-fit-crop.png', crop(c))

    // For the review only — a mock, not the app: (c) if a phone turned sideways kept the list in its
    // drawer (today a 844-wide screen counts as wide and keeps the list beside the terminal).
    let cDrawerMock: Measure | null = null
    if (shots) {
        await phone.addStyleTag({ content: '.phone-wide .phone-sidebar { display: none !important; }' })
        cDrawerMock = await measure(phone)
        await capture(cdp, shots, 't77-c-landscape-drawer-mock.png')
        await capture(cdp, shots, 't77-c-landscape-drawer-mock-crop.png', crop(cDrawerMock))
    }

    // through all of it the Mac's pty kept its size
    const after = await ptyState(page, SCREEN)
    expect(after.size).toEqual(mac.size)
    expect(after.resized).toBe(mac.resized)

    const report = {
        mac: { cols: mac.size!.cols, rows: mac.size!.rows, fontPx: desktop!.fontPx, cellWidthPx: desktop!.width / mac.size!.cols, cellHeightPx: desktop!.height / mac.size!.rows, dpr: desktop!.dpr },
        a,
        b,
        c,
        ...(cDrawerMock ? { cDrawerMock } : {})
    }
    console.log(`[t77] ${JSON.stringify(report)}`)
    if (shots) fs.writeFileSync(path.join(shots, 't77-measure.json'), JSON.stringify(report, null, 2))
})

/** The text area the crops show: the fixture's tool calls, diff and Korean answer, as far as is on screen. */
function crop(m: Measure): { x: number; y: number; width: number; height: number } {
    const cell = m.cellHeightPx * m.scale
    const left = Math.max(0, m.hostLeft)
    return {
        x: left,
        y: m.hostTop + CROP_FIRST_ROW * cell,
        width: Math.min(m.viewport.width - left, m.cols * m.cellWidthPx * m.scale),
        height: Math.min(CROP_ROWS * cell, m.viewport.height - (m.hostTop + CROP_FIRST_ROW * cell))
    }
}

async function measure(phone: Page): Promise<Measure> {
    // a zoom or a turn lays out on the next frames (ResizeObserver, xterm's own)
    await phone.waitForTimeout(600)
    return phone.evaluate(() => {
        const terminal = document.querySelector<HTMLElement>('[data-testid="phone-terminal"]')!
        const host = document.querySelector<HTMLElement>('[data-testid="phone-terminal-host"]')!
        const scroller = document.querySelector<HTMLElement>('[data-testid="phone-terminal-scroller"]')!
        const screen = host.querySelector<HTMLElement>('.xterm-screen')!
        const rowsElement = host.querySelector<HTMLElement>('.xterm-rows')!
        const [cols, rows] = (document.querySelector('[data-testid="phone-terminal-size"]')!.textContent ?? '').split('×').map(Number)
        const scale = Number(terminal.dataset.scale)
        const fontPx = parseFloat(getComputedStyle(rowsElement).fontSize)
        const cellWidthPx = screen.offsetWidth / cols
        const cellHeightPx = screen.offsetHeight / rows
        const hostBox = host.getBoundingClientRect()
        // data-scale is rounded to 4 places: a whole cell short by a rounding error is still on screen
        const tiny = 0.02
        return {
            viewport: { width: window.innerWidth, height: window.innerHeight },
            dpr: window.devicePixelRatio,
            cols,
            rows,
            scale,
            zoom: terminal.dataset.zoom ?? '',
            fontPx,
            glyphPx: Math.round(fontPx * scale * 100) / 100,
            cellWidthPx,
            cellHeightPx,
            visibleCols: Math.min(cols, Math.floor(scroller.clientWidth / (cellWidthPx * scale) + tiny)),
            visibleRows: Math.min(rows, Math.floor(scroller.clientHeight / (cellHeightPx * scale) + tiny)),
            sideways: scroller.scrollWidth > scroller.clientWidth + 1,
            scrollerWidth: scroller.clientWidth,
            scrollerHeight: scroller.clientHeight,
            hostLeft: hostBox.left,
            hostTop: hostBox.top,
            fit: {
                naturalWidth: Number(terminal.dataset.naturalWidth),
                screenWidth: screen.offsetWidth,
                fitWidth: Number(terminal.dataset.fitWidth),
                scrollerWidth: scroller.clientWidth,
                fontFamily: rowsElement.style.fontFamily || getComputedStyle(rowsElement).fontFamily,
                bundledFontLoaded: document.fonts.check('13px "CLIM Phone Mono"'),
                at: Math.round(performance.now())
            }
        }
    })
}

/** A fit shows every column; when it does not, say which input of the scale was stale. */
async function expectAllColumns(phone: Page, m: Measure): Promise<void> {
    if (m.visibleCols !== m.cols) {
        // read again a second later: a value that settles is an order problem, not a wrong formula
        await phone.waitForTimeout(1000)
        const later = await measure(phone)
        console.log('[t77] fit showed', m.visibleCols, 'of', m.cols, 'columns', JSON.stringify({ then: m.fit, scale: m.scale, later: later.fit, laterScale: later.scale, laterVisible: later.visibleCols }))
    }
    expect(m.visibleCols, JSON.stringify({ fit: m.fit, scale: m.scale })).toBe(m.cols)
}

/** A phone of `width`×`height` points at device scale 3: the window and the emulated screen. */
async function turn(app: ElectronApplication, cdp: CDPSession, base: string, width: number, height: number, nth = 0): Promise<void> {
    await app.evaluate(({ BrowserWindow }, o) => {
        const wins = BrowserWindow.getAllWindows().filter((w) => w.webContents.getURL().startsWith(o.base))
        wins[o.nth]?.setContentSize(o.width, o.height)
    }, { base, width, height, nth })
    await cdp.send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: DPR,
        mobile: true,
        screenOrientation: width > height ? { type: 'landscapePrimary', angle: 90 } : { type: 'portraitPrimary', angle: 0 }
    })
}

/** Device pixels: a 390-point-wide capture is 1170 px, as an iPhone screenshot is. */
async function capture(cdp: CDPSession, dir: string | null, name: string, clip?: { x: number; y: number; width: number; height: number }): Promise<void> {
    if (!dir) return
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) })
    fs.writeFileSync(path.join(dir, name), Buffer.from(data, 'base64'))
}

/**
 * A phone window in its own cookie jar, let in as this Mac's owner the way `tailscale serve`
 * does it: every request of that window carries the owner's login and a tailnet address.
 */
async function openOwnerPhone(app: ElectronApplication, url: string, partition: string): Promise<Page> {
    const opened = app.waitForEvent('window')
    await app.evaluate(({ BrowserWindow, session }, o) => {
        session.fromPartition(o.partition).webRequest.onBeforeSendHeaders((details, callback) => {
            callback({ requestHeaders: { ...details.requestHeaders, 'Tailscale-User-Login': o.owner, 'X-Forwarded-For': '100.101.102.103' } })
        })
        const win = new BrowserWindow({
            width: 390,
            height: 844,
            useContentSize: true,
            show: false,
            webPreferences: { partition: o.partition, backgroundThrottling: false }
        })
        void win.loadURL(o.url)
    }, { url, partition, owner: OWNER })
    const page = await opened
    await page.waitForLoadState('domcontentloaded')
    return page
}
