import { test, expect, type CDPSession, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { closeApp, launchAppWithWorkspaces, type LaunchResult, resizeMainWindow } from './helpers'
import { listLines, NO_FOLDER_PART, searchLines, type ListLine } from '../../src/renderer/src/phone/sessionListLines'
import type { PhoneSession, PhoneSessionsResponse } from '../../src/shared/phone'

/**
 * T173 — fb-1125 b61af757: the phone's session drawer folds its session folders, as the Mac sidebar does
 * (cbc0ee48). Unit: `listLines(data, folded)` hides a folded part's rows and pinned line but keeps its
 * heading with the count; «No folder» folds under `none`; search ignores folding. App (CDP touch 390×844,
 * scale 3, let in as the Mac's owner): a tap on a heading folds, the count stays, a reload keeps it, a
 * second tap unfolds, search still finds a folded folder's session.
 *
 * T173_SHOTS=<dir> + T173_LABEL save captures; T173_BEFORE=1 only takes them (the old code's «before»).
 */

const BEFORE = process.env.T173_BEFORE === '1'
const LABEL = process.env.T173_LABEL ?? 'run'
const OWNER = 'owner-t173@example.com'
const PORT = 47973

function session(id: string, folder?: string, extra: Partial<PhoneSession> = {}): PhoneSession {
    return { id, name: id, workspaceId: 'w', workspaceName: 'w', agent: null, state: 'idle', sessionFolderId: folder, ...extra }
}
const DATA: PhoneSessionsResponse = {
    sessions: [
        session('a1', 'fa', { pinned: true }), session('a2', 'fa'), session('a3', 'fa'),
        session('b1', 'fb'),
        session('n1', undefined, { pinned: true }), session('n2'),
        session('t1', 'fa', { thread: true })
    ],
    sessionFolders: [{ id: 'fa', name: 'Alpha' }, { id: 'fb', name: 'Beta' }]
}
const ids = (lines: ListLine[]) => lines.filter((l) => l.kind === 'row').map((l) => (l.kind === 'row' ? l.session.id : ''))
const headings = (lines: ListLine[]) => lines.flatMap((l) => (l.kind === 'folder' ? [{ title: l.title, count: l.count, collapsed: l.collapsed }] : []))

test('T173 unit: a folded part keeps its heading and count, loses its rows and pinned line (b61af757)', () => {
    const open = listLines(DATA)
    expect(ids(open)).toEqual(['a1', 'a2', 'a3', 'b1', 'n1', 'n2'])
    expect(headings(open)).toEqual([
        { title: 'Alpha', count: 3, collapsed: false },
        { title: 'Beta', count: 1, collapsed: false },
        { title: 'No folder', count: 2, collapsed: false }
    ])
    expect(open.filter((l) => l.kind === 'divider')).toHaveLength(2)

    const alphaFolded = listLines(DATA, new Set(['fa']))
    expect(ids(alphaFolded)).toEqual(['b1', 'n1', 'n2'])
    expect(headings(alphaFolded)[0]).toEqual({ title: 'Alpha', count: 3, collapsed: true })
    // Alpha's pinned line went with it; «No folder»'s stays
    expect(alphaFolded.filter((l) => l.kind === 'divider').map((l) => l.key)).toEqual(['divider-none'])

    const noneFolded = listLines(DATA, new Set([NO_FOLDER_PART]))
    expect(ids(noneFolded)).toEqual(['a1', 'a2', 'a3', 'b1'])
    expect(headings(noneFolded)[2]).toEqual({ title: 'No folder', count: 2, collapsed: true })

    const allFolded = listLines(DATA, new Set(['fa', 'fb', NO_FOLDER_PART]))
    expect(ids(allFolded)).toEqual([])
    expect(headings(allFolded).map((h) => h.collapsed)).toEqual([true, true, true])
    // a stale id (a folder since deleted) folds nothing
    expect(ids(listLines(DATA, new Set(['gone'])))).toEqual(ids(open))
    // without session folders there are no headings, so nothing to fold — «none» alone hides nothing
    expect(ids(listLines({ sessions: [session('x'), session('y')], sessionFolders: [] }, new Set([NO_FOLDER_PART])))).toEqual(['x', 'y'])
})

test('T173 unit: search finds a folded folder\'s session (b61af757)', () => {
    const found = searchLines(DATA, 'a2')
    expect(found && ids(found)).toEqual(['a2'])
})

let result: LaunchResult | null = null
const tempDirs: string[] = []
test.afterEach(async () => {
    if (result) {
        const done = result
        result = null
        const closed = await Promise.race([closeApp(done).then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 20_000))])
        if (!closed) {
            done.app.process().kill('SIGKILL')
            fs.rmSync(done.userDataDir, { recursive: true, force: true })
        }
    }
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

async function shot(page: Page, name: string): Promise<void> {
    const dir = process.env.T173_SHOTS
    if (!dir) return
    fs.mkdirSync(dir, { recursive: true })
    await page.waitForTimeout(400)
    await page.screenshot({ path: path.join(dir, `${name}-${LABEL}.png`) })
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
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true, screenOrientation: { type: 'portraitPrimary', angle: 0 } })
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
    await phone.reload()
    await phone.waitForLoadState('domcontentloaded')
    return { phone, cdp }
}

