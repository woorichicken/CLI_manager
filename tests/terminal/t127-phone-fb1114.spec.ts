import { test, expect, type CDPSession, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { closeApp, launchAppWithWorkspaces, type LaunchResult, resizeMainWindow, waitForBufferText, writeToTerminal } from './helpers'
import { gridRowHtml, historyRowCount } from '../../src/renderer/src/phone/terminalHistory'
import { createLongPress, LONG_PRESS_MS } from '../../src/renderer/src/phone/longPress'
import type { FoldCell, FoldLine } from '../../src/renderer/src/phone/terminalFold'

/**
 * T127 — fb-1114, the phone (CDP touch 390×844, scale 3, let in as the Mac's owner).
 *
 *  3f59e735 the top of the phone terminal was empty: the Mac's screen, fitted to the phone's width, is
 *  shorter than the room and sits at the bottom. The rows of history just above it now fill that room —
 *  same cells, same scale, following a history drag; nothing when there is no history or the screen
 *  fills the room (zoomed). The Mac's pty never changes size for it (decision 0009): same size, no
 *  `resized` event.
 *  ebf8dec6 a press held on a session row renames it in place (the Mac sidebar's ⋯ → Rename); a tap
 *  still opens, a moving finger is a scroll, the click that ends the press does not hit ✓/✕, a
 *  view-only device gets no editor. No delete.
 *
 * T127_SHOTS=<dir> + T127_LABEL save captures before the checks; T127_BEFORE=1 only takes them (the
 * old code: the review's «before» column).
 */

const BEFORE = process.env.T127_BEFORE === '1'
const LABEL = process.env.T127_LABEL ?? 'run'
const SHELL = 't127-shell'
const FRESH = 't127-fresh'
const OTHER = 't127-other'
const OWNER = 'owner-t127@example.com'
const PORT = 47927
const HISTORY_LINES = 300
const NEW_NAME = 'T127 폰 목록에서 바꾼 이름'

let result: LaunchResult | null = null
test.afterEach(async () => {
    if (!result) return
    const done = result
    result = null
    const closed = await Promise.race([closeApp(done).then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 20_000))])
    if (!closed) {
        done.app.process().kill('SIGKILL')
        fs.rmSync(done.userDataDir, { recursive: true, force: true })
    }
})

async function shot(page: Page, name: string): Promise<void> {
    const dir = process.env.T127_SHOTS
    if (!dir) return
    fs.mkdirSync(dir, { recursive: true })
    await page.waitForTimeout(400)
    await page.screenshot({ path: path.join(dir, `${name}-${LABEL}.png`) })
}

async function ptyState(page: Page, id: string): Promise<{ size: { cols: number; rows: number } | null; resized: number }> {
    const context = await page.evaluate((sessionId) => window.api.feedbackTerminalContext(sessionId), id)
    const events = context.terminal?.events ?? []
    return { size: context.terminal?.size ?? null, resized: events.filter((e) => e.kind === 'resized').length }
}

/** a 390×844 touch phone; `owner` lets it in as `tailscale serve` does, otherwise it meets the pairing screen */
async function openPhone(app: ElectronApplication, url: string, partition: string, owner = true): Promise<{ phone: Page; cdp: CDPSession }> {
    const opened = app.waitForEvent('window')
    await app.evaluate(({ BrowserWindow, session }, o) => {
        const jar = session.fromPartition(o.partition)
        if (o.owner) {
            jar.webRequest.onBeforeSendHeaders((details, callback) => {
                callback({ requestHeaders: { ...details.requestHeaders, 'Tailscale-User-Login': o.owner, 'X-Forwarded-For': '100.101.102.103' } })
            })
        }
        const win = new BrowserWindow({ width: 390, height: 844, useContentSize: true, show: false, webPreferences: { partition: o.partition, backgroundThrottling: false } })
        void win.loadURL(o.url)
    }, { url, partition, owner: owner ? OWNER : '' })
    const phone = await opened
    await phone.waitForLoadState('domcontentloaded')
    const cdp = await phone.context().newCDPSession(phone)
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true, screenOrientation: { type: 'portraitPrimary', angle: 0 } })
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
    await phone.reload()
    await phone.waitForLoadState('domcontentloaded')
    return { phone, cdp }
}

