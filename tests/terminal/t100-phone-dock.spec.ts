import { test, expect, type CDPSession, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'fs'
import net from 'net'
import os from 'os'
import path from 'path'
import { closeApp, launchAppWithWorkspaces, LaunchResult, REPO_ROOT, resizeMainWindow, waitForBufferText } from './helpers'

/**
 * T100 — the phone's Dock panel against the real app and phone server, with a fake `dock.sock` on the far
 * side (the extension itself is covered in artifact-dock tests/dock-list.e2e.mjs). Touch phone: CDP 390×844,
 * scale 3, let in as the owner the way `tailscale serve` does it.
 *
 * The person asked to see the Dock with its order, so the checks are about exactly that: a reply that is not
 * in time order is drawn as it came, the panel opens over the chat and closing it leaves the chat where it
 * was, and looking never touches the Mac's window (no resize, nothing but one fixed request on the socket).
 *
 * T100_SHOTS=<dir> + T100_LABEL saves captures before the checks.
 */

const CLAUDE = 't100-claude'
const CLAUDE_ID = '00000000-0000-4000-8000-00000000c100'
const SHELL = 't100-shell'
const OWNER = 'owner-t100@example.com'
const PORT = 47900
const DPR = 3
const MOCK = path.join(REPO_ROOT, 'scripts/mock-cli/chat-mock.cjs')
const LABEL = process.env.T100_LABEL ?? 'run'

const fileRow = (name: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    key: `file:/Users/me/plan/${name}.html`,
    url: `file:///Users/me/plan/${name}.html`,
    title: name,
    sub: '~/plan',
    at: 100,
    pinned: false,
    missing: false,
    ...extra
})

// not newest first, on purpose: a sort anywhere on the way would show up
const OPEN_ROWS = [
    fileRow('Phone feature plan', { pinned: true, at: 10, sessionId: CLAUDE }),
    fileRow('Newest report', { at: 900, sessionId: SHELL, sub: '~/Downloads/_batches/plan-phone-design-1107/d2-dock/review/a-rather-long-folder' }),
    fileRow('Oldest report', { at: 1, sessionId: 'closed-session' }),
    { ...fileRow('Artifact page', { at: 50 }), key: 'artifact:abc', url: 'https://claude.ai/code/artifact/abc', sub: 'Claude artifact' }
]
const CLOSED_ROWS = [fileRow('Old report', { missing: true, at: 3 }), fileRow('Older page', { at: 2 })]
const listReply = (open: unknown[] = OPEN_ROWS, closed: unknown[] = CLOSED_ROWS): string =>
    `${JSON.stringify({ id: 'x', ok: true, protocol: 1, extVersion: '0.7.0', missingSupported: true, open, closed })}\n`

interface FakeDock {
    file: string
    connections(): number
    received(): string[]
    setReply(reply: string | null): void
    stop(): Promise<void>
    start(): Promise<void>
}

function fakeDock(): FakeDock {
    const file = path.join('/tmp', `t100-${process.pid}.sock`)
    let reply: string | null = listReply()
    let count = 0
    const received: string[] = []
    let server: net.Server | null = null
    const live = new Set<net.Socket>()
    const start = (): Promise<void> =>
        new Promise((resolve) => {
            fs.rmSync(file, { force: true })
            server = net.createServer((socket) => {
                count++
                live.add(socket)
                socket.on('close', () => live.delete(socket))
                socket.on('error', () => undefined)
                socket.on('data', (chunk) => {
                    received.push(chunk.toString('utf8'))
                    if (reply !== null) socket.write(reply)
                })
            })
            server.listen(file, resolve)
        })
    const stop = (): Promise<void> =>
        new Promise((resolve) => {
            for (const socket of live) socket.destroy()
            if (!server) return resolve()
            server.close(() => resolve())
            server = null
        })
    return { file, connections: () => count, received: () => received, setReply: (next) => (reply = next), stop, start }
}

let result: LaunchResult | null = null
let dock: FakeDock | null = null
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
    if (dock) {
        await dock.stop()
        fs.rmSync(dock.file, { force: true })
    }
    dock = null
})

async function shot(page: Page, name: string): Promise<void> {
    const dir = process.env.T100_SHOTS
    if (!dir) return
    fs.mkdirSync(dir, { recursive: true })
    await page.waitForTimeout(400)
    await page.screenshot({ path: path.join(dir, `${name}-${LABEL}.png`) })
}

