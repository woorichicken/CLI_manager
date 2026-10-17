import { test, expect, Page } from '@playwright/test'
import { randomUUID } from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { launchAppWithWorkspaces, closeApp, LaunchResult, REPO_ROOT } from './helpers'

/**
 * T31 — feedback widget gate (attach type `dev+url`) and its main-process relay.
 *
 * These tests load the built renderer from file://, exactly like the packaged app, so the gate
 * under test is the one users get. Judged at the user's end: the floating button in the DOM, the
 * widget chunk actually requested (a late-mounting widget passes a "not there" check that runs
 * too early), and what the relay sends or refuses. The chunk is watched with Playwright's request
 * events: Resource Timing records nothing for file:// pages, so a check built on it always says
 * "not loaded" — the remembered-unlock test is the positive control that this watcher does see it.
 *
 * - A build without VITE_DP_FEEDBACK_URL/KEY has no widget: the gate tests then check that
 *   Settings says so instead of pretending to be locked.
 * - Typing the real password needs ~/.config/climanager-app-feedback-password, which never
 *   enters the repo. Without it that test is skipped; the remembered-unlock test still mounts
 *   the widget.
 * - FEEDBACK_LIVE=1 also sends one marked report to Lasso Run through the real UI.
 */

const FLOATING_BUTTON = '#feedback-kit-floating-button'
const PASSWORD_FILE = path.join(os.homedir(), '.config', 'climanager-app-feedback-password')
const GATE_SOURCE = path.join(REPO_ROOT, 'src/renderer/src/utils/feedbackGate.ts')
const RENDERER_ASSETS = path.join(REPO_ROOT, 'out/renderer/assets')
// Same marker the release gate counts: only a build with the ingest URL contains it.
const FEEDBACK_BUNDLE_MARKER = 'dp-agentation-ingest/'
// Long enough for a lazily imported chunk to have been requested if the gate had let it through.
const LAZY_CHUNK_SETTLE_MS = 1500

function buildHasFeedback(): boolean {
    if (!fs.existsSync(RENDERER_ASSETS)) return false
    return fs.readdirSync(RENDERER_ASSETS)
        .filter((name) => name.endsWith('.js'))
        .some((name) => fs.readFileSync(path.join(RENDERER_ASSETS, name), 'utf-8').includes(FEEDBACK_BUNDLE_MARKER))
}

function gateConstants(): { hash: string; storageKey: string } {
    const source = fs.readFileSync(GATE_SOURCE, 'utf-8')
    const hash = /FEEDBACK_PASSWORD_HASH = '([0-9a-f]{64})'/.exec(source)?.[1]
    const storageKey = /UNLOCK_STORAGE_KEY = '([^']+)'/.exec(source)?.[1]
    if (!hash || !storageKey) throw new Error('feedbackGate.ts constants not found')
    return { hash, storageKey }
}

/** Starts watching for the widget chunk. Attach before the load you want to judge. */
function watchWidgetChunk(page: Page): () => boolean {
    let requested = false
    page.on('request', (request) => {
        if (/FeedbackWidget-[^/]*\.js$/.test(request.url())) requested = true
    })
    return () => requested
}

/** Reloads the renderer under a watcher, waiting until the app is back. */
async function reloadWatched(page: Page): Promise<() => boolean> {
    const chunkRequested = watchWidgetChunk(page)
    await page.reload()
    await page.getByText('T31FEEDBACK').first().waitFor({ timeout: 30_000 })
    return chunkRequested
}

async function openFeedbackSettings(page: Page): Promise<void> {
    await page.locator('button[title="Settings"]').first().click()
    await expect(page.getByTestId('feedback-mode-status')).toBeVisible()
}

const HAS_FEEDBACK = buildHasFeedback()