async function centre(page: Page, selector: string, dx: 'middle' | 'right' = 'middle'): Promise<{ x: number; y: number }> {
    const box = await page.locator(selector).first().boundingBox()
    expect(box, selector).not.toBeNull()
    return { x: dx === 'right' ? box!.x + box!.width - 24 : box!.x + box!.width / 2, y: box!.y + box!.height / 2 }
}

/** a finger down for `ms`, moved by `drag` px down along the way, then up — CDP touch, as a real finger arrives */
async function press(cdp: CDPSession, page: Page, at: { x: number; y: number }, ms: number, drag = 0): Promise<void> {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: at.x, y: at.y }] })
    if (drag) {
        for (let step = 1; step <= 4; step++) {
            await page.waitForTimeout(40)
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: at.x, y: at.y + (drag * step) / 4 }] })
        }
        await page.waitForTimeout(Math.max(0, ms - 160))
    } else {
        await page.waitForTimeout(ms)
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
}

const tap = async (cdp: CDPSession, page: Page, selector: string): Promise<void> => press(cdp, page, await centre(page, selector), 60)

/** the number in «T127 history N» on the grid's first row and on the history's last row */
async function rowNumbers(phone: Page): Promise<{ gridFirst: number; historyLast: number | null; historyRows: number }> {
    return phone.evaluate(() => {
        const number = (text: string | null | undefined): number => Number(/T127 history (\d+)/.exec(text ?? '')?.[1] ?? NaN)
        const grid = document.querySelector('[data-testid="phone-terminal-host"] .xterm-rows')?.firstElementChild?.textContent
        const rows = document.querySelectorAll('[data-testid="phone-terminal-history"] .phone-term-history-row')
        return { gridFirst: number(grid), historyLast: rows.length ? number(rows[rows.length - 1].textContent) : null, historyRows: rows.length }
    })
}

test.describe('T127 units', () => {
    test('historyRowCount: whole rows of the room the screen leaves, no more than the history holds', () => {
        // a 43-row screen 731px tall at 0.486: 355px of 760 — 405px spare = 23 rows of 8.26px... at most the history
        expect(historyRowCount(760, 731, 43, 0.486, 1000)).toBe(Math.floor((760 - 731 * 0.486) / ((731 / 43) * 0.486)))
        expect(historyRowCount(760, 731, 43, 0.486, 7)).toBe(7)
        expect(historyRowCount(760, 731, 43, 0.486, 0), 'no history: the room stays empty').toBe(0)
        expect(historyRowCount(760, 731, 43, 1.2, 1000), 'zoomed past the room').toBe(0)
        expect(historyRowCount(760, 731, 43, 760 / 731, 1000), 'exactly the room').toBe(0)
        expect(historyRowCount(0, 731, 43, 0.5, 1000), 'not measured yet').toBe(0)
        expect(historyRowCount(760, 0, 43, 0.5, 1000)).toBe(0)
    })

    const cell = (chars: string, width = 1, fg: number | null = null): FoldCell => ({
        getChars: () => chars,
        getWidth: () => width,
        isFgDefault: () => fg === null,
        isFgRGB: () => false,
        getFgColor: () => fg ?? 0,
        isBgDefault: () => true,
        isBgRGB: () => false,
        getBgColor: () => 0,
        isBold: () => 0,
        isItalic: () => 0,
        isDim: () => 0,
        isUnderline: () => 0,
        isInverse: () => 0,
        isInvisible: () => 0
    })
    const lineOf = (cells: FoldCell[], cols: number): FoldLine => ({ isWrapped: false, getCell: (x) => (x < cols ? cells[x] ?? cell(' ') : undefined) })
    const theme = { foreground: '#e0e0e0', background: '#0f0f12', cursor: '#fff' }

    test('gridRowHtml: the row as the grid has it — a frame edge kept, a wide glyph once, escaped, trailing blanks dropped', () => {
        const frame = lineOf([cell('│'), cell('a'), cell(' '), cell(' '), cell(' '), cell('│')], 10)
        expect(gridRowHtml(frame, 10, theme).text, 'the folded view drops the edge; the grid keeps it').toBe('│a   │')
        const hangul = lineOf([cell('한', 2), cell('', 0), cell('<'), cell('&')], 6)
        expect(gridRowHtml(hangul, 6, theme)).toEqual({ html: '한&lt;&amp;', text: '한<&' })
        const coloured = lineOf([cell('o', 1, 1), cell('k', 1, 1), cell('!')], 5)
        expect(gridRowHtml(coloured, 5, theme).html).toBe('<span style="color:#cc0000;">ok</span>!')
        expect(gridRowHtml(lineOf([], 4), 4, theme)).toEqual({ html: '', text: '' })
    })

    test('createLongPress: held still it fires once and eats its click; a tap is a click; a moving finger is a scroll', () => {
        let pending: (() => void) | null = null
        const schedule = (run: () => void, ms: number): (() => void) => {
            expect(ms).toBe(LONG_PRESS_MS)
            pending = run
            return () => (pending = null)
        }
        let fired = 0
        const lp = createLongPress(() => fired++, schedule)
        // a tap: lifted before the time
        lp.down(10, 10)
        lp.up()
        expect(pending).toBeNull()
        expect(lp.takeClick()).toBe(true)
        // held: fires, and the click after it is eaten — once
        lp.down(10, 10)
        lp.move(13, 14) // 5px: within the slop
        ;(pending as unknown as () => void)()
        expect(fired).toBe(1)
        lp.up()
        expect(lp.takeClick()).toBe(false)
        expect(lp.takeClick(), 'only that one click').toBe(true)
        // a scroll: the finger moved past the slop, nothing fires
        lp.down(10, 10)
        lp.move(10, 40)
        expect(pending).toBeNull()
        expect(fired).toBe(1)
        expect(lp.takeClick()).toBe(true)
        // the browser took the gesture (pointercancel)
        lp.down(10, 10)
        lp.cancel()
        expect(pending).toBeNull()
    })
})

