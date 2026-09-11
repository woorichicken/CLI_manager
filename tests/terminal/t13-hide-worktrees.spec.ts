import { test, expect } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { launchAppWithWorkspaces, closeApp, LaunchResult } from './helpers'

/**
 * T13 — "Show Worktrees" has to change the sidebar, not just the stored value.
 *
 * Driven through the real UI for the same reason T11 is: the setting travels
 * from Settings through App into three separate worktree lists in the sidebar,
 * and a value that saves correctly while the rows stay on screen is exactly the
 * failure a store-level assertion would miss.
 */
test.describe('T13 hide worktrees', () => {
    let ctx: LaunchResult
    const tempDirs: string[] = []

    test.afterEach(async () => {
        if (ctx) await closeApp(ctx)
        for (const dir of tempDirs.splice(0)) {
            fs.rmSync(dir, { recursive: true, force: true })
        }
    })

    test('turning the setting off removes worktree rows from the sidebar', async () => {
        // Plain directories: the startup worktree scan skips non-repos, so the
        // seeded worktree row survives until the setting hides it.
        const parentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'climanger-t13-'))
        tempDirs.push(parentDir)

        ctx = await launchAppWithWorkspaces([
            {
                id: 'ws-parent',
                name: 'T13PARENT',
                path: parentDir,
                sessions: [{ id: 's-parent', name: 'T13SESSPARENT' }]
            },
            {
                id: 'ws-worktree',
                name: 'T13WORKTREE',
                path: path.join(parentDir, 'wt'),
                parentWorkspaceId: 'ws-parent',
                branchName: 'T13WORKTREE',
                sessions: [{ id: 's-worktree', name: 'T13SESSWT' }]
            }
        ])
        const { page } = ctx
        await page.setViewportSize({ width: 1500, height: 950 })

        const worktreeRow = page.getByText('T13WORKTREE', { exact: true })

        // Workspaces render expanded, so the worktree row is on screen already.
        // Asserting it first keeps the "it disappeared" check below honest.
        await expect(worktreeRow.first()).toBeVisible({ timeout: 15_000 })

        // Settings > Git (Local) > Show Worktrees
        await page.locator('button[title="Settings"]').click()
        await page.getByRole('button', { name: 'Git (Local)', exact: true }).click()
        const toggleRow = page.locator('div.flex.items-center.justify-between')
            .filter({ hasText: 'Show Worktrees' })
        await toggleRow.locator('button').first().click()

        // Settings only apply on Save — Escape would discard the toggle.
        await page.getByRole('button', { name: 'Save', exact: true }).click()
        await expect(worktreeRow).toHaveCount(0, { timeout: 15_000 })

        // The parent is still there — only its worktree children went away.
        await expect(page.getByText('T13PARENT', { exact: true }).first()).toBeVisible()
    })
})
