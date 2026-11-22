import { test, expect, type CDPSession, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { closeApp, launchAppWithWorkspaces, type LaunchResult, resizeMainWindow } from './helpers'
import type { SessionRelation } from '../../src/shared/types'

/**
 * T153 — fb-1117 2nd round, the phone's session drawer (CDP touch 390×844, scale 3, let in as the Mac's owner).
 *
 *  7c4165af the drawer was one List: it now has the Mac's All sessions List · Tree switch. Tree is the
 *  sidebar's own forest (`sessionForestFor`, run in main over the sidebar's entries): the same rows in
 *  the same order at the same depths as the Mac's `data-tree-depth`, then «Not in a tree». The choice is
 *  this phone's (kept over a reload); the Mac's «Show Session Tree» off takes the switch away.
 *  f683eafe what a held press hid is now a ⋯ at the end of the row: Rename (the same rename — the Mac
 *  sidebar follows) and Memo when there is one. A tap elsewhere closes it. A view-only device has no ⋯.
 *  No end / delete (decision 0009).
 *
 * T153_SHOTS=<dir> + T153_LABEL save captures before the checks; T153_BEFORE=1 only takes them (the
 * old code: the review's «before» column).
 */

const BEFORE = process.env.T153_BEFORE === '1'
const LABEL = process.env.T153_LABEL ?? 'run'
const OWNER = 'owner-t153@example.com'
const PORT = 47953
const NEW_NAME = 'T153 ⋯ 메뉴로 바꾼 이름'

const CHIEF = 't153-chief-0-4000-8000-000000000001'
const LEAD_A = 't153-lead-a-4000-8000-000000000002'
const LEAD_B = 't153-lead-b-4000-8000-000000000003'
const WORKER = 't153-worker-4000-8000-000000000004'
const HELPER = 't153-helper-4000-8000-000000000005'
const TALK = 't153-talk-00-4000-8000-000000000006'
const LOOSE = 't153-loose-0-4000-8000-000000000007'
const HAND = 't153-hand-00-4000-8000-000000000008'
const SOLO = 't153-solo-00-4000-8000-000000000009'

// T63's seed: opened, connected, a hand-added pair (HAND under LOOSE) and a removed one (SOLO alone)
const RELATIONS: SessionRelation[] = [
    { from: CHIEF, to: LEAD_A, kind: 'opened', at: 1 },
    { from: CHIEF, to: LEAD_B, kind: 'opened', at: 2 },
    { from: LEAD_A, to: WORKER, kind: 'opened', at: 3 },
    { from: WORKER, to: HELPER, kind: 'connected', at: 4 },
    { from: CHIEF, to: TALK, kind: 'connected', at: 5 },
    { from: LOOSE, to: HAND, kind: 'manual', at: 6 },
    { from: LEAD_B, to: SOLO, kind: 'opened', at: 7, dismissed: true }
]

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
    const dir = process.env.T153_SHOTS
    if (!dir) return
    fs.mkdirSync(dir, { recursive: true })
    await page.waitForTimeout(400)
    await page.screenshot({ path: path.join(dir, `${name}-${LABEL}.png`) })
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

/** a short CDP touch on the middle of the element — a finger, not a mouse */
async function tap(cdp: CDPSession, page: Page, selector: string): Promise<void> {
    const box = await page.locator(selector).first().boundingBox()
    expect(box, selector).not.toBeNull()
    const at = { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [at] })
    await page.waitForTimeout(60)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
}

async function launch(memoOn: string | null = null): Promise<{ app: ElectronApplication; page: Page; base: string }> {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'climanager-t153-'))
    tempDirs.push(home)
    const chief = path.join(home, 'chief')
    const lab = path.join(home, 'lab')
    for (const dir of [chief, lab]) fs.mkdirSync(dir, { recursive: true })
    const statusFile = path.join(home, 'tailscale-status.json')
    fs.writeFileSync(statusFile, JSON.stringify({ BackendState: 'Running', Self: { UserID: 42, DNSName: 'mac.tail1234.ts.net.', TailscaleIPs: ['100.100.1.1'] }, User: { '42': { LoginName: OWNER } } }))
    const memo = (id: string) => (id === memoOn ? { memo: 'T153 memo line one', memoPages: ['T153 memo page two'] } : {})
    result = await launchAppWithWorkspaces(
        [
            { id: 'ws-chief', name: 'chief', path: chief, sessions: [
                { id: CHIEF, name: 'T153 chief', ...memo(CHIEF) }, { id: TALK, name: 'T153 talk' }, { id: LOOSE, name: 'T153 loose' }, { id: SOLO, name: 'T153 solo' }
            ] },
            { id: 'ws-lab', name: 'lab', path: lab, sessions: [
                { id: LEAD_A, name: 'T153 lead A' }, { id: LEAD_B, name: 'T153 lead B' }, { id: WORKER, name: 'T153 worker' },
                { id: HELPER, name: 'T153 helper' }, { id: HAND, name: 'T153 hand' }
            ] }
        ],
        {
            settings: { phone: { enabled: true, port: PORT }, showHomeWorkspace: false },
            config: { sessionRelations: RELATIONS },
            env: { CLIMANAGER_PHONE_TAILSCALE_STATUS: statusFile, CLIMANAGER_HOME: path.join(home, 'climanager') }
        }
    )
    const { app, page } = result
    await resizeMainWindow(app, 1280, 800)
    const state = await page.evaluate(() => window.api.getPhoneState())
    expect(state.running).toBe(true)
    return { app, page, base: `http://127.0.0.1:${state.port}` }
}

