import { test, expect, Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { launchAppWithWorkspaces, closeApp, activateSession, resizeMainWindow, LaunchResult } from './helpers'
import type { SessionRelation } from '../../src/shared/types'

/**
 * T137 — The Related dialog's All · Above · Beside · Below filter (report 33f92744).
 *
 * Seeded like T40: a chief opened three leads, lead A opened a worker, the worker
 * opened a helper. From lead A the tree has the chief above, leads B and C beside,
 * the worker and its helper below. Each filter lists only its part of the tree;
 * a filter with nothing in it says so; the choice is remembered when the dialog
 * opens again; ← → move the choice; the header's count does not change; at
 * 390 the filter and Sort stay inside the dialog. Judged in the DOM.
 */

const CHIEF = 't137-chief-4000-8000-000000000001'
const LEAD_A = 't137-leada-4000-8000-000000000002'
const LEAD_B = 't137-leadb-4000-8000-000000000003'
const LEAD_C = 't137-leadc-4000-8000-000000000004'
const WORKER = 't137-workr-4000-8000-000000000005'
const HELPER = 't137-helpr-4000-8000-000000000006'
const NAMES: Record<string, string> = {
    [CHIEF]: 'AI: t137 chief',
    [LEAD_A]: 'AI: t137 lead A',
    [LEAD_B]: 'AI: t137 lead B',
    [LEAD_C]: 'AI: t137 lead C',
    [WORKER]: 'AI: t137 worker',
    [HELPER]: 'AI: t137 helper'
}

const RELATIONS: SessionRelation[] = [
    { from: CHIEF, to: LEAD_A, kind: 'opened', at: 1 },
    { from: CHIEF, to: LEAD_B, kind: 'opened', at: 2 },
    { from: CHIEF, to: LEAD_C, kind: 'opened', at: 3 },
    { from: LEAD_A, to: WORKER, kind: 'opened', at: 4 },
    { from: WORKER, to: HELPER, kind: 'opened', at: 5 }
]

/** What each filter must list from lead A, and nothing else. */
const EXPECTED: Record<string, string[]> = {
    all: [CHIEF, LEAD_B, LEAD_C, WORKER, HELPER],
    above: [CHIEF],
    beside: [LEAD_B, LEAD_C],
    below: [WORKER, HELPER]
}

test.describe('T137 Related filter (33f92744)', () => {
    let ctx: LaunchResult | undefined
    const temps: string[] = []

    test.afterEach(async () => {
        if (ctx) await closeApp(ctx)
        ctx = undefined
        for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
    })

    async function launch(): Promise<LaunchResult> {
        const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'climanager-t137-ws-'))
        const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'climanager-t137-home-'))
        temps.push(folder, homeDir)
        return launchAppWithWorkspaces(
            [{ id: 'ws-t137', name: 'T137 project', path: folder, sessions: Object.keys(NAMES).map(id => ({ id, name: NAMES[id] })) }],
            { config: { sessionRelations: RELATIONS }, env: { CLIMANAGER_HOME: homeDir } }
        )
    }

    const button = (p: Page, id: string) => p.locator(`[data-related-button="${id}"]`)
    const dialog = (p: Page) => p.locator('[data-related-modal]')
    const option = (p: Page, key: string) => dialog(p).locator(`[data-related-filter-option="${key}"]`)
    const listedIds = (p: Page) => dialog(p).locator('[data-related-row]').evaluateAll(rows =>
        rows.map(row => row.getAttribute('data-related-row') ?? '').sort())
    const shotsDir = (): string | undefined => {
        const shots = process.env.T137_SHOTS
        if (shots) fs.mkdirSync(shots, { recursive: true })
        return shots
    }
    const label = (): string => process.env.T137_LABEL ?? 'after'
    // The chips fade their colours (transition-colors, 150ms): a shot right after a click shows the old one lit.
    const settledShot = async (p: Page, options: { path: string }): Promise<void> => {
        await p.waitForTimeout(400)
        await p.screenshot(options)
    }

    async function openDialog(p: Page, id: string): Promise<void> {
        await activateSession(p, NAMES[id])
        await button(p, id).click()
        await expect(dialog(p)).toBeVisible()
        await expect(dialog(p).locator('[data-related-row]').first()).toBeVisible()
    }

    test('T137 each filter lists only its part; remembered; keys; header count unchanged', async () => {
        ctx = await launch()
        const { page } = ctx
        await resizeMainWindow(ctx.app, 1280, 800)
        const shots = shotsDir()
        await activateSession(page, NAMES[LEAD_A])
        const headerCount = await button(page, LEAD_A).getAttribute('data-related-count')
        await openDialog(page, LEAD_A)
        if (shots) await settledShot(page, { path: path.join(shots, `related-all-1280-${label()}.png`) })

        // Default is All: the tree as it was.
        await expect(dialog(page).locator('[data-related-filter]')).toHaveAttribute('data-related-filter', 'all')
        expect(await listedIds(page)).toEqual([...EXPECTED.all].sort())

        for (const key of ['above', 'beside', 'below'] as const) {
            await option(page, key).click()
            await expect(option(page, key)).toHaveAttribute('aria-checked', 'true')
            await expect.poll(() => listedIds(page)).toEqual([...EXPECTED[key]].sort())
            // Only that part of the tree is drawn.
            const tree = { above: 'up', beside: 'side', below: 'down' }[key]
            const sections = await dialog(page).locator('[data-related-tree]').evaluateAll(els => els.map(el => el.getAttribute('data-related-tree')))
            expect(sections).toEqual([tree])
            await expect(option(page, key)).toContainText(String(EXPECTED[key].length))
            if (shots) await settledShot(page, { path: path.join(shots, `related-${key}-1280-${label()}.png`) })
        }
        // Below keeps the helper indented under the worker.
        await expect(dialog(page).locator(`[data-related-tree="down"] [data-related-row="${HELPER}"]`)).toBeVisible()

        // The header count does not follow the filter.
        await expect(button(page, LEAD_A)).toHaveAttribute('data-related-count', headerCount ?? '')

        // Remembered: close and open again, still Below.
        await page.keyboard.press('Escape')
        await expect(dialog(page)).toHaveCount(0)
        await button(page, LEAD_A).click()
        await expect(option(page, 'below')).toHaveAttribute('aria-checked', 'true')
        await expect.poll(() => listedIds(page)).toEqual([...EXPECTED.below].sort())

        // Keyboard: the chosen chip takes Tab focus; ← moves to Beside, Home to All.
        await option(page, 'below').focus()
        await page.keyboard.press('ArrowLeft')
        await expect(option(page, 'beside')).toHaveAttribute('aria-checked', 'true')
        await expect(option(page, 'beside')).toBeFocused()
        await expect.poll(() => listedIds(page)).toEqual([...EXPECTED.beside].sort())
        await page.keyboard.press('Home')
        await expect(option(page, 'all')).toHaveAttribute('aria-checked', 'true')
        await expect.poll(() => listedIds(page)).toEqual([...EXPECTED.all].sort())
        await page.keyboard.press('ArrowLeft') // wraps to the last
        await expect(option(page, 'below')).toHaveAttribute('aria-checked', 'true')
    })

    test('T137 a filter with nothing in it says so', async () => {
        ctx = await launch()
        const { page } = ctx
        await openDialog(page, CHIEF)
        await option(page, 'above').click()
        await expect(dialog(page).locator('[data-related-filter-empty="above"]')).toBeVisible()
        await expect(dialog(page).locator('[data-related-row]')).toHaveCount(0)
        const shots = shotsDir()
        if (shots) await settledShot(page, { path: path.join(shots, `related-empty-1280-${label()}.png`) })
        // Back to All, the chief's leads are there again.
        await option(page, 'all').click()
        await expect(dialog(page).locator('[data-related-filter-empty]')).toHaveCount(0)
        await expect(dialog(page).locator(`[data-related-row="${LEAD_A}"]`)).toBeVisible()
    })

    test('T137 narrow window keeps the filter and Sort inside the dialog', async () => {
        ctx = await launch()
        const { page } = ctx
        await resizeMainWindow(ctx.app, 390, 800)
        const shots = shotsDir()
        await openDialog(page, LEAD_A)
        if (shots) await settledShot(page, { path: path.join(shots, `related-all-390-${label()}.png`) })
        const panel = await dialog(page).boundingBox()
        expect(panel).not.toBeNull()
        for (const selector of ['[data-related-filter-option="all"]', '[data-related-filter-option="below"]', '[data-related-order]']) {
            const box = await dialog(page).locator(selector).boundingBox()
            expect(box, selector).not.toBeNull()
            expect(box!.x, selector).toBeGreaterThanOrEqual(panel!.x)
            expect(box!.x + box!.width, selector).toBeLessThanOrEqual(panel!.x + panel!.width + 1)
        }
        await option(page, 'below').click()
        await expect.poll(() => listedIds(page)).toEqual([...EXPECTED.below].sort())
        if (shots) await settledShot(page, { path: path.join(shots, `related-below-390-${label()}.png`) })
    })
})