async function launch(): Promise<{ app: ElectronApplication; page: Page; base: string }> {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'climanager-t127-'))
    const project = path.join(home, 'project')
    fs.mkdirSync(project, { recursive: true })
    const statusFile = path.join(home, 'tailscale-status.json')
    fs.writeFileSync(statusFile, JSON.stringify({ BackendState: 'Running', Self: { UserID: 42, DNSName: 'mac.tail1234.ts.net.', TailscaleIPs: ['100.100.1.1'] }, User: { '42': { LoginName: OWNER } } }))
    result = await launchAppWithWorkspaces(
        [{ id: 'w-t127', name: 'T127 project', path: project, sessions: [{ id: SHELL, name: 'T127 Shell' }, { id: FRESH, name: 'T127 Fresh' }, { id: OTHER, name: 'T127 Other' }] }],
        { settings: { phone: { enabled: true, port: PORT } }, env: { CLIMANAGER_PHONE_TAILSCALE_STATUS: statusFile } }
    )
    const { app, page } = result
    await resizeMainWindow(app, 1280, 800)
    const state = await page.evaluate(() => window.api.getPhoneState())
    expect(state.running).toBe(true)
    return { app, page, base: `http://127.0.0.1:${state.port}` }
}

test('T127 phone terminal: the room above the screen shows the history, not an empty top (3f59e735)', async () => {
    test.setTimeout(180_000)
    const { app, page, base } = await launch()
    await page.locator(`[data-session-item="${SHELL}"]`).first().click()
    await page.waitForTimeout(800)
    await writeToTerminal(page, SHELL, `seq -f 'T127 history %g' 1 ${HISTORY_LINES}\r`)
    await waitForBufferText(page, SHELL, `T127 history ${HISTORY_LINES}`, 20_000)
    // what the Mac did to its ptys before any phone came: the phone adds nothing to it
    const mac = { shell: await ptyState(page, SHELL), fresh: await ptyState(page, FRESH) }
    expect(mac.shell.size).not.toBeNull()

    const { phone, cdp } = await openPhone(app, `${base}/?session=${SHELL}&view=terminal`, 't127-term')
    await expect(phone.getByTestId('phone-terminal')).toHaveAttribute('data-status', 'live', { timeout: 15_000 })
    await phone.waitForTimeout(800)
    await shot(phone, 'A-terminal-390')

    if (!BEFORE) {
        const scroller = (await phone.getByTestId('phone-terminal-scroller').boundingBox())!
        const sizer = (await phone.locator('.phone-term-sizer').boundingBox())!
        const rowHeight = sizer.height / mac.shell.size!.rows
        expect(sizer.height, 'fitted, the Mac screen is shorter than the room — the case of the report').toBeLessThan(scroller.height - 5 * rowHeight)
        expect(Math.abs(sizer.y + sizer.height - (scroller.y + scroller.height)), 'the screen still sits at the bottom').toBeLessThanOrEqual(1)
        const history = phone.getByTestId('phone-terminal-history')
        await expect(history).toBeVisible()
        const box = (await history.boundingBox())!
        expect(box.y - scroller.y, 'no empty top: less than one row is left above').toBeLessThan(rowHeight + 1)
        expect(Math.abs(box.y + box.height - sizer.y), 'the history ends where the screen starts').toBeLessThanOrEqual(1)
        // the rows just above the screen, in order
        const numbers = await rowNumbers(phone)
        expect(numbers.historyRows).toBeGreaterThan(5)
        expect(numbers.historyLast).toBe(numbers.gridFirst - 1)
        // same cells: a row of the history is as wide as the same characters on the grid
        const widths = await phone.evaluate(() => {
            const textWidth = (element: Element): number => {
                const range = document.createRange()
                range.selectNodeContents(element)
                return range.getBoundingClientRect().width
            }
            const grid = document.querySelector('[data-testid="phone-terminal-host"] .xterm-rows')!.firstElementChild!
            const rows = document.querySelectorAll('[data-testid="phone-terminal-history"] .phone-term-history-row')
            const last = rows[rows.length - 1]
            return { grid: textWidth(grid), gridText: grid.textContent!.trimEnd(), history: textWidth(last), historyText: last.textContent! }
        })
        expect(widths.historyText.length, `${widths.historyText} ~ ${widths.gridText}`).toBe(widths.gridText.length)
        expect(Math.abs(widths.history - widths.grid), 'the history lands on the grid’s columns').toBeLessThanOrEqual(2)

        // a drag down through the history: the room follows the grid back
        const at = { x: scroller.x + scroller.width / 2, y: scroller.y + scroller.height * 0.6 }
        await press(cdp, phone, at, 300, 160)
        await expect.poll(async () => (await rowNumbers(phone)).gridFirst).toBeLessThan(numbers.gridFirst)
        const dragged = await rowNumbers(phone)
        expect(dragged.historyLast).toBe(dragged.gridFirst - 1)
        await tap(cdp, phone, '[aria-label="Scroll to the end"]')
        await expect.poll(async () => (await rowNumbers(phone)).gridFirst).toBe(numbers.gridFirst)

        // zoomed past the room: the screen fills it, no history drawn
        for (let i = 0; i < 4; i++) await tap(cdp, phone, '[data-testid="phone-terminal-zoom-in"]')
        await expect(history).toHaveCount(0)
        await tap(cdp, phone, '[data-testid="phone-terminal-fit"]')
        await expect(history).toBeVisible()
    }

    // a shell with no history: nothing to show, the room stays empty
    await phone.goto(`${base}/?session=${FRESH}&view=terminal`)
    await expect(phone.getByTestId('phone-terminal')).toHaveAttribute('data-status', 'live', { timeout: 15_000 })
    await phone.waitForTimeout(800)
    if (!BEFORE) {
        await expect(phone.getByTestId('phone-terminal-history')).toHaveCount(0)
        // and the Mac's ptys: same size, never resized by the phone (decision 0009)
        for (const [id, before] of [[SHELL, mac.shell], [FRESH, mac.fresh]] as const) {
            const after = await ptyState(page, id)
            expect(after.size, id).toEqual(before.size)
            expect(after.resized, id).toBe(before.resized)
        }
    }
})

