import { test, expect, Page } from '@playwright/test'
import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { launchAppWithWorkspaces, closeApp, writeToTerminal, resizeMainWindow, LaunchResult, REPO_ROOT } from './helpers'

/**
 * T150 — System Monitor popover in the app (fb-1117 9aebd089 · 67732aa2).
 *
 * Disk: the popover must show this Mac's real disk — the data volume, size − free — not the sealed
 * system volume `/` (the old popover said "11Gi / 926Gi · 11%" on a 90% full disk). The expected
 * numbers come from `df` run here, computed without the app's parser.
 *
 * Sessions: next to the saved total, how many are working and waiting right now, with the status
 * dots setting left off (the user's default) — counted when the popover opens, no reader ticking.
 *
 * Fails on the code before this change: no "working" count, and the disk is `/`'s Gi numbers.
 */

const AGENT = `node ${path.join(REPO_ROOT, 'scripts/mock-cli/agent-mock.cjs')} --box`
const HOME = 's150-home'
const WORK = 's150-work'
const ASK = 's150-ask'
const IDLE = 's150-idle'
const LOGS = 's150-logs'
const DATA_VOLUME = '/System/Volumes/Data'

let ctx: LaunchResult | null = null

test.afterEach(async () => {
    if (ctx) await closeApp(ctx)
    ctx = null
})

const shotsDir = (): string | undefined => {
    const shots = process.env.T150_SHOTS
    if (shots) fs.mkdirSync(shots, { recursive: true })
    return shots
}
const label = (): string => process.env.T150_LABEL ?? 'after'

/** This Mac's disk as Finder would put it, straight from df — independent of the app's parser. */
function expectedDisk(): { used: string; total: string; free: string; percent: number } {
    const mount = fs.existsSync(DATA_VOLUME) ? DATA_VOLUME : '/'
    const line = execFileSync('df', ['-kP', mount], { encoding: 'utf8' }).trim().split('\n')[1].split(/\s+/)
    const size = Number(line[1]) * 1024
    const free = Number(line[3]) * 1024
    const gb = (bytes: number): string => (bytes / 1e9 >= 1000 ? `${(bytes / 1e12).toFixed(1)} TB` : `${Math.round(bytes / 1e9)} GB`)
    return { used: gb(size - free), total: gb(size), free: gb(free), percent: Math.round(((size - free) / size) * 100) }
}

async function ticks(app: LaunchResult['app']): Promise<number> {
    return app.evaluate(() => ((globalThis as { __sessionScreenStatusTicks?: unknown[] }).__sessionScreenStatusTicks ?? []).length)
}

// Found by its text, not the new attributes, so the before capture works on the old popover too.
const popover = (page: Page) => page.locator('div.fixed', { hasText: 'Uptime' }).last()

test.describe('T150 system monitor popover', () => {
    test('disk is the data volume in Finder units; sessions show working and waiting right now', async () => {
        ctx = await launchAppWithWorkspaces(
            [{
                id: 'w-t150',
                name: 'T150 monitor',
                sessions: [
                    { id: HOME, name: 'T150 home' },
                    { id: WORK, name: 'T150 working', initialCommand: `${AGENT} --work-ms 600000` },
                    { id: ASK, name: 'T150 asking', initialCommand: AGENT },
                    { id: IDLE, name: 'T150 idle', initialCommand: AGENT },
                    { id: LOGS, name: 'T150 logs', initialCommand: 'while true; do echo "tick $RANDOM"; sleep 0.2; done' }
                ]
            }],
            // The status dots stay off: the count must not depend on them (or start their reader).
            { settings: { hooks: { enabled: false, claudeCode: { enabled: true, detectRunning: true, detectReady: true, detectError: false, showInSidebar: true, autoDismissSeconds: 5 } } } }
        )
        const { page, app } = ctx
        const shots = shotsDir()
        await resizeMainWindow(app, 1280, 800)
        await page.locator(`[data-session-item="${HOME}"]`).click()

        await expect.poll(async () => page.evaluate((id) => (window as unknown as { __termDebug: { text: (id: string) => string } }).__termDebug.text(id), ASK), { timeout: 20_000 }).toContain('❯')
        await writeToTerminal(page, WORK, 'go\r')
        await writeToTerminal(page, ASK, 'ASK\r')
        // Let the mocks draw their turn / question.
        await page.waitForTimeout(2500)

        const button = page.locator('button[title="System Monitor"]')
        await button.click()
        await expect(popover(page).getByText('Uptime', { exact: true })).toBeVisible({ timeout: 15_000 })
        if (shots) await page.screenshot({ path: path.join(shots, `monitor-popover-1280-${label()}.png`) })
        if (shots) await popover(page).screenshot({ path: path.join(shots, `monitor-popover-crop-${label()}.png`) })

        // Disk — the real one.
        const disk = expectedDisk()
        const diskRow = page.locator('[data-system-monitor="disk"]')
        await expect(diskRow.locator('[data-system-monitor-value]')).toHaveText(`${disk.used} / ${disk.total}`)
        await expect(diskRow.locator('[data-system-monitor-detail]')).toHaveText(`${disk.free} free`)
        await expect(diskRow.locator('[data-system-monitor-value]')).not.toContainText('Gi')

        const sessions = page.locator('[data-system-monitor="sessions"]')
        // Sessions — the saved total, and right now one working and one waiting (the idle agent and the shell are neither).
        // (The repo-root workspace also picks up its git worktrees, so the total is read from the saved config.)
        const saved = JSON.parse(fs.readFileSync(path.join(ctx.userDataDir, 'config.json'), 'utf8')) as { workspaces: Array<{ sessions?: unknown[] }> }
        const total = saved.workspaces.reduce((sum, w) => sum + (w.sessions?.length ?? 0), 0)
        expect(total).toBeGreaterThanOrEqual(5)
        await expect(sessions.locator('[data-system-monitor-total]')).toHaveText(String(total))
        const activity = page.locator('[data-system-monitor="activity"]')
        await expect(activity.locator('[data-system-monitor-working]')).toHaveAttribute('data-system-monitor-working', '1')
        await expect(activity.locator('[data-system-monitor-waiting]')).toHaveAttribute('data-system-monitor-waiting', '1')
        await expect(activity).toContainText('1 working')
        await expect(activity).toContainText('1 waiting')

        // Read on open only: the sidebar dots' reader never started.
        expect(await ticks(app)).toBe(0)

        // Answer the question, refresh: waiting goes to 0.
        await writeToTerminal(page, ASK, '1')
        await page.waitForTimeout(2000)
        await page.locator('button[title="Refresh"]').click()
        await expect(activity.locator('[data-system-monitor-waiting]')).toHaveAttribute('data-system-monitor-waiting', '0', { timeout: 10_000 })
        await expect(activity.locator('[data-system-monitor-working]')).toHaveAttribute('data-system-monitor-working', '1')

        // The popover stays inside the window at 1280.
        const box = await popover(page).boundingBox()
        const width = await page.evaluate(() => window.innerWidth)
        expect(box && box.x + box.width).toBeLessThanOrEqual(width)
    })
})
