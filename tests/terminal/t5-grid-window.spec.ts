import { test, expect } from '@playwright/test'
import {
    launchAppWithSessions,
    closeApp,
    activateSession,
    writeToTerminal,
    waitForBufferText,
    termText,
    saveMetrics,
    LaunchResult
} from './helpers'

/**
 * T5 — Grid Window smoke test.
 *
 * The Grid Window is a second BrowserWindow attaching a SECOND xterm to the
 * same pty stream (main window keeps its hidden TerminalView mounted). This
 * exercises: batched output fan-out to multiple windows, pty resize ownership
 * hand-off (main defers while hidden, grid drives), and recovery after the
 * grid window closes.
 */

test.describe('T5 grid window', () => {
    let ctx: LaunchResult

    test.afterEach(async () => {
        if (ctx) await closeApp(ctx)
    })

    test('grid window receives output and main window survives its close', async () => {
        ctx = await launchAppWithSessions([
            { id: 'sess-t5-1', name: 'TSESS1' },
            { id: 'sess-t5-2', name: 'TSESS2' }
        ])
        const { app, page } = ctx

        await activateSession(page, 'TSESS1')
        await page.waitForTimeout(1500)

        // Open the grid window for session 1
        const gridPagePromise = app.waitForEvent('window', { timeout: 30_000 })
        await page.evaluate(() =>
            (window as unknown as { api: { openFullscreenTerminal: (ids: string[]) => Promise<boolean> } })
                .api.openFullscreenTerminal(['sess-t5-1'])
        )
        const gridPage = await gridPagePromise
        const gridErrors: string[] = []
        gridPage.on('pageerror', err => gridErrors.push(String(err)))

        // Grid window registers its own xterm for the same session
        await gridPage.waitForFunction(
            () => {
                const dbg = (window as unknown as { __termDebug?: { ids: () => string[] } }).__termDebug
                return Boolean(dbg && dbg.ids().includes('sess-t5-1'))
            },
            undefined,
            { timeout: 30_000 }
        )
        await gridPage.waitForTimeout(1500) // grid xterm fit + pty resize settle

        // Output must reach BOTH windows (broadcast of batched chunks)
        await writeToTerminal(page, 'sess-t5-1', 'echo GRID-SMOKE-$((40+2))\n')
        await waitForBufferText(page, 'sess-t5-1', 'GRID-SMOKE-42', 30_000)

        const gridText: string = await gridPage.evaluate(() =>
            (window as unknown as { __termDebug: { text: (id: string, m?: number) => string | null } })
                .__termDebug.text('sess-t5-1', 80) ?? ''
        )
        expect(gridText, 'grid window xterm must receive the same output').toContain('GRID-SMOKE-42')

        // Close the grid window and verify the main-window terminal recovers
        await gridPage.close()
        await page.waitForTimeout(1500) // main view becomes visible again, re-fits

        await writeToTerminal(page, 'sess-t5-1', 'echo AFTER-CLOSE-$((50+5))\n')
        await waitForBufferText(page, 'sess-t5-1', 'AFTER-CLOSE-55', 30_000)
        const mainText = await termText(page, 'sess-t5-1', 80)

        saveMetrics('t5-grid', {
            gridReceivedOutput: gridText.includes('GRID-SMOKE-42'),
            mainAliveAfterClose: mainText.includes('AFTER-CLOSE-55'),
            gridPageErrors: gridErrors.length,
            mainPageErrors: ctx.pageErrors.length
        })

        expect(mainText, 'main terminal must keep working after grid close').toContain('AFTER-CLOSE-55')
        expect(gridErrors, 'no renderer errors in grid window').toEqual([])
        expect(ctx.pageErrors, 'no renderer errors in main window').toEqual([])
    })
})
