import { test, expect, type Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { closeApp, launchAppWithWorkspaces, openLoopWindow, LaunchResult, REPO_ROOT, resizeMainWindow, waitForBufferText } from './helpers'

/**
 * T157 — fb-1121.
 *
 *  - 4e4103ff: the Loop window (⟳) has the feedback widget too, unlocked the same way as the main window
 *    (needs a build with VITE_DP_FEEDBACK_URL/KEY — skipped otherwise, like T31).
 *  - 16f1402e: a copy button on the person's own message copies it to the system clipboard.
 *  - 96d478ed: «Mine» in the message box's status row leaves only the person's messages; again, all back.
 *
 * T157_SHOTS=<dir> (+ T157_LABEL) saves captures before the checks.
 */

const ID = 't157-claude'
const CLAUDE_ID = '00000000-0000-4000-8000-00000000f157'
const MOCK = path.join(REPO_ROOT, 'scripts/mock-cli/chat-mock.cjs')
const FIXTURES = path.join(__dirname, 'fixtures/transcripts')
const LABEL = process.env.T157_LABEL ?? 'after'
const FLOATING_BUTTON = '#feedback-kit-floating-button'
const GATE_SOURCE = path.join(REPO_ROOT, 'src/renderer/src/utils/feedbackGate.ts')
const RENDERER_ASSETS = path.join(REPO_ROOT, 'out/renderer/assets')
const claudeProjectSlug = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, '-')

function buildHasFeedback(): boolean {
    if (!fs.existsSync(RENDERER_ASSETS)) return false
    return fs.readdirSync(RENDERER_ASSETS).filter((name) => name.endsWith('.js'))
        .some((name) => fs.readFileSync(path.join(RENDERER_ASSETS, name), 'utf-8').includes('dp-agentation-ingest/'))
}

async function shot(page: Page, name: string): Promise<void> {
    const dir = process.env.T157_SHOTS
    if (!dir) return
    fs.mkdirSync(dir, { recursive: true })
    await page.waitForTimeout(300)
    await page.screenshot({ path: path.join(dir, `${name}-${LABEL}.png`) })
}

let result: LaunchResult | null = null
test.afterEach(async () => {
    if (result) await closeApp(result)
    result = null
})

async function launch(): Promise<LaunchResult> {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'climanager-t157-'))
    const project = path.join(home, 'project')
    fs.mkdirSync(project)
    const claudeDir = path.join(home, 'claude')
    const transcript = path.join(claudeDir, 'projects', claudeProjectSlug(project), `${CLAUDE_ID}.jsonl`)
    fs.mkdirSync(path.dirname(transcript), { recursive: true })
    fs.copyFileSync(path.join(FIXTURES, 'claude/tools.jsonl'), transcript)
    result = await launchAppWithWorkspaces(
        [{ id: 'w-t157', name: 'T157 project', path: project, sessions: [
            { id: ID, name: 'T157 Claude', cliSessionId: CLAUDE_ID, cliToolName: 'claude', cliCommand: `node ${MOCK} --transcript ${transcript}` }
        ] }],
        { env: { CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: path.join(home, 'codex'), CLIMANAGER_HOME: path.join(home, 'clim') } }
    )
    await resizeMainWindow(result.app, 1280, 800)
    return result
}

test('T157 16f1402e · 96d478ed: copy my message; «Mine» shows only my messages', async () => {
    const { app, page } = await launch()
    await waitForBufferText(page, ID, 'Claude Code (mock)', 20_000)
    await page.getByText('T157 Claude', { exact: true }).first().click()
    await page.getByTestId('view-toggle-chat').click()
    const chat = page.locator('[data-testid="chat-view"][data-session-id]:visible')
    const mine = chat.locator('[data-testid="chat-turn"][data-role="user"]').first()
    await expect(mine).toBeVisible({ timeout: 15_000 })
    const before = await app.evaluate(({ clipboard }) => clipboard.readText())
    try {
        await mine.hover()
        await shot(page, 't157-1-copy-mine')
        const copy = mine.getByTestId('chat-copy-mine')
        await expect(copy).toHaveCSS('opacity', '1')
        await copy.click()
        const said = (await mine.innerText()).trim()
        await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe('Add a guard to src/a.ts and show me')
        expect(said).toContain('Add a guard to src/a.ts')
    } finally {
        await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), before)
    }

    const assistant = chat.locator('[data-testid="chat-turn"][data-role="assistant"]')
    await expect(assistant).not.toHaveCount(0)
    const toggle = chat.getByTestId('chat-only-mine')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')
    await expect(assistant).toHaveCount(0)
    await expect(chat.locator('[data-testid="chat-turn"][data-role="user"]')).not.toHaveCount(0)
    await shot(page, 't157-2-only-mine')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')
    await expect(assistant).not.toHaveCount(0)
})

test('T157 4e4103ff: the Loop window has the feedback widget', async () => {
    test.skip(!buildHasFeedback(), 'build has no VITE_DP_FEEDBACK_URL/KEY')
    const { app, page } = await launch()
    const source = fs.readFileSync(GATE_SOURCE, 'utf-8')
    const hash = /FEEDBACK_PASSWORD_HASH = '([0-9a-f]{64})'/.exec(source)![1]
    const storageKey = /UNLOCK_STORAGE_KEY = '([^']+)'/.exec(source)![1]
    await page.evaluate(([key, value]) => localStorage.setItem(key, value), [storageKey, hash])
    const loop = await openLoopWindow(app, page)
    await expect(loop.locator(FLOATING_BUTTON)).toBeVisible({ timeout: 15_000 })
    await shot(loop, 't157-3-loop-feedback')
    // locked again: none there either
    await page.evaluate((key) => localStorage.removeItem(key), storageKey)
    await loop.reload()
    await loop.waitForTimeout(2000)
    await expect(loop.locator(FLOATING_BUTTON)).toHaveCount(0)
})
