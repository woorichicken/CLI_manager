import { test, expect, Page, ElectronApplication, _electron as electron } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { launchAppWithWorkspaces, closeApp, activateSession, resizeMainWindow, LaunchResult, REPO_ROOT } from './helpers'
import type { SessionRelation } from '../../src/shared/types'

/**
 * T38 — The Related dialog's relation tab.
 *
 * Seeded the way tonight's sessions look: a chief opened three leads, the first
 * lead opened a worker, and that worker opened a helper. Opened from the first
 * lead, the dialog shows the chief above, the other two leads beside and the
 * worker with its helper below. Judged in the DOM: where each row sits, which
 * session is on screen after a click, and whether a row fits a narrow window.
 */

const CHIEF = 'tr-chief-000-4000-8000-000000000001'
const LEAD_A = 'tr-lead-a-00-4000-8000-000000000002'
const LEAD_B = 'tr-lead-b-00-4000-8000-000000000003'
const LEAD_C = 'tr-lead-c-00-4000-8000-000000000004'
const WORKER = 'tr-worker-00-4000-8000-000000000005'
const HELPER = 'tr-helper-00-4000-8000-000000000006'
const LEAD_A_NAME = 'AI: tr1022 lead A'
const LEAD_B_NAME = 'AI: tr1022 lead B'
const HELPER_NAME = 'AI: tr1022 helper with a rather long name to check the cut'

const RELATIONS: SessionRelation[] = [
    { from: CHIEF, to: LEAD_A, kind: 'opened', at: 1 },
    { from: CHIEF, to: LEAD_B, kind: 'opened', at: 2 },
    { from: CHIEF, to: LEAD_C, kind: 'opened', at: 3 },
    { from: LEAD_A, to: WORKER, kind: 'opened', at: 4 },
    { from: WORKER, to: HELPER, kind: 'opened', at: 5 }
]