async function launch(options: { socket: string | null }): Promise<{ app: ElectronApplication; page: Page; base: string }> {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'climanager-t100-'))
    const project = path.join(home, 'project')
    fs.mkdirSync(project, { recursive: true })
    const statusFile = path.join(home, 'tailscale-status.json')
    fs.writeFileSync(statusFile, JSON.stringify({ BackendState: 'Running', Self: { UserID: 42, DNSName: 'mac.tail1234.ts.net.', TailscaleIPs: ['100.100.1.1'] }, User: { '42': { LoginName: OWNER } } }))
    const transcript = path.join(home, 'claude', 'projects', 'x', `${CLAUDE_ID}.jsonl`)
    fs.mkdirSync(path.dirname(transcript), { recursive: true })
    fs.writeFileSync(transcript, '')
    result = await launchAppWithWorkspaces(
        [{
            id: 'w-t100',
            name: 'T100 project',
            path: project,
            sessions: [
                { id: CLAUDE, name: 'T100 Claude', cliSessionId: CLAUDE_ID, cliToolName: 'claude', cliCommand: `node ${MOCK} --transcript ${transcript} --work-ms 50` },
                { id: SHELL, name: 'T100 Shell' }
            ]
        }],
        {
            settings: { phone: { enabled: true, port: PORT } },
            env: {
                CLIMANAGER_PHONE_TAILSCALE_STATUS: statusFile,
                CLAUDE_CONFIG_DIR: path.join(home, 'claude'),
                ...(options.socket ? { ARTIFACT_DOCK_SOCKET: options.socket } : {})
            }
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

const rowTitles = (panel: ReturnType<Page['getByTestId']>, section: 'open' | 'closed'): Promise<string[]> =>
    panel.locator(`[data-dock-section="${section}"] [data-testid="phone-dock-title"]`).allTextContents()

const macPtySize = (page: Page, id: string): Promise<{ cols: number; rows: number } | null> =>
    page.evaluate((sessionId) => window.api.feedbackTerminalContext(sessionId).then((c) => c.terminal?.size ?? null), id)
const macResizeEvents = (page: Page, id: string): Promise<number> =>
    page.evaluate((sessionId) => window.api.feedbackTerminalContext(sessionId).then((c) => (c.terminal?.events ?? []).filter((e) => e.kind === 'resized').length), id)

test('T100 ☰ → Dock over the chat: the Mac\'s order, then back to the same place', async () => {
    test.setTimeout(180_000)
    dock = fakeDock()
    await dock.start()
    const { app, page, base } = await launch({ socket: dock.file })
    const { phone, cdp } = await openPhone(app, `${base}/?session=${CLAUDE}&view=chat`, 't100-main')
    const box = phone.getByTestId('chat-composer')
    await expect(box).toBeVisible({ timeout: 15_000 })

    // enough chat to scroll, and text in the box: both must survive the panel
    for (let turn = 1; turn <= 3; turn++) {
        await box.fill('TABLE')
        await phone.getByTestId('chat-send').click()
        await waitForBufferText(page, CLAUDE, `ANSWER[${turn}]: TABLE`, 15_000)
    }
    const scroller = phone.getByTestId('chat-scroll')
    await expect.poll(() => scroller.evaluate((el) => el.scrollHeight - el.clientHeight), { timeout: 15_000 }).toBeGreaterThan(300)
    await scroller.evaluate((el) => {
        el.scrollTop = 200
        el.dispatchEvent(new Event('scroll'))
    })
    await box.fill('half a thought')
    await scroller.evaluate((el) => ((el as HTMLElement & { __t100?: boolean }).__t100 = true))
    const scrollBefore = await scroller.evaluate((el) => el.scrollTop)
    const sizeBefore = await macPtySize(page, CLAUDE)

    await tap(cdp, phone, '[data-testid="phone-menu-button"]')
    await expect(phone.getByTestId('phone-sidebar')).toBeVisible()
    await shot(phone, 't100-drawer-390')
    const entry = phone.getByTestId('phone-dock-entry')
    await expect(entry).toBeVisible()

    const urlBefore = phone.url()
    await tap(cdp, phone, '[data-testid="phone-dock-entry"]')
    const panel = phone.getByTestId('phone-dock-panel')
    await expect(panel).toBeVisible()
    await expect(phone.getByTestId('phone-sidebar'), 'the drawer closed behind it').toHaveCount(0)
    expect(new URL(phone.url()).searchParams.get('panel')).toBe('dock')

    // the order as it came — pinned first because the extension said so, and no sort by time here
    await expect.poll(() => rowTitles(panel, 'open')).toEqual(['Phone feature plan', 'Newest report', 'Oldest report', 'Artifact page'])
    expect(await rowTitles(panel, 'closed')).toEqual(['Old report', 'Older page'])
    await expect(panel.locator('[data-dock-section="open"] [data-testid="phone-dock-section-title"]')).toHaveText('Open 4')
    await expect(panel.getByTestId('phone-dock-status')).toHaveCount(0)
    await shot(phone, 't100-panel-390')

    const row = (title: string) => panel.getByTestId('phone-dock-row').filter({ hasText: title })
    await expect(row('Phone feature plan')).toHaveAttribute('data-pinned', 'true')
    await expect(row('Old report')).toHaveAttribute('data-missing', 'true')
    await expect(row('Old report')).toContainText('Deleted')
    await expect(row('Phone feature plan').getByTestId('phone-dock-session')).toHaveText('T100 Claude')
    await expect(row('Oldest report').getByTestId('phone-dock-session-gone')).toBeVisible()
    await expect(row('Artifact page').locator('a')).toHaveAttribute('href', 'https://claude.ai/code/artifact/abc')
    await expect(row('Artifact page').locator('a')).toHaveAttribute('rel', /noopener/)

    // nothing to change anything on the Mac: no pin, close, reload or «this window» controls
    await expect(panel.getByRole('button', { name: /^(pin|unpin|close tab|reload|this window|move here)$/i })).toHaveCount(0)

    // a long folder name fits the row: tapping shows all of it, the panel does not scroll sideways
    await tap(cdp, phone, '[data-testid="phone-dock-row"]:has-text("Newest report") [data-testid="phone-dock-row-body"]')
    await expect(row('Newest report')).toHaveAttribute('data-expanded', 'true')
    await shot(phone, 't100-panel-expanded-390')
    expect(await panel.evaluate((el) => el.scrollWidth <= el.clientWidth), 'no sideways scroll').toBe(true)

    // ✕: the panel goes, and the chat is the same chat in the same place
    await tap(cdp, phone, '[data-testid="phone-dock-close"]')
    await expect(panel).toHaveCount(0)
    expect(new URL(phone.url()).searchParams.get('panel')).toBeNull()
    expect(phone.url()).toBe(urlBefore)
    expect(await scroller.evaluate((el) => (el as HTMLElement & { __t100?: boolean }).__t100), 'the same DOM node').toBe(true)
    expect(await scroller.evaluate((el) => el.scrollTop)).toBe(scrollBefore)
    await expect(box).toHaveValue('half a thought')

    // the browser's back closes it too, not the session
    await tap(cdp, phone, '[data-testid="phone-menu-button"]')
    await tap(cdp, phone, '[data-testid="phone-dock-entry"]')
    await expect(panel).toBeVisible()
    await phone.goBack()
    await expect(panel).toHaveCount(0)
    await expect(phone.getByTestId('phone-session')).toBeVisible()
    expect(await scroller.evaluate((el) => (el as HTMLElement & { __t100?: boolean }).__t100)).toBe(true)
    expect(await scroller.evaluate((el) => el.scrollTop)).toBe(scrollBefore)
    await expect(box).toHaveValue('half a thought')

    // looking at it changed nothing on the Mac
    expect(await macPtySize(page, CLAUDE)).toEqual(sizeBefore)
    expect(await macResizeEvents(page, CLAUDE)).toBe(0)
    expect(dock.received().length).toBeGreaterThan(0)
    expect(dock.received().every((sent) => sent === '{"cmd":"list","v":1}\n'), 'only the one fixed request').toBe(true)
})

test('T100 a session name goes to that session; back returns to where the panel was opened', async () => {
    test.setTimeout(180_000)
    dock = fakeDock()
    await dock.start()
    const { app, base } = await launch({ socket: dock.file })
    const { phone, cdp } = await openPhone(app, `${base}/?session=${CLAUDE}&view=chat`, 't100-go')
    await expect(phone.getByTestId('chat-composer')).toBeVisible({ timeout: 15_000 })
    await tap(cdp, phone, '[data-testid="phone-menu-button"]')
    await tap(cdp, phone, '[data-testid="phone-dock-entry"]')
    const panel = phone.getByTestId('phone-dock-panel')
    await expect(panel.getByTestId('phone-dock-session').first()).toBeVisible()

    await tap(cdp, phone, '[data-testid="phone-dock-row"]:has-text("Newest report") [data-testid="phone-dock-session"]')
    await expect(panel).toHaveCount(0)
    await expect.poll(() => new URL(phone.url()).searchParams.get('session')).toBe(SHELL)
    expect(new URL(phone.url()).searchParams.get('panel')).toBeNull()
    await expect(phone.getByTestId('phone-session')).toBeVisible()

    await phone.goBack()
    await expect.poll(() => new URL(phone.url()).searchParams.get('session')).toBe(CLAUDE)
    expect(new URL(phone.url()).searchParams.get('panel'), 'the panel is not reopened by back').toBeNull()
    await expect(panel).toHaveCount(0)
})

test('T100 the panel opens from the bare list too, and the left-edge swipe stays out of it', async () => {
    test.setTimeout(180_000)
    dock = fakeDock()
    await dock.start()
    const { app, base } = await launch({ socket: dock.file })
    const { phone, cdp } = await openPhone(app, `${base}/`, 't100-list')
    await expect(phone.getByTestId('phone-dock-entry')).toBeVisible({ timeout: 15_000 })
    await tap(cdp, phone, '[data-testid="phone-dock-entry"]')
    const panel = phone.getByTestId('phone-dock-panel')
    await expect(panel).toBeVisible()
    await phone.reload()
    await expect(panel, 'a reload keeps it open').toBeVisible({ timeout: 15_000 })
    // arriving at the panel's address directly: no entry of ours behind it, and ✕ must not leave the page
    await phone.goto(`${base}/?panel=dock`)
    await expect(panel).toBeVisible({ timeout: 15_000 })
    await tap(cdp, phone, '[data-testid="phone-dock-close"]')
    await expect(panel).toHaveCount(0)
    await expect(phone.getByTestId('phone-session-list')).toBeVisible()
    expect(new URL(phone.url()).searchParams.get('panel')).toBeNull()

    // the swipe that opens the drawer from a session is off while the panel is up
    await phone.goto(`${base}/?session=${CLAUDE}&view=chat`)
    await expect(phone.getByTestId('chat-composer')).toBeVisible({ timeout: 15_000 })
    await tap(cdp, phone, '[data-testid="phone-menu-button"]')
    await tap(cdp, phone, '[data-testid="phone-dock-entry"]')
    await expect(panel).toBeVisible()
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 6, y: 400 }] })
    await phone.waitForTimeout(30)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 120, y: 402 }] })
    await phone.waitForTimeout(30)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await phone.waitForTimeout(200)
    await expect(phone.getByTestId('phone-sidebar')).toHaveCount(0)
})

