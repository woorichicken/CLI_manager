import { test, expect, Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { launchAppWithWorkspaces, closeApp, chooseSidebarView, resizeMainWindow, LaunchResult, REPO_ROOT } from './helpers'

/**
 * T197 — the session right-click menu (report 2ea599ad, fb-1128).
 *
 * - No "Disconnect AI" item: the AI mark is a mark, not a permission (decision 0006); ending access is
 *   switching the API off, and `POST /v1/sessions/:id/release` still clears the mark and stops a wait (T15).
 *   No tooltip points at that item either — the sidebar row, the header badge or a split pane's badge.
 * - "Connect to agent conversation…" only on a session with no conversation: not on one with a saved
 *   conversation id. A tool name remembered without a conversation (a Codex template's session, shell in
 *   front — T104's case) still offers it: the window cannot see the foreground program.
 *
 * `T197_SHOTS=<path.png>` captures the menu of the AI-driven session before the checks.
 */

const AI_CLIENT = 't197-client'
const CONVERSATION_ID = '4a5b6c7d-0000-4000-8000-0000000000aa'

const seed = [
    { id: 's-t197-ai', name: 'T197 AI' },
    { id: 's-t197-shell', name: 'T197 Shell' },
    { id: 's-t197-conv', name: 'T197 Saved conversation' },
    { id: 's-t197-tool', name: 'T197 Tool name only' }
]

const menu = (page: Page) => page.locator('[data-sidebar-menu="session"]')
const listRow = (page: Page, id: string) => page.locator(`[data-testid="sidebar-all-sessions"] [data-session-item="${id}"]`)

async function openMenu(page: Page, id: string): Promise<void> {
    await page.keyboard.press('Escape')
    await expect(menu(page)).toHaveCount(0)
    await listRow(page, id).click({ button: 'right' })
    await expect(menu(page)).toBeVisible()
}

test.describe('T197 session menu: no Disconnect AI, Connect only where nothing is connected', () => {
    let ctx: LaunchResult | undefined
    test.afterEach(async () => {
        if (ctx) await closeApp(ctx)
        ctx = undefined
    })

    test('sidebar menu, row and header tooltips; Connect only without a saved conversation', async () => {
        const since = Date.now()
        // The app clears a stored Claude conversation whose file is gone (validateCliSessionIds), so the
        // saved one gets a synthetic transcript in a private Claude dir.
        const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'climanager-t197-claude-'))
        const transcript = path.join(claudeDir, 'projects', REPO_ROOT.replace(/[^A-Za-z0-9]/g, '-'), `${CONVERSATION_ID}.jsonl`)
        fs.mkdirSync(path.dirname(transcript), { recursive: true })
        fs.copyFileSync(path.join(__dirname, 'fixtures/transcripts/claude/tools.jsonl'), transcript)
        ctx = await launchAppWithWorkspaces(
            [{ id: 'ws-t197', name: 'T197 workspace', sessions: seed }],
            {
                settings: { showHomeWorkspace: false },
                env: { CLAUDE_CONFIG_DIR: claudeDir },
                // Raw store rows: the seed helper has no field for the AI mark or a tool name without an id.
                config: {
                    workspaces: [{
                        id: 'ws-t197',
                        name: 'T197 workspace',
                        path: REPO_ROOT,
                        createdAt: 1700000000000,
                        sessions: [
                            { id: 's-t197-ai', name: 'T197 AI', cwd: REPO_ROOT, type: 'regular', aiControl: { client: AI_CLIENT, since } },
                            { id: 's-t197-shell', name: 'T197 Shell', cwd: REPO_ROOT, type: 'regular' },
                            // A conversation is stored but no tool name: nothing is resumed at start (resumeCommandFor).
                            { id: 's-t197-conv', name: 'T197 Saved conversation', cwd: REPO_ROOT, type: 'regular', cliSessionId: CONVERSATION_ID },
                            // A tool name with no conversation id: nothing connected yet.
                            { id: 's-t197-tool', name: 'T197 Tool name only', cwd: REPO_ROOT, type: 'regular', cliToolName: 'codex' }
                        ]
                    }]
                }
            }
        )
        const { app, page } = ctx
        await resizeMainWindow(app, 1280, 800)
        await page.locator('[data-session-item="s-t197-ai"]').first().click()
        await chooseSidebarView(page, 'list')

        await openMenu(page, 's-t197-ai')
        if (process.env.T197_SHOTS) await page.screenshot({ path: process.env.T197_SHOTS })

        // The AI-driven session: still marked, no item to take it "back".
        await expect(menu(page)).not.toContainText('Disconnect')
        await expect(menu(page)).toContainText('Clear Terminal')
        await expect(page.locator(`[data-ai-badge="s-t197-ai"]`)).toBeVisible()
        const badgeTitle = await page.locator(`[data-ai-badge="s-t197-ai"]`).getAttribute('title')
        expect(badgeTitle).toContain('AI connected')
        expect(badgeTitle).not.toContain('Disconnect')
        const rowTitles = await listRow(page, 's-t197-ai').evaluate(el =>
            [el, ...Array.from(el.querySelectorAll('[title]'))].map(node => node.getAttribute('title') ?? ''))
        expect(rowTitles.join('\n')).toContain(AI_CLIENT)
        expect(rowTitles.join('\n')).not.toContain('Disconnect')

        // A plain shell: nothing connected, so Connect is offered.
        await openMenu(page, 's-t197-shell')
        await expect(menu(page).getByTestId('connect-agent-conversation')).toBeVisible()

        // A saved conversation: Connect is not offered.
        await openMenu(page, 's-t197-conv')
        await expect(menu(page).getByText('Copy Session ID')).toBeVisible()
        await expect(menu(page).getByTestId('connect-agent-conversation')).toHaveCount(0)
        // A remembered tool name with no conversation: still offered.
        await openMenu(page, 's-t197-tool')
        await expect(menu(page).getByTestId('connect-agent-conversation')).toBeVisible()
        await page.keyboard.press('Escape')

        // Split view: the AI session's pane badge does not name a menu item either, and its header has no menu.
        for (const id of ['s-t197-ai', 's-t197-shell']) {
            await listRow(page, id).hover()
            await page.locator(`[data-session-select="${id}"]`).click()
        }
        await page.getByTestId('session-selection-split').click()
        const pane = page.locator('[data-pane-header="s-t197-ai"]')
        await expect(pane).toBeVisible()
        const paneBadge = pane.locator('[data-ai-badge="s-t197-ai"]')
        if (await paneBadge.count() > 0) expect(await paneBadge.getAttribute('title')).not.toContain('Disconnect')
        await pane.click({ button: 'right', position: { x: 40, y: 10 } })
        await expect(page.getByText('Disconnect AI')).toHaveCount(0)

        expect(ctx.pageErrors).toEqual([])
    })
})
