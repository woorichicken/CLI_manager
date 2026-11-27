import { test, expect, Page, _electron as electron } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { launchAppWithWorkspaces, closeApp, resizeMainWindow, LaunchResult, REPO_ROOT } from './helpers'

/**
 * T192 — one View ▾ dropdown in the sidebar toolbar (view-filter-1127, person 11-27: 「view list, tree 있는데,
 * 이게 드롭다운으로 있고, 위에 폴더 별로 보는것도 아래로 내려오는게 맞는거 같다」).
 *
 * The header's view toggle is gone; the toolbar above the list carries View ▾ (Folders · List · Tree) in both
 * views, the Threads icon stays beside it in All sessions, and the folder view gets New session too. Judged in
 * the DOM (which view is on screen, which option is checked), localStorage (the same keys as before), the
 * toolbar's widths, and across a restart with values the old toggle wrote. On the old code there is no
 * `sidebar-view-menu`, so every test fails at its first step.
 * `T192_SHOTS=<dir>` keeps 1280 (left 560px) and 390 captures of each state.
 */

const SHOTS = process.env.T192_SHOTS
const LABEL = process.env.T192_LABEL ?? 'after'

const IDS = { lead: 's-t192-lead', work: 's-t192-work', talk: 's-t192-talk', other: 's-t192-other' }

const storage = (page: Page) => page.evaluate(() => ({
    view: localStorage.getItem('sidebar-view-mode'),
    layout: localStorage.getItem('sidebar-all-sessions-layout')
}))

/** Width checks for the toolbar: nothing pushed out, New session's label whole. */
const toolbarFit = (page: Page) => page.evaluate(() => {
    const bar = document.querySelector('[data-testid="all-sessions-toolbar"]') as HTMLElement
    const ns = bar.querySelector('[data-testid="all-sessions-new-session"]') as HTMLElement
    const label = ns.querySelector('span') as HTMLElement
    const right = bar.getBoundingClientRect().right
    return {
        barFits: bar.scrollWidth <= bar.clientWidth,
        labelWhole: label.scrollWidth <= label.clientWidth,
        newSessionInside: ns.getBoundingClientRect().right <= right + 0.5,
        newSessionWidth: Math.round(ns.getBoundingClientRect().width)
    }
})

