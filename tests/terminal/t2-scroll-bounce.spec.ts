import { test, expect } from '@playwright/test'
import {
    launchAppWithSessions,
    closeApp,
    activateSession,
    writeToTerminal,
    scrollTerminal,
    termState,
    termText,
    waitForBufferText,
    resizeMainWindow,
    saveMetrics,
    LaunchResult,
    TermState
} from './helpers'

/**
 * T2 — Scroll position stability while a TUI keeps rendering.
 *
 * Starts the Claude Code-like mock TUI, scrolls the viewport up (as a user
 * reading history would), then samples viewport state. The viewport must NOT
 * jump back to the bottom while output continues.
 */

test.describe('T2 scroll bounce', () => {
    let ctx: LaunchResult

    test.afterEach(async () => {
        if (ctx) await closeApp(ctx)
    })

    test('viewport stays where the user scrolled during TUI output', async () => {
        ctx = await launchAppWithSessions([{ id: 'sess-t2', name: 'TSESS1' }])
        const { page } = ctx

        await activateSession(page, 'TSESS1')
        await page.waitForTimeout(1500)

        await writeToTerminal(
            page,
            'sess-t2',
            'node scripts/mock-cli/claude-mock.cjs --duration 20 --fps 12 --hist 25\n'
        )
        // Let history accumulate beyond one viewport
        await page.waitForTimeout(5000)

        // User scrolls up to read history. Capture state immediately (before
        // the next output frame) to prove the scroll itself took effect —
        // a later snapshot can already be polluted by the bounce bug.
        await scrollTerminal(page, 'sess-t2', -40)
        const initial = await termState(page, 'sess-t2')
        expect(initial).not.toBeNull()
        if (initial!.baseY === 0) {
            const tail = await termText(page, 'sess-t2', 40)
            console.log('[t2-diag] state:', JSON.stringify(initial))
            console.log('[t2-diag] buffer tail:\n' + tail)
        }
        expect(initial!.baseY, 'precondition: scrollback must exist').toBeGreaterThan(0)
        expect(initial!.atBottom, 'precondition: scroll-up must take effect').toBe(false)
        const bouncedImmediately = (await termState(page, 'sess-t2'))!.atBottom

        // Sample viewport while the TUI keeps rendering
        const samples: TermState[] = []
        for (let i = 0; i < 50; i++) {
            await page.waitForTimeout(200)
            const s = await termState(page, 'sess-t2')
            if (s) samples.push(s)
        }

        const bounces = samples.filter(s => s.atBottom).length
        let viewportJumps = 0
        for (let i = 1; i < samples.length; i++) {
            if (samples[i].viewportY !== samples[i - 1].viewportY) viewportJumps++
        }
        const final = samples[samples.length - 1]

        saveMetrics('t2-bounce', {
            initialViewportY: initial!.viewportY,
            initialBaseY: initial!.baseY,
            bouncedImmediately,
            bounces,
            viewportJumps,
            finalAtBottom: final.atBottom,
            finalViewportY: final.viewportY,
            sampleCount: samples.length
        })

        expect(bouncedImmediately, 'viewport must not snap back right after scrolling').toBe(false)
        expect(bounces, 'viewport must never snap to bottom while user is scrolled up').toBe(0)
        expect(final.atBottom, 'viewport must still be scrolled up at the end').toBe(false)
    })

    test('viewport stays put across TUI full-clear repaints', async () => {
        ctx = await launchAppWithSessions([{ id: 'sess-t2b', name: 'TSESS1' }])
        const { page } = ctx

        await activateSession(page, 'TSESS1')
        await page.waitForTimeout(1500)

        // Full clear (CSI 2J) every 20 frames — like CLI resize repaints
        await writeToTerminal(
            page,
            'sess-t2b',
            'node scripts/mock-cli/claude-mock.cjs --duration 20 --fps 10 --hist 20 --clear-every 20\n'
        )
        await page.waitForTimeout(5000)

        await scrollTerminal(page, 'sess-t2b', -40)
        const initial = await termState(page, 'sess-t2b')
        expect(initial!.atBottom, 'precondition: scroll-up must take effect').toBe(false)

        const samples: TermState[] = []
        for (let i = 0; i < 40; i++) {
            await page.waitForTimeout(200)
            const s = await termState(page, 'sess-t2b')
            if (s) samples.push(s)
        }
        const bounces = samples.filter(s => s.atBottom).length
        const final = samples[samples.length - 1]

        saveMetrics('t2-fullclear', {
            initialViewportY: initial!.viewportY,
            bounces,
            finalAtBottom: final.atBottom
        })

        expect(bounces, 'full-clear repaints must not snap the viewport to bottom').toBe(0)
    })

    test('viewport stays put when the window is resized while scrolled up', async () => {
        ctx = await launchAppWithSessions([{ id: 'sess-t2c', name: 'TSESS1' }])
        const { page, app } = ctx

        await activateSession(page, 'TSESS1')
        await page.waitForTimeout(1500)

        await writeToTerminal(
            page,
            'sess-t2c',
            'node scripts/mock-cli/claude-mock.cjs --duration 25 --fps 10 --hist 20\n'
        )
        await page.waitForTimeout(5000)

        await scrollTerminal(page, 'sess-t2c', -40)
        const initial = await termState(page, 'sess-t2c')
        expect(initial!.atBottom, 'precondition: scroll-up must take effect').toBe(false)

        // Resize the window twice while the user is reading history
        await resizeMainWindow(app, 1150, 760)
        await page.waitForTimeout(1500)
        const afterResize1 = await termState(page, 'sess-t2c')
        await resizeMainWindow(app, 1280, 840)
        await page.waitForTimeout(1500)
        const afterResize2 = await termState(page, 'sess-t2c')

        saveMetrics('t2-resize', {
            initialAtBottom: initial!.atBottom,
            afterResize1AtBottom: afterResize1!.atBottom,
            afterResize2AtBottom: afterResize2!.atBottom
        })

        expect(afterResize1!.atBottom, 'resize #1 must not snap viewport to bottom').toBe(false)
        expect(afterResize2!.atBottom, 'resize #2 must not snap viewport to bottom').toBe(false)
    })

    test('scroll position survives switching to another session and back', async () => {
        ctx = await launchAppWithSessions([
            { id: 'sess-t2d-1', name: 'TSESS1' },
            { id: 'sess-t2d-2', name: 'TSESS2' }
        ])
        const { page } = ctx

        await activateSession(page, 'TSESS1')
        await page.waitForTimeout(1500)

        await writeToTerminal(
            page,
            'sess-t2d-1',
            'node scripts/mock-cli/claude-mock.cjs --duration 30 --fps 8 --hist 15\n'
        )
        await page.waitForTimeout(5000)

        await scrollTerminal(page, 'sess-t2d-1', -40)
        const initial = await termState(page, 'sess-t2d-1')
        expect(initial!.atBottom, 'precondition: scroll-up must take effect').toBe(false)

        // Switch away and back while output continues
        await activateSession(page, 'TSESS2')
        await page.waitForTimeout(2000)
        await activateSession(page, 'TSESS1')
        await page.waitForTimeout(1000)

        const afterSwitch = await termState(page, 'sess-t2d-1')

        saveMetrics('t2-switch', {
            initialViewportY: initial!.viewportY,
            afterSwitchViewportY: afterSwitch!.viewportY,
            afterSwitchAtBottom: afterSwitch!.atBottom
        })

        expect(afterSwitch!.atBottom, 'returning to the session must not lose the scroll position').toBe(false)
    })

    test('viewport content does not drift once scrollback is at capacity', async () => {
        ctx = await launchAppWithSessions([{ id: 'sess-t2e', name: 'TSESS1' }])
        const { page } = ctx

        await activateSession(page, 'TSESS1')
        await page.waitForTimeout(1500)

        // Fill scrollback past the 10k cap, then keep output flowing
        await writeToTerminal(page, 'sess-t2e', 'seq 1 12000; echo FILL-DONE\n')
        await waitForBufferText(page, 'sess-t2e', 'FILL-DONE', 120_000)
        await writeToTerminal(
            page,
            'sess-t2e',
            'node scripts/mock-cli/claude-mock.cjs --duration 15 --fps 10 --hist 20\n'
        )
        await page.waitForTimeout(3000)

        await scrollTerminal(page, 'sess-t2e', -40)
        const initial = await termState(page, 'sess-t2e')
        expect(initial!.atBottom, 'precondition: scroll-up must take effect').toBe(false)

        const samples: TermState[] = []
        for (let i = 0; i < 40; i++) {
            await page.waitForTimeout(200)
            const s = await termState(page, 'sess-t2e')
            if (s) samples.push(s)
        }
        const bounces = samples.filter(s => s.atBottom).length
        // Content drift: the text under the user's eyes must not change while
        // they are reading history — even though new output keeps trimming the
        // scrollback at capacity.
        let contentDrifts = 0
        for (let i = 1; i < samples.length; i++) {
            if (samples[i].topLine !== samples[i - 1].topLine) contentDrifts++
        }

        saveMetrics('t2-capacity', {
            initialViewportY: initial!.viewportY,
            initialBaseY: initial!.baseY,
            bounces,
            contentDrifts,
            firstTopLine: samples[0]?.topLine?.slice(0, 40),
            lastTopLine: samples[samples.length - 1]?.topLine?.slice(0, 40),
            finalAtBottom: samples[samples.length - 1].atBottom
        })

        expect(bounces, 'trimming at capacity must not snap the viewport to bottom').toBe(0)
        expect(contentDrifts, 'content under the viewport must not drift while reading').toBeLessThanOrEqual(1)
    })

    test('viewport stays put while a real claude recording replays', async () => {
        ctx = await launchAppWithSessions([{ id: 'sess-t2f', name: 'TSESS1' }])
        const { page } = ctx

        await activateSession(page, 'TSESS1')
        await page.waitForTimeout(1500)

        // Some real history first, then the recorded claude byte stream
        await writeToTerminal(page, 'sess-t2f', 'seq 1 3000; echo FILL-DONE\n')
        await waitForBufferText(page, 'sess-t2f', 'FILL-DONE', 60_000)
        await writeToTerminal(
            page,
            'sess-t2f',
            'node scripts/mock-cli/replay.cjs scripts/mock-cli/recordings/claude.jsonl --speed 3 --max-delay 300 --loop 2\n'
        )
        await page.waitForTimeout(3000)

        await scrollTerminal(page, 'sess-t2f', -60)
        const initial = await termState(page, 'sess-t2f')
        expect(initial!.atBottom, 'precondition: scroll-up must take effect').toBe(false)

        const samples: TermState[] = []
        for (let i = 0; i < 60; i++) {
            await page.waitForTimeout(200)
            const s = await termState(page, 'sess-t2f')
            if (s) samples.push(s)
        }
        const bounces = samples.filter(s => s.atBottom).length
        let contentDrifts = 0
        for (let i = 1; i < samples.length; i++) {
            if (samples[i].topLine !== samples[i - 1].topLine) contentDrifts++
        }

        saveMetrics('t2-replay', {
            bounces,
            contentDrifts,
            finalAtBottom: samples[samples.length - 1].atBottom
        })

        expect(bounces, 'real claude output must not snap the viewport to bottom').toBe(0)
        expect(contentDrifts, 'content must not drift during real claude output').toBeLessThanOrEqual(1)
    })
})
