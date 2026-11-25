import { test, expect, type Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { closeApp, launchAppWithWorkspaces, LaunchResult, REPO_ROOT, resizeMainWindow, waitForBufferText } from './helpers'
import type { SessionRelation } from '../../src/shared/types'

/**
 * T170 — `@` in the Chat box names a session (89755e23).
 *
 * The menu lists a «Sessions» group above the files: what this session opened (Below), then Beside, Above,
 * Also related, then the rest. Typing after `@` filters by session or workspace name. Picking one leaves
 * `<name> (climanager://session/<8>) ` in the box and sends nothing; the message that goes out carries the
 * link and the bubble draws it as a session link.
 *
 * The session runs chat-mock; the others are plain sessions. T170_SHOTS + T170_LABEL save captures first.
 */

const MOCK = path.join(REPO_ROOT, 'scripts/mock-cli/chat-mock.cjs')
const LABEL = process.env.T170_LABEL ?? 'run'
const ME = '170a0001-0000-4000-8000-000000000001'
const KID_OLD = '170b0002-0000-4000-8000-000000000002'
const KID_NEW = '170b0003-0000-4000-8000-000000000003'
const PARENT = '170c0004-0000-4000-8000-000000000004'
const SIBLING = '170d0005-0000-4000-8000-000000000005'
const STRANGER = '170e0006-0000-4000-8000-000000000006'
const RELATIONS: SessionRelation[] = [
    { from: ME, to: KID_OLD, kind: 'opened', at: 1 },
    { from: ME, to: KID_NEW, kind: 'opened', at: 2 },
    { from: PARENT, to: ME, kind: 'opened', at: 3 },
    { from: PARENT, to: SIBLING, kind: 'opened', at: 4 }
]

let result: LaunchResult | null = null
test.afterEach(async () => {
    if (result) {
        const done = result
        const closed = await Promise.race([closeApp(done).then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 20_000))])
        if (!closed) {
            done.app.process().kill('SIGKILL')
            fs.rmSync(done.userDataDir, { recursive: true, force: true })
        }
    }
    result = null
})

async function shot(page: Page, name: string): Promise<void> {
    const dir = process.env.T170_SHOTS
    if (!dir) return
    fs.mkdirSync(dir, { recursive: true })
    await page.waitForTimeout(400)
    await page.screenshot({ path: path.join(dir, `${name}-${LABEL}.png`) })
}

const terminalLines = (page: Page, id: string): Promise<string> =>
    page.evaluate((sessionId) => window.api.feedbackTerminalContext(sessionId).then((c) => (c.terminal?.recentLines ?? []).join('\n')), id)

