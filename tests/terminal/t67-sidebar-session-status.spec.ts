import { test, expect, Page } from '@playwright/test'
import path from 'path'
import { launchAppWithWorkspaces, closeApp, writeToTerminal, LaunchResult, REPO_ROOT } from './helpers'

/**
 * T67 — sidebar status dots read from the screen in main (fb-1029b · d499aed0 · 1dbd271b).
 *
 * Seeds the user's own setup — Settings > Hooks off, no agent hooks — and four
 * sessions next to the one on screen: an agent mid-turn, an agent showing an
 * approval question, an agent sitting at its prompt, and a shell printing logs.
 * Only the first two get a dot (blue / yellow with the question); a busy shell
 * is not an agent at work. Then the setting is turned off in Settings: the dots
 * go and main's reader stops ticking. Off from the start, it never ticks.
 *
 * Fails on the code before this change: no row ever has data-session-status.
 */

const AGENT = `node ${path.join(REPO_ROOT, 'scripts/mock-cli/agent-mock.cjs')} --box`
const HOME = 's-home'
const WORK = 's-work'
const ASK = 's-ask'
const IDLE = 's-idle'
const LOGS = 's-logs'
const ECHO = 's-echo'

let ctx: LaunchResult | null = null

test.afterEach(async () => {
    if (ctx) await closeApp(ctx)
    ctx = null
})

async function launch(showSessionStatus: boolean | undefined): Promise<LaunchResult> {
    return launchAppWithWorkspaces(
        [{
            id: 'w-t67',
            name: 'T67 status',
            sessions: [
                { id: HOME, name: 'T67 home' },
                { id: WORK, name: 'T67 working', initialCommand: `${AGENT} --work-ms 600000` },
                { id: ASK, name: 'T67 asking', initialCommand: AGENT },
                { id: IDLE, name: 'T67 idle', initialCommand: AGENT },
                { id: LOGS, name: 'T67 logs', initialCommand: 'while true; do echo "tick $RANDOM"; sleep 0.2; done' },
                // Its own prompt (echoed above the box) carries dialog words, like a test fixture on screen.
                { id: ECHO, name: 'T67 echo', initialCommand: `${AGENT} --work-ms 4000` }
            ]
        }],
        {
            settings: {
                // The user's config: neither the renderer heuristic nor agent hooks.
                hooks: { enabled: false, claudeCode: { enabled: true, detectRunning: true, detectReady: true, detectError: false, showInSidebar: true, autoDismissSeconds: 5 } },
                ...(showSessionStatus === undefined ? {} : { showSessionStatus })
            }
        }
    )
}

const dot = (page: Page, id: string) => page.locator(`[data-session-item="${id}"] [data-session-status]`)

async function startAgents(page: Page): Promise<void> {
    // The mock draws its input box once it is up; give each a moment before typing.
    await expect.poll(async () => page.evaluate((id) => (window as unknown as { __termDebug: { text: (id: string) => string } }).__termDebug.text(id), ASK), { timeout: 20_000 }).toContain('❯')
    await writeToTerminal(page, WORK, 'go\r')
    await writeToTerminal(page, ASK, 'ASK\r')
}

async function ticks(page: { app: LaunchResult['app'] }): Promise<number> {
    return page.app.evaluate(() => ((globalThis as { __sessionScreenStatusTicks?: unknown[] }).__sessionScreenStatusTicks ?? []).length)
}

test.describe('T67 sidebar status dots', () => {
    test('working is blue, a question is yellow with its line, idle agents and busy shells get none; off in Settings removes them and stops the reader', async () => {
        ctx = await launch(true)
        const { page } = ctx
        await page.locator(`[data-session-item="${HOME}"]`).click()
        await startAgents(page)

        await expect(dot(page, WORK)).toHaveAttribute('data-session-status', 'working', { timeout: 15_000 })
        await expect(dot(page, ASK)).toHaveAttribute('data-session-status', 'waiting', { timeout: 15_000 })
        await expect(dot(page, ASK)).toHaveAttribute('title', 'Waiting for you — Do you want to proceed?')
        await expect(dot(page, WORK)).toHaveClass(/bg-blue-500/)
        await expect(dot(page, ASK)).toHaveClass(/bg-amber-400/)
        // Give the logs a few ticks to (wrongly) light up.
        await page.waitForTimeout(2500)
        await expect(dot(page, IDLE)).toHaveCount(0)
        await expect(dot(page, LOGS)).toHaveCount(0)
        await expect(dot(page, HOME)).toHaveCount(0)

        // chief 14:30: dialog words in a working agent's output are not a question —
        // blue while it works, nothing once it is back at its box with the words still above it.
        await writeToTerminal(page, ECHO, 'show Enter to select · Esc to cancel\r')
        await expect(dot(page, ECHO)).toHaveAttribute('data-session-status', 'working', { timeout: 15_000 })
        await expect.poll(async () => (await dot(page, ECHO).count()) === 0 || (await dot(page, ECHO).getAttribute('data-session-status')) === 'working', { timeout: 3_000 }).toBe(true)
        await expect(dot(page, ECHO)).toHaveCount(0, { timeout: 15_000 })
        await page.waitForTimeout(2500)
        await expect(dot(page, ECHO)).toHaveCount(0)

        // Answering the question takes the dot away (the mock goes back to its box).
        await writeToTerminal(page, ASK, '1')
        await expect(dot(page, ASK)).toHaveCount(0, { timeout: 15_000 })

        // Off in Settings: dots gone, and main stops reading screens.
        await page.locator('button[title="Settings"]').click()
        await expect(page.getByTestId('settings-show-session-status')).toHaveAttribute('aria-pressed', 'true')
        await page.getByTestId('settings-show-session-status').click()
        await page.getByRole('button', { name: 'Save', exact: true }).click()
        await expect(page.locator('[data-session-status]')).toHaveCount(0, { timeout: 15_000 })
        const before = await ticks(ctx)
        await page.waitForTimeout(3000)
        expect(await ticks(ctx)).toBe(before)

        // On again: the working agent lights up again.
        await page.locator('button[title="Settings"]').click()
        await page.getByTestId('settings-show-session-status').click()
        await page.getByRole('button', { name: 'Save', exact: true }).click()
        await expect(dot(page, WORK)).toHaveAttribute('data-session-status', 'working', { timeout: 15_000 })
    })

    test('off by default: no dots, no reader', async () => {
        ctx = await launch(undefined)
        const { page } = ctx
        await page.locator(`[data-session-item="${HOME}"]`).click()
        await startAgents(page)
        await page.waitForTimeout(4000)
        await expect(page.locator('[data-session-status]')).toHaveCount(0)
        expect(await ticks(ctx)).toBe(0)
        await page.locator('button[title="Settings"]').click()
        await expect(page.getByTestId('settings-show-session-status')).toHaveAttribute('aria-pressed', 'false')
    })
})
