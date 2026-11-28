import { test, expect, type Locator, type Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { closeApp, launchAppWithWorkspaces, LaunchResult, REPO_ROOT, resizeMainWindow, termText, waitForBufferText } from './helpers'

/**
 * T206 — the model chip sets the reasoning effort (b50ec326).
 *
 * Claude: the chip's menu has an Effort group (low · medium · high · xhigh · max, the current one checked);
 * a pick asks first — Claude Code 2.1.332 saves `/effort <level>` as the default for new sessions — and then
 * types `/effort <level>` the way the model pick types `/model`. Clicking the chip's `· high` opens the menu
 * at that group. While the agent works the command waits for the turn (as `/model` does); while it asks a
 * question it is refused and the chip says why. Codex sets effort inside its `/model` picker: the group
 * offers the terminal.
 *
 * T206_SHOTS=<dir> + T206_LABEL save captures before the checks.
 */

const MOCK = path.join(REPO_ROOT, 'scripts/mock-cli/chat-mock.cjs')
const LABEL = process.env.T206_LABEL ?? 'run'
const slug = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, '-')
const CLAUDE_ID = '00000000-0000-4000-8000-0000000c2061'
const CODEX_ID = '00000000-0000-4000-8000-0000000c2062'
const WORK_MS = 4_000

let result: LaunchResult | null = null
test.afterEach(async () => {
    if (!result) return
    const done = result
    result = null
    const closed = await Promise.race([closeApp(done).then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 20_000))])
    if (!closed) {
        done.app.process().kill('SIGKILL')
        fs.rmSync(done.userDataDir, { recursive: true, force: true })
    }
})

const chat = (page: Page): Locator => page.locator('[data-testid="chat-view"][data-session-id]:visible')

async function shot(page: Page, name: string): Promise<void> {
    const dir = process.env.T206_SHOTS
    if (!dir) return
    fs.mkdirSync(dir, { recursive: true })
    await page.waitForTimeout(400)
    await page.screenshot({ path: path.join(dir, `${name}-${LABEL}.png`), clip: { x: 0, y: 0, width: 1280, height: 765 } }) // above the status bar's port list
}

async function openChat(page: Page, name: string): Promise<void> {
    await page.getByText(name, { exact: true }).first().click()
    await page.waitForTimeout(400)
    await page.getByTestId('view-toggle-chat').click()
    await expect(chat(page)).toBeVisible()
}

const at = (s: number): string => new Date(Date.UTC(2026, 10, 28, 1, 0, s)).toISOString()

