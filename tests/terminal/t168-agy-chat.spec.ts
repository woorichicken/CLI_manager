import { test, expect, type Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { closeApp, launchAppWithWorkspaces, LaunchResult, REPO_ROOT, waitForBufferText, writeToTerminal } from './helpers'

/**
 * T168 — an Antigravity CLI (agy) session in the app: resumed on restart, its conversation in the
 * Chat view, sent to and stopped from the Chat, and found when agy is started by hand.
 *
 * The agy here is scripts/mock-cli/agy-mock.cjs run as a program named `agy` on a PATH with no real
 * one (HOME, ANTIGRAVITY_APP_DATA_DIR and PATH are temporary). It draws agy 1.5.16's screen (copied
 * from a real session, fixtures/agy) and keeps agy's records: the step ledger and the presence lock
 * it holds open, which the app reads with lsof.
 */

const MOCK = path.join(REPO_ROOT, 'scripts/mock-cli/agy-mock.cjs')
const RESUMED_ID = '00000000-0000-4000-8000-0000000016a1'
const NEW_ID = '00000000-0000-4000-8000-0000000016b2'
const SHOTS = process.env.T168_SHOTS
const LABEL = process.env.T168_LABEL ?? 'after'

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
    await page.screenshot({ path: path.join(SHOTS, `t168-${LABEL}-${name}.png`) })
}

function sandbox() {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 't168-'))
    const home = path.join(root, 'home')
    const bin = path.join(root, 'bin')
    const project = path.join(root, 'project')
    const agyHome = path.join(root, 'agy-data')
    for (const dir of [home, bin, project, agyHome]) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(home, '.zshrc'), `export PATH=${JSON.stringify(bin)}:$PATH\n`)
    const launcher = path.join(bin, 'agy')
    fs.writeFileSync(launcher, `#!${process.execPath}\nrequire(${JSON.stringify(MOCK)})\n`)
    fs.chmodSync(launcher, 0o755)
    return { root, home, bin, project, agyHome }
}