/** the phone's rows top to bottom: id and the depth its line carries (0 outside a tree) */
const phoneRows = (phone: Page) =>
    phone.locator('[data-testid="phone-session-row"]').evaluateAll((rows) =>
        rows.map((row) => ({ id: row.getAttribute('data-session-id'), depth: Number(row.closest('[data-tree-depth]')?.getAttribute('data-tree-depth') ?? 0) }))
    )

test('T153 phone list: Tree is the Mac sidebar\'s tree, kept on this phone, gone with the Mac\'s setting (7c4165af)', async () => {
    test.setTimeout(180_000)
    const { app, page, base } = await launch()
    // the Mac's Tree: what the phone must match
    await page.getByTestId('sidebar-view-toggle').click()
    await page.getByTestId('all-sessions-layout-tree').click()
    const macIds = (group: string) => page.locator(`[data-testid="${group}"] [data-session-item]`).evaluateAll((rows) => rows.map((r) => r.getAttribute('data-session-item')))
    await expect.poll(() => macIds('session-tree-rows')).toEqual([CHIEF, LEAD_A, WORKER, HELPER, LEAD_B, TALK, LOOSE, HAND])
    const macDepths = await page.locator('[data-testid="session-tree-rows"] [data-session-item]').evaluateAll((rows) => rows.map((r) => Number(r.getAttribute('data-tree-depth') ?? 0)))
    const macUnlinked = await macIds('session-tree-unlinked-rows')
    expect(macUnlinked).toEqual([SOLO])
    const macTree = [...(await macIds('session-tree-rows')).map((id, i) => ({ id, depth: macDepths[i] })), ...macUnlinked.map((id) => ({ id, depth: 0 }))]

    const { phone, cdp } = await openPhone(app, `${base}/`, 't153-tree')
    await expect(phone.locator(`[data-testid="phone-session-row"][data-session-id="${HELPER}"]`)).toBeVisible({ timeout: 15_000 })
    await shot(phone, 'E-list-390')
    if (BEFORE) return

    // List first (the phone's default), then Tree
    await expect(phone.getByTestId('phone-layout-list')).toHaveAttribute('aria-pressed', 'true')
    await tap(cdp, phone, '[data-testid="phone-layout-tree"]')
    await expect(phone.getByTestId('phone-layout-tree')).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(() => phoneRows(phone)).toEqual(macTree)
    await expect(phone.getByTestId('phone-list-folder').filter({ hasText: 'Not in a tree' })).toHaveCount(1)
    // deeper reads further right, by its depth
    const left = async (id: string) => (await phone.locator(`[data-testid="phone-session-row"][data-session-id="${id}"]`).boundingBox())!.x
    expect(await left(LEAD_A)).toBeGreaterThan(await left(CHIEF))
    expect(await left(WORKER)).toBeGreaterThan(await left(LEAD_A))
    expect(await left(HELPER)).toBeGreaterThan(await left(WORKER))
    expect(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no sideways scroll').toBe(true)
    await shot(phone, 'E-tree-390')

    // kept on this phone across a reload
    await phone.reload()
    await expect(phone.getByTestId('phone-layout-tree')).toHaveAttribute('aria-pressed', 'true', { timeout: 15_000 })
    await expect.poll(() => phoneRows(phone)).toEqual(macTree)
    // a tap on a Tree row still opens that session
    await tap(cdp, phone, `[data-testid="phone-session-row"][data-session-id="${WORKER}"]`)
    await expect(phone.getByTestId('phone-session-title')).toHaveText('T153 worker')

    // the Mac's «Show Session Tree» off: no switch on the phone, the Mac's List order
    await page.locator('button[title^="Settings"]').first().click()
    await page.getByTestId('settings-category-sidebar').click()
    await page.getByTestId('settings-show-session-tree').click()
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByTestId('all-sessions-layout-tree')).toHaveCount(0, { timeout: 15_000 })
    await tap(cdp, phone, '[data-testid="phone-menu-button"]')
    await expect(phone.getByTestId('phone-list-layout')).toHaveCount(0, { timeout: 10_000 })
    await expect(phone.locator('.phone-list-order')).toHaveText('Mac order')
    expect((await phoneRows(phone)).every((row) => row.depth === 0), 'flat rows').toBe(true)
})

