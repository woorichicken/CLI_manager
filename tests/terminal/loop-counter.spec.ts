import { test, expect } from '@playwright/test'
import { LoopCounter } from '../../src/main/LoopCounter'

/**
 * Pure unit tests for LoopCounter — no Electron, no real timers.
 *
 * LoopCounter takes `now` as an explicit parameter, so iteration counting,
 * skip-first (claude startup), debounce, reset, and the count modes can be
 * verified deterministically. This pins the exact counting semantics that the
 * timing-based t6 E2E can only assert loosely.
 */

test.describe('LoopCounter', () => {
    test('settle mode: skips the startup settle, then counts each iteration', () => {
        const c = new LoopCounter({ countMode: 'settle', debounceMs: 0 })
        c.registerSession('t')

        // First running→ready = claude startup → skipped.
        c.recordStatus('t', 'running', 0)
        c.recordStatus('t', 'ready', 10)
        expect(c.getCount('t')).toBe(0)

        // Iteration 1.
        c.recordStatus('t', 'running', 20)
        c.recordStatus('t', 'ready', 30)
        expect(c.getCount('t')).toBe(1)

        // Iteration 2.
        c.recordStatus('t', 'running', 40)
        c.recordStatus('t', 'ready', 50)
        expect(c.getCount('t')).toBe(2)
        expect(c.getLastAt('t')).toBe(50)
    })

    test('debounce collapses sub-window flicker into one iteration', () => {
        const c = new LoopCounter({ countMode: 'settle', debounceMs: 1000 })
        c.registerSession('t')

        // Startup (skipped).
        c.recordStatus('t', 'running', 0)
        c.recordStatus('t', 'ready', 100)
        expect(c.getCount('t')).toBe(0)

        // Iteration 1 at t=200.
        c.recordStatus('t', 'running', 150)
        c.recordStatus('t', 'ready', 200)
        expect(c.getCount('t')).toBe(1)

        // Flicker settle at t=500 (only 300ms after the last count < 1000ms) → swallowed.
        c.recordStatus('t', 'running', 300)
        c.recordStatus('t', 'ready', 500)
        expect(c.getCount('t')).toBe(1)

        // Real iteration at t=1300 (1100ms after the last count ≥ 1000ms) → counts.
        c.recordStatus('t', 'running', 1200)
        c.recordStatus('t', 'ready', 1300)
        expect(c.getCount('t')).toBe(2)
    })

    test('reset re-arms skip-first so the post-restart startup is not counted', () => {
        const c = new LoopCounter({ countMode: 'settle', debounceMs: 0 })
        c.registerSession('t')

        c.recordStatus('t', 'running', 0)
        c.recordStatus('t', 'ready', 10) // startup skipped
        c.recordStatus('t', 'running', 20)
        c.recordStatus('t', 'ready', 30) // iteration 1
        expect(c.getCount('t')).toBe(1)

        c.reset('t')
        expect(c.getCount('t')).toBe(0)
        expect(c.getLastAt('t')).toBeNull()

        // Post-restart startup settle → skipped again.
        c.recordStatus('t', 'running', 40)
        c.recordStatus('t', 'ready', 50)
        expect(c.getCount('t')).toBe(0)

        // First real iteration after restart.
        c.recordStatus('t', 'running', 60)
        c.recordStatus('t', 'ready', 70)
        expect(c.getCount('t')).toBe(1)
    })

    test('start mode: counts ready→running, skipping the first (startup) start', () => {
        const c = new LoopCounter({ countMode: 'start', debounceMs: 0 })
        c.registerSession('t')

        // First ready→running = startup → skipped.
        c.recordStatus('t', 'running', 0)
        expect(c.getCount('t')).toBe(0)
        // running→ready does not count in start mode.
        c.recordStatus('t', 'ready', 10)
        expect(c.getCount('t')).toBe(0)
        // Next ready→running = iteration 1.
        c.recordStatus('t', 'running', 20)
        expect(c.getCount('t')).toBe(1)
    })

    test('start mode after reset (from stopped) counts the first iteration, not off-by-one', () => {
        const c = new LoopCounter({ countMode: 'start', debounceMs: 0 })
        c.registerSession('t')

        c.recordStatus('t', 'running', 0) // boot start → skipped
        c.recordStatus('t', 'ready', 10)
        c.recordStatus('t', 'running', 20) // iteration 1
        expect(c.getCount('t')).toBe(1)

        // Session goes stopped, then the user restarts it.
        c.recordStatus('t', 'stopped', 30)
        c.reset('t')
        expect(c.getCount('t')).toBe(0)

        // Post-restart: boot start skipped (previousStatus rebaselined to 'ready'),
        // then the first real iteration counts — NOT skipped.
        c.recordStatus('t', 'running', 40) // boot start after restart → skipped
        c.recordStatus('t', 'ready', 50)
        c.recordStatus('t', 'running', 60) // first real iteration → count 1
        expect(c.getCount('t')).toBe(1)
    })

    test('customPattern mode counts every match (no skip-first) and ignores status', () => {
        const c = new LoopCounter({ countMode: 'settle', debounceMs: 0, customPattern: 'DONE' })
        c.registerSession('t')

        c.recordOutput('t', 'working...\n', 0) // no match
        expect(c.getCount('t')).toBe(0)

        // First match counts — pattern markers are explicit, so no startup skip.
        c.recordOutput('t', 'iteration DONE\n', 10)
        expect(c.getCount('t')).toBe(1)
        c.recordOutput('t', 'another DONE\n', 20)
        expect(c.getCount('t')).toBe(2)

        // Status transitions are ignored when a pattern is active.
        c.recordStatus('t', 'running', 30)
        c.recordStatus('t', 'ready', 40)
        expect(c.getCount('t')).toBe(2)
    })

    test("'stopped' status never counts", () => {
        const c = new LoopCounter({ countMode: 'settle', debounceMs: 0 })
        c.registerSession('t')

        c.recordStatus('t', 'running', 0)
        c.recordStatus('t', 'ready', 10) // startup skipped
        c.recordStatus('t', 'running', 20)
        c.recordStatus('t', 'ready', 30) // iteration 1
        c.recordStatus('t', 'stopped', 40)
        expect(c.getCount('t')).toBe(1)
    })

    test('an invalid customPattern falls back to status-based counting', () => {
        // Unbalanced bracket → RegExp throws → patternRegex stays null → status mode.
        const c = new LoopCounter({ countMode: 'settle', debounceMs: 0, customPattern: '[' })
        c.registerSession('t')

        c.recordStatus('t', 'running', 0)
        c.recordStatus('t', 'ready', 10) // startup skipped
        c.recordStatus('t', 'running', 20)
        c.recordStatus('t', 'ready', 30) // iteration 1 via status fallback
        expect(c.getCount('t')).toBe(1)
    })
})
