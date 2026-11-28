import { test, expect, type Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { closeApp, launchAppWithWorkspaces, LaunchResult, REPO_ROOT, resizeMainWindow, waitForBufferText } from './helpers'

/**
 * T201 — fb-1128 12bf830d: a reply thread does not start threads of its own. A session that is a reply thread
 * (an `opened` relation with an answer anchor — threadSessionIds) shows no «Reply in thread» button and no thread
 * chip under its answers, whether it is open as a session or in its parent's thread panel. Its parent, and a
 * session the master opened without an anchor, keep the button.
 *
 * T201_SHOTS=<dir> (+ T201_LABEL) saves captures before the checks.
 */

const PARENT = 't201-parent'
const CHILD = 't201-thread'
const OPENED = 't201-opened'
const ids: Record<string, string> = {
    [PARENT]: '00000000-0000-4000-8000-0000000a0201',
    [CHILD]: '00000000-0000-4000-8000-0000000b0201',
    [OPENED]: '00000000-0000-4000-8000-0000000c0201'
}
const MOCK = path.join(REPO_ROOT, 'scripts/mock-cli/chat-mock.cjs')
const FIXTURES = path.join(__dirname, 'fixtures/transcripts')
const LABEL = process.env.T201_LABEL ?? 'run'
const claudeProjectSlug = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, '-')

let result: LaunchResult | null = null
test.afterEach(async () => {
    if (result) await closeApp(result)
    result = null
})

async function shot(page: Page, name: string): Promise<void> {
    const dir = process.env.T201_SHOTS
    if (!dir) return
    fs.mkdirSync(dir, { recursive: true })
    await page.waitForTimeout(400)
    await page.screenshot({ path: path.join(dir, `${name}-${LABEL}.png`) })
}

function replyTs(): string {
    const records = fs.readFileSync(path.join(FIXTURES, 'claude/tools.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    return records.find((record) => record.type === 'assistant')!.timestamp
}

async function launch(): Promise<Page> {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'climanager-t201-'))
    const project = path.join(home, 'project')
    fs.mkdirSync(project)
    const claudeDir = path.join(home, 'claude')
    const agent = (id: string): { cliSessionId: string; cliToolName: string; cliCommand: string } => {
        const transcript = path.join(claudeDir, 'projects', claudeProjectSlug(project), `${ids[id]}.jsonl`)
        fs.mkdirSync(path.dirname(transcript), { recursive: true })
        fs.copyFileSync(path.join(FIXTURES, 'claude/tools.jsonl'), transcript)
        return { cliSessionId: ids[id], cliToolName: 'claude', cliCommand: `node ${MOCK} --transcript ${transcript} --work-ms 300` }
    }
    const now = Date.now()
    result = await launchAppWithWorkspaces(
        [
            {
                id: 'w-t201',
                name: 'T201 project',
                path: project,
                sessions: [
                    { id: PARENT, name: 'T201 Lead', ...agent(PARENT) },
                    { id: CHILD, name: 'T201 Lead · thread', ...agent(CHILD) },
                    { id: OPENED, name: 'T201 Worker', ...agent(OPENED) }
                ]
            }
        ],
        {
            config: {
                sessionRelations: [
                    { from: PARENT, to: CHILD, kind: 'opened', at: now - 2000, anchor: { turnTs: replyTs() } },
                    // the master opened this one: no answer anchor, so not a thread
                    { from: PARENT, to: OPENED, kind: 'opened', at: now - 3000 }
                ]
            },
            env: { CLAUDE_CONFIG_DIR: path.join(home, 'claude'), CODEX_HOME: path.join(home, 'codex'), CLIMANAGER_HOME: path.join(home, 'clim') }
        }
    )
    await resizeMainWindow(result.app, 1280, 800)
    for (const id of [PARENT, CHILD, OPENED]) await waitForBufferText(result.page, id, 'Claude Code (mock)', 30_000)
    return result.page
}

const macChat = (page: Page) => page.locator('[data-testid="chat-view"][data-session-id]:not([data-thread-embedded]):visible')

async function openAsChat(page: Page, name: string, id: string) {
    // a thread has no sidebar row (1b965ad1): the sidebar search finds it
    await page.getByTestId('sidebar-search-toggle').click()
    await page.getByPlaceholder('Search projects and sessions').fill(name)
    await page.locator(`[data-testid="sidebar-search-results"] [data-session-item="${id}"]`).first().click()
    await page.getByTestId('sidebar-search-toggle').click()
    await expect(page.locator('[data-crumb="session"]:visible')).toHaveText(name)
    // the header's Terminal / Chat for the session on screen (a no-op when it is already on Chat)
    await page.getByTestId('view-toggle-chat').click()
    const view = macChat(page)
    await expect(view).toHaveAttribute('data-session-id', id)
    await expect(view.locator('[data-testid="chat-turn"][data-role="assistant"]').first()).toBeVisible({ timeout: 15_000 })
    return view
}

test('T201 12bf830d: a reply thread shows no Reply in thread; its parent and an opened session do', async () => {
    test.setTimeout(180_000)
    const page = await launch()

    // the parent: its answers carry «Reply in thread», and the thread's chip
    const parent = await openAsChat(page, 'T201 Lead', PARENT)
    await expect(parent.locator(':scope > .chat-main').getByTestId('chat-fork').first()).toBeAttached()
    await expect(parent.locator(':scope > .chat-main').getByTestId('chat-thread-chip')).toHaveCount(1)
    await shot(page, 't201-1-parent')

    // the thread opened as a session: none (before: one per answer)
    const thread = await openAsChat(page, 'T201 Lead · thread', CHILD)
    await expect(thread.locator('[data-testid="chat-turn"][data-role="assistant"]').first()).toBeVisible()
    await shot(page, 't201-2-thread-as-session')
    await expect(thread.getByTestId('chat-fork')).toHaveCount(0)
    await expect(thread.getByTestId('chat-thread-chip')).toHaveCount(0)

    // a session opened without an anchor is no thread: it keeps the button
    const opened = await openAsChat(page, 'T201 Worker', OPENED)
    await expect(opened.getByTestId('chat-fork').first()).toBeAttached()
})
