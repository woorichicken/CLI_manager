import { test, expect } from '@playwright/test'
import { launchAppWithWorkspaces, closeApp, LaunchResult } from './helpers'

/**
 * T23 — the loading screens around a restart.
 *
 * Restoring many sessions blocks the window for seconds (measured: 167
 * sessions → 5–9s before the sidebar appears), and installing an update kills
 * every terminal before relaunching. Both used to show a still window. Pinned
 * here: the restore screen goes away once sessions are on screen — a loader
 * that never leaves is worse than none — and an install shows its own screen.
 */
test.describe('T23 busy overlay', () => {
    let ctx: LaunchResult

    test.afterEach(async () => {
        if (ctx) await closeApp(ctx)
    })

    test('the restore screen leaves once sessions are shown, and an install shows its own', async () => {
        ctx = await launchAppWithWorkspaces([
            { id: 'ws-a', name: 'T21A', sessions: [{ id: 's-a1', name: 'T21A1' }, { id: 's-a2', name: 'T21A2' }] },
            { id: 'ws-b', name: 'T21B', sessions: [{ id: 's-b1', name: 'T21B1' }] }
        ])
        const { page, app } = ctx
        const overlay = page.locator('[data-busy-overlay]')

        await expect(page.getByText('T21A').first()).toBeVisible()
        await expect(overlay).toHaveCount(0)
        await expect(page.getByText('Restoring sessions…')).toHaveCount(0)

        // What main sends right before it closes every terminal for an update.
        // Sent from main, not clicked: the real install would quit the app.
        await app.evaluate(({ BrowserWindow }) => {
            for (const win of BrowserWindow.getAllWindows()) win.webContents.send('update-status', { status: 'installing' })
        })
        await expect(overlay).toHaveCount(1)
        await expect(overlay).toContainText('Installing update…')

        expect(ctx.pageErrors).toEqual([])
    })
})
