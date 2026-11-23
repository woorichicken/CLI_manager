import { test, expect, type CDPSession, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { closeApp, launchAppWithWorkspaces, type LaunchResult, resizeMainWindow } from './helpers'
import { PhoneDevices } from '../../src/main/phone/PhoneDevices'
import { PhoneServer } from '../../src/main/phone/PhoneServer'

/**
 * T165 — f683eafe round 2 (person, 11-23: 「나는 넣었으면 좋겠고」): the phone's row ⋯ menu ends a session.
 *
 *  Unit (a real PhoneServer, devices paired in a temp folder): POST /api/phone/end/<id> — a view-only
 *  device 403 (nothing ended), no cookie or a revoked device 401, an unknown or broken id 404, a drive
 *  device 200 and the Mac's close is called once.
 *  App (CDP touch 390×844, scale 3, let in as the Mac's owner): ⋯ → End session → a sheet with the
 *  session's name, Cancel focused; Cancel keeps it; End closes it on the Mac the way the sidebar and the
 *  Control API do — gone from the Mac sidebar, config.json and its relations, and from the phone's list.
 *
 * T165_SHOTS=<dir> + T165_LABEL save captures before the checks (the old build's «before»).
 */

const LABEL = process.env.T165_LABEL ?? 'run'
const OWNER = 'owner-t165@example.com'
const ENDED = 't165-ended-0-4000-8000-000000000001'
const KEPT = 't165-kept-00-4000-8000-000000000002'

test.describe('T165 phone server: POST /api/phone/end/<id>', () => {
    let server: PhoneServer
    let base = ''
    let devices: PhoneDevices
    const ended: string[] = []
    const pairAs = (role: 'drive' | 'watch', label: string): { cookie: string; id: string } => {
        const { code } = devices.startPairing(role)
        const paired = devices.pair(code, label)
        if ('error' in paired) throw new Error(paired.error)
        return { cookie: `climanager_phone=${paired.token}`, id: paired.device.id }
    }
    const end = (id: string, cookie?: string) =>
        fetch(`${base}/api/phone/end/${id}`, { method: 'POST', headers: { ...(cookie ? { cookie } : {}), origin: base, 'content-type': 'application/json' }, body: '{}' })

    test.beforeAll(async () => {
        const data = fs.mkdtempSync(path.join(os.tmpdir(), 't165-server-'))
        devices = new PhoneDevices(path.join(data, 'devices.json'))
        server = new PhoneServer({
            devices,
            push: { forgetOwner: () => undefined, publicKey: () => 'key', keysProblem: () => null, count: () => 0, onStatus: () => undefined } as never,
            tailscale: { read: async () => ({ found: false, owner: null, dnsName: null }), peek: () => null } as never,
            staticDir: data,
            onStateChange: () => undefined,
            statusPoller: { start: () => undefined, stop: () => undefined },
            listSessions: () => ({ sessions: [] }) as never,
            sessionExists: (id: string) => id === 's1',
            conversation: {} as never,
            saveAttachment: () => ({ status: 'attached', path: '/tmp/x' }) as never,
            maskLine: (text: string) => text,
            recordPhoneInput: () => undefined,
            terminals: {} as never,
            subscribeConversation: () => () => undefined,
            endSession: (id: string) => {
                if (id !== 's1') return false
                ended.push(id)
                return true
            }
        } as never)
        const state = await server.apply({ enabled: true, port: 0 } as never)
        base = `http://127.0.0.1:${state.port}`
    })
    test.afterAll(() => server.stop())

    test('view-only 403, no cookie or revoked 401, unknown 404, drive ends it once', async () => {
        const watch = pairAs('watch', 'Watcher')
        const watchRes = await end('s1', watch.cookie)
        expect(watchRes.status).toBe(403)
        expect(((await watchRes.json()) as { error: string }).error).toBe('view_only')

        expect((await end('s1')).status).toBe(401)
        const gone = pairAs('drive', 'Lost phone')
        devices.revoke(gone.id)
        expect((await end('s1', gone.cookie)).status).toBe(401)

        const drive = pairAs('drive', 'Phone')
        expect((await end('nope', drive.cookie)).status).toBe(404)
        expect((await end('%E0%A4', drive.cookie)).status).toBe(404)
        // another site's page may not end anything
        const foreign = await fetch(`${base}/api/phone/end/s1`, { method: 'POST', headers: { cookie: drive.cookie, origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' })
        expect(foreign.status).toBe(403)
        expect(ended).toEqual([])

        const ok = await end('s1', drive.cookie)
        expect(ok.status).toBe(200)
        expect(await ok.json()).toEqual({ status: 'ended' })
        expect(ended).toEqual(['s1'])
    })
})

let result: LaunchResult | null = null
const tempDirs: string[] = []
test.afterEach(async () => {
    if (result) await closeApp(result)
    result = null
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

async function shot(page: Page, name: string): Promise<void> {
    const dir = process.env.T165_SHOTS
    if (!dir) return
    fs.mkdirSync(dir, { recursive: true })
    await page.waitForTimeout(400)
    await page.screenshot({ path: path.join(dir, `r2-${LABEL}-${name}.png`) })
}

/** a 390×844 touch phone let in as `tailscale serve` lets the Mac's owner in */
async function openPhone(app: ElectronApplication, url: string): Promise<{ phone: Page; cdp: CDPSession }> {
    const opened = app.waitForEvent('window')
    await app.evaluate(({ BrowserWindow, session }, o) => {
        const jar = session.fromPartition(o.partition)
        jar.webRequest.onBeforeSendHeaders((details, callback) => {
            callback({ requestHeaders: { ...details.requestHeaders, 'Tailscale-User-Login': o.owner, 'X-Forwarded-For': '100.101.102.103' } })
        })
        const win = new BrowserWindow({ width: 390, height: 844, useContentSize: true, show: false, webPreferences: { partition: o.partition, backgroundThrottling: false } })
        void win.loadURL(o.url)
    }, { url, partition: 't165-phone', owner: OWNER })
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

const storedIds = (userDataDir: string): string[] =>
    (JSON.parse(fs.readFileSync(path.join(userDataDir, 'config.json'), 'utf-8')).workspaces as Array<{ sessions: Array<{ id: string }> }>)
        .flatMap((w) => w.sessions.map((s) => s.id))
const storedRelations = (userDataDir: string): Array<{ from: string; to: string }> =>
    JSON.parse(fs.readFileSync(path.join(userDataDir, 'config.json'), 'utf-8')).sessionRelations ?? []

test('T165 app: ⋯ → End session → a sheet; Cancel keeps it, End closes it on the Mac', async () => {
    test.setTimeout(120_000)
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'climanager-t165-'))
    tempDirs.push(home)
    const project = path.join(home, 'project')
    fs.mkdirSync(project, { recursive: true })
    const statusFile = path.join(home, 'tailscale-status.json')
    fs.writeFileSync(statusFile, JSON.stringify({ BackendState: 'Running', Self: { UserID: 42, DNSName: 'mac.tail1234.ts.net.', TailscaleIPs: ['100.100.1.1'] }, User: { '42': { LoginName: OWNER } } }))
    result = await launchAppWithWorkspaces(
        [{ id: 'ws-t165', name: 'T165 project', path: project, sessions: [{ id: ENDED, name: 'T165 to end' }, { id: KEPT, name: 'T165 kept' }] }],
        {
            settings: { phone: { enabled: true, port: 0 }, showHomeWorkspace: false },
            config: { sessionRelations: [{ from: KEPT, to: ENDED, kind: 'opened', at: 1 }] },
            env: { CLIMANAGER_PHONE_TAILSCALE_STATUS: statusFile, CLIMANAGER_HOME: path.join(home, 'climanager') }
        }
    )
    const { app, page, userDataDir } = result
    await resizeMainWindow(app, 1280, 800)
    await expect.poll(() => page.evaluate(() => window.api.getPhoneState().then((s) => s.running)), { timeout: 15_000 }).toBe(true)
    const port = (await page.evaluate(() => window.api.getPhoneState())).port
    await expect(page.locator(`[data-session-item="${ENDED}"]`).first()).toBeVisible({ timeout: 15_000 })

    const { phone, cdp } = await openPhone(app, `http://127.0.0.1:${port}/`)
    const row = (id: string) => `[data-testid="phone-session-row"][data-session-id="${id}"]`
    const more = (id: string) => `[data-testid="phone-row-more"][data-session-id="${id}"]`
    await expect(phone.locator(row(ENDED))).toBeVisible({ timeout: 15_000 })
    await tap(cdp, phone, more(ENDED))
    const menu = phone.locator(`[data-testid="phone-row-menu"][data-session-id="${ENDED}"]`)
    await expect(menu).toBeVisible()
    await shot(phone, 'menu-390')

    // the menu has End session, last, apart from what only changes a label
    await expect(menu.getByRole('menuitem')).toHaveText(['Rename', 'End session'])
    await tap(cdp, phone, '[data-testid="phone-row-menu-end"]')
    const sheet = phone.getByTestId('phone-end-sheet')
    await expect(sheet).toBeVisible()
    await expect(sheet).toContainText('T165 to end')
    await expect(sheet).toContainText('The terminal closes and the session leaves the list.')
    await expect(phone.getByTestId('phone-end-cancel')).toBeFocused()
    const endButton = phone.getByTestId('phone-end-confirm')
    expect(await endButton.evaluate((el) => getComputedStyle(el).backgroundColor)).toMatch(/^rgb\((2[0-9]{2}), [0-9]{1,2}, [0-9]{1,2}\)$/)
    const box = (await sheet.boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(390)
    await shot(phone, 'sheet-390')

    // Cancel: nothing happens on the Mac
    await tap(cdp, phone, '[data-testid="phone-end-cancel"]')
    await expect(sheet).toHaveCount(0)
    await phone.waitForTimeout(500)
    expect(storedIds(userDataDir)).toEqual([ENDED, KEPT])
    await expect(page.locator(`[data-session-item="${ENDED}"]`).first()).toBeVisible()

    // End: closed on the Mac like the sidebar's delete — sidebar, store, relations; and the phone's list
    await tap(cdp, phone, more(ENDED))
    await tap(cdp, phone, '[data-testid="phone-row-menu-end"]')
    await tap(cdp, phone, '[data-testid="phone-end-confirm"]')
    await expect.poll(() => storedIds(userDataDir), { timeout: 10_000 }).toEqual([KEPT])
    expect(storedRelations(userDataDir)).toEqual([])
    await expect(page.locator(`[data-session-item="${ENDED}"]`)).toHaveCount(0, { timeout: 10_000 })
    await expect(page.locator(`[data-session-item="${KEPT}"]`).first()).toBeVisible()
    await expect(phone.locator(row(ENDED))).toHaveCount(0, { timeout: 10_000 })
    await expect(phone.locator(row(KEPT))).toBeVisible()
    await shot(phone, 'after-end-390')
})
