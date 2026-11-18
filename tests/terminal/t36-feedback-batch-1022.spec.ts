import { test, expect } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { launchAppWithWorkspaces, closeApp, resizeMainWindow, LaunchResult } from './helpers'

/**
 * T36 — night-1022 feedback batch (reports 2d0c0695, dfba0c2e, e8760b87).
 *
 * - The sidebar header and the main header draw their divider on the same line.
 * - "Show Playground" changes the sidebar, not just the stored value (same reasoning as T13).
 * - Cmd+Shift+L opens and closes the Related sessions dialog of the active tab.
 * - fb-1117 0e6c4a0a: Settings › General "Show Source Control" off hides the header's Source Control
 *   button and the split panes' Git Panel buttons; Review Diff stays. `T36_SHOTS=<dir>` (+ T36_LABEL)
 *   leaves header and Settings captures. Fails on the code before it: there is no such switch.
 *
 * The drag-region CSS (1e36db69, d2fc2339) and the stale terminal rows (a6166f8e) are not
 * covered here: Playwright cannot see Electron's OS-level drag regions, and the stale rows need
 * a streaming TUI — both were checked by reading the code paths (see the PR).
 */
test.describe('T36 feedback batch 1022', () => {
    let ctx: LaunchResult
    const tempDirs: string[] = []

    test.afterEach(async () => {
        if (ctx) await closeApp(ctx)
        for (const dir of tempDirs.splice(0)) {
            fs.rmSync(dir, { recursive: true, force: true })
        }
    })

    async function launch() {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'climanger-t36-'))
        tempDirs.push(dir)
        ctx = await launchAppWithWorkspaces([
            { id: 'ws-a', name: 'T36WS', path: dir, sessions: [{ id: 's-a', name: 'T36SESS' }] }
        ])
        await ctx.page.setViewportSize({ width: 1500, height: 950 })
        await expect(ctx.page.getByText('T36WS', { exact: true }).first()).toBeVisible({ timeout: 15_000 })
        return ctx.page
    }

    test('sidebar header and main header end on the same line', async () => {
        const page = await launch()
        const sidebarHeader = page.locator('div.glass-panel > div.draggable').filter({ hasText: 'Workspaces' }).first()
        const mainHeader = page.locator('div.flex-1.glass-panel > div.draggable').first()
        const sidebarBox = await sidebarHeader.boundingBox()
        const mainBox = await mainHeader.boundingBox()
        expect(sidebarBox).not.toBeNull()
        expect(mainBox).not.toBeNull()
        // Bottom edge = where the divider is drawn; a 1px tolerance covers sub-pixel rounding.
        expect(Math.abs((sidebarBox!.y + sidebarBox!.height) - (mainBox!.y + mainBox!.height))).toBeLessThanOrEqual(1)
        expect(Math.abs(sidebarBox!.y - mainBox!.y)).toBeLessThanOrEqual(1)
    })

    test('Show Playground off removes the Playground section', async () => {
        const page = await launch()
        const section = page.getByText('PLAYGROUND', { exact: true })
        await expect(section).toBeVisible()

        await page.locator('button[title^="Settings"]').click()
        await page.getByTestId('settings-show-playground').click()
        await page.getByRole('button', { name: 'Save', exact: true }).click()

        await expect(section).toHaveCount(0, { timeout: 15_000 })
        await expect(page.getByText('T36WS', { exact: true }).first()).toBeVisible()
    })

    test('Show Source Control off hides the header and split-pane Git buttons; on brings them back (fb-1117 0e6c4a0a)', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'climanger-t36sc-'))
        tempDirs.push(dir)
        ctx = await launchAppWithWorkspaces([
            { id: 'ws-sc', name: 'T36SC', path: dir, sessions: [{ id: 's-sc1', name: 'T36SC one' }, { id: 's-sc2', name: 'T36SC two' }] }
        ], { settings: { showHomeWorkspace: false } })
        const { app, page } = ctx
        await resizeMainWindow(app, 1280, 800)
        const shots = process.env.T36_SHOTS
        const label = process.env.T36_LABEL ?? 'after'
        const shot = async (name: string): Promise<void> => {
            if (!shots) return
            fs.mkdirSync(shots, { recursive: true })
            await page.waitForTimeout(300)
            await page.screenshot({ path: path.join(shots, `${name}-1280-${label}.png`) })
        }
        await page.locator('[data-session-item="s-sc1"]').first().click()

        const headerButton = page.locator('button[title="Source Control"]')
        const paneButtons = page.locator('button[title="Git Panel"]')
        await expect(headerButton).toHaveCount(1)
        await shot('header-source-control-on')

        await page.locator('button[title^="Settings"]').click()
        const toggle = page.getByTestId('settings-show-source-control')
        await expect(toggle).toHaveAttribute('aria-pressed', 'true')
        await toggle.scrollIntoViewIfNeeded()
        await shot('settings-show-source-control')
        await toggle.click()
        await expect(toggle).toHaveAttribute('aria-pressed', 'false')
        await page.getByRole('button', { name: 'Save', exact: true }).click()

        await expect(headerButton).toHaveCount(0, { timeout: 15_000 })
        // The buttons beside it stay (only Source Control goes).
        await expect(page.locator('button[title="Review Diff"]')).toHaveCount(1)
        await shot('header-source-control-off')
        const config = JSON.parse(fs.readFileSync(path.join(ctx.userDataDir, 'config.json'), 'utf8')) as { settings: { showSourceControl?: boolean } }
        expect(config.settings.showSourceControl).toBe(false)

        // Two sessions side by side: the pane headers have no Git button either, their other buttons stay.
        await page.getByTestId('sidebar-view-toggle').click()
        await page.getByTestId('all-sessions-layout-list').click()
        for (const id of ['s-sc1', 's-sc2']) {
            await page.locator(`[data-session-item="${id}"]`).first().hover()
            await page.locator(`[data-session-select="${id}"]`).click()
        }
        await page.getByTestId('session-selection-split').click()
        await expect(page.locator('button[title="Open in Grid Window"]')).toHaveCount(2, { timeout: 15_000 })
        await expect(paneButtons).toHaveCount(0)

        // On again: both panes get theirs back.
        await page.locator('button[title^="Settings"]').first().click()
        await page.getByTestId('settings-show-source-control').click()
        await page.getByRole('button', { name: 'Save', exact: true }).click()
        await expect(paneButtons).toHaveCount(2, { timeout: 15_000 })
    })

    test('Cmd+Shift+L toggles the Related sessions dialog', async () => {
        const page = await launch()
        await page.getByText('T36SESS', { exact: true }).first().click()

        const dialog = page.locator('[data-related-modal]')
        await page.keyboard.press('Meta+Shift+L')
        await expect(dialog).toBeVisible({ timeout: 10_000 })
        await expect(dialog).toHaveAttribute('data-related-modal', 's-a')

        await page.keyboard.press('Meta+Shift+L')
        await expect(dialog).toHaveCount(0, { timeout: 10_000 })
    })
})