test('T100 on a wide screen the list stays beside the panel', async () => {
    test.setTimeout(180_000)
    dock = fakeDock()
    await dock.start()
    const { app, base } = await launch({ socket: dock.file })
    const { phone, cdp } = await openPhone(app, `${base}/?session=${CLAUDE}&view=chat`, 't100-wide')
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 768, deviceScaleFactor: 1, mobile: false })
    await expect(phone.getByTestId('phone-dock-entry')).toBeVisible({ timeout: 15_000 })
    await phone.getByTestId('phone-dock-entry').click()
    const panel = phone.getByTestId('phone-dock-panel')
    await expect.poll(() => rowTitles(panel, 'open')).toContain('Newest report')
    await shot(phone, 't100-panel-1024')
    const sidebar = (await phone.getByTestId('phone-sidebar').boundingBox())!
    const box = (await panel.boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(sidebar.x + sidebar.width - 1)
    expect(box.x + box.width).toBeLessThanOrEqual(1024)
    await expect(phone.getByTestId('phone-session-list')).toBeVisible()
})

test('T100 Chrome off, an old extension, a broken answer: the band says so and the last list stays', async () => {
    test.setTimeout(240_000)
    dock = fakeDock()
    await dock.start()
    const { app, base } = await launch({ socket: dock.file })
    const { phone, cdp } = await openPhone(app, `${base}/?session=${CLAUDE}&view=chat`, 't100-states')
    await expect(phone.getByTestId('chat-composer')).toBeVisible({ timeout: 15_000 })
    await tap(cdp, phone, '[data-testid="phone-menu-button"]')
    await tap(cdp, phone, '[data-testid="phone-dock-entry"]')
    const panel = phone.getByTestId('phone-dock-panel')
    await expect.poll(() => rowTitles(panel, 'open')).toContain('Newest report')

    // while it polls, the list keeps its place and the same nodes
    const list = phone.getByTestId('phone-dock-list')
    await list.evaluate((el) => {
        el.style.minHeight = '0'
        el.scrollTop = 30
    })
    const scrollTop = await list.evaluate((el) => el.scrollTop)
    await panel.getByTestId('phone-dock-row').first().evaluate((el) => ((el as HTMLElement & { __t100?: boolean }).__t100 = true))
    const seen = dock.connections()
    await expect.poll(() => dock!.connections(), { timeout: 15_000 }).toBeGreaterThan(seen)
    expect(await list.evaluate((el) => el.scrollTop)).toBe(scrollTop)
    expect(await panel.getByTestId('phone-dock-row').first().evaluate((el) => (el as HTMLElement & { __t100?: boolean }).__t100)).toBe(true)

    // Chrome off
    await dock.stop()
    fs.rmSync(dock.file, { force: true })
    const status = panel.getByTestId('phone-dock-status')
    await expect(status).toHaveAttribute('data-status', 'chrome_off', { timeout: 15_000 })
    await expect(status).toContainText(/Chrome is off · list from \d/)
    await expect.poll(() => rowTitles(panel, 'open')).toContain('Newest report')
    await shot(phone, 't100-chrome-off-390')

    // a broken answer
    dock.setReply('{oops\n')
    await dock.start()
    await expect(status).toHaveAttribute('data-status', 'error', { timeout: 15_000 })
    await expect(status).toHaveText('Could not read the Dock list.')
    await expect.poll(() => rowTitles(panel, 'open')).toContain('Newest report')

    // an old extension takes the request and never answers
    dock.setReply(null)
    await expect(status).toHaveAttribute('data-status', 'outdated', { timeout: 15_000 })
    await expect(status).toContainText('It may be older than 0.7.0')
    await shot(phone, 't100-outdated-390')

    // closed: no more polling
    await tap(cdp, phone, '[data-testid="phone-dock-close"]')
    await expect(panel).toHaveCount(0)
})