function seedLedger(agyHome: string, id: string): void {
    const file = path.join(agyHome, 'brain', id, '.system_generated', 'logs', 'transcript_full.jsonl')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const rows = [
        { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-25T03:00:00Z', content: '<USER_REQUEST>\nList the files here\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nx\n</ADDITIONAL_METADATA>' },
        { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-25T03:00:01Z', model: 'gemini-3.8-flash-low', content: '', tool_calls: [{ name: 'run_command', args: { CommandLine: 'ls -la' } }] },
        { step_index: 2, source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: '2026-11-25T03:00:02Z', content: 'Created At: 2026-11-25T12:00:02+09:00\nCompleted At: 2026-11-25T12:00:02+09:00\ntotal 0\nnotes.txt' },
        { step_index: 3, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-25T03:00:03Z', model: 'gemini-3.8-flash-low', content: 'There is one file, notes.txt.' }
    ]
    fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
}

function sessionsIn(userDataDir: string): Array<Record<string, unknown>> {
    const config = JSON.parse(fs.readFileSync(path.join(userDataDir, 'config.json'), 'utf8'))
    return (config.workspaces as Array<{ sessions: Array<Record<string, unknown>> }>).flatMap((workspace) => workspace.sessions)
}

test('T168 agy: resumed, read and driven from the Chat, found when started by hand', async () => {
    test.setTimeout(180_000)
    const box = sandbox()
    seedLedger(box.agyHome, RESUMED_ID)
    result = await launchAppWithWorkspaces(
        [{
            id: 'w-t168',
            name: 'T168 project',
            path: box.project,
            sessions: [
                { id: 't168-agy', name: 'T168 agy', cliSessionId: RESUMED_ID, cliToolName: 'agy', cliCommand: 'agy --model gemini-3.8-flash-low' },
                { id: 't168-shell', name: 'T168 shell' }
            ]
        }],
        {
            env: {
                HOME: box.home,
                ZDOTDIR: box.home,
                PATH: `${box.bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
                SHELL: '/bin/zsh',
                ANTIGRAVITY_APP_DATA_DIR: box.agyHome,
                AGY_MOCK_ID: NEW_ID,
                AGY_MOCK_WORK_MS: '2500',
                CLIMANAGER_AGY_SYNC_MS: '300'
            }
        }
    )
    const { page, userDataDir } = result

    // --- restart: the stored conversation is resumed with its own command ----------------------
    await page.getByText('T168 agy', { exact: true }).first().click()
    await waitForBufferText(page, 't168-agy', `ARGS: --model gemini-3.8-flash-low --conversation ${RESUMED_ID}`, 30_000)
    await waitForBufferText(page, 't168-agy', 'Antigravity CLI (mock)', 10_000)

    // --- the Chat: the ledger as turns, the model read only -----------------------------------
    await expect(page.getByTestId('view-toggle')).toBeVisible()
    await page.getByTestId('view-toggle-chat').click()
    const view = chat(page)
    await expect(view).toBeVisible()
    await expect(view.locator('[data-testid="chat-turn"][data-role="user"]').first()).toContainText('List the files here')
    await expect(view.locator('[data-testid="chat-answer"]', { hasText: 'There is one file, notes.txt.' })).toBeVisible()
    await expect(view.getByTestId('chat-turn-agent').first()).toHaveText('Antigravity')
    const work = view.getByTestId('chat-work-block').first()
    await work.locator('.chat-work-head').click()
    await expect(work.getByTestId('chat-tool').first()).toContainText('ls -la')
    const model = view.getByTestId('chat-model-chip')
    await expect(model).toHaveAttribute('data-readonly', 'true')
    await expect(model.getByTestId('chat-model-effort')).toContainText('low')
    // no fork on an agy answer
    await expect(view.getByTestId('chat-fork')).toHaveCount(0)
    await shot(page, 'chat')

    // --- sending from the Chat, the turn working, its answer recorded and shown -----------------
    const composer = view.getByTestId('chat-composer')
    await composer.fill('hello from chat')
    await composer.press('Enter')
    await expect(view.getByTestId('chat-working')).toBeVisible({ timeout: 10_000 })
    await shot(page, 'working')
    await waitForBufferText(page, 't168-agy', 'ANSWER[3]: hello from chat', 15_000)
    await expect(view.locator('[data-testid="chat-answer"]', { hasText: 'ANSWER[3]: hello from chat' })).toBeVisible({ timeout: 10_000 })
    await expect(view.getByTestId('chat-working')).toHaveCount(0, { timeout: 10_000 })

    // --- Stop: agy's Esc cancels the turn ----------------------------------------------------
    await composer.fill('a long one')
    await composer.press('Enter')
    await expect(view.getByTestId('chat-working')).toBeVisible({ timeout: 10_000 })
    await view.getByTestId('chat-stop').click()
    await waitForBufferText(page, 't168-agy', 'Cancelled.', 10_000)

    // --- agy's question: no card, the chat says to answer it in the terminal ------------------
    await composer.fill('ASK')
    await composer.press('Enter')
    await waitForBufferText(page, 't168-agy', 'Question 1/1: Which color do you like?', 10_000)
    await expect(view.getByTestId('chat-prompt-card')).toHaveCount(0)
    await composer.fill('blue please')
    await composer.press('Enter')
    await expect(view.getByTestId('chat-composer-note')).toContainText('asking a question', { timeout: 10_000 })
    await shot(page, 'question')

    // --- started by hand in a plain shell: found once its first prompt makes the conversation ---
    await page.getByText('T168 shell', { exact: true }).first().click()
    await writeToTerminal(page, 't168-shell', 'agy\r')
    await waitForBufferText(page, 't168-shell', 'Antigravity CLI (mock)', 20_000)
    await writeToTerminal(page, 't168-shell', 'first words\r')
    await waitForBufferText(page, 't168-shell', 'ANSWER[1]: first words', 15_000)
    await expect.poll(() => sessionsIn(userDataDir).find((session) => session.id === 't168-shell'), { timeout: 15_000 })
        .toMatchObject({ cliToolName: 'agy', cliSessionId: NEW_ID, cliCommand: 'agy' })
    await expect(page.getByTestId('view-toggle')).toBeVisible({ timeout: 10_000 })
    // the resumed one kept its id and command
    expect(sessionsIn(userDataDir).find((session) => session.id === 't168-agy')).toMatchObject({ cliToolName: 'agy', cliSessionId: RESUMED_ID, cliCommand: 'agy --model gemini-3.8-flash-low' })
})
