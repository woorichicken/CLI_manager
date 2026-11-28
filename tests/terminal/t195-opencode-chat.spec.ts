import { test, expect, type Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createRequire } from 'module'
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite'
import { closeApp, launchAppWithWorkspaces, LaunchResult, REPO_ROOT, waitForBufferText, writeToTerminal } from './helpers'

/**
 * T195 — an OpenCode session in the app: resumed on restart, its conversation in the Chat view, sent to
 * and stopped (two Esc) from the Chat, its question answered in the terminal, and found when opencode is
 * started by hand.
 *
 * The opencode here is scripts/mock-cli/opencode-mock.cjs run as a program named `opencode` on a PATH with
 * no real one (HOME, XDG_DATA_HOME and PATH are temporary). It draws opencode 1.18.15's screen (copied from
 * a real session, fixtures/opencode), keeps OpenCode 1.x's SQLite store and sets its `OC | <title>` title.
 */

const { DatabaseSync } = createRequire(__filename)('node:sqlite') as { DatabaseSync: typeof DatabaseSyncType }
const MOCK = path.join(REPO_ROOT, 'scripts/mock-cli/opencode-mock.cjs')
const RESUMED_ID = 'ses_t195resumed0000000000000'
const NEW_ID = 'ses_t195new000000000000000000'
const SHOTS = process.env.T195_SHOTS
const LABEL = process.env.T195_LABEL ?? 'after'

let result: LaunchResult | null = null
let root: string | null = null
test.afterEach(async () => {
    if (result) await closeApp(result)
    result = null
    if (root) fs.rmSync(root, { recursive: true, force: true })
    root = null
})

const chat = (page: Page) => page.locator(`[data-testid="chat-view"][data-session-id]:visible`)

async function shot(page: Page, name: string): Promise<void> {
    if (!SHOTS) return
    fs.mkdirSync(SHOTS, { recursive: true })
    await page.waitForTimeout(300)
    await page.screenshot({ path: path.join(SHOTS, `t195-${LABEL}-${name}.png`) })
}

function sandbox() {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't195-')))
    const home = path.join(root, 'home')
    const bin = path.join(root, 'bin')
    const project = path.join(root, 'project')
    const data = path.join(root, 'xdg-data')
    for (const dir of [home, bin, project, path.join(data, 'opencode')]) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(home, '.zshrc'), `export PATH=${JSON.stringify(bin)}:$PATH\n`)
    const launcher = path.join(bin, 'opencode')
    fs.writeFileSync(launcher, `#!${process.execPath}\nrequire(${JSON.stringify(MOCK)})\n`)
    fs.chmodSync(launcher, 0o755)
    return { root, home, bin, project, data }
}

/** OpenCode 1.x rows for a session that ran `ls -la` and answered (the shapes of fixtures/opencode). */
function seedStore(data: string, project: string): void {
    const db = new DatabaseSync(path.join(data, 'opencode', 'opencode.db'))
    db.exec('PRAGMA journal_mode = WAL')
    db.exec(`
CREATE TABLE session (id text PRIMARY KEY, project_id text NOT NULL, parent_id text, slug text NOT NULL, directory text NOT NULL,
  title text NOT NULL, version text NOT NULL, revert text, model text, time_created integer NOT NULL, time_updated integer NOT NULL);
CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);`)
    const t = Date.parse('2026-11-27T03:00:00Z')
    db.prepare("INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (?, 'global', 's', ?, 'Listing the files', '1.18.15', ?, ?)").run(RESUMED_ID, project, t, t + 9)
    const message = (id: string, at: number, data: object) => db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)').run(id, RESUMED_ID, at, at, JSON.stringify(data))
    const part = (id: string, messageId: string, at: number, data: object) => db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)').run(id, messageId, RESUMED_ID, at, at, JSON.stringify(data))
    message('msg_t195a', t + 1, { role: 'user', time: { created: t + 1 }, agent: 'build' })
    part('prt_t195a', 'msg_t195a', t + 1, { type: 'text', text: 'List the files here' })
    message('msg_t195b', t + 2, { role: 'assistant', time: { created: t + 2, completed: t + 3 }, modelID: 'mock-model', providerID: 'mock', finish: 'tool-calls' })
    part('prt_t195b', 'msg_t195b', t + 2, { type: 'tool', tool: 'bash', callID: 'c1', state: { status: 'completed', input: { command: 'ls -la' }, output: 'notes.txt\n', metadata: { exit: 0 } } })
    message('msg_t195c', t + 4, { role: 'assistant', time: { created: t + 4, completed: t + 5 }, modelID: 'mock-model', providerID: 'mock', finish: 'stop', tokens: { input: 900, output: 40, reasoning: 0, cache: { read: 0, write: 0 } } })
    part('prt_t195c', 'msg_t195c', t + 4, { type: 'text', text: 'There is one file, notes.txt.' })
    db.close()
}

