import { test, expect, Page, Locator, _electron as electron, ElectronApplication } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import zlib from 'zlib'
import { launchAppWithWorkspaces, closeApp, REPO_ROOT, LaunchResult } from './helpers'
import type { TerminalSession, TerminalTemplate, Workspace } from '../../src/shared/types'

/**
 * T134 — a template's small logo (report 8062e68c, fb-1114b).
 *
 * The template edit dialog takes a PNG or SVG, shrinks it and keeps it in the app's store (no path
 * to the original file). A session opened from that template remembers the template, and its sidebar
 * row shows the logo in the icon slot — folder view and All sessions alike. Sessions opened before
 * keep their icon; removing the logo brings the icon back. Judged on the row's <img> (what it draws,
 * read back through a canvas), config.json, and an app restart.
 */

const TEMPLATE: TerminalTemplate = { id: 'tpl-t134', name: 'T134Agent', icon: 'terminal', description: '', command: 'echo T134-RAN' }
const OLD_SESSION = { id: 's-t134-old', name: 'T134OLD' }
// No width/height on purpose: an SVG without an intrinsic size still has to come out as a logo.
const RED_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#e11d48"/></svg>'

/** A solid red RGBA PNG, built here so the fixture cannot be a mistyped base64 string. */
function redPng(size: number): Buffer {
    const crcTable = Array.from({ length: 256 }, (_, n) => {
        let c = n
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
        return c >>> 0
    })
    const crc32 = (buf: Buffer): number => {
        let c = 0xffffffff
        for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
        return (c ^ 0xffffffff) >>> 0
    }
    const chunk = (type: string, data: Buffer): Buffer => {
        const len = Buffer.alloc(4)
        len.writeUInt32BE(data.length)
        const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
        const crc = Buffer.alloc(4)
        crc.writeUInt32BE(crc32(body))
        return Buffer.concat([len, body, crc])
    }
    const header = Buffer.alloc(13)
    header.writeUInt32BE(size, 0)
    header.writeUInt32BE(size, 4)
    header.writeUInt8(8, 8)
    header.writeUInt8(6, 9)
    const rowBytes = Buffer.concat([Buffer.from([0]), Buffer.concat(Array.from({ length: size }, () => Buffer.from([225, 29, 72, 255])))])
    const raw = Buffer.concat(Array.from({ length: size }, () => rowBytes))
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', header),
        chunk('IDAT', zlib.deflateSync(raw)),
        chunk('IEND', Buffer.alloc(0))
    ])
}

const readConfig = (dir: string): { workspaces: Workspace[]; customTemplates: TerminalTemplate[] } =>
    JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'))

const sessionsOf = (dir: string): TerminalSession[] => readConfig(dir).workspaces.flatMap(w => w.sessions)

const row = (page: Page, id: string): Locator => page.locator(`[data-session-item="${id}"]`).first()

/** Centre pixel of the row's logo, drawn through a canvas — the image really decoded, not only a src. */
const logoPixel = (page: Page, id: string): Promise<{ w: number; h: number; rgba: number[] } | null> =>
    page.evaluate((sessionId) => {
        const img = document.querySelector(`[data-session-item="${sessionId}"] img[data-template-logo]`) as HTMLImageElement | null
        if (!img || !img.complete || img.naturalWidth === 0) return null
        const canvas = document.createElement('canvas')
        canvas.width = img.naturalWidth
        canvas.height = img.naturalHeight
        const ctx = canvas.getContext('2d')!
        ctx.drawImage(img, 0, 0)
        const d = ctx.getImageData(Math.floor(img.naturalWidth / 2), Math.floor(img.naturalHeight / 2), 1, 1).data
        return { w: img.naturalWidth, h: img.naturalHeight, rgba: Array.from(d) }
    }, id)

async function openTemplateEditor(page: Page): Promise<Locator> {
    await page.locator('button[title^="Settings"]').first().click()
    await page.getByRole('button', { name: 'Templates', exact: true }).click()
    await page.getByText(TEMPLATE.name, { exact: true }).first().waitFor()
    await page.locator('button[title="Edit"]').first().click()
    const dialog = page.getByTestId('template-edit-dialog')
    await expect(dialog).toBeVisible()
    return dialog
}

async function saveTemplateAndSettings(page: Page, dialog: Locator): Promise<void> {
    await dialog.getByRole('button', { name: 'Save Template' }).click()
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Templates', exact: true })).toHaveCount(0)
}

