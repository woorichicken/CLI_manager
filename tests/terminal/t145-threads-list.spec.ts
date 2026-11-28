import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { closeApp, launchAppWithWorkspaces, LaunchResult, REPO_ROOT, resizeMainWindow, waitForBufferText, toggleSidebarView } from './helpers'

/**
 * T145 — All sessions › Threads (the 💬 icon beside View ▾ — it was beside List / Tree; backlog spec 2026-11-16).
 *
 * Two chat-mock parents and three anchored forks are seeded in config.json (the fork itself is T117's
 * subject): one child asks a question (waiting), one works for a long turn (working), one is idle
 * until it asks while the list is closed (the badge is live in All sessions; Folders view watches nothing).
 * A master-opened session without an anchor and a hand pair are seeded too — they must not appear.
 *
 *  - the icon's badge counts the waiting thread; the list shows the three rows newest first with their
 *    status dots, parent · workspace, and the parent reply's quote; a status change follows within 3s
 *  - a row opens the parent's Chat with that child's thread panel beside a narrowed Chat (no overlap);
 *    the sidebar stays on Threads with the row selected; the order does not move on click
 *  - closing a child drops its row; the icon again returns to List; the choice survives a restart
 *  - 1280 and 390 (sidebar open): no row overflows the sidebar
 *
 * T145_SHOTS=<dir> (+ T145_LABEL) saves captures at 1280 and 390; the first one is taken before the
 * icon is looked for, so the old code leaves its "before".
 */

