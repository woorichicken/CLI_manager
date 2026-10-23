import { test, expect } from '@playwright/test'
import Module from 'module'

/**
 * T42 — the pty size a renderer asks for is checked in main before node-pty sees it (unit, no Electron).
 *
 * `terminal-create` and `terminal-resize` take cols/rows straight from a renderer. Since hidden sessions
 * measure their own box (T41), a box caught mid-layout can hand over a fraction or a sliver, and a bad
 * message could hand over anything. Both handlers go through clampPtySize: whole cells, 2x1 at least,
 * 1000x500 at most, the default 80x30 for what is not a number.
 */

// TerminalManager loads node-pty at import, built for Electron's ABI; the guard needs none of it.
type Loader = (request: string, parent: unknown, isMain: boolean) => unknown
const moduleWithLoad = Module as unknown as { _load: Loader }
const realLoad = moduleWithLoad._load
moduleWithLoad._load = function (request, parent, isMain) {
    if (request === 'node-pty') return {}
    return realLoad.call(this, request, parent, isMain)
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const manager = require('../../src/main/TerminalManager') as typeof import('../../src/main/TerminalManager')
moduleWithLoad._load = realLoad
const { clampPtySize, PTY_MIN_COLS, PTY_MIN_ROWS, PTY_MAX_COLS, PTY_MAX_ROWS } = manager

test.describe('T42 pty size guard', () => {
    test('an ordinary size passes through unchanged', () => {
        expect(clampPtySize(111, 43)).toEqual({ cols: 111, rows: 43 })
    })

    test('fractions are cut down to whole cells', () => {
        expect(clampPtySize(103.9, 42.5)).toEqual({ cols: 103, rows: 42 })
    })

    test('a sliver or a negative size is raised to the floor', () => {
        expect(clampPtySize(1, 0)).toEqual({ cols: PTY_MIN_COLS, rows: PTY_MIN_ROWS })
        expect(clampPtySize(-5, -1)).toEqual({ cols: 2, rows: 1 })
        expect(clampPtySize(0.4, 0.9)).toEqual({ cols: 2, rows: 1 })
    })

    test('a huge size is cut to the ceiling', () => {
        expect(clampPtySize(5000, 9000)).toEqual({ cols: PTY_MAX_COLS, rows: PTY_MAX_ROWS })
        expect(clampPtySize(Number.MAX_SAFE_INTEGER, 501)).toEqual({ cols: 1000, rows: 500 })
    })

    test('anything that is not a finite number gets the default 80x30', () => {
        expect(clampPtySize(NaN, Infinity)).toEqual({ cols: 80, rows: 30 })
        expect(clampPtySize('120', null)).toEqual({ cols: 80, rows: 30 })
        expect(clampPtySize(undefined, { rows: 40 })).toEqual({ cols: 80, rows: 30 })
    })

    test('each side is judged on its own', () => {
        expect(clampPtySize(120, NaN)).toEqual({ cols: 120, rows: 30 })
        expect(clampPtySize(0, 40)).toEqual({ cols: 2, rows: 40 })
    })
})