async function openFromWorkspaceMenu(page: Page, workspaceName: string): Promise<void> {
    await page.getByText(workspaceName, { exact: true }).first().click({ button: 'right' })
    await page.getByRole('button', { name: TEMPLATE.name }).first().click()
}

test.describe('T134 template logo', () => {
    let ctx: LaunchResult | null = null
    let relaunched: ElectronApplication | null = null
    const dirs: string[] = []
    const tempDir = (prefix: string): string => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
        dirs.push(dir)
        return dir
    }

    test.afterEach(async () => {
        if (relaunched) await relaunched.close().catch(() => undefined)
        relaunched = null
        if (ctx) await closeApp(ctx)
        ctx = null
        for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
    })

    test('a logo picked for a template marks new sessions from it, survives a restart, and goes when removed', async () => {
        const folder = tempDir('climanger-t134-ws-')
        const files = tempDir('climanger-t134-files-')
        const svgPath = path.join(files, 'agent-logo.svg')
        fs.writeFileSync(svgPath, RED_SVG)

        ctx = await launchAppWithWorkspaces(
            [{ id: 'ws-t134', name: 'T134WS', path: folder, sessions: [OLD_SESSION] }],
            { customTemplates: [TEMPLATE], settings: { showHomeWorkspace: false } }
        )
        const { page, userDataDir } = ctx
        await page.setViewportSize({ width: 1280, height: 800 })

        // --- Pick the image in the template editor ----------------------------
        const dialog = await openTemplateEditor(page)
        await dialog.getByTestId('template-logo-input').setInputFiles(svgPath)
        await expect(dialog.getByTestId('template-logo-preview')).toBeVisible()
        await saveTemplateAndSettings(page, dialog)

        await expect.poll(() => readConfig(userDataDir).customTemplates[0]?.logo ?? '').toMatch(/^data:image\/png;base64,/)
        // Kept in the store, small: no file path, a few KB at most.
        const stored = readConfig(userDataDir).customTemplates[0].logo!
        expect(stored).not.toContain(files)
        expect(stored.length).toBeLessThan(20_000)

        // --- A session opened before keeps its look -----------------------------
        await expect(row(page, OLD_SESSION.id).locator('img[data-template-logo]')).toHaveCount(0)
        await expect(row(page, OLD_SESSION.id).locator('svg').first()).toBeVisible()

        // --- A session opened from the template shows the logo ------------------
        await openFromWorkspaceMenu(page, 'T134WS')
        await expect.poll(() => sessionsOf(userDataDir).find(s => s.name === TEMPLATE.name)?.templateId ?? '').toBe(TEMPLATE.id)
        const newId = sessionsOf(userDataDir).find(s => s.name === TEMPLATE.name)!.id
        await expect(row(page, newId).locator('img[data-template-logo]')).toBeVisible()
        await expect.poll(() => logoPixel(page, newId)).toMatchObject({ w: 32, h: 32 })
        const pixel = (await logoPixel(page, newId))!
        expect(pixel.rgba[0]).toBeGreaterThan(180)   // the red square, not a blank image
        expect(pixel.rgba[1]).toBeLessThan(80)
        expect(pixel.rgba[3]).toBe(255)
        // Same 14px slot as the icon it replaces, so names stay in line.
        const box = await row(page, newId).locator('img[data-template-logo]').boundingBox()
        expect(Math.round(box!.width)).toBe(14)

        // --- All sessions view draws the same rows ------------------------------
        await page.getByTestId('sidebar-view-toggle').click()
        const list = page.getByTestId('sidebar-all-sessions')
        await expect(list.locator(`[data-session-item="${newId}"] img[data-template-logo]`)).toBeVisible()
        await expect(list.locator(`[data-session-item="${OLD_SESSION.id}"] img[data-template-logo]`)).toHaveCount(0)

        // --- Restart: the session still knows its template ----------------------
        const keptDir = userDataDir
        await ctx.app.close()
        dirs.push(keptDir)
        ctx.userDataDir = path.join(keptDir, '..', 'climanger-t134-unused')
        relaunched = await electron.launch({
            args: [path.join(REPO_ROOT, 'out/main/index.js')],
            env: { ...process.env, CLIMANGER_TEST_USERDATA: keptDir, CLIMANGER_TERM_DEBUG: '1', CLIMANGER_TEST_HEADLESS: '1' } as Record<string, string>
        })
        const page2 = await relaunched.firstWindow()
        await page2.setViewportSize({ width: 1280, height: 800 })
        await expect(row(page2, newId).locator('img[data-template-logo]')).toBeVisible({ timeout: 30_000 })
        await expect(row(page2, OLD_SESSION.id).locator('img[data-template-logo]')).toHaveCount(0)

        // --- Remove the logo: the row's icon comes back --------------------------
        const dialog2 = await openTemplateEditor(page2)
        await expect(dialog2.getByTestId('template-logo-preview')).toBeVisible()
        await dialog2.getByTestId('template-logo-remove').click()
        await expect(dialog2.getByTestId('template-logo-preview')).toHaveCount(0)
        await saveTemplateAndSettings(page2, dialog2)
        await expect.poll(() => readConfig(keptDir).customTemplates[0]?.logo).toBeUndefined()
        await expect(row(page2, newId).locator('img[data-template-logo]')).toHaveCount(0)
        await expect(row(page2, newId).locator('svg').first()).toBeVisible()
        // The session keeps its template: a new logo would show again.
        expect(sessionsOf(keptDir).find(s => s.id === newId)?.templateId).toBe(TEMPLATE.id)
    })

    test('broken, huge and oversized images are refused with a message and the app keeps going', async () => {
        const folder = tempDir('climanger-t134-ws-')
        const files = tempDir('climanger-t134-files-')
        const broken = path.join(files, 'broken.png')
        fs.writeFileSync(broken, 'this is not a png at all')
        // A real PNG header claiming 30000×30000: decoding it would take gigabytes.
        const bomb = path.join(files, 'bomb.png')
        const ihdr = Buffer.alloc(25)
        ihdr.writeUInt32BE(13, 0)
        ihdr.write('IHDR', 4, 'ascii')
        ihdr.writeUInt32BE(30000, 8)
        ihdr.writeUInt32BE(30000, 12)
        ihdr.writeUInt8(8, 16)
        ihdr.writeUInt8(6, 17)
        fs.writeFileSync(bomb, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr, Buffer.alloc(64)]))
        const heavy = path.join(files, 'heavy.svg')
        fs.writeFileSync(heavy, RED_SVG.replace('</svg>', `<!--${'x'.repeat(3 * 1024 * 1024)}--></svg>`))
        const good = path.join(files, 'good.svg')
        fs.writeFileSync(good, RED_SVG)
        // Under 2 MB but claiming 60000×60000: halving step by step would ask for 30000px canvases (PR #138 review)
        const giant = path.join(files, 'giant.svg')
        fs.writeFileSync(giant, RED_SVG.replace('<svg ', '<svg width="60000" height="60000" '))

        ctx = await launchAppWithWorkspaces(
            [{ id: 'ws-t134', name: 'T134WS', path: folder, sessions: [OLD_SESSION] }],
            { customTemplates: [TEMPLATE], settings: { showHomeWorkspace: false } }
        )
        const { page, userDataDir, pageErrors } = ctx
        const dialog = await openTemplateEditor(page)
        const input = dialog.getByTestId('template-logo-input')
        const error = dialog.getByTestId('template-logo-error')

        await input.setInputFiles(good)
        await expect(dialog.getByTestId('template-logo-preview')).toBeVisible()
        const kept = await dialog.getByTestId('template-logo-preview').getAttribute('src')

        for (const [file, message] of [[broken, /could not be read/i], [bomb, /too large/i], [heavy, /too big/i]] as const) {
            await input.setInputFiles(file)
            await expect(error).toHaveText(message)
            // The logo picked before stays.
            await expect(dialog.getByTestId('template-logo-preview')).toHaveAttribute('src', kept!)
        }

        // A huge declared size still comes out as a visible 32×32 logo, quickly.
        // cleared first, so the preview that comes back can only be the giant's (it draws the same red square)
        await dialog.getByTestId('template-logo-remove').click()
        await expect(dialog.getByTestId('template-logo-preview')).toHaveCount(0)
        const startedAt = Date.now()
        await input.setInputFiles(giant)
        await expect(error).toHaveCount(0)
        await expect(dialog.getByTestId('template-logo-preview')).toBeVisible()
        expect(Date.now() - startedAt, 'no stall').toBeLessThan(5_000)
        const giantPixel = await dialog.getByTestId('template-logo-preview').evaluate(async (el) => {
            const img = el as HTMLImageElement
            await img.decode()
            const canvas = document.createElement('canvas')
            canvas.width = img.naturalWidth
            canvas.height = img.naturalHeight
            const ctx = canvas.getContext('2d')!
            ctx.drawImage(img, 0, 0)
            return { w: img.naturalWidth, h: img.naturalHeight, rgba: Array.from(ctx.getImageData(16, 16, 1, 1).data) }
        })
        expect(giantPixel.w).toBe(32)
        expect(giantPixel.rgba[0], 'the red square, not a blank logo').toBeGreaterThan(180)
        expect(giantPixel.rgba[3]).toBe(255)
        // Back to the small one for the save below.
        await input.setInputFiles(good)
        await expect(dialog.getByTestId('template-logo-preview')).toHaveAttribute('src', kept!)

        // Still responsive: the dialog saves and the logo is the good one.
        await saveTemplateAndSettings(page, dialog)
        await expect.poll(() => readConfig(userDataDir).customTemplates[0]?.logo).toBe(kept)
        expect(pageErrors).toEqual([])
    })

    test('the shortcut, the Related dialog and the Control API all keep the template on the new session', async () => {
        const folder = tempDir('climanger-t134-ws-')
        const home = tempDir('climanger-t134-home-')
        // A real 32×32 red PNG, as a template already holding a logo would store it.
        const logo = 'data:image/png;base64,' + redPng(32).toString('base64')
        ctx = await launchAppWithWorkspaces(
            [{ id: 'ws-t134', name: 'T134WS', path: folder, sessions: [OLD_SESSION] }],
            {
                customTemplates: [{ ...TEMPLATE, logo } as TerminalTemplate],
                settings: { showHomeWorkspace: false, controlApi: { enabled: true, port: 0 } },
                env: { CLIMANAGER_HOME: home }
            }
        )
        const { page, userDataDir } = ctx
        await expect(row(page, OLD_SESSION.id).locator('img[data-template-logo]')).toHaveCount(0)
        const created = (): TerminalSession[] => sessionsOf(userDataDir).filter(s => s.id !== OLD_SESSION.id)

        // Settings › Keyboard default: the first template is ⌘T then 1 on the active workspace.
        await row(page, OLD_SESSION.id).click()
        await page.keyboard.press('Meta+t')
        await page.keyboard.press('1')
        await expect.poll(() => created().length).toBe(1)
        expect(created()[0].templateId).toBe(TEMPLATE.id)
        await expect(row(page, created()[0].id).locator('img[data-template-logo]')).toBeVisible()

        // Related › New session with the template.
        await row(page, OLD_SESSION.id).click()
        await page.locator(`[data-related-button="${OLD_SESSION.id}"]`).first().click()
        await page.locator('[data-related-new]').click()
        const form = page.locator('[data-related-new-form]')
        await form.locator('[data-related-new-template]').selectOption(TEMPLATE.id)
        await form.locator('[data-related-new-name]').fill('T134RELATED')
        await form.locator('[data-related-new-create]').click()
        await expect.poll(() => created().find(s => s.name === 'T134RELATED')?.templateId ?? '').toBe(TEMPLATE.id)

        // Control API: open with the template by name.
        const discoveryPath = path.join(home, 'control-api.json')
        await expect.poll(() => fs.existsSync(discoveryPath), { timeout: 15_000 }).toBe(true)
        const discovery = JSON.parse(fs.readFileSync(discoveryPath, 'utf-8')) as { url: string; token: string }
        const res = await fetch(discovery.url + '/v1/sessions', {
            method: 'POST',
            headers: { Authorization: `Bearer ${discovery.token}`, 'Content-Type': 'application/json', 'X-Client-Name': 't134' },
            body: JSON.stringify({ path: folder, template: TEMPLATE.name, name: 'T134API' })
        })
        expect(res.status).toBe(200)
        const apiId = ((await res.json()) as { session: { id: string } }).session.id
        await expect.poll(() => sessionsOf(userDataDir).find(s => s.id === apiId)?.templateId ?? '').toBe(TEMPLATE.id)
        await expect(row(page, apiId).locator('img[data-template-logo]')).toBeVisible()

        // A plain terminal (no template) carries nothing.
        const plain = await fetch(discovery.url + '/v1/sessions', {
            method: 'POST',
            headers: { Authorization: `Bearer ${discovery.token}`, 'Content-Type': 'application/json', 'X-Client-Name': 't134' },
            body: JSON.stringify({ path: folder, command: 'echo plain', name: 'T134PLAIN' })
        })
        const plainId = ((await plain.json()) as { session: { id: string } }).session.id
        await expect.poll(() => sessionsOf(userDataDir).some(s => s.id === plainId)).toBe(true)
        expect(sessionsOf(userDataDir).find(s => s.id === plainId)?.templateId).toBeUndefined()
    })
})