const PARENT_A = 't145-parent-a'
const PARENT_B = 't145-parent-b'
const CHILD_WAIT = 't145-child-wait'
const CHILD_WORK = 't145-child-work'
const CHILD_IDLE = 't145-child-idle'
const WORKER = 't145-worker'
const HAND = 't145-hand'
const MOCK = path.join(REPO_ROOT, 'scripts/mock-cli/chat-mock.cjs')
const FIXTURES = path.join(__dirname, 'fixtures/transcripts')
const LABEL = process.env.T145_LABEL ?? 'run'
const ids: Record<string, string> = {
    [PARENT_A]: '00000000-0000-4000-8000-0000000a0145',
    [PARENT_B]: '00000000-0000-4000-8000-0000000b0145',
    [CHILD_WAIT]: '00000000-0000-4000-8000-0000000c0145',
    [CHILD_WORK]: '00000000-0000-4000-8000-0000000d0145',
    [CHILD_IDLE]: '00000000-0000-4000-8000-0000000e0145'
}
const claudeProjectSlug = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, '-')
function replyTs(): string {
    const records = fs.readFileSync(path.join(FIXTURES, 'claude/tools.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    return records.find((record) => record.type === 'assistant')!.timestamp
}

let result: LaunchResult | null = null
let relaunched: ElectronApplication | null = null
const keepDirs: string[] = []
test.afterEach(async () => {
    if (relaunched) await relaunched.close().catch(() => undefined)
    relaunched = null
    if (result) await closeApp(result)
    result = null
    for (const dir of keepDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

async function shot(page: Page, name: string, width = 1280, height = 800): Promise<void> {
    const dir = process.env.T145_SHOTS
    if (!dir) return
    fs.mkdirSync(dir, { recursive: true })
    await page.waitForTimeout(400)
    await page.screenshot({ path: path.join(dir, `${name}-${LABEL}.png`), clip: { x: 0, y: 0, width, height } })
}

async function launch(): Promise<{ app: ElectronApplication; page: Page; home: string }> {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'climanager-t145-'))
    const project = path.join(home, 'project')
    const backend = path.join(home, 'backend')
    fs.mkdirSync(project)
    fs.mkdirSync(backend)
    const claudeDir = path.join(home, 'claude')
    const agent = (id: string, cwd: string, workMs = 400): { cliSessionId: string; cliToolName: string; cliCommand: string } => {
        const transcript = path.join(claudeDir, 'projects', claudeProjectSlug(cwd), `${ids[id]}.jsonl`)
        fs.mkdirSync(path.dirname(transcript), { recursive: true })
        fs.copyFileSync(path.join(FIXTURES, 'claude/tools.jsonl'), transcript)
        return { cliSessionId: ids[id], cliToolName: 'claude', cliCommand: `node ${MOCK} --transcript ${transcript} --work-ms ${workMs}` }
    }
    const now = Date.now()
    const anchor = { turnTs: replyTs() }
    result = await launchAppWithWorkspaces(
        [
            {
                id: 'w-t145-project',
                name: 'T145 project',
                path: project,
                sessions: [
                    { id: PARENT_A, name: 'Release prep', ...agent(PARENT_A, project) },
                    { id: CHILD_WAIT, name: 'Release prep · fork', ...agent(CHILD_WAIT, project) },
                    { id: CHILD_IDLE, name: 'Release prep · fork 2', ...agent(CHILD_IDLE, project) },
                    { id: WORKER, name: 'T145 Worker' }
                ]
            },
            {
                id: 'w-t145-backend',
                name: 'T145 backend',
                path: backend,
                sessions: [
                    { id: PARENT_B, name: 'API lead', ...agent(PARENT_B, backend) },
                    { id: CHILD_WORK, name: 'API lead · fork', ...agent(CHILD_WORK, backend, 120_000) },
                    { id: HAND, name: 'T145 Hand pair' }
                ]
            }
        ],
        {
            config: {
                sessionRelations: [
                    { from: PARENT_A, to: CHILD_WAIT, kind: 'opened', at: now - 3000, anchor },
                    { from: PARENT_A, to: CHILD_IDLE, kind: 'opened', at: now - 2000, anchor },
                    { from: PARENT_B, to: CHILD_WORK, kind: 'opened', at: now - 1000, anchor },
                    // an old fork, a session the master opened and a hand pair: not threads
                    { from: PARENT_A, to: WORKER, kind: 'opened', at: now - 4000 },
                    { from: PARENT_B, to: HAND, kind: 'manual', at: now - 5000 }
                ]
            },
            env: { CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: path.join(home, 'codex'), CLIMANAGER_HOME: path.join(home, 'clim') }
        }
    )
    const { app, page } = result
    await resizeMainWindow(app, 1280, 800)
    for (const id of [PARENT_A, PARENT_B, CHILD_WAIT, CHILD_WORK, CHILD_IDLE]) await waitForBufferText(page, id, 'Claude Code (mock)', 30_000)
    return { app, page, home }
}

const rows = (page: Page) => page.getByTestId('sidebar-thread-row')
const rowOrder = (page: Page): Promise<string[]> => rows(page).evaluateAll((elements) => elements.map((el) => el.getAttribute('data-child-id') ?? ''))
const macChat = (page: Page) => page.locator('[data-testid="chat-view"][data-session-id]:not([data-thread-embedded]):visible')

/** Every part of every row ends inside the sidebar's list. */
async function overflowingRows(page: Page): Promise<string[]> {
    return page.getByTestId('sidebar-all-sessions').evaluate((list) => {
        const right = list.getBoundingClientRect().right
        const bad: string[] = []
        for (const row of Array.from(list.querySelectorAll('[data-testid="sidebar-thread-row"]'))) {
            if (row.scrollWidth > row.clientWidth + 1) bad.push(`${row.getAttribute('data-child-id')}: scroll ${row.scrollWidth} > ${row.clientWidth}`)
            for (const part of Array.from(row.querySelectorAll('*'))) {
                const box = part.getBoundingClientRect()
                if (box.width > 0 && box.right > right + 0.5) bad.push(`${row.getAttribute('data-child-id')} ${part.getAttribute('data-testid') ?? part.tagName}: ${box.right} > ${right}`)
            }
        }
        return bad
    })
}

test('T145: the Threads icon lists every anchored thread, opens it beside the parent Chat, and keeps its place', async () => {
    test.setTimeout(240_000)
    const { page } = await launch()
    // waiting and working first, so the badge and dots have something to show
    await page.evaluate((id) => window.api.writeTerminal(id, 'ASK\r'), CHILD_WAIT)
    await page.evaluate((id) => window.api.writeTerminal(id, 'Keep working on the batch\r'), CHILD_WORK)
    await waitForBufferText(page, CHILD_WAIT, 'Do you want to proceed?', 15_000)

    // Folders view: nothing watches the thread list — a renamed parent sends this window nothing
    await page.evaluate(() => {
        const w = window as unknown as { __t145Changes: number }
        w.__t145Changes = 0
        window.api.onAllChatThreadsChanged(() => { w.__t145Changes++ })
    })
    const listChanges = (): Promise<number> => page.evaluate(() => (window as unknown as { __t145Changes: number }).__t145Changes)
    await page.evaluate((id) => window.api.renameSession('w-t145-backend', id, 'API lead (renamed)'), PARENT_B)
    await page.waitForTimeout(2500)
    expect(await listChanges()).toBe(0)
    await page.evaluate((id) => window.api.renameSession('w-t145-backend', id, 'API lead'), PARENT_B)

    await toggleSidebarView(page)
    await expect(page.getByTestId('sidebar-all-sessions')).toBeVisible()
    await shot(page, 't145-1-all-sessions')
    const toolbar = page.getByTestId('all-sessions-toolbar')
    // View ▾ stays put when the Threads icon and its badge come in (view-filter-1127: it replaced the header toggle)
    const toggleX = async (): Promise<number> => (await page.getByTestId('sidebar-view-menu').boundingBox())!.x
    const xBefore = await toggleX()

    const icon = page.getByTestId('all-sessions-threads')
    await expect(icon).toBeVisible({ timeout: 5000 })
    await expect(icon).toHaveAttribute('aria-pressed', 'false')
    // the closed list's badge: one waiting thread
    await expect(icon.getByTestId('all-sessions-threads-badge')).toHaveText('1', { timeout: 15_000 })
    await expect(page.getByTestId('all-sessions-new-session')).toContainText('New session')
    expect(await toggleX()).toBe(xBefore)
    // still closed: the badge is live — the idle child asks and the count follows within 3 seconds
    await page.evaluate((id) => window.api.writeTerminal(id, 'ASK\r'), CHILD_IDLE)
    await expect(icon.getByTestId('all-sessions-threads-badge')).toHaveText('2', { timeout: 3000 })
    await expect(icon).toHaveAttribute('aria-pressed', 'false')
    expect(await listChanges()).toBeGreaterThan(0)

    await icon.click()
    await expect(icon).toHaveAttribute('aria-pressed', 'true')
    await expect(toolbar.getByTestId('sidebar-view-menu')).toHaveAttribute('data-dimmed', 'true')
    await expect(rows(page)).toHaveCount(3)
    // only anchored forks — not the master-opened worker or the hand pair
    expect((await rowOrder(page)).sort()).toEqual([CHILD_IDLE, CHILD_WAIT, CHILD_WORK].sort())
    const row = (id: string) => page.locator(`[data-testid="sidebar-thread-row"][data-child-id="${id}"]`)
    await expect(row(CHILD_WAIT).getByTestId('sidebar-thread-dot')).toHaveAttribute('data-status', 'waiting', { timeout: 5000 })
    await expect(row(CHILD_WORK).getByTestId('sidebar-thread-dot')).toHaveAttribute('data-status', 'working', { timeout: 5000 })
    await expect(row(CHILD_IDLE).getByTestId('sidebar-thread-dot')).toHaveAttribute('data-status', 'waiting')
    await expect(row(CHILD_WAIT).getByTestId('sidebar-thread-status')).toHaveText('Waiting for you')
    await expect(row(CHILD_WORK).getByTestId('sidebar-thread-status')).toHaveText('Working')
    await expect(row(CHILD_IDLE).getByTestId('sidebar-thread-status')).toHaveText('Waiting for you')
    await expect(row(CHILD_WAIT).getByTestId('sidebar-thread-parent')).toHaveText('in Release prep · T145 project')
    await expect(row(CHILD_WORK).getByTestId('sidebar-thread-parent')).toHaveText('in API lead · T145 backend')
    await expect(row(CHILD_WAIT).getByTestId('sidebar-thread-quote')).toContainText('Here is the summary.')
    await expect(row(CHILD_WAIT).getByTestId('sidebar-thread-quote')).not.toContainText('|')
    await expect(row(CHILD_WAIT).getByTestId('sidebar-thread-time')).toHaveText(/^(now|\d+m)$/)
    // the DOM order is main's order: newest activity first
    const mainOrder = await page.evaluate(() => window.api.getAllChatThreads(false).then((list) => list.map((thread) => thread.childId)))
    await expect.poll(() => rowOrder(page)).toEqual(mainOrder)
    expect(await overflowingRows(page)).toEqual([])
    await shot(page, 't145-2-threads-1280')

    // open: a renamed parent follows within 3 seconds
    await page.evaluate((id) => window.api.renameSession('w-t145-project', id, 'Release prep 2'), PARENT_A)
    await expect(row(CHILD_WAIT).getByTestId('sidebar-thread-parent')).toHaveText('in Release prep 2 · T145 project', { timeout: 3000 })
    await page.evaluate((id) => window.api.renameSession('w-t145-project', id, 'Release prep'), PARENT_A)
    await expect(row(CHILD_WAIT).getByTestId('sidebar-thread-parent')).toHaveText('in Release prep · T145 project', { timeout: 3000 })
    await expect(icon.getByTestId('all-sessions-threads-badge')).toHaveText('2')

    // fb-1120b 8a858cc3: a row opens the thread as its own session (in Chat)
    const before = await rowOrder(page)
    await row(CHILD_WORK).click()
    await expect(macChat(page)).toHaveAttribute('data-session-id', CHILD_WORK, { timeout: 15_000 })
    await expect(page.getByTestId('chat-thread-panel')).toHaveCount(0)
    await expect(row(CHILD_WORK)).toHaveAttribute('data-selected', 'true')
    expect(await rowOrder(page)).toEqual(before)
    // its small split icon opens the parent's Chat with that thread's panel beside it
    const beside = (id: string) => page.locator(`[data-child-id="${id}"] ~ [data-testid="sidebar-thread-open-beside"]`)
    // the icon shows on a row that is not selected only while the pointer is over it
    await page.mouse.move(5, 5)
    await expect(beside(CHILD_WAIT)).toHaveCSS('opacity', '0')
    await row(CHILD_WAIT).hover()
    await expect(beside(CHILD_WAIT)).toHaveCSS('opacity', '1')
    await row(CHILD_WORK).hover()
    await beside(CHILD_WORK).click()
    const panel = page.getByTestId('chat-thread-panel')
    await expect(panel).toBeVisible({ timeout: 15_000 })
    await expect(panel).toHaveAttribute('data-session-id', CHILD_WORK)
    await expect(macChat(page)).toHaveAttribute('data-session-id', PARENT_B)
    await expect(page.locator('[data-crumb="session"]:visible')).toHaveText('API lead')
    await expect(row(CHILD_WORK)).toHaveAttribute('data-selected', 'true')
    await expect(icon).toHaveAttribute('aria-pressed', 'true')
    expect(await rowOrder(page)).toEqual(before)
    await expect(panel.getByTestId('chat-thread-quote')).toContainText('Here is the summary.')
    // the Chat narrows beside the panel (1280: Chat is wider than 760px, so no overlay)
    const main = macChat(page).locator(':scope > .chat-main')
    const mainBox = (await main.boundingBox())!
    const panelBox = (await panel.boundingBox())!
    expect(mainBox.x + mainBox.width).toBeLessThanOrEqual(panelBox.x + 1)
    await expect(main.getByTestId('chat-composer')).toBeVisible()
    await shot(page, 't145-3-thread-open-1280')

    // the other parent's split icon switches parent and panel
    await row(CHILD_WAIT).hover()
    await beside(CHILD_WAIT).click()
    await expect(macChat(page)).toHaveAttribute('data-session-id', PARENT_A)
    await expect(panel).toHaveAttribute('data-session-id', CHILD_WAIT)
    await expect(row(CHILD_WAIT)).toHaveAttribute('data-selected', 'true')
    await expect(row(CHILD_WORK)).not.toHaveAttribute('data-selected', 'true')

    // fb-1120b f8a6577f: a double-click on a row renames that thread session in place
    await row(CHILD_IDLE).dblclick()
    const rename = page.getByTestId('sidebar-thread-rename')
    await expect(rename).toBeFocused({ timeout: 5000 })
    await rename.fill('Idle thread renamed')
    await rename.press('Enter')
    await expect(row(CHILD_IDLE)).toContainText('Idle thread renamed', { timeout: 5000 })

    // 390 with the sidebar open: nothing spills out of the sidebar
    await resizeMainWindow(result!.app, 390, 800)
    await expect(rows(page)).toHaveCount(3)
    expect(await overflowingRows(page)).toEqual([])
    await shot(page, 't145-4-threads-390', 390)
    await resizeMainWindow(result!.app, 1280, 800)

    // closing a child drops its row at once (and the selected one's panel)
    await page.evaluate(() => window.api.removeSession('w-t145-project', 't145-child-wait'))
    await expect(rows(page)).toHaveCount(2, { timeout: 3000 })
    await expect(panel).toHaveCount(0)
    await expect(row(CHILD_WAIT)).toHaveCount(0)

    // fb-1128 385ccba4: the row's × closes the thread — the sidebar's Delete (same confirm: a running agent asks first)
    const close = (id: string) => page.locator(`[data-child-id="${id}"] ~ [data-testid="sidebar-thread-close"]`)
    await page.mouse.move(5, 5)
    await expect(close(CHILD_IDLE)).toHaveCSS('opacity', '0')
    await row(CHILD_IDLE).hover()
    await expect(close(CHILD_IDLE)).toHaveCSS('opacity', '1')
    await expect(close(CHILD_IDLE)).toHaveAttribute('title', 'Close thread')
    await shot(page, 't145-5-close-hover')
    expect(await overflowingRows(page)).toEqual([])
    // the row's right-click is the session menu
    await row(CHILD_IDLE).click({ button: 'right' })
    await expect(page.locator('[data-sidebar-menu="session"]')).toContainText('Copy Session ID')
    await page.keyboard.press('Escape')
    const storedIds = (): string[] => JSON.parse(fs.readFileSync(path.join(result!.userDataDir, 'config.json'), 'utf-8'))
        .workspaces.flatMap((w: { sessions: Array<{ id: string }> }) => w.sessions.map((s) => s.id))
    const answerDialog = (response: number) => result!.app.evaluate(({ dialog }, answer) => {
        const asked = globalThis as unknown as { __t145Asked: number }
        asked.__t145Asked = 0
        dialog.showMessageBox = (async () => { asked.__t145Asked++; return { response: answer, checkboxChecked: false } }) as unknown as typeof dialog.showMessageBox
    }, response)
    const asked = () => result!.app.evaluate(() => (globalThis as unknown as { __t145Asked: number }).__t145Asked)
    // Cancel: nothing closes
    await answerDialog(0)
    await row(CHILD_IDLE).hover()
    await close(CHILD_IDLE).click()
    await expect.poll(asked).toBe(1)
    await page.waitForTimeout(500)
    await expect(row(CHILD_IDLE)).toHaveCount(1)
    expect(storedIds()).toContain(CHILD_IDLE)
    // Terminate: the row, the stored session and its thread go; the parent stays
    await answerDialog(1)
    await row(CHILD_IDLE).hover()
    await close(CHILD_IDLE).click()
    await expect(row(CHILD_IDLE)).toHaveCount(0, { timeout: 3000 })
    await expect(rows(page)).toHaveCount(1)
    await expect.poll(storedIds).not.toContain(CHILD_IDLE)
    expect(storedIds()).toContain(PARENT_A)

    // the icon again: back to the list, in the layout it had
    await icon.click()
    await expect(icon).toHaveAttribute('aria-pressed', 'false')
    await expect(rows(page)).toHaveCount(0)
    await expect(page.locator(`[data-session-item="${PARENT_A}"]`).first()).toBeVisible()
    await expect(toolbar.getByTestId('sidebar-view-menu')).toHaveAttribute('data-view', 'list')
    await expect(toolbar.getByTestId('sidebar-view-menu')).not.toHaveAttribute('data-dimmed', 'true')

    // on again, then restart: the list is still open
    await icon.click()
    await expect(rows(page)).toHaveCount(1)
    const userDataDir = result!.userDataDir
    await result!.app.close()
    keepDirs.push(userDataDir)
    result = null
    relaunched = await electron.launch({
        args: [path.join(REPO_ROOT, 'out/main/index.js')],
        env: {
            ...process.env,
            CLIMANGER_TEST_USERDATA: userDataDir,
            CLIMANGER_TERM_DEBUG: '1',
            CLIMANGER_TEST_HEADLESS: '1'
        } as Record<string, string>
    })
    const again = await relaunched.firstWindow()
    await expect(again.getByTestId('all-sessions-threads')).toHaveAttribute('aria-pressed', 'true', { timeout: 30_000 })
    await expect(again.getByTestId('sidebar-thread-row')).toHaveCount(1, { timeout: 15_000 })
})

test('T145: with no threads the list says how to make one, and nothing else is listed', async () => {
    test.setTimeout(120_000)
    result = await launchAppWithWorkspaces([{ id: 'w-t145-empty', name: 'T145 empty', sessions: [{ id: 't145-a', name: 'A' }, { id: 't145-b', name: 'B' }] }], {
        config: { sessionRelations: [{ from: 't145-a', to: 't145-b', kind: 'opened', at: Date.now() }] }
    })
    const { page } = result
    await toggleSidebarView(page)
    const icon = page.getByTestId('all-sessions-threads')
    await expect(icon).toBeVisible()
    await expect(icon.getByTestId('all-sessions-threads-badge')).toHaveCount(0)
    await icon.click()
    await expect(page.getByTestId('sidebar-threads-empty')).toHaveText('No threads yet — use Reply in thread on an answer')
    await expect(rows(page)).toHaveCount(0)
})