test.describe('T31 feedback gate', () => {
    let ctx: LaunchResult

    test.afterEach(async () => {
        if (ctx) await closeApp(ctx)
    })

    const launch = () => launchAppWithWorkspaces([{ id: 'ws-fb', name: 'T31FEEDBACK', sessions: [{ id: 's-fb', name: 'T31SESS' }] }])

    test('locked by default: no button, no widget chunk', async () => {
        ctx = await launch()
        const { page } = ctx
        const chunkRequested = await reloadWatched(page)
        await openFeedbackSettings(page)
        const status = page.getByTestId('feedback-mode-status')
        if (HAS_FEEDBACK) {
            await expect(status).toHaveText(/^Off/)
            await expect(page.getByTestId('feedback-mode-toggle')).toHaveText('Turn On…')
        } else {
            await expect(status).toHaveText('Not available in this build')
            await expect(page.getByTestId('feedback-mode-toggle')).toHaveCount(0)
        }
        await page.waitForTimeout(LAZY_CHUNK_SETTLE_MS)
        await expect(page.locator(FLOATING_BUTTON)).toHaveCount(0)
        expect(chunkRequested()).toBe(false)
    })

    test('a wrong password keeps it locked', async () => {
        test.skip(!HAS_FEEDBACK, 'build has no VITE_DP_FEEDBACK_URL/KEY')
        ctx = await launch()
        const { page } = ctx
        const chunkRequested = watchWidgetChunk(page)
        await openFeedbackSettings(page)
        await page.getByTestId('feedback-mode-toggle').click()
        const input = page.locator('[data-feedback-password]')
        await input.fill('not-the-password')
        await page.getByTestId('feedback-gate-submit').click()
        await expect(input).toHaveAttribute('aria-invalid', 'true')
        await page.waitForTimeout(LAZY_CHUNK_SETTLE_MS)
        await expect(page.locator(FLOATING_BUTTON)).toHaveCount(0)
        expect(chunkRequested()).toBe(false)
    })

    test('a remembered unlock mounts the widget; Turn Off removes it', async () => {
        test.skip(!HAS_FEEDBACK, 'build has no VITE_DP_FEEDBACK_URL/KEY')
        ctx = await launch()
        const { page } = ctx
        const { hash, storageKey } = gateConstants()
        await page.evaluate(([key, value]) => localStorage.setItem(key, value), [storageKey, hash])
        const chunkRequested = await reloadWatched(page)
        await expect(page.locator(FLOATING_BUTTON)).toBeVisible({ timeout: 15_000 })
        expect(chunkRequested()).toBe(true)

        await openFeedbackSettings(page)
        await expect(page.getByTestId('feedback-mode-status')).toHaveText(/^On/)
        await page.getByTestId('feedback-mode-toggle').click()
        await expect(page.getByTestId('feedback-mode-status')).toHaveText(/^Off/)
        await expect(page.locator(FLOATING_BUTTON)).toHaveCount(0)
        expect(await page.evaluate((key) => localStorage.getItem(key), storageKey)).toBeNull()
    })

    test('the real password unlocks this machine', async () => {
        test.skip(!HAS_FEEDBACK, 'build has no VITE_DP_FEEDBACK_URL/KEY')
        test.skip(!fs.existsSync(PASSWORD_FILE), `no ${PASSWORD_FILE}`)
        ctx = await launch()
        const { page } = ctx
        const chunkRequested = watchWidgetChunk(page)
        await openFeedbackSettings(page)
        await page.getByTestId('feedback-mode-toggle').click()
        await page.locator('[data-feedback-password]').fill(fs.readFileSync(PASSWORD_FILE, 'utf-8').trim())
        await page.getByTestId('feedback-gate-submit').click()
        await expect(page.locator('[data-feedback-password]')).toHaveCount(0)
        await expect(page.getByTestId('feedback-mode-status')).toHaveText(/^On/)
        await expect(page.locator(FLOATING_BUTTON)).toBeVisible({ timeout: 15_000 })
        expect(chunkRequested()).toBe(true)
    })

    test('the relay refuses anything but the ingest function', async () => {
        ctx = await launch()
        const { page } = ctx
        const relay = (request: { url: string; method: string }) => page.evaluate((req) =>
            window.api.feedbackRelay({ ...req, headers: {}, body: '{}' }), request)

        expect((await relay({ url: 'https://example.com/functions/v1/dp-agentation-ingest/x', method: 'POST' })).error)
            .toBe('url not allowed')
        expect((await relay({ url: 'http://abc.supabase.co/functions/v1/dp-agentation-ingest/x', method: 'POST' })).error)
            .toBe('url not allowed')
        expect((await relay({ url: 'https://abc.supabase.co/functions/v1/other-function', method: 'POST' })).error)
            .toBe('url not allowed')
        expect((await relay({ url: 'https://abc.supabase.co/functions/v1/dp-agentation-ingest/x', method: 'DELETE' })).error)
            .toBe('method not allowed')
    })

    test('live: a report sent from the widget reaches Lasso Run', async () => {
        test.skip(process.env.FEEDBACK_LIVE !== '1', 'set FEEDBACK_LIVE=1 to send a real report')
        test.skip(!HAS_FEEDBACK, 'build has no VITE_DP_FEEDBACK_URL/KEY')
        ctx = await launch()
        const { page } = ctx
        const { hash, storageKey } = gateConstants()
        await page.evaluate(([key, value]) => localStorage.setItem(key, value), [storageKey, hash])
        await reloadWatched(page)
        const button = page.locator(FLOATING_BUTTON)
        await expect(button).toBeVisible({ timeout: 15_000 })

        // First press turns element picking on (defaultMode="pick"); the second opens the whole-screen report.
        await button.click()
        await button.click()
        const marker = `[bootstrap-qa:${randomUUID()}]`
        await page.locator('#feedback-kit-comment').fill(`${marker} CLI Manager desktop relay check`)
        await page.locator('[aria-labelledby="feedback-kit-dialog-title"] button[type="submit"]').click()
        await expect(page.getByText('보냈습니다').first()).toBeVisible({ timeout: 30_000 })
        console.log(`T31 live marker: ${marker}`)
    })
})