test.describe('T38 session tree', () => {
    let ctx: LaunchResult | undefined
    let relaunched: ElectronApplication | null = null
    const temps: string[] = []

    test.afterEach(async () => {
        if (ctx) await closeApp(ctx)
        ctx = undefined
        if (relaunched) await relaunched.close().catch(() => undefined)
        relaunched = null
        for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
    })

    // One CLIMANAGER_HOME per launch, kept so a restart can use the same one.
    let homeDir = ''

    async function launch(): Promise<LaunchResult> {
        const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'climanager-tree-t38-ws-'))
        homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'climanager-tree-t38-home-'))
        temps.push(folder, homeDir)
        return launchAppWithWorkspaces(
            [{
                id: 'ws-tree', name: 'CLImanger', path: folder, sessions: [
                    { id: CHIEF, name: 'AI: tr1022 chief' },
                    { id: LEAD_A, name: LEAD_A_NAME },
                    { id: LEAD_B, name: LEAD_B_NAME },
                    { id: LEAD_C, name: 'AI: tr1022 lead C' },
                    { id: WORKER, name: 'AI: tr1022 worker' },
                    { id: HELPER, name: HELPER_NAME }
                ]
            }],
            { config: { sessionRelations: RELATIONS }, env: { CLIMANAGER_HOME: homeDir } }
        )
    }

    const button = (p: Page, id: string) => p.locator(`[data-related-button="${id}"]`)
    const dialog = (p: Page) => p.locator('[data-related-modal]')
    const section = (p: Page, where: string) => dialog(p).locator(`[data-related-tree="${where}"]`)
    const rowIn = (p: Page, where: string, id: string) => section(p, where).locator(`[data-related-row="${id}"]`)

    test('T38 a lead sees its sibling and goes there', async () => {
        ctx = await launch()
        const { page } = ctx
        await resizeMainWindow(ctx.app, 1280, 800)
        const shots = process.env.RELATED_SESSIONS_SHOTS
        if (shots) fs.mkdirSync(shots, { recursive: true })

        await activateSession(page, LEAD_A_NAME)
        await button(page, LEAD_A).click()
        await expect(dialog(page).locator('[data-related-tab="tree"]')).toHaveAttribute('aria-selected', 'true')

        await expect(rowIn(page, 'up', CHIEF)).toBeVisible()
        await expect(rowIn(page, 'side', LEAD_B)).toBeVisible()
        await expect(rowIn(page, 'side', LEAD_C)).toBeVisible()
        await expect(rowIn(page, 'down', WORKER)).toBeVisible()
        await expect(rowIn(page, 'down', HELPER)).toBeVisible()
        await expect(section(page, 'side').locator('[data-related-row]')).toHaveCount(2)
        // Last lines arrive on the next status poll; the shot should show them.
        if (shots) await expect(page.locator(`[data-related-last-line="${HELPER}"]`)).toBeVisible()
        if (shots) await page.screenshot({ path: path.join(shots, 'tree-1280.png') })

        // The helper hangs one level deeper than the worker.
        const worker = await rowIn(page, 'down', WORKER).boundingBox()
        const helper = await rowIn(page, 'down', HELPER).locator('[data-related-open]').boundingBox()
        const workerText = await rowIn(page, 'down', WORKER).locator('[data-related-open]').boundingBox()
        expect(worker && helper && workerText && helper.x).toBeGreaterThan(workerText!.x)

        await rowIn(page, 'side', LEAD_B).locator('[data-related-open]').click()
        await expect(dialog(page)).toHaveCount(0)
        await expect(button(page, LEAD_B)).toBeVisible()
        await expect(button(page, LEAD_A)).not.toBeVisible()
    })

    test('T38 narrow window keeps rows readable', async () => {
        ctx = await launch()
        const { page } = ctx
        await resizeMainWindow(ctx.app, 390, 800)
        const shots = process.env.RELATED_SESSIONS_SHOTS
        if (shots) fs.mkdirSync(shots, { recursive: true })

        await activateSession(page, LEAD_A_NAME)
        await button(page, LEAD_A).click()
        const panel = await dialog(page).locator('> div').nth(1).boundingBox()
        expect(panel).not.toBeNull()
        const panelRight = panel!.x + panel!.width

        // A long last line (a prompt with a deep path) is cut at the front, so its end — where the session is — stays visible.
        const lastLine = page.locator(`[data-related-last-line="${HELPER}"]`)
        await expect(lastLine).toBeVisible()
        if (shots) await page.screenshot({ path: path.join(shots, 'tree-390.png') })
        const tail = await lastLine.evaluate((el) => {
            const box = el.getBoundingClientRect()
            const caret = document.caretRangeFromPoint(box.right - 4, box.top + box.height / 2)
            return { cut: el.scrollWidth > el.clientWidth, offset: caret?.startOffset ?? -1, length: (el.textContent ?? '').length }
        })
        expect(tail.cut).toBe(true)
        expect(tail.offset).toBeGreaterThanOrEqual(tail.length - 3)

        // Even the deepest, longest-named row stays inside the dialog, and the name is not squeezed to nothing.
        const helperRow = rowIn(page, 'down', HELPER)
        await expect(helperRow).toBeVisible()
        for (const selector of ['', ' [data-related-open]', ' [data-related-copy-id]', ' [data-related-remove]']) {
            const box = await page.locator(`[data-related-row="${HELPER}"]${selector}`).boundingBox()
            expect(box, selector).not.toBeNull()
            expect(box!.x + box!.width, selector).toBeLessThanOrEqual(panelRight + 1)
        }
        const nameBox = await helperRow.locator('[data-related-open]').boundingBox()
        expect(nameBox!.width).toBeGreaterThan(120)
    })

    const tab = (p: Page, key: string) => dialog(p).locator(`[data-related-tab="${key}"]`)
    const recentOrder = (p: Page, among: string[]) =>
        dialog(p).locator('[data-related-recent] [data-related-row]').evaluateAll(
            (rows, wanted) => rows.map(row => row.getAttribute('data-related-row')!).filter(id => (wanted as string[]).includes(id)),
            among
        )
    const recentOnDisk = (userDataDir: string): string[] =>
        JSON.parse(fs.readFileSync(path.join(userDataDir, 'config.json'), 'utf-8')).recentSessions ?? []

    test('T38 recent tab follows what you looked at and survives a restart', async () => {
        ctx = await launch()
        const { page } = ctx
        await resizeMainWindow(ctx.app, 1280, 800)
        const shots = process.env.RELATED_SESSIONS_SHOTS
        if (shots) fs.mkdirSync(shots, { recursive: true })

        // Look at three sessions in turn, then open the dialog from the last one.
        await activateSession(page, LEAD_B_NAME)
        await activateSession(page, 'AI: tr1022 lead C')
        await activateSession(page, 'AI: tr1022 worker')
        await button(page, WORKER).click()
        await tab(page, 'recent').click()
        await expect(tab(page, 'recent')).toHaveAttribute('aria-selected', 'true')
        // Newest first; the dialog's own session is not offered.
        await expect.poll(() => recentOrder(page, [LEAD_B, LEAD_C, WORKER])).toEqual([LEAD_C, LEAD_B])
        await expect(dialog(page).locator(`[data-related-recent] [data-related-row="${WORKER}"]`)).toHaveCount(0)
        if (shots) { await page.waitForTimeout(500); await page.screenshot({ path: path.join(shots, 'recent-1280.png') }) } // tab underline is a transition
        await resizeMainWindow(ctx.app, 390, 800)
        if (shots) { await page.waitForTimeout(500); await page.screenshot({ path: path.join(shots, 'recent-390.png') }) }
        await page.keyboard.press('Escape')

        // The order is on disk, so a restart brings it back.
        await expect.poll(() => recentOnDisk(ctx!.userDataDir)[0]).toBe(WORKER)
        const userDataDir = ctx.userDataDir
        temps.push(userDataDir)
        await ctx.app.close()
        ctx = undefined
        relaunched = await electron.launch({
            args: [path.join(REPO_ROOT, 'out/main/index.js')],
            env: {
                ...process.env,
                CLIMANGER_TEST_USERDATA: userDataDir,
                CLIMANGER_TERM_DEBUG: '1',
                CLIMANGER_TEST_HEADLESS: '1',
                CLIMANAGER_HOME: homeDir
            } as Record<string, string>
        })
        const page2 = await relaunched.firstWindow()
        await page2.locator(`[data-session-item="${HELPER}"]`).waitFor({ timeout: 30_000 })
        await activateSession(page2, HELPER_NAME)
        await button(page2, HELPER).click()
        await tab(page2, 'recent').click()
        await expect.poll(() => recentOrder(page2, [WORKER, LEAD_C, LEAD_B])).toEqual([WORKER, LEAD_C, LEAD_B])
        await page2.keyboard.press('Escape')

        // A deleted session leaves the list.
        const rowInSidebar = page2.locator(`[data-session-item="${LEAD_B}"]`)
        await rowInSidebar.hover()
        await rowInSidebar.getByTitle('Delete session').click()
        await expect(rowInSidebar).toHaveCount(0)
        await button(page2, HELPER).click()
        await tab(page2, 'recent').click()
        await expect(dialog(page2).locator(`[data-related-recent] [data-related-row="${LEAD_C}"]`)).toBeVisible()
        await expect(dialog(page2).locator(`[data-related-recent] [data-related-row="${LEAD_B}"]`)).toHaveCount(0)
        await expect.poll(() => recentOnDisk(userDataDir)).not.toContain(LEAD_B)
    })

    test('T38 all tab filters by name and copies the id', async () => {
        ctx = await launch()
        const { page, app } = ctx
        await resizeMainWindow(app, 1280, 800)
        const shots = process.env.RELATED_SESSIONS_SHOTS
        if (shots) fs.mkdirSync(shots, { recursive: true })

        await activateSession(page, LEAD_A_NAME)
        await button(page, LEAD_A).click()
        await tab(page, 'all').click()
        await expect(tab(page, 'all')).toHaveAttribute('aria-selected', 'true')

        const rows = dialog(page).locator('[data-related-all] [data-related-row]')
        // Every other session, grouped under its workspace; no state is polled for them. (The app also
        // opens a session of its own in its working folder, so the seeded ones are checked by id, not counted.)
        for (const id of [CHIEF, LEAD_B, LEAD_C, WORKER, HELPER]) {
            await expect(dialog(page).locator(`[data-related-all] [data-related-row="${id}"]`)).toBeVisible()
        }
        await expect(dialog(page).locator('[data-related-all] [data-related-workspace="ws-tree"]')).toBeVisible()
        await expect(dialog(page).locator('[data-related-all] [data-related-state]')).toHaveCount(0)
        await expect(dialog(page).locator(`[data-related-all] [data-related-row="${LEAD_A}"]`)).toHaveCount(0)
        await expect(dialog(page).locator('[data-related-all] [data-related-remove]')).toHaveCount(0)
        if (shots) { await page.waitForTimeout(500); await page.screenshot({ path: path.join(shots, 'all-1280.png') }) } // tab underline is a transition

        await dialog(page).locator('[data-related-search]').fill('HELPER')
        await expect(rows).toHaveCount(1)
        await expect(dialog(page).locator(`[data-related-all] [data-related-row="${HELPER}"]`)).toBeVisible()
        await dialog(page).locator('[data-related-search]').fill('no such session')
        await expect(rows).toHaveCount(0)
        await dialog(page).locator('[data-related-search]').fill('helper')

        // The clipboard is the machine's, not the test's: put back what was there.
        const saved = await app.evaluate(({ clipboard }) => clipboard.readText())
        try {
            await dialog(page).locator(`[data-related-all] [data-related-copy-id="${HELPER}"]`).click()
            await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe(HELPER)
        } finally {
            await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), saved)
        }

        await dialog(page).locator('[data-related-search]').fill('')
        await resizeMainWindow(app, 390, 800)
        // The copy notice covers the footer for a moment; wait it out.
        if (shots) { await page.waitForTimeout(2200); await page.screenshot({ path: path.join(shots, 'all-390.png') }) }
        const panel = await dialog(page).locator('> div').nth(1).boundingBox()
        const box = await dialog(page).locator(`[data-related-all] [data-related-row="${HELPER}"]`).boundingBox()
        expect(box!.x + box!.width).toBeLessThanOrEqual(panel!.x + panel!.width + 1)
    })
})
