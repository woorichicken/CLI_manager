import { defineConfig } from '@playwright/test'

/**
 * Playwright config for Electron terminal pipeline tests.
 *
 * Tests launch the BUILT app (out/main/index.js), so run `pnpm build` first.
 * Each test spawns its own Electron instance with an isolated userData dir
 * (CLIMANGER_TEST_USERDATA) — the user's real config is never touched.
 *
 * Run:  pnpm test:term                       (assert + metrics under "current")
 *       METRICS_LABEL=baseline pnpm test:term  (label metrics for comparison)
 */
export default defineConfig({
    testDir: './tests/terminal',
    timeout: 240_000,
    workers: 1,
    retries: 0,
    reporter: [['list']],
    use: {
        actionTimeout: 30_000
    }
})