async function tap(cdp: CDPSession, page: Page, selector: string): Promise<void> {
    const box = await page.locator(selector).first().boundingBox()
    expect(box, selector).not.toBeNull()
    const at = { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [at] })
    await page.waitForTimeout(60)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
}

test('T173 phone: a tap on a folder heading folds its sessions, kept over a reload; search ignores it (b61af757)', async () => {
    test.setTimeout(180_000)
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'climanager-t173-'))
    tempDirs.push(home)
    const dir = path.join(home, 'ws')
    fs.mkdirSync(dir, { recursive: true })
    const statusFile = path.join(home, 'tailscale-status.json')
    fs.writeFileSync(statusFile, JSON.stringify({ BackendState: 'Running', Self: { UserID: 42, DNSName: 'mac.tail1234.ts.net.', TailscaleIPs: ['100.100.1.1'] }, User: { '42': { LoginName: OWNER } } }))
    result = await launchAppWithWorkspaces(
        [{ id: 'ws-1', name: 'lab173', path: dir, sessions: [
            { id: 't173-a1-0000-4000-8000-000000000001', name: 'T173 alpha one', sessionFolderId: 'sf-a' },
            { id: 't173-a2-0000-4000-8000-000000000002', name: 'T173 alpha two', sessionFolderId: 'sf-a' },
            { id: 't173-b1-0000-4000-8000-000000000003', name: 'T173 beta one', sessionFolderId: 'sf-b' },
            { id: 't173-n1-0000-4000-8000-000000000004', name: 'T173 loose one' },
            { id: 't173-n2-0000-4000-8000-000000000005', name: 'T173 loose two' }
        ] }],
        {
            settings: { phone: { enabled: true, port: PORT }, showHomeWorkspace: false },
            config: { sessionFolders: [{ id: 'sf-a', name: 'Alpha', isExpanded: true, createdAt: 1 }, { id: 'sf-b', name: 'Beta', isExpanded: true, createdAt: 2 }] },
            env: { CLIMANAGER_PHONE_TAILSCALE_STATUS: statusFile, CLIMANAGER_HOME: path.join(home, 'climanager') }
        }
    )
    const { app, page } = result
    await resizeMainWindow(app, 1280, 800)
    const state = await page.evaluate(() => window.api.getPhoneState())
    expect(state.running).toBe(true)
    const { phone, cdp } = await openPhone(app, `http://127.0.0.1:${state.port}/`, 't173')
    const rows = () => phone.locator('[data-testid="phone-session-row"]')
    await expect(rows()).toHaveCount(5, { timeout: 15_000 })
    await shot(phone, 'list-390')
    if (BEFORE) return

    const heading = (title: string) => phone.getByTestId('phone-list-folder').filter({ hasText: title })
    await expect(heading('Alpha')).toHaveAttribute('data-state', 'expanded')
    const box = await heading('Alpha').boundingBox()
    expect(box!.height, 'a finger-sized target').toBeGreaterThanOrEqual(44)

    await tap(cdp, phone, '[data-testid="phone-list-folder"][data-folder-id="sf-a"]')
    await expect(heading('Alpha')).toHaveAttribute('data-state', 'collapsed')
    await expect(heading('Alpha')).toHaveAttribute('aria-expanded', 'false')
    await expect(heading('Alpha')).toHaveAttribute('data-count', '2')
    await expect(rows()).toHaveCount(3)
    await expect(phone.getByText('T173 alpha one')).toHaveCount(0)
    // the count is drawn (CSS), the heading's words are not changed
    expect(await heading('Alpha').evaluate((el) => getComputedStyle(el, '::after').content)).toBe('"(2)"')
    await expect(heading('Alpha')).toHaveText('Alpha')
    await shot(phone, 'folded-390')

    // «No folder» folds the same way
    await tap(cdp, phone, '[data-testid="phone-list-folder"][data-folder-id=""]')
    await expect(rows()).toHaveCount(1)
    await expect(heading('No folder')).toHaveAttribute('data-count', '2')

    // kept on this phone across a reload
    await phone.reload()
    await expect(heading('Alpha')).toHaveAttribute('data-state', 'collapsed', { timeout: 15_000 })
    await expect(heading('No folder')).toHaveAttribute('data-state', 'collapsed')
    await expect(rows()).toHaveCount(1)
    expect(await phone.evaluate(() => JSON.parse(localStorage.getItem('phone-session-folders-collapsed') ?? '[]').sort())).toEqual(['none', 'sf-a'])

    // search is not folding: it finds a folded folder's session, and the list comes back folded
    await tap(cdp, phone, '[data-testid="phone-list-search-toggle"]')
    await phone.getByTestId('phone-list-search').fill('alpha one')
    await expect(rows()).toHaveCount(1)
    await expect(phone.getByText('T173 alpha one')).toBeVisible()
    await tap(cdp, phone, '[data-testid="phone-list-search-toggle"]')
    await expect(rows()).toHaveCount(1)

    // a second tap unfolds; a row still opens its session
    await tap(cdp, phone, '[data-testid="phone-list-folder"][data-folder-id="sf-a"]')
    await expect(heading('Alpha')).toHaveAttribute('data-state', 'expanded')
    await expect(rows()).toHaveCount(3)
    await tap(cdp, phone, '[data-testid="phone-session-row"][data-session-id="t173-a1-0000-4000-8000-000000000001"]')
    await expect(phone.getByTestId('phone-session-title')).toHaveText('T173 alpha one')
    expect(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no sideways scroll').toBe(true)
})