test('T127 phone list: a held press renames the session in place, the Mac sidebar follows (ebf8dec6)', async () => {
    test.setTimeout(180_000)
    const { app, page, base } = await launch()
    const { phone, cdp } = await openPhone(app, `${base}/?session=${SHELL}&view=terminal`, 't127-list')
    await expect(phone.getByTestId('phone-terminal')).toHaveAttribute('data-status', 'live', { timeout: 15_000 })
    await tap(cdp, phone, '[data-testid="phone-menu-button"]')
    const otherRow = `[data-testid="phone-session-row"][data-session-id="${OTHER}"]`
    await expect(phone.locator(otherRow)).toBeVisible()

    // held still on the right of the row, where ✓ and ✕ will be: the editor, not the session, and the click that ends it hits nothing
    await press(cdp, phone, await centre(phone, otherRow, 'right'), 800)
    await phone.waitForTimeout(300)
    await shot(phone, 'B-longpress-390')
    if (BEFORE) return
    const editor = phone.locator(`[data-testid="phone-row-rename"][data-session-id="${OTHER}"]`)
    await expect(editor).toBeVisible()
    await expect(phone.getByTestId('phone-rename-input')).toHaveValue('T127 Other')
    await expect(phone.getByTestId('phone-rename-input')).toBeFocused()
    await expect(phone.getByTestId('phone-session-title')).toHaveText('T127 Shell')
    expect(new URL(phone.url()).searchParams.get('session')).toBe(SHELL)
    await phone.waitForTimeout(900)
    await expect(editor, 'still open after the press: its click was eaten').toBeVisible()
    expect(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no sideways scroll').toBe(true)

    await phone.getByTestId('phone-rename-input').fill(`  ${NEW_NAME}  `)
    await shot(phone, 'B-editing-390')
    await tap(cdp, phone, '[data-testid="phone-rename-save"]')
    await expect(editor).toHaveCount(0)
    await expect(phone.locator(otherRow)).toContainText(NEW_NAME)
    await shot(phone, 'B-saved-390')
    // the Mac: its sidebar without a reload, and the store
    await expect(page.locator(`[data-session-item="${OTHER}"]`).first()).toContainText(NEW_NAME, { timeout: 10_000 })
    await shot(page, 'B-mac-sidebar-1280')
    const stored = await page.evaluate(async (id) => (await window.api.getWorkspaces()).flatMap((w: { sessions: Array<{ id: string; name: string }> }) => w.sessions).find((s) => s.id === id)?.name, OTHER)
    expect(stored).toBe(NEW_NAME)

    // ✕ leaves it as it was
    const shellRow = `[data-testid="phone-session-row"][data-session-id="${SHELL}"]`
    await press(cdp, phone, await centre(phone, shellRow), 800)
    await expect(phone.getByTestId('phone-rename-input')).toHaveValue('T127 Shell')
    await phone.waitForTimeout(900)
    await phone.getByTestId('phone-rename-input').fill('not this')
    await tap(cdp, phone, '[data-testid="phone-rename-cancel"]')
    await expect(phone.getByTestId('phone-row-rename')).toHaveCount(0)
    await expect(phone.locator(shellRow)).toContainText('T127 Shell')

    // a finger that moves is a scroll: no editor
    await press(cdp, phone, await centre(phone, otherRow), 800, 40)
    await phone.waitForTimeout(300)
    await expect(phone.getByTestId('phone-row-rename')).toHaveCount(0)

    // a tap still opens the session
    await tap(cdp, phone, otherRow)
    await expect(phone.getByTestId('phone-session-title')).toHaveText(NEW_NAME)
    await expect(phone.getByTestId('phone-row-rename')).toHaveCount(0)

    // a view-only device: the press renames nothing
    await page.locator('[title^="Settings"]').first().click()
    await page.getByTestId('settings-category-phone').click()
    await page.getByTestId('phone-pair-watch').click()
    const watchCode = (await page.getByTestId('phone-pair-code-mac').textContent())!.replace(/\D/g, '')
    const watcher = await openPhone(app, `${base}/?session=${SHELL}&view=terminal`, 't127-watch', false)
    await watcher.phone.getByTestId('phone-pair-code').fill(watchCode)
    await watcher.phone.getByTestId('phone-pair-submit').click()
    await expect(watcher.phone.getByTestId('phone-terminal')).toHaveAttribute('data-status', 'live', { timeout: 15_000 })
    await tap(watcher.cdp, watcher.phone, '[data-testid="phone-menu-button"]')
    await expect(watcher.phone.locator(otherRow)).toBeVisible()
    await press(watcher.cdp, watcher.phone, await centre(watcher.phone, otherRow), 800)
    await watcher.phone.waitForTimeout(500)
    await expect(watcher.phone.getByTestId('phone-row-rename')).toHaveCount(0)
    await expect(watcher.phone.getByTestId('phone-rename-input')).toHaveCount(0)
})
