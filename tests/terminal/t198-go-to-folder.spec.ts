import { test, expect, Page } from '@playwright/test'
import fs from 'fs'
import path from 'path'
import { launchAppWithWorkspaces, closeApp, chooseSidebarView, resizeMainWindow, LaunchResult } from './helpers'

/**
 * T198 — "Go to Folder" on a session row in All sessions (report 14d866d3, fb-1128).
 *
 * From List, Tree or a session folder, the item switches the sidebar to Folders (the same saved view
 * key as View ▾), opens the workspace folder (stored) and the workspace (in memory) that hold the
 * session, scrolls its row into view and marks it for a moment. The session on screen stays as it was.
 * The Folders view has no such item — the row is already there.
 *
 * `T198_SHOTS=<dir>` writes `<label>.png` (the menu) and `<label>-folders.png` (after the move);
 * `T198_LABEL` names them (default `after`).
 */

const TARGET = 's-t198-target'
const FILLERS = Array.from({ length: 10 }, (_, i) => ({ id: `s-t198-fill-${i}`, name: `T198 filler ${i}` }))

const visibleTerminal = (page: Page): Promise<string> => page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-session-id]'))
        .filter((el) => getComputedStyle(el).visibility === 'visible')
        .map((el) => el.getAttribute('data-session-id'))
        .join(',') || 'none')
const menu = (page: Page) => page.locator('[data-sidebar-menu="session"]')
const goToFolder = (page: Page) => menu(page).getByTestId('session-menu-go-to-folder')

test.describe('T198 Go to Folder from All sessions', () => {
    let ctx: LaunchResult | undefined
    test.afterEach(async () => {
        if (ctx) await closeApp(ctx)
        ctx = undefined
    })

    test('a session in a closed folder: List → Go to Folder opens the folder and shows the row', async () => {
        ctx = await launchAppWithWorkspaces(
            [
                // First and outside the folder: the harness waits for the first workspace's name.
                { id: 'ws-t198-top', name: 'T198 top', sessions: FILLERS },
                { id: 'ws-t198-in', name: 'T198 inside', folderId: 'f-t198', sessions: [{ id: 's-t198-other', name: 'T198 other' }, { id: TARGET, name: 'T198 target' }] }
            ],
            {
                folders: [{ id: 'f-t198', name: 'T198 folder', isExpanded: false, createdAt: 1700000000000 }],
                settings: { showHomeWorkspace: false }
            }
        )
        const { app, page, userDataDir } = ctx
        // Short window: the ten fillers push the folder below the fold, so the row has to be scrolled to.
        await resizeMainWindow(app, 1280, 520)
        const storedFolder = () => JSON.parse(fs.readFileSync(path.join(userDataDir, 'config.json'), 'utf-8'))
            .folders.find((f: { id: string }) => f.id === 'f-t198')?.isExpanded

        await page.locator('[data-session-item="s-t198-fill-0"]').first().click()
        await expect.poll(() => visibleTerminal(page)).toBe('s-t198-fill-0')
        await expect(page.locator('[data-workspace-item="ws-t198-in"]')).toHaveCount(0)

        // Folders view: no item, the row is already in its place.
        await page.locator('[data-session-item="s-t198-fill-1"]').first().click({ button: 'right' })
        await expect(menu(page)).toBeVisible()
        await expect(goToFolder(page)).toHaveCount(0)
        await page.keyboard.press('Escape')
        await page.locator('[data-session-item="s-t198-fill-0"]').first().click()

        await chooseSidebarView(page, 'list')
        await page.locator(`[data-testid="sidebar-all-sessions"] [data-session-item="${TARGET}"]`).click({ button: 'right' })
        await expect(goToFolder(page)).toBeVisible()
        const shots = process.env.T198_SHOTS
        const label = process.env.T198_LABEL || 'after'
        if (shots) { fs.mkdirSync(shots, { recursive: true }); await page.screenshot({ path: path.join(shots, `${label}.png`) }) }
        await goToFolder(page).click()

        await expect(page.locator('[data-testid="sidebar-view-menu"][data-view="folders"]')).toBeVisible()
        expect(await page.evaluate(() => localStorage.getItem('sidebar-view-mode'))).toBe('folders')
        await expect.poll(storedFolder).toBe(true)
        const row = page.locator(`[data-session-item="${TARGET}"]`)
        await expect(row).toHaveCount(1)
        await expect(row).toBeInViewport()
        await expect(row).toHaveAttribute('data-revealed', 'true')
        if (shots) await page.screenshot({ path: path.join(shots, `${label}-folders.png`) })
        // The mark fades; the session on screen is the one it was.
        await expect(row).not.toHaveAttribute('data-revealed', 'true', { timeout: 5_000 })
        expect(await visibleTerminal(page)).toBe('s-t198-fill-0')

        // A workspace closed by hand opens again, and Tree has the item too.
        await page.locator('[data-workspace-item="ws-t198-in"]').getByText('T198 inside', { exact: true }).click()
        await expect(row).toHaveCount(0)
        await chooseSidebarView(page, 'tree')
        await page.locator(`[data-session-item="${TARGET}"]`).first().click({ button: 'right' })
        await goToFolder(page).click()
        await expect(page.locator('[data-testid="sidebar-view-menu"][data-view="folders"]')).toBeVisible()
        await expect(row).toBeInViewport()

        expect(ctx.pageErrors).toEqual([])
    })

    test('leaving Folders while the row is still marked drops the mark — coming back later does not scroll or mark it again', async () => {
        ctx = await launchAppWithWorkspaces(
            [
                { id: 'ws-t198-top', name: 'T198 top', sessions: FILLERS },
                { id: 'ws-t198-in', name: 'T198 inside', folderId: 'f-t198', sessions: [{ id: TARGET, name: 'T198 target' }] }
            ],
            {
                folders: [{ id: 'f-t198', name: 'T198 folder', isExpanded: false, createdAt: 1700000000000 }],
                settings: { showHomeWorkspace: false }
            }
        )
        const { app, page } = ctx
        await resizeMainWindow(app, 1280, 520)
        await page.locator('[data-session-item="s-t198-fill-0"]').first().click()
        await chooseSidebarView(page, 'list')
        await page.locator(`[data-testid="sidebar-all-sessions"] [data-session-item="${TARGET}"]`).click({ button: 'right' })
        const row = page.locator(`[data-session-item="${TARGET}"]`)
        // Back to List straight away — well inside the 1.6 s mark — and stay there past it.
        const movedAt = Date.now()
        await goToFolder(page).click()
        await page.locator('[data-testid="sidebar-view-menu"][data-view="folders"]').waitFor()
        await chooseSidebarView(page, 'list')
        expect(Date.now() - movedAt).toBeLessThan(1_500)
        await page.waitForTimeout(2_500)
        // Folders again: the old target is not scrolled to or marked. Any mark set at all is recorded,
        // however short — the row may be drawn a frame after the switch.
        await page.evaluate(() => {
            const w = window as unknown as { __t198Marks: number }
            w.__t198Marks = 0
            new MutationObserver((records) => {
                for (const r of records) if ((r.target as Element).getAttribute?.('data-revealed') === 'true') w.__t198Marks++
            }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['data-revealed'] })
        })
        await chooseSidebarView(page, 'folders')
        await page.waitForTimeout(800)
        await expect(row).toHaveCount(1)
        expect(await page.evaluate(() => (window as unknown as { __t198Marks: number }).__t198Marks)).toBe(0)
        expect(ctx.pageErrors).toEqual([])
    })
})
