import { test, expect, Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { launchAppWithWorkspaces, closeApp, activateSession, resizeMainWindow, LaunchResult } from './helpers'
import type { SessionRelation } from '../../src/shared/types'

/**
 * T40 — The Related dialog's relation tab.
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

test.describe('T40 session tree', () => {
    let ctx: LaunchResult | undefined
    const temps: string[] = []

    test.afterEach(async () => {
        if (ctx) await closeApp(ctx)
        ctx = undefined
        for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
    })

    async function launch(): Promise<LaunchResult> {
        const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'climanager-tree-t40-ws-'))
        temps.push(folder)
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
            { config: { sessionRelations: RELATIONS }, env: { CLIMANAGER_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'climanager-tree-t40-home-')) } }
        )
    }

    const button = (p: Page, id: string) => p.locator(`[data-related-button="${id}"]`)
    const dialog = (p: Page) => p.locator('[data-related-modal]')
    const section = (p: Page, where: string) => dialog(p).locator(`[data-related-tree="${where}"]`)
    const rowIn = (p: Page, where: string, id: string) => section(p, where).locator(`[data-related-row="${id}"]`)

    test('T40 a lead sees its sibling and goes there', async () => {
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

    test('T40 narrow window keeps rows readable', async () => {
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
})
