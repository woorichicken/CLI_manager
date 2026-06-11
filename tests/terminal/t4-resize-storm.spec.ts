import { test, expect } from '@playwright/test'
import {
    launchAppWithSessions,
    closeApp,
    activateSession,
    writeToTerminal,
    resetDebugCounters,
    debugCounters,
    resizeMainWindow,
    saveMetrics,
    LaunchResult
} from './helpers'

/**
 * T4 — Resize storm: window resizes must not fan out to hidden terminals.
 *
 * Every pty resize sends SIGWINCH to the shell/CLI, which makes TUIs repaint
 * their whole UI (polluting scrollback and burning CPU). Hidden terminals
 * should defer pty resize until they become visible.
 */

test.describe('T4 resize storm', () => {
    let ctx: LaunchResult

    test.afterEach(async () => {
        if (ctx) await closeApp(ctx)
    })

    test('window resize only resizes the visible terminal pty', async () => {
        const sessions = Array.from({ length: 6 }, (_, i) => ({
            id: `sess-t4-${i + 1}`,
            name: `TSESS${i + 1}`
        }))
        ctx = await launchAppWithSessions(sessions)
        const { page, app } = ctx

        await activateSession(page, 'TSESS1')
        // Give every terminal a real running TUI so SIGWINCH repaints are observable
        for (const s of sessions) {
            await writeToTerminal(page, s.id, 'node scripts/mock-cli/claude-mock.cjs --duration 60 --fps 4 --hist 2\n')
        }
        await page.waitForTimeout(3000)

        await resetDebugCounters(page)

        // Simulate a user dragging the window through several sizes
        const sizes: Array<[number, number]> = [
            [1180, 780], [1100, 720], [1240, 820], [1000, 680], [1320, 860], [1200, 800]
        ]
        for (const [w, h] of sizes) {
            await resizeMainWindow(app, w, h)
            await page.waitForTimeout(300)
        }
        // Let debounced resizes + idle callbacks flush
        await page.waitForTimeout(4000)

        const counters = await debugCounters(page)
        const visibleResizes = counters.ptyResize['sess-t4-1'] ?? 0
        let hiddenResizes = 0
        const hiddenDetail: Record<string, number> = {}
        for (const s of sessions.slice(1)) {
            const n = counters.ptyResize[s.id] ?? 0
            hiddenDetail[s.id] = n
            hiddenResizes += n
        }

        saveMetrics('t4-resize', {
            windowResizes: sizes.length,
            visibleResizes,
            hiddenResizes,
            hiddenDetail,
            totalPtyResizes: counters.ptyResizeTotal
        })

        expect(visibleResizes, 'visible terminal should follow the window').toBeGreaterThan(0)
        expect(hiddenResizes, 'hidden terminals must not resize their ptys during the storm').toBe(0)

        // Switching to a hidden terminal applies its deferred size exactly once
        await resetDebugCounters(page)
        await activateSession(page, 'TSESS2')
        await page.waitForTimeout(2000)
        const afterSwitch = await debugCounters(page)
        const switchResizes = afterSwitch.ptyResize['sess-t4-2'] ?? 0

        saveMetrics('t4-switch', { switchResizes })

        expect(switchResizes, 'newly visible terminal applies its size').toBeGreaterThan(0)
        expect(switchResizes, 'no resize spam on session switch').toBeLessThanOrEqual(2)
    })
})
