import { test, expect, Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { launchAppWithWorkspaces, closeApp, resizeMainWindow, LaunchResult, REPO_ROOT } from './helpers'

/**
 * T157 — Status panel in the System Monitor (fb-1120b queues).
 *
 * With Settings › General › Status command set, opening the System Monitor runs it once and shows a
 * "Queues" section: blocked rows open with their items, an unreadable row says "Lookup failed", the
 * counts are the app's own (not the command's). It runs on open and on Refresh only — no polling.
 * With the setting empty the section is absent and the popover keeps its old width.
 *
 * Fails on the code before this change: there is no Queues section.
 */

const FIXTURES = path.join(REPO_ROOT, 'tests', 'terminal', 'fixtures', 'status-command')

let ctx: LaunchResult | null = null
test.afterEach(async () => {
    if (ctx) await closeApp(ctx)
    ctx = null
})

const popover = (page: Page) => page.locator('div.fixed', { hasText: 'Uptime' }).last()
const shots = (): string | undefined => {
    const dir = process.env.T157_SHOTS
    if (dir) fs.mkdirSync(dir, { recursive: true })
    return dir
}

async function openMonitor(page: Page): Promise<void> {
    await page.locator('button[title="System Monitor"]').click()
    await expect(popover(page).getByText('Uptime', { exact: true })).toBeVisible({ timeout: 15_000 })
}

test.describe('T157 status panel', () => {
    test('shows the command\'s queues on open, blocked rows first opened, no polling', async () => {
        const runLog = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 't157-')), 'runs.log')
        const command = `STATUS_FIXTURE_LOG="${runLog}" "${process.execPath}" "${path.join(FIXTURES, 'report.cjs')}"`
        ctx = await launchAppWithWorkspaces(
            [{ id: 'w-t157', name: 'T157 status', sessions: [{ id: 's157-home', name: 'T157 home' }] }],
            { settings: { statusCommand: command } }
        )
        const { page, app } = ctx
        await resizeMainWindow(app, 1280, 800)
        await page.locator('[data-session-item="s157-home"]').click()

        // Nothing ran before anyone looked.
        await page.waitForTimeout(1500)
        expect(fs.existsSync(runLog)).toBe(false)

        await openMonitor(page)
        const panel = page.locator('[data-status-panel]')
        await expect(panel.locator('[data-status-source="heavy"]')).toBeVisible({ timeout: 15_000 })
        if (shots()) await popover(page).screenshot({ path: path.join(shots()!, 'status-panel-1280.png') })

        // The app's counts, not the fixture's "ok: 99".
        await expect(panel.locator('[data-status-counts]')).toContainText('1 blocked')
        await expect(panel.locator('[data-status-counts]')).toContainText('1 check')
        await expect(panel.locator('[data-status-counts]')).toContainText('1 failed')

        const heavy = panel.locator('[data-status-source="heavy"]')
        await expect(heavy).toHaveAttribute('data-status-state', 'blocked')
        await expect(heavy).toContainText('Blocked')
        await expect(heavy.locator('[data-status-summary]')).toHaveText('used 2 · waiting 1')
        // Blocked rows open by themselves; a "check" row stays closed until clicked.
        await expect(heavy.locator('[data-status-item]')).toHaveText(['waiting pid 4242 for 21 min :: pnpm e2e'])
        const list = panel.locator('[data-status-source="list"]')
        await expect(list.locator('[data-status-item]')).toHaveCount(0)
        await list.locator('button').click()
        await expect(list.locator('[data-status-item]')).toHaveText(['contest-1106 10/12'])

        // A state the app does not know is a failed lookup, not a fine row.
        await expect(panel.locator('[data-status-source="remote"]')).toHaveAttribute('data-status-state', 'error')
        await expect(panel.locator('[data-status-source="remote"]')).toContainText('Lookup failed')

        // One run for the open; Refresh runs it again; leaving it open does not.
        expect(fs.readFileSync(runLog, 'utf8').trim().split('\n')).toHaveLength(1)
        await page.locator('button[title="Refresh"]').click()
        await expect.poll(() => fs.readFileSync(runLog, 'utf8').trim().split('\n').length, { timeout: 10_000 }).toBe(2)
        await page.waitForTimeout(3000)
        expect(fs.readFileSync(runLog, 'utf8').trim().split('\n')).toHaveLength(2)

        // Wider for the rows, still inside the window.
        const box = await popover(page).boundingBox()
        const width = await page.evaluate(() => window.innerWidth)
        expect(box?.width).toBe(380)
        expect(box && box.x + box.width).toBeLessThanOrEqual(width)
    })

    test('a failing command says so; no setting means no section', async () => {
        ctx = await launchAppWithWorkspaces(
            [{ id: 'w-t157b', name: 'T157 broken', sessions: [{ id: 's157-b', name: 'T157 b' }] }],
            { settings: { statusCommand: `"${process.execPath}" "${path.join(FIXTURES, 'broken.cjs')}"` } }
        )
        await ctx.page.locator('[data-session-item="s157-b"]').click()
        await openMonitor(ctx.page)
        await expect(ctx.page.locator('[data-status-error]')).toContainText('Status command failed: no JSON in the output (exit 1)', { timeout: 15_000 })
        await closeApp(ctx)

        ctx = await launchAppWithWorkspaces([{ id: 'w-t157c', name: 'T157 none', sessions: [{ id: 's157-c', name: 'T157 c' }] }])
        await ctx.page.locator('[data-session-item="s157-c"]').click()
        await openMonitor(ctx.page)
        await ctx.page.waitForTimeout(1500)
        await expect(ctx.page.locator('[data-status-panel]')).toHaveCount(0)
        const box = await popover(ctx.page).boundingBox()
        expect(box?.width).toBe(260)
        if (shots()) await popover(ctx.page).screenshot({ path: path.join(shots()!, 'status-panel-unset-1280.png') })
    })
})