test('T100 no list yet with Chrome off says what to do; polling stops when the panel closes', async () => {
    test.setTimeout(180_000)
    dock = fakeDock()
    // the socket file is not there: the env says the Dock is installed, Chrome is simply off
    const { app, base } = await launch({ socket: dock.file })
    const { phone, cdp } = await openPhone(app, `${base}/?session=${CLAUDE}&view=chat`, 't100-empty')
    await expect(phone.getByTestId('chat-composer')).toBeVisible({ timeout: 15_000 })
    await tap(cdp, phone, '[data-testid="phone-menu-button"]')
    await tap(cdp, phone, '[data-testid="phone-dock-entry"]')
    const panel = phone.getByTestId('phone-dock-panel')
    await expect(panel.getByTestId('phone-dock-status')).toHaveAttribute('data-status', 'chrome_off', { timeout: 15_000 })
    await expect(panel).toContainText('Open Chrome on the Mac to see the list.')
    await shot(phone, 't100-chrome-off-empty-390')

    await tap(cdp, phone, '[data-testid="phone-dock-close"]')
    await expect(panel).toHaveCount(0)
    await dock.start()
    await phone.waitForTimeout(6_000)
    expect(dock.connections(), 'the socket is only asked while the panel is open').toBe(0)
})

test('T100 no Dock on this Mac: no line in the drawer at all', async () => {
    test.setTimeout(180_000)
    // test mode without ARTIFACT_DOCK_SOCKET: the real socket is never opened (/me says no Dock)
    const { app, base } = await launch({ socket: null })
    const { phone, cdp } = await openPhone(app, `${base}/?session=${CLAUDE}&view=chat`, 't100-none')
    await expect(phone.getByTestId('chat-composer')).toBeVisible({ timeout: 15_000 })
    await tap(cdp, phone, '[data-testid="phone-menu-button"]')
    await expect(phone.getByTestId('phone-sidebar')).toBeVisible()
    await expect(phone.getByTestId('phone-session-list')).toBeVisible()
    await expect(phone.getByTestId('phone-dock-entry')).toHaveCount(0)
    // an old address with the panel in it opens nothing
    await phone.goto(`${base}/?session=${CLAUDE}&view=chat&panel=dock`)
    await expect(phone.getByTestId('chat-composer')).toBeVisible({ timeout: 15_000 })
    await expect(phone.getByTestId('phone-dock-panel')).toHaveCount(0)
    const status = await phone.evaluate(() => fetch('/api/phone/dock').then((r) => r.status))
    expect(status).toBe(404)
})
