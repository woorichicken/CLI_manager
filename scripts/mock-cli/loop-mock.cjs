#!/usr/bin/env node
/**
 * loop-mock.cjs
 *
 * Deterministic mock that simulates N iterations of a Claude Code /loop run,
 * producing output activity that the LoopManager activity detector can count.
 *
 * Timing relationship to LoopManager constants:
 *   QUIET_READY_MS = 1500 ms  — silence needed for running → ready transition
 *   quietMs arg default 1700  — must be > QUIET_READY_MS (1700 > 1500 ✓)
 *
 * Per iteration:
 *   1. Emit a "burst" of stdout lines spread over ~burstMs   (status = running)
 *   2. Stay SILENT for quietMs ms                            (quiet timer fires → ready)
 *
 * After N iterations: print LOOP_MOCK_DONE and exit 0.
 *
 * Optional 4th arg or LOOP_MOCK_FLICKER=1 env var:
 *   Prepends a tiny burst + a short silence < debounceMs (300 ms default when
 *   called from tests) before the first "real" iteration, to exercise debounce
 *   absorption. Only useful when calling tests set debounceMs small enough for
 *   the flicker gap to fall inside the window.
 *
 * Usage:
 *   node loop-mock.cjs [iterations=3] [quietMs=1700] [burstMs=400] [flicker=0]
 *
 * Example (3 iterations, silence 1.7 s, burst 400 ms):
 *   node loop-mock.cjs 3 1700 400
 */

'use strict'

const iterations = parseInt(process.argv[2] ?? '3', 10)
const quietMs    = parseInt(process.argv[3] ?? '1700', 10)
const burstMs    = parseInt(process.argv[4] ?? '400', 10)
const flicker    = (process.argv[5] === '1') || (process.env.LOOP_MOCK_FLICKER === '1')

// Lines emitted per burst (spread evenly across burstMs)
const LINES_PER_BURST = 5
const lineIntervalMs  = Math.max(20, Math.floor(burstMs / LINES_PER_BURST))

/** Sleep for ms milliseconds. */
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Emit a short burst of output lines over ~burstMs. */
async function emitBurst(label) {
    for (let i = 0; i < LINES_PER_BURST; i++) {
        process.stdout.write(`[loop-mock] ${label} line ${i + 1}/${LINES_PER_BURST}\n`)
        await sleep(lineIntervalMs)
    }
}

async function main() {
    // Optional leading flicker: a tiny burst + short silence (< debounceMs)
    // to exercise the LoopCounter debounce absorption logic.
    if (flicker) {
        process.stdout.write('[loop-mock] FLICKER start\n')
        await sleep(50)
        process.stdout.write('[loop-mock] FLICKER end\n')
        // 200 ms silence — inside the 300 ms debounce used by tests
        await sleep(200)
    }

    for (let iter = 1; iter <= iterations; iter++) {
        // --- BURST phase (running) ---
        await emitBurst(`iter-${iter}`)

        // --- SILENCE phase (quiet timer fires → ready) ---
        // quietMs must be > QUIET_READY_MS (1500 ms) for the settle to fire.
        await sleep(quietMs)
    }

    process.stdout.write('LOOP_MOCK_DONE\n')
    process.exit(0)
}

main().catch((err) => {
    process.stderr.write(`[loop-mock] fatal: ${err}\n`)
    process.exit(1)
})