test.describe('T192 sidebar View menu', () => {
    let ctx: LaunchResult | undefined
    let relaunched: Awaited<ReturnType<typeof electron.launch>> | null = null
    const dirs: string[] = []
    const dir = (prefix: string): string => {
        const made = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
        dirs.push(made)
        return made
    }
    test.afterEach(async () => {
        if (ctx) await closeApp(ctx)
        ctx = undefined
        if (relaunched) await relaunched.close().catch(() => undefined)
        relaunched = null
        for (const made of dirs.splice(0)) fs.rmSync(made, { recursive: true, force: true })
    })

    async function launch(settings: Record<string, unknown> = {}): Promise<LaunchResult> {
        const folder = dir('climanger-t192-ws-')
        ctx = await launchAppWithWorkspaces(
            [{ id: 'ws-t192', name: 'T192WS', path: folder, sessions: [
                { id: IDS.lead, name: 'T192 lead' },
                { id: IDS.work, name: 'T192 work', role: 'work' },
                { id: IDS.talk, name: 'T192 talk' },
                { id: IDS.other, name: 'T192 other' }
            ] }],
            {
                settings: { showHomeWorkspace: false, ...settings },
                config: { sessionRelations: [{ from: IDS.lead, to: IDS.work, kind: 'opened', at: 1 }] },
                env: { CLIMANAGER_HOME: dir('climanger-t192-home-') }
            }
        )
        return ctx
    }

    async function shot(page: Page, name: string, width: number): Promise<void> {
        if (!SHOTS) return
        fs.mkdirSync(SHOTS, { recursive: true })
        await page.mouse.move(width - 10, 700)
        await page.waitForTimeout(150)
        await page.screenshot({
            path: path.join(SHOTS, `${LABEL}-${name}-${width}.png`),
            ...(width > 600 ? { clip: { x: 0, y: 0, width: 560, height: 800 } } : {})
        })
    }

    test('the dropdown switches Folders · List · Tree, keeps the old keys, and survives a restart', async () => {
        const { page, app } = await launch()
        const chip = page.getByTestId('sidebar-view-menu')
        const menu = page.getByTestId('sidebar-view-menu-list')

        // The header toggle is gone; the folder view now has the toolbar with View ▾ and New session.
        await expect(page.getByTestId('sidebar-workspace-list')).toBeVisible()
        await expect(page.getByTestId('sidebar-view-toggle')).toHaveCount(0)
        await expect(chip).toHaveAttribute('data-view', 'folders')
        await expect(chip).toHaveText(/Folders/)
        await expect(page.getByTestId('all-sessions-new-session')).toBeVisible()
        await expect(page.getByTestId('all-sessions-threads')).toHaveCount(0)
        for (const width of [1280, 390]) {
            await resizeMainWindow(app, width, width === 390 ? 844 : 800)
            await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width)
            await shot(page, 'folders', width)
        }
        await resizeMainWindow(app, 1280, 800)

        // Open: three options, the current one checked and focused. Pressing the chip again closes it.
        await chip.click()
        await expect(menu).toBeVisible()
        await expect(menu.locator('[data-view-option]')).toHaveCount(3)
        await expect(menu.locator('[data-view-option="folders"]')).toHaveAttribute('aria-checked', 'true')
        await expect(menu.locator('[data-view-option="folders"]')).toBeFocused()
        await shot(page, 'folders-open', 1280)
        await chip.click()
        await expect(menu).toHaveCount(0)

        // Keyboard: ↓ then Enter picks List — All sessions, the same keys as the old toggle wrote.
        await chip.click()
        await page.keyboard.press('ArrowDown')
        await expect(menu.locator('[data-view-option="list"]')).toBeFocused()
        await page.keyboard.press('Enter')
        await expect(menu).toHaveCount(0)
        await expect(page.getByTestId('sidebar-all-sessions')).toBeVisible()
        await expect(chip).toHaveAttribute('data-view', 'list')
        await expect(chip).toBeFocused()
        expect(await storage(page)).toEqual({ view: 'all', layout: 'list' })
        // Threads stays the icon beside the dropdown.
        await expect(page.getByTestId('all-sessions-threads')).toBeVisible()
        for (const width of [1280, 390]) {
            await resizeMainWindow(app, width, width === 390 ? 844 : 800)
            await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width)
            expect(await toolbarFit(page)).toMatchObject({ barFits: true, labelWhole: true, newSessionInside: true })
            await shot(page, 'list', width)
            await chip.click()
            await expect(menu).toBeVisible()
            // The menu stays inside the window.
            const box = (await menu.boundingBox())!
            expect(box.x + box.width).toBeLessThanOrEqual(width)
            await shot(page, 'list-open', width)
            await page.keyboard.press('Escape')
            await expect(menu).toHaveCount(0)
        }
        await resizeMainWindow(app, 1280, 800)

        // ↑ wraps from the top; a click outside closes without choosing.
        await chip.click()
        await expect(menu.locator('[data-view-option="list"]')).toBeFocused()
        await page.keyboard.press('ArrowUp')
        await expect(menu.locator('[data-view-option="folders"]')).toBeFocused()
        await page.keyboard.press('ArrowUp')
        await expect(menu.locator('[data-view-option="tree"]')).toBeFocused()
        await page.mouse.click(900, 500)
        await expect(menu).toHaveCount(0)
        await expect(chip).toHaveAttribute('data-view', 'list')

        // Tree by click.
        await chip.click()
        await menu.locator('[data-view-option="tree"]').click()
        await expect(page.getByTestId('sidebar-session-tree')).toBeVisible()
        await expect(chip).toHaveAttribute('data-view', 'tree')
        expect(await storage(page)).toEqual({ view: 'all', layout: 'tree' })
        await shot(page, 'tree', 1280)

        // The toolbar does not scroll away with a long list: it sits above the scrolling part.
        const listBox = (await page.getByTestId('sidebar-all-sessions').boundingBox())!
        const barBox = (await page.getByTestId('all-sessions-toolbar').boundingBox())!
        expect(barBox.y + barBox.height).toBeLessThanOrEqual(listBox.y + 0.5)

        // New session from the folder view opens the same dialog.
        await chip.click()
        await menu.locator('[data-view-option="folders"]').click()
        await expect(page.getByTestId('sidebar-workspace-list')).toBeVisible()
        expect(await storage(page)).toEqual({ view: 'folders', layout: 'tree' })
        await page.getByTestId('all-sessions-new-session').click()
        await expect(page.locator('[data-new-session-dialog]')).toBeVisible()
        await page.keyboard.press('Escape')
        await expect(page.locator('[data-new-session-dialog]')).toHaveCount(0)

        // Back to Tree, then restart: the same view comes back.
        await chip.click()
        await menu.locator('[data-view-option="tree"]').click()
        await expect(page.getByTestId('sidebar-session-tree')).toBeVisible()
        const userDataDir = ctx!.userDataDir
        await ctx!.app.close()
        dirs.push(userDataDir)
        ctx = undefined
        relaunched = await electron.launch({
            args: [path.join(REPO_ROOT, 'out/main/index.js')],
            env: { ...process.env, CLIMANGER_TEST_USERDATA: userDataDir, CLIMANGER_TERM_DEBUG: '1', CLIMANGER_TEST_HEADLESS: '1' } as Record<string, string>
        })
        const again = await relaunched.firstWindow()
        await expect(again.getByTestId('sidebar-session-tree')).toBeVisible({ timeout: 30_000 })
        await expect(again.getByTestId('sidebar-view-menu')).toHaveAttribute('data-view', 'tree')
    })

    test('values the old toggle saved open as before; with the tree off there is no Tree option', async () => {
        // The old app wrote these keys; the new one must read them unchanged.
        const first = await launch({ showSessionTree: false })
        await first.page.evaluate(() => {
            localStorage.setItem('sidebar-view-mode', 'all')
            localStorage.setItem('sidebar-all-sessions-layout', 'tree')
        })
        const userDataDir = first.userDataDir
        await first.app.close()
        dirs.push(userDataDir)
        ctx = undefined
        relaunched = await electron.launch({
            args: [path.join(REPO_ROOT, 'out/main/index.js')],
            env: { ...process.env, CLIMANGER_TEST_USERDATA: userDataDir, CLIMANGER_TERM_DEBUG: '1', CLIMANGER_TEST_HEADLESS: '1' } as Record<string, string>
        })
        const page = await relaunched.firstWindow()
        // All sessions, shown as List because Settings turns the tree off — the saved Tree is kept for later.
        await expect(page.getByTestId('sidebar-all-sessions')).toBeVisible({ timeout: 30_000 })
        await expect(page.getByTestId('sidebar-session-tree')).toHaveCount(0)
        const chip = page.getByTestId('sidebar-view-menu')
        await expect(chip).toHaveAttribute('data-view', 'list')
        await chip.click()
        const menu = page.getByTestId('sidebar-view-menu-list')
        await expect(menu.locator('[data-view-option]')).toHaveCount(2)
        await expect(menu.locator('[data-view-option="tree"]')).toHaveCount(0)
        await expect(menu.locator('[data-view-option="list"]')).toHaveAttribute('aria-checked', 'true')
        await page.keyboard.press('Escape')
        expect(await storage(page)).toEqual({ view: 'all', layout: 'tree' })
    })
})