function sessionsIn(userDataDir: string): Array<Record<string, unknown>> {
    const config = JSON.parse(fs.readFileSync(path.join(userDataDir, 'config.json'), 'utf8'))
    return (config.workspaces as Array<{ sessions: Array<Record<string, unknown>> }>).flatMap((workspace) => workspace.sessions)
}

test('T195 OpenCode: resumed, read and driven from the Chat, found when started by hand', async () => {
    test.setTimeout(180_000)
    const box = sandbox()
    seedStore(box.data, box.project)
    result = await launchAppWithWorkspaces(
        [{
            id: 'w-t195',
            name: 'T195 project',
            path: box.project,
            sessions: [
                { id: 't195-oc', name: 'T195 opencode', cliSessionId: RESUMED_ID, cliToolName: 'opencode', cliCommand: 'opencode -m mock/mock-model' },
                { id: 't195-shell', name: 'T195 shell' }
            ]
        }],
        {
            env: {
                HOME: box.home,
                ZDOTDIR: box.home,
                PATH: `${box.bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
                SHELL: '/bin/zsh',
                XDG_DATA_HOME: box.data,
                OPENCODE_MOCK_ID: NEW_ID,
                OPENCODE_MOCK_WORK_MS: '2500',
                CLIMANAGER_OPENCODE_SYNC_MS: '300'
            }
        }
    )
    const { page, userDataDir } = result

    // --- restart: the stored session is resumed with its own command ----------------------------
    await page.getByText('T195 opencode', { exact: true }).first().click()
    await waitForBufferText(page, 't195-oc', `ARGS: -m mock/mock-model --session ${RESUMED_ID}`, 30_000)
    await waitForBufferText(page, 't195-oc', 'OpenCode (mock)', 10_000)

    // --- the Chat: the store's rows as turns, the model read only -------------------------------
    await expect(page.getByTestId('view-toggle')).toBeVisible()
    await page.getByTestId('view-toggle-chat').click()
    const view = chat(page)
    await expect(view).toBeVisible()
    await expect(view.locator('[data-testid="chat-turn"][data-role="user"]').first()).toContainText('List the files here')
    await expect(view.locator('[data-testid="chat-answer"]', { hasText: 'There is one file, notes.txt.' })).toBeVisible()
    await expect(view.getByTestId('chat-turn-agent').first()).toHaveText('OpenCode')
    const work = view.getByTestId('chat-work-block').first()
    await work.locator('.chat-work-head').click()
    await expect(work.getByTestId('chat-tool').first()).toContainText('ls -la')
    await expect(view.getByTestId('chat-model-chip')).toHaveAttribute('data-readonly', 'true')
    await expect(view.getByTestId('chat-model-chip')).toContainText('mock-model')
    await expect(view.getByTestId('chat-fork')).toHaveCount(0)
    await shot(page, 'chat')

    // --- sending from the Chat (the composer's grey hint is no typed text), its answer shown ----
    const composer = view.getByTestId('chat-composer')
    await composer.fill('hello from chat')
    await composer.press('Enter')
    await expect(view.getByTestId('chat-working')).toBeVisible({ timeout: 10_000 })
    await shot(page, 'working')
    await waitForBufferText(page, 't195-oc', 'ANSWER[3]: hello from chat', 15_000)
    await expect(view.locator('[data-testid="chat-answer"]', { hasText: 'ANSWER[3]: hello from chat' })).toBeVisible({ timeout: 10_000 })
    await expect(view.getByTestId('chat-working')).toHaveCount(0, { timeout: 10_000 })

    // --- Stop: OpenCode wants Esc twice ----------------------------------------------------------
    await composer.fill('a long one')
    await composer.press('Enter')
    await expect(view.getByTestId('chat-working')).toBeVisible({ timeout: 10_000 })
    await view.getByTestId('chat-stop').click()
    await waitForBufferText(page, 't195-oc', 'Mock Model · interrupted', 10_000)
    await expect(view.getByTestId('chat-working')).toHaveCount(0, { timeout: 10_000 })

    // --- its question: no card, the chat says to answer it in the terminal -----------------------
    await composer.fill('ASK')
    await composer.press('Enter')
    await waitForBufferText(page, 't195-oc', 'Which colour do you prefer?', 10_000)
    await expect(view.getByTestId('chat-prompt-card')).toHaveCount(0)
    await composer.fill('blue please')
    await composer.press('Enter')
    await expect(view.getByTestId('chat-composer-note')).toContainText('asking a question', { timeout: 10_000 })
    await shot(page, 'question')

    // --- started by hand in a plain shell: found once its first answer names the session ---------
    await page.getByText('T195 shell', { exact: true }).first().click()
    await writeToTerminal(page, 't195-shell', 'opencode\r')
    await waitForBufferText(page, 't195-shell', 'OpenCode (mock)', 20_000)
    // the home screen names no session: nothing is bound yet
    await page.waitForTimeout(1500)
    expect(sessionsIn(userDataDir).find((session) => session.id === 't195-shell')?.cliToolName).toBeUndefined()
    await writeToTerminal(page, 't195-shell', 'first words\r')
    await waitForBufferText(page, 't195-shell', 'ANSWER[1]: first words', 15_000)
    await expect.poll(() => sessionsIn(userDataDir).find((session) => session.id === 't195-shell'), { timeout: 15_000 })
        .toMatchObject({ cliToolName: 'opencode', cliSessionId: NEW_ID, cliCommand: 'opencode' })
    await expect(page.getByTestId('view-toggle')).toBeVisible({ timeout: 10_000 })
    // the resumed one kept its id and command
    expect(sessionsIn(userDataDir).find((session) => session.id === 't195-oc')).toMatchObject({ cliToolName: 'opencode', cliSessionId: RESUMED_ID, cliCommand: 'opencode -m mock/mock-model' })
})

test('T195 OpenCode: an Enter lost in the composer is pressed again (code review)', async () => {
    test.setTimeout(120_000)
    const box = sandbox()
    seedStore(box.data, box.project)
    result = await launchAppWithWorkspaces(
        [{ id: 'w-t195b', name: 'T195 project', path: box.project, sessions: [{ id: 't195-lost', name: 'T195 lost enter', cliSessionId: RESUMED_ID, cliToolName: 'opencode', cliCommand: 'opencode' }] }],
        {
            env: {
                HOME: box.home,
                ZDOTDIR: box.home,
                PATH: `${box.bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
                SHELL: '/bin/zsh',
                XDG_DATA_HOME: box.data,
                OPENCODE_MOCK_LOSE_ENTERS: '1',
                OPENCODE_MOCK_WORK_MS: '500',
                CLIMANAGER_OPENCODE_SYNC_MS: '300'
            }
        }
    )
    const { page } = result
    await page.getByText('T195 lost enter', { exact: true }).first().click()
    await waitForBufferText(page, 't195-lost', 'OpenCode (mock)', 30_000)
    await page.getByTestId('view-toggle-chat').click()
    const view = chat(page)
    await expect(view.locator('[data-testid="chat-answer"]', { hasText: 'There is one file, notes.txt.' })).toBeVisible()
    const composer = view.getByTestId('chat-composer')
    await composer.fill('after a lost enter')
    await composer.press('Enter')
    // the first Enter is swallowed: the text sits in OpenCode's composer until the Chat presses Enter again
    await waitForBufferText(page, 't195-lost', 'ANSWER[3]: after a lost enter', 20_000)
})
