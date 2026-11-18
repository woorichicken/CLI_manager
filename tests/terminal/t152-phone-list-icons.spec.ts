import { test, expect, type CDPSession, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import zlib from 'zlib'
import { closeApp, launchAppWithWorkspaces, type LaunchResult, resizeMainWindow } from './helpers'
import { MAX_PHONE_LOGO_CHARS, phoneTemplateLogo } from '../../src/main/phone/templateLogos'

/**
 * T152 — fb-1117 2nd round, the phone's session drawer (CDP touch 390×844, scale 3, let in as the Mac's owner).
 *
 *  df190888 the drawer's head showed a generic laptop glyph: it now draws the app's own icon — the
 *  one phone.html already gives the home screen (`/phone/icon-180.png`), judged on a decoded image.
 *  59886f9c the phone row had only Chat / Terminal glyphs while the Mac sidebar row draws the
 *  template's logo, the AI robot and the master's crown. The phone row now draws the same mark in
 *  the same order (crown > logo > robot), the old glyph otherwise — a dangling template id included.
 *  A logo travels once per template in the list response, not once per row.
 *
 * T152_SHOTS=<dir> + T152_LABEL save captures before the checks; T152_BEFORE=1 only takes them (the
 * old code: the review's «before» column).
 */

const BEFORE = process.env.T152_BEFORE === '1'
const LABEL = process.env.T152_LABEL ?? 'run'
const OWNER = 'owner-t152@example.com'
const PORT = 47952
const TEMPLATE_ID = 't152-template'
const LOGO_A = 't152-logo-a'
const LOGO_B = 't152-logo-b'
const AI = 't152-ai'
const MASTER = 't152-master'
const PLAIN = 't152-plain'
const DANGLING = 't152-dangling'

/** A solid red 32×32 PNG data URL — what the template editor stores (T134), made here so the test owns its pixels. */
function redPngDataUrl(size = 32): string {
    const crcTable = (buf: Buffer): number => zlib.crc32(buf)
    const chunk = (type: string, data: Buffer): Buffer => {
        const len = Buffer.alloc(4)
        len.writeUInt32BE(data.length)
        const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
        const crc = Buffer.alloc(4)
        crc.writeUInt32BE(crcTable(body) >>> 0)
        return Buffer.concat([len, body, crc])
    }
    const header = Buffer.alloc(13)
    header.writeUInt32BE(size, 0)
    header.writeUInt32BE(size, 4)
    header[8] = 8 // bit depth
    header[9] = 6 // RGBA
    const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 4, Buffer.from([0xe0, 0x20, 0x20, 0xff]))])
    const raw = Buffer.concat(Array.from({ length: size }, () => row))
    const png = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', header),
        chunk('IDAT', zlib.deflateSync(raw)),
        chunk('IEND', Buffer.alloc(0))
    ])
    return `data:image/png;base64,${png.toString('base64')}`
}

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
    const dir = process.env.T152_SHOTS
    if (!dir) return
    fs.mkdirSync(dir, { recursive: true })
    await page.waitForTimeout(400)
    await page.screenshot({ path: path.join(dir, `${name}-${LABEL}.png`) })
}

/** a 390×844 touch phone let in as the Mac's owner (`tailscale serve`'s headers) */
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

/** The image really decoded: its natural size and the centre pixel, read through a canvas. */
const decoded = (page: Page, selector: string): Promise<{ w: number; h: number; rgba: number[] } | null> =>
    page.evaluate(async (sel) => {
        const img = document.querySelector(sel) as HTMLImageElement | null
        if (!img) return null
        if (!img.complete) await new Promise((resolve) => img.addEventListener('load', resolve, { once: true }))
        if (!img.naturalWidth) return { w: 0, h: 0, rgba: [] }
        const canvas = document.createElement('canvas')
        canvas.width = img.naturalWidth
        canvas.height = img.naturalHeight
        const ctx = canvas.getContext('2d')!
        ctx.drawImage(img, 0, 0)
        const px = ctx.getImageData(Math.floor(img.naturalWidth / 2), Math.floor(img.naturalHeight / 2), 1, 1).data
        return { w: img.naturalWidth, h: img.naturalHeight, rgba: [...px] }
    }, selector)