test('T153 phone list: ⋯ opens Rename (the Mac follows) and Memo; a view-only device has none (f683eafe)', async () => {
    test.setTimeout(180_000)
    const { app, page, base } = await launch(CHIEF)
    const { phone, cdp } = await openPhone(app, `${base}/`, 't153-menu')
    const row = (id: string) => `[data-testid="phone-session-row"][data-session-id="${id}"]`
    const more = (id: string) => `[data-testid="phone-row-more"][data-session-id="${id}"]`
    await expect(phone.locator(row(CHIEF))).toBeVisible({ timeout: 15_000 })
    await shot(phone, 'E-row-390')
    if (BEFORE) return

    // ⋯ on every row, inside the screen
    await expect(phone.locator('[data-testid="phone-row-more"]')).toHaveCount(9)
    const moreBox = (await phone.locator(more(CHIEF)).boundingBox())!
    expect(moreBox.x + moreBox.width).toBeLessThanOrEqual(390)
    expect(moreBox.height).toBeGreaterThanOrEqual(40)

    // the memo session: Rename and Memo — no end, no delete
    await tap(cdp, phone, more(CHIEF))
    const menu = phone.locator(`[data-testid="phone-row-menu"][data-session-id="${CHIEF}"]`)
    await expect(menu).toBeVisible()
    await expect(menu.getByRole('menuitem')).toHaveText(['Rename', 'Memo'])
    const menuBox = (await menu.boundingBox())!
    expect(menuBox.x + menuBox.width, 'menu inside the screen').toBeLessThanOrEqual(390)
    await shot(phone, 'E-menu-390')
    // a tap elsewhere closes it, and opens nothing
    await tap(cdp, phone, '.phone-list-title')
    await expect(menu).toHaveCount(0)
    await expect(phone.getByTestId('phone-session-title')).toHaveCount(0)

    // Memo: the memo over the drawer, read-only, first page
    await tap(cdp, phone, more(CHIEF))
    await tap(cdp, phone, '[data-testid="phone-row-menu-memo"]')
    await expect(phone.getByTestId('phone-memo-panel')).toBeVisible()
    await expect(phone.getByTestId('phone-memo-text')).toHaveText('T153 memo line one')
    await expect(phone.getByTestId('phone-memo-page')).toHaveText('1 / 2')
    await shot(phone, 'E-memo-390')
    await tap(cdp, phone, '[data-testid="phone-memo-close"]')
    await expect(phone.getByTestId('phone-memo-panel')).toHaveCount(0)

    // a session without a memo: Rename only
    await tap(cdp, phone, more(TALK))
    await expect(phone.locator(`[data-testid="phone-row-menu"][data-session-id="${TALK}"]`).getByRole('menuitem')).toHaveText(['Rename'])

    // Rename: the same editor as the held press; the Mac sidebar and the store follow
    await tap(cdp, phone, '[data-testid="phone-row-menu-rename"]')
    await expect(phone.getByTestId('phone-rename-input')).toHaveValue('T153 talk')
    await expect(phone.locator(more(TALK)), 'no ⋯ while renaming').toHaveCount(0)
    await phone.getByTestId('phone-rename-input').fill(NEW_NAME)
    await tap(cdp, phone, '[data-testid="phone-rename-save"]')
    await expect(phone.locator(row(TALK))).toContainText(NEW_NAME)
    await expect(page.locator(`[data-session-item="${TALK}"]`).first()).toContainText(NEW_NAME, { timeout: 10_000 })
    const stored = await page.evaluate(async (id) => (await window.api.getWorkspaces()).flatMap((w: { sessions: Array<{ id: string; name: string }> }) => w.sessions).find((s) => s.id === id)?.name, TALK)
    expect(stored).toBe(NEW_NAME)

    // a view-only device: no ⋯ at all
    await page.locator('[title^="Settings"]').first().click()
    await page.getByTestId('settings-category-phone').click()
    await page.getByTestId('phone-pair-watch').click()
    const watchCode = (await page.getByTestId('phone-pair-code-mac').textContent())!.replace(/\D/g, '')
    const watcher = await openPhone(app, `${base}/`, 't153-watch', false)
    await watcher.phone.getByTestId('phone-pair-code').fill(watchCode)
    await watcher.phone.getByTestId('phone-pair-submit').click()
    await expect(watcher.phone.locator(row(CHIEF))).toBeVisible({ timeout: 15_000 })
    await expect(watcher.phone.locator('[data-testid="phone-row-more"]')).toHaveCount(0)
})