test('T206 Effort in the model chip: Claude asks, then types /effort; waits while working, refused at a question; Codex → terminal', async () => {
    test.setTimeout(240_000)
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'climanager-t206-'))
    const project = path.join(home, 'project')
    fs.mkdirSync(project)
    const claudeDir = path.join(home, 'claude')
    const codexDir = path.join(home, 'codex')
    const transcript = path.join(claudeDir, 'projects', slug(project), `${CLAUDE_ID}.jsonl`)
    fs.mkdirSync(path.dirname(transcript), { recursive: true })
    fs.writeFileSync(transcript, '')
    const rollout = path.join(codexDir, 'sessions', '2026', '11', '28', `rollout-2026-11-28T10-00-00-${CODEX_ID}.jsonl`)
    fs.mkdirSync(path.dirname(rollout), { recursive: true })
    fs.writeFileSync(
        rollout,
        [
            { timestamp: at(0), type: 'session_meta', payload: { id: CODEX_ID, cwd: project, source: 'cli', originator: 'codex_cli_rs' } },
            { timestamp: at(1), type: 'turn_context', payload: { turn_id: 't1', cwd: project, model: 'gpt-6.1-sol', effort: 'medium' } },
            { timestamp: at(1), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hello Codex' }] } },
            { timestamp: at(2), type: 'event_msg', payload: { type: 'agent_message', message: 'Hello.', phase: 'final_answer' } },
            { timestamp: at(2), type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1', last_agent_message: 'Hello.' } }
        ]
            .map((record) => JSON.stringify(record))
            .join('\n') + '\n'
    )

    result = await launchAppWithWorkspaces(
        [
            {
                id: 'w-t206',
                name: 'T206 project',
                path: project,
                sessions: [
                    { id: 't206-claude', name: 'T206 Claude', cliSessionId: CLAUDE_ID, cliToolName: 'claude', cliCommand: `node ${MOCK} --transcript ${transcript} --work-ms ${WORK_MS}` },
                    { id: 't206-codex', name: 'T206 Codex', cliSessionId: CODEX_ID, cliToolName: 'codex', cliCommand: `node ${MOCK} --agent codex --transcript ${rollout} --continue` }
                ]
            }
        ],
        { env: { CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: codexDir } }
    )
    const { app, page } = result
    await resizeMainWindow(app, 1280, 800)
    await waitForBufferText(page, 't206-claude', 'Claude Code (mock)', 20_000)
    await openChat(page, 'T206 Claude')
    const composer = chat(page).getByTestId('chat-composer')
    await composer.fill('hello')
    await composer.press('Enter')
    const chip = chat(page).getByTestId('chat-model-chip')
    await expect(chip.getByTestId('chat-model-effort')).toHaveText('· high', { timeout: 20_000 })
    await expect(chat(page).getByTestId('chat-working')).toHaveCount(0, { timeout: 20_000 })

    // the chip's `· high` opens the menu at the Effort group, the current level checked and focused
    await chip.getByTestId('chat-model-effort').click()
    const menu = chat(page).getByTestId('chat-model-menu')
    await expect(menu).toBeVisible()
    await shot(page, 't206-effort-menu')
    const options = menu.getByTestId('chat-effort-option')
    expect(await options.evaluateAll((rows) => rows.map((row) => row.getAttribute('data-level')))).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    await expect(menu.locator('[data-testid="chat-effort-option"][aria-checked="true"]')).toHaveAttribute('data-level', 'high')
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-level'))).toBe('high')

    // a pick asks first: Claude saves it as the default; Cancel types nothing
    await menu.locator('[data-testid="chat-effort-option"][data-level="xhigh"]').click()
    const confirm = chat(page).getByTestId('chat-model-confirm')
    await expect(confirm).toHaveAttribute('data-kind', 'effort')
    await expect(confirm).toContainText('default effort for new Claude sessions')
    await shot(page, 't206-effort-confirm')
    await chat(page).getByTestId('chat-model-confirm-cancel').click()
    await page.keyboard.press('Escape')
    await page.waitForTimeout(500)
    expect(await termText(page, 't206-claude')).not.toContain('/effort')

    // OK types `/effort xhigh`; the chip follows Claude's answer
    await chip.click()
    await menu.locator('[data-testid="chat-effort-option"][data-level="xhigh"]').click()
    await chat(page).getByTestId('chat-model-confirm-ok').click()
    await waitForBufferText(page, 't206-claude', 'ANSWER[2]: /effort xhigh', 10_000)
    await waitForBufferText(page, 't206-claude', 'EFFORT: xhigh', 10_000)
    await expect(chip.getByTestId('chat-model-effort')).toHaveText('· xhigh', { timeout: 10_000 })
    await expect(menu).toBeHidden()

    // while the agent works the command waits for the turn to end, as /model does
    await composer.fill('long turn')
    await composer.press('Enter')
    await expect(chat(page).getByTestId('chat-working').first()).toBeVisible({ timeout: 10_000 })
    await chip.click()
    await menu.locator('[data-testid="chat-effort-option"][data-level="max"]').click()
    await expect(confirm).toContainText('The agent is working')
    await chat(page).getByTestId('chat-model-confirm-ok').click()
    await page.waitForTimeout(1_000)
    expect(await termText(page, 't206-claude'), 'not typed into the working agent').not.toContain('/effort max')
    await waitForBufferText(page, 't206-claude', 'EFFORT: max', WORK_MS + 15_000)

    // while a question waits the command is refused, and the chip says why
    await expect(chat(page).getByTestId('chat-working')).toHaveCount(0, { timeout: 20_000 })
    await composer.fill('ASK')
    await composer.press('Enter')
    await expect(chat(page).getByTestId('chat-prompt-card')).toBeVisible({ timeout: 15_000 })
    await chip.click()
    await menu.locator('[data-testid="chat-effort-option"][data-level="low"]').click()
    await chat(page).getByTestId('chat-model-confirm-ok').click()
    const refused = chat(page).getByTestId('chat-model-refused')
    await expect(refused).toBeVisible({ timeout: 5_000 })
    await expect(refused).toContainText('asking a question')
    expect(await termText(page, 't206-claude')).not.toContain('/effort low')

    // Codex: effort is in its /model picker — the group offers the terminal
    await page.keyboard.press('Escape')
    await openChat(page, 'T206 Codex')
    const codexChip = chat(page).getByTestId('chat-model-chip')
    await expect(codexChip.getByTestId('chat-model-effort')).toHaveText('· medium', { timeout: 15_000 })
    await codexChip.getByTestId('chat-model-effort').click()
    await expect(chat(page).getByTestId('chat-effort-option')).toHaveCount(0)
    await expect(chat(page).getByTestId('chat-effort-terminal')).toContainText('Change in Terminal')
    await shot(page, 't206-codex')
    await chat(page).getByTestId('chat-effort-terminal').click()
    await chat(page).getByTestId('chat-model-confirm-ok').click()
    await waitForBufferText(page, 't206-codex', 'PANEL: /model', 10_000)
    await expect(page.getByTestId('view-toggle')).toHaveAttribute('data-mode', 'terminal')
})
