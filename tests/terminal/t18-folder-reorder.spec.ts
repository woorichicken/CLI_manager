import { test, expect } from '@playwright/test'
import fs from 'fs'
import path from 'path'
import { launchAppWithWorkspaces, closeApp, LaunchResult } from './helpers'

/**
 * T18 — Sidebar folders can be reordered by dragging, and the order survives.
 *
 * The main process had a `reorder-folders` handler long before anything in the
 * renderer called it, so the check runs from the drag handle to config.json:
 * a store-level assertion alone would have passed while the UI did nothing.
 */
const FOLDERS = [
    { id: 'f-alpha', name: 'T18ALPHA', isExpanded: false, createdAt: 1700000000000 },
    { id: 'f-beta', name: 'T18BETA', isExpanded: false, createdAt: 1700000000001 },
    { id: 'f-gamma', name: 'T18GAMMA', isExpanded: false, createdAt: 1700000000002 }
]

test.describe('T18 folder reorder', () => {
    let ctx: LaunchResult

    test.afterEach(async () => {
        if (ctx) await closeApp(ctx)
    })

    test('dragging a folder below another moves it and persists the order', async () => {
        ctx = await launchAppWithWorkspaces(
            [{ id: 'ws-main', name: 'T18WS', sessions: [{ id: 's-main', name: 'T18SESS' }] }],
            { folders: FOLDERS }
        )
        const { page, userDataDir } = ctx

        const headerOrder = async (): Promise<string[]> =>
            page.locator('[data-testid^="folder-header-"]').evaluateAll(els =>
                els.map(el => el.getAttribute('data-testid')!.replace('folder-header-', ''))
            )

        await page.locator('[data-testid="folder-header-f-alpha"]').waitFor({ timeout: 15_000 })
        expect(await headerOrder()).toEqual(['f-alpha', 'f-beta', 'f-gamma'])

        // Drag the first folder down by exactly one row: framer-motion swaps as the
        // dragged row passes a neighbour, so a longer drag would pass gamma too.
        const handle = page.getByTitle('Drag to reorder folder').first()
        const handleBox = (await handle.boundingBox())!
        const alphaBox = (await page.locator('[data-testid="folder-header-f-alpha"]').boundingBox())!
        const betaBox = (await page.locator('[data-testid="folder-header-f-beta"]').boundingBox())!
        const rowHeight = betaBox.y - alphaBox.y
        const startX = handleBox.x + handleBox.width / 2
        const startY = handleBox.y + handleBox.height / 2
        await page.mouse.move(startX, startY)
        await page.mouse.down()
        await page.mouse.move(startX, startY + rowHeight, { steps: 12 })
        await page.mouse.up()

        await expect.poll(headerOrder).toEqual(['f-beta', 'f-alpha', 'f-gamma'])

        // Persisted after the debounce — read from disk, not from renderer state.
        const storedOrder = (): string[] =>
            (JSON.parse(fs.readFileSync(path.join(userDataDir, 'config.json'), 'utf-8')).folders as Array<{ id: string }>)
                .map(f => f.id)
        await expect.poll(storedOrder, { timeout: 5_000 }).toEqual(['f-beta', 'f-alpha', 'f-gamma'])

        // The drag must not also count as a click that expands the folder.
        const stored = JSON.parse(fs.readFileSync(path.join(userDataDir, 'config.json'), 'utf-8'))
        expect(stored.folders.find((f: { id: string }) => f.id === 'f-alpha').isExpanded).toBe(false)

        // A plain click still toggles expand.
        await page.locator('[data-testid="folder-header-f-gamma"]').click()
        await expect.poll(() =>
            JSON.parse(fs.readFileSync(path.join(userDataDir, 'config.json'), 'utf-8'))
                .folders.find((f: { id: string }) => f.id === 'f-gamma').isExpanded
        ).toBe(true)
    })
})