test('T170 @ lists sessions above files, filters, picks a link without sending, and the sent message keeps the link', async () => {
    test.setTimeout(180_000)
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'climanager-t170-'))
    const project = path.join(home, 'project')
    fs.mkdirSync(project, { recursive: true })
    fs.writeFileSync(path.join(project, 'kid-notes.txt'), 'x')
    const claudeDir = path.join(home, 'claude')
    const transcript = path.join(claudeDir, 'projects', 'x', '00000000-0000-4000-8000-0000000c1700.jsonl')
    fs.mkdirSync(path.dirname(transcript), { recursive: true })
    fs.writeFileSync(transcript, '')
    result = await launchAppWithWorkspaces(
        [
            {
                id: 'w-t170',
                name: 'T170 project',
                path: project,
                sessions: [
                    {
                        id: ME,
                        name: 'T170 Claude',
                        cliSessionId: '00000000-0000-4000-8000-0000000c1700',
                        cliToolName: 'claude',
                        cliCommand: `node ${MOCK} --transcript ${transcript} --work-ms 300`
                    },
                    { id: KID_OLD, name: 'T170 kid old' },
                    { id: KID_NEW, name: 'T170 kid new' },
                    { id: PARENT, name: 'T170 parent' },
                    { id: SIBLING, name: 'T170 sibling' }
                ]
            },
            { id: 'w-zeta', name: 'Zeta workspace', path: project, sessions: [{ id: STRANGER, name: 'T170 stranger' }] }
        ],
        { config: { sessionRelations: RELATIONS }, env: { CLAUDE_CONFIG_DIR: claudeDir } }
    )
    const { app, page } = result
    await resizeMainWindow(app, 1280, 800)
    await waitForBufferText(page, ME, 'Claude Code (mock)', 20_000)
    await page.getByText('T170 Claude', { exact: true }).first().click()
    await page.waitForTimeout(400)
    await page.getByTestId('view-toggle-chat').click()
    const chat = page.locator('[data-testid="chat-view"][data-session-id]:visible')
    const composer = chat.getByTestId('chat-composer')
    await expect(composer).toBeVisible({ timeout: 15_000 })
    const menu = chat.getByTestId('chat-complete')
    const sessionRows = menu.locator('[data-kind="session"]')
    // the app may add a session of its own (Home/Playground): only this test's are compared
    const mentioned = (): Promise<string[]> =>
        sessionRows.evaluateAll((rows) => rows.map((row) => row.getAttribute('data-session-mention') ?? '').filter((id) => id.startsWith('170')))

    // `@` alone: sessions first — Below (newest first), Beside, Above, then the rest; never itself
    await composer.focus()
    await page.keyboard.type('@')
    await expect(menu).toBeVisible()
    await shot(page, 't170-1-at')
    await expect.poll(() => mentioned()).toEqual([KID_NEW, KID_OLD, SIBLING, PARENT, STRANGER])
    await expect(sessionRows.nth(0)).toContainText('Below')
    await expect(sessionRows.nth(2)).toContainText('Beside')
    await expect(sessionRows.nth(3)).toContainText('Above')
    await expect(sessionRows.nth(0)).toContainText('T170 project')
    await expect(menu.getByTestId('chat-complete-group').first()).toHaveText('Sessions')

    // the files stay below the sessions
    await page.keyboard.type('kid')
    await expect(menu.locator('[data-kind="file"]').first()).toBeVisible({ timeout: 10_000 })
    const kinds = await menu.locator('[data-testid="chat-complete-row"]').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-kind')))
    expect(kinds.indexOf('file')).toBeGreaterThan(kinds.lastIndexOf('session'))
    await expect(menu.getByTestId('chat-complete-group').nth(1)).toHaveText('Files')
    await expect.poll(() => mentioned()).toEqual([KID_NEW, KID_OLD])

    // a workspace name filters too
    await composer.fill('@zeta')
    await expect.poll(() => mentioned()).toEqual([STRANGER])

    // Enter picks: the name and the link, nothing sent
    await composer.fill('look at @kid old')
    await composer.fill('look at @old')
    await expect.poll(() => mentioned()).toEqual([KID_OLD])
    await page.keyboard.press('Enter')
    await expect(composer).toHaveValue('look at T170 kid old (climanager://session/170b0002) ')
    await expect(menu).toBeHidden()
    await shot(page, 't170-2-picked')
    await page.waitForTimeout(600)
    expect(await terminalLines(page, ME)).not.toContain('ANSWER[1]')

    // the message that goes out keeps the link, and the bubble draws it as a session link
    await page.keyboard.type('please')
    await page.keyboard.press('Enter')
    await expect.poll(() => terminalLines(page, ME), { timeout: 10_000 }).toContain('ANSWER[1]: look at T170 kid old (climanager://session/170b0002) please')
    await expect(chat.getByTestId('chat-session-link').first()).toBeVisible({ timeout: 10_000 })
    await shot(page, 't170-3-sent')

    // ↑/↓ and Tab work as they do for files: Tab picks the highlighted session
    await composer.fill('@')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Tab')
    await expect(composer).toHaveValue('T170 kid old (climanager://session/170b0002) ')
    // Esc closes the menu and keeps the text
    await composer.fill('@zeta')
    await expect(menu).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(menu).toBeHidden()
    await expect(composer).toHaveValue('@zeta')
})