test.describe('T152 units', () => {
    test('phoneTemplateLogo: only a base64 PNG data URL up to the cap goes to the phone', () => {
        const good = redPngDataUrl()
        expect(phoneTemplateLogo(good)).toBe(good)
        const odd: unknown[] = [
            undefined,
            null,
            42,
            '',
            'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
            'data:image/png,not-base64',
            'javascript:alert(1)',
            'https://example.com/logo.png',
            `${good}" onerror="x`,
            `${good}\nmore`,
            'data:image/png;base64,' + 'A'.repeat(MAX_PHONE_LOGO_CHARS)
        ]
        for (const value of odd) expect(phoneTemplateLogo(value), String(value).slice(0, 40)).toBeUndefined()
        const atCap = 'data:image/png;base64,' + 'A'.repeat(MAX_PHONE_LOGO_CHARS - 'data:image/png;base64,'.length)
        expect(phoneTemplateLogo(atCap)).toBe(atCap)
    })
})

test('T152 phone drawer: the app logo in the head, and the Mac row icons on each session row (df190888 · 59886f9c)', async () => {
    test.setTimeout(180_000)
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'climanager-t152-'))
    tempDirs.push(home)
    const project = path.join(home, 'project')
    fs.mkdirSync(project, { recursive: true })
    const climanagerHome = path.join(home, 'climanager')
    fs.mkdirSync(climanagerHome, { recursive: true })
    const statusFile = path.join(home, 'tailscale-status.json')
    fs.writeFileSync(statusFile, JSON.stringify({ BackendState: 'Running', Self: { UserID: 42, DNSName: 'mac.tail1234.ts.net.', TailscaleIPs: ['100.100.1.1'] }, User: { '42': { LoginName: OWNER } } }))
    const logo = redPngDataUrl()
    const session = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id, name, cwd: project, type: 'regular', ...extra })
    result = await launchAppWithWorkspaces([{ id: 'w-t152', name: 'T152 project', path: project, sessions: [] }], {
        settings: { phone: { enabled: true, port: PORT }, controlApi: { enabled: true, port: 0 } },
        env: { CLIMANAGER_PHONE_TAILSCALE_STATUS: statusFile, CLIMANAGER_HOME: climanagerHome },
        config: {
            customTemplates: [{ id: TEMPLATE_ID, name: 'T152 Agent', icon: 'code', description: '', command: 'true', logo }],
            workspaces: [
                {
                    id: 'w-t152',
                    name: 'T152 project',
                    path: project,
                    createdAt: 1700000000000,
                    sessions: [
                        session(LOGO_A, 'T152 Logo A', { templateId: TEMPLATE_ID }),
                        session(LOGO_B, 'T152 Logo B', { templateId: TEMPLATE_ID }),
                        session(AI, 'T152 AI'),
                        session(MASTER, 'T152 Master'),
                        session(PLAIN, 'T152 Plain'),
                        session(DANGLING, 'T152 Dangling', { templateId: 'no-such-template' })
                    ]
                }
            ]
        }
    })
    const { app, page } = result
    await resizeMainWindow(app, 1280, 800)
    const state = await page.evaluate(() => window.api.getPhoneState())
    expect(state.running).toBe(true)
    const base = `http://127.0.0.1:${state.port}`

    // The Control API makes the AI session (a touch) and the master (it opens one) — as on the Mac
    const discoveryPath = path.join(climanagerHome, 'control-api.json')
    await expect.poll(() => fs.existsSync(discoveryPath), { timeout: 15_000 }).toBe(true)
    const discovery = JSON.parse(fs.readFileSync(discoveryPath, 'utf-8')) as { url: string; token: string }
    const api = async (method: string, route: string, body?: unknown, caller?: string): Promise<number> => {
        const res = await fetch(discovery.url + route, {
            method,
            headers: {
                Authorization: `Bearer ${discovery.token}`,
                'Content-Type': 'application/json',
                'X-Client-Name': 't152',
                ...(caller ? { 'X-Caller-Session': caller } : {})
            },
            body: body === undefined ? undefined : JSON.stringify(body)
        })
        await res.text()
        return res.status
    }
    await page.locator(`[data-session-item="${MASTER}"]`).first().waitFor({ timeout: 15_000 })
    expect(await api('POST', `/v1/sessions/${AI}/input`, { text: 'true' })).toBe(200)
    expect(await api('POST', '/v1/sessions', { path: project, name: 'T152 Child' }, MASTER)).toBe(200)
    // the Mac's own marks, the ones the phone must follow
    await expect(page.locator(`[data-session-item="${MASTER}"] [data-master-icon]`).first()).toBeVisible({ timeout: 10_000 })
    await expect(page.locator(`[data-session-item="${LOGO_A}"] img[data-template-logo]`).first()).toBeVisible()
    await expect(page.locator(`[data-session-item="${AI}"]`).first()).toHaveAttribute('data-session-role', 'ai')

    const { phone } = await openPhone(app, `${base}/`, 't152-phone')
    const row = (id: string) => phone.locator(`[data-testid="phone-session-row"][data-session-id="${id}"]`)
    await expect(row(LOGO_A)).toBeVisible({ timeout: 15_000 })
    await expect(row(MASTER)).toBeVisible()
    // the list polls every 3 s: the master mark has had time to arrive
    await phone.waitForTimeout(3_500)
    await shot(phone, 'E-drawer-390')
    if (BEFORE) return

    // df190888 — the head draws the app's icon, decoded, not the laptop glyph
    await expect(phone.locator('.phone-sidebar-head .lucide-laptop')).toHaveCount(0)
    const head = await decoded(phone, '[data-testid="phone-app-logo"]')
    expect(head, 'the head has an image').not.toBeNull()
    expect(head!.w, 'the app icon decoded').toBe(180)
    expect(head!.rgba[3], 'an opaque middle pixel').toBeGreaterThan(0)

    // 59886f9c — each row the Mac's mark, in the Mac's order
    await expect(row(MASTER).locator('[data-row-icon]')).toHaveAttribute('data-row-icon', 'master', { timeout: 10_000 })
    await expect(row(LOGO_A).locator('[data-row-icon]')).toHaveAttribute('data-row-icon', 'logo')
    await expect(row(LOGO_B).locator('[data-row-icon]')).toHaveAttribute('data-row-icon', 'logo')
    await expect(row(AI).locator('[data-row-icon]')).toHaveAttribute('data-row-icon', 'ai')
    await expect(row(PLAIN).locator('[data-row-icon]')).toHaveAttribute('data-row-icon', 'terminal')
    await expect(row(DANGLING).locator('[data-row-icon]'), 'a deleted template draws the plain icon').toHaveAttribute('data-row-icon', 'terminal')
    const logoPixel = await decoded(phone, `[data-testid="phone-session-row"][data-session-id="${LOGO_A}"] img[data-row-icon="logo"]`)
    expect(logoPixel?.w, 'the logo decoded at its stored size').toBe(32)
    expect(logoPixel!.rgba[0], 'red').toBeGreaterThan(200)
    expect(logoPixel!.rgba[1], 'red').toBeLessThan(80)
    const box = await row(LOGO_A).locator('img[data-row-icon="logo"]').boundingBox()
    expect(box?.width).toBe(14)
    expect(box?.height).toBe(14)

    // the logo once per template, not per row
    const listed = await phone.evaluate(async () => (await fetch('/api/phone/sessions')).json())
    expect(Object.keys(listed.templateLogos ?? {})).toEqual([TEMPLATE_ID])
    const rows = listed.sessions as Array<{ id: string; icon?: string; templateId?: string }>
    expect(rows.filter((s) => s.icon === 'logo').map((s) => s.id).sort()).toEqual([LOGO_A, LOGO_B])
    expect(rows.find((s) => s.id === DANGLING)?.templateId, 'no logo to point at: no template id').toBeUndefined()
    expect(JSON.stringify(rows), 'no data URL on a row').not.toContain('data:image')
    await shot(phone, 'E-drawer-after-checks-390')
})
