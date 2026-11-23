import { test, expect, type Locator, type Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { closeApp, launchAppWithWorkspaces, LaunchResult, REPO_ROOT, resizeMainWindow, termText, waitForBufferText } from './helpers'

/**
 * T160 — fb-1123 Chat reports, in the app.
 *
 * 8a3a326f: a Codex session whose turns failed on the usage limit shows the reason under each prompt
 * (the terminal printed it in red; the Chat showed the prompts and nothing). 0adc1255: Codex's `/model`
 * records `thread_settings_applied` at once — the model chip follows it without waiting for a turn.
 * 00c4df83: with a message queued while Claude works, the send key in the empty box sends the first one
 * now (as its Send now button), the queued row says so, and neither an IME's Enter nor a second press
 * right behind a send pushes a queued message out.
 *
 * Checks the old build fails are soft, so a run on the old build reaches the end and leaves every «before»
 * capture. T160_SHOTS=<folder> saves `<folder>/<report id8>/<T160_LABEL or after>.png` before each check.
 */

const MOCK = path.join(REPO_ROOT, 'scripts/mock-cli/chat-mock.cjs')
const slug = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, '-')
const CODEX_ID = '00000000-0000-4000-8000-0000000c1601'
const CLAUDE_ID = '00000000-0000-4000-8000-0000000c1602'
const LIMIT = 'You’ve hit your usage limit. Upgrade to Pro (https://example.invalid/pro) or try again at Nov 24th, 2026 11:15 PM.'

let result: LaunchResult | null = null
test.afterEach(async () => {
    if (result) await closeApp(result)
    result = null
})

const chat = (page: Page): Locator => page.locator('[data-testid="chat-view"][data-session-id]:visible')

async function shot(page: Page, report: string): Promise<void> {
    const dir = process.env.T160_SHOTS
    if (!dir) return
    fs.mkdirSync(path.join(dir, report), { recursive: true })
    await page.waitForTimeout(400)
    await page.screenshot({ path: path.join(dir, report, `${process.env.T160_LABEL ?? 'after'}.png`), clip: { x: 0, y: 0, width: 1280, height: 800 } })
}

async function openChat(page: Page, name: string): Promise<void> {
    await page.getByText(name, { exact: true }).first().click()
    await page.waitForTimeout(400)
    await page.getByTestId('view-toggle-chat').click()
    await expect(chat(page)).toBeVisible()
}

const at = (s: number): string => new Date(Date.UTC(2026, 10, 23, 1, 0, s)).toISOString()
const jsonl = (records: unknown[]): string => records.map((record) => JSON.stringify(record)).join('\n') + '\n'

/** A Codex 0.166 interactive rollout: one answered turn, then two the usage limit stopped (shapes measured 2026-11-23). */
function codexRollout(file: string, cwd: string): void {
    const turn = (s: number, id: string, words: string): unknown[] => [
        { timestamp: at(s), type: 'event_msg', payload: { type: 'thread_settings_applied', thread_id: CODEX_ID, thread_settings: { model: 'gpt-6.1-sol', reasoning_effort: 'xhigh' } } },
        { timestamp: at(s), type: 'event_msg', payload: { type: 'task_started', turn_id: id } },
        { timestamp: at(s), type: 'turn_context', payload: { turn_id: id, cwd, model: 'gpt-6.1-sol', effort: 'xhigh', sandbox_policy: { type: 'danger-full-access' } } },
        { timestamp: at(s), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: words }] } }
    ]
    const records = [
        { timestamp: at(0), type: 'session_meta', payload: { id: CODEX_ID, cwd, source: 'cli', originator: 'codex_cli_rs' } },
        ...turn(1, 't1', 'Did we submit it?'),
        { timestamp: at(2), type: 'event_msg', payload: { type: 'agent_message', message: 'Not yet: the record shows 0 of 1.', phase: 'final_answer' } },
        { timestamp: at(2), type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1', last_agent_message: 'Not yet.' } },
        ...turn(10, 't2', 'What did we decide to submit?'),
        { timestamp: at(11), type: 'event_msg', payload: { type: 'task_complete', turn_id: 't2', last_agent_message: null, error: { message: LIMIT, codex_error_info: 'usage_limit_exceeded' } } },
        ...turn(20, 't3', 'Where are we now?'),
        { timestamp: at(21), type: 'event_msg', payload: { type: 'task_complete', turn_id: 't3', last_agent_message: null, error: { message: LIMIT, codex_error_info: 'usage_limit_exceeded' } } }
    ]
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, jsonl(records))
}

test('T160 fb-1123: a failed Codex turn shows why, the Codex chip follows /model, Enter sends the queued message now', async () => {
    test.setTimeout(240_000)
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'climanager-t160-'))
    const project = path.join(home, 'project')
    fs.mkdirSync(project)
    const claudeDir = path.join(home, 'claude')
    const codexDir = path.join(home, 'codex')
    const rollout = path.join(codexDir, 'sessions', '2026', '11', '23', `rollout-2026-11-23T10-00-00-${CODEX_ID}.jsonl`)
    const transcript = path.join(claudeDir, 'projects', slug(project), `${CLAUDE_ID}.jsonl`)
    codexRollout(rollout, project)
    fs.mkdirSync(path.dirname(transcript), { recursive: true })
    fs.writeFileSync(transcript, '')

    result = await launchAppWithWorkspaces(
        [
            {
                id: 'w-t160',
                name: 'T160 project',
                path: project,
                sessions: [
                    { id: 't160-codex', name: 'T160 Codex', cliSessionId: CODEX_ID, cliToolName: 'codex', cliCommand: `node ${MOCK} --agent codex --transcript ${rollout} --continue` },
                    { id: 't160-claude', name: 'T160 Claude', cliSessionId: CLAUDE_ID, cliToolName: 'claude', cliCommand: `node ${MOCK} --transcript ${transcript} --work-ms 9000` }
                ]
            }
        ],
        { env: { CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: codexDir } }
    )
    const { app, page } = result
    await resizeMainWindow(app, 1280, 800)

    // --- 8a3a326f: the usage-limit reason under each failed prompt --------------------------------
    await openChat(page, 'T160 Codex')
    await expect(chat(page).getByText('Where are we now?')).toBeVisible({ timeout: 15_000 })
    await shot(page, '8a3a326f')
    const failures = chat(page).locator('[data-testid="chat-notice"][data-source="error"]')
    await expect.soft(failures).toHaveCount(2, { timeout: 5_000 })
    await expect.soft(failures.last()).toContainText('usage limit')
    await expect.soft(failures.last()).toContainText('Turn failed')
    // each reason sits right after its own prompt
    const order = await chat(page).locator('[data-testid="chat-turn"]').evaluateAll((turns) =>
        turns.map((turn) => (turn.querySelector('[data-source="error"]') ? 'error' : turn.textContent?.includes('Where are we now?') ? 'q3' : turn.textContent?.includes('What did we decide') ? 'q2' : 'other'))
    )
    expect.soft(order.slice(-4)).toEqual(['q2', 'error', 'q3', 'error'])

    // --- 0adc1255: the chip follows a /model change before any turn ------------------------------
    const chip = chat(page).getByTestId('chat-model-chip')
    await expect(chip).toHaveAttribute('title', /gpt-6\.1-sol · reasoning xhigh/)
    // what the real codex-cli wrote for one pick in its /model picker (0.171, 2026-11-23): settings, no turn
    fs.appendFileSync(rollout, jsonl([
        { timestamp: at(40), type: 'event_msg', payload: { type: 'thread_settings_applied', thread_id: CODEX_ID, thread_settings: { model: 'gpt-6-sol', reasoning_effort: 'medium' } } },
        { timestamp: at(40), type: 'event_msg', payload: { type: 'thread_settings_applied', thread_id: CODEX_ID, thread_settings: { model: 'gpt-6-sol', reasoning_effort: 'medium' } } }
    ]))
    await page.waitForTimeout(3_000)
    await shot(page, '0adc1255')
    await expect.soft(chip).toHaveAttribute('title', /gpt-6-sol · reasoning medium/, { timeout: 5_000 })
    await expect.soft(chat(page).getByTestId('chat-model-effort')).toHaveText('· medium')

    // --- 00c4df83: Enter in the empty box sends the first queued message now ----------------------
    await openChat(page, 'T160 Claude')
    await waitForBufferText(page, 't160-claude', 'Claude Code (mock)', 20_000)
    const composer = chat(page).getByTestId('chat-composer')
    await composer.fill('first')
    await composer.press('Enter')
    await expect(chat(page).getByTestId('chat-working')).toBeVisible({ timeout: 10_000 })
    await composer.fill('second')
    await composer.press('Enter')
    const queued = chat(page).getByTestId('chat-queued-item')
    await expect(queued).toHaveCount(1, { timeout: 5_000 })
    // a third, and a second press right behind it (a double press, or Korean IME's Enter after the
    // composition): only the third is queued — «second» does not follow it out
    await page.waitForTimeout(600)
    await composer.fill('third')
    await composer.press('Enter')
    await composer.press('Enter')
    await expect(queued).toHaveCount(2, { timeout: 5_000 })
    await page.waitForTimeout(800)
    expect(await termText(page, 't160-claude')).not.toContain('HELD: second')
    // an Enter while an IME composes, in the empty box: nothing goes
    await composer.evaluate((element) => {
        element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, bubbles: true, cancelable: true }))
    })
    // a composition that just ended, then Enter at once: nothing goes either
    await composer.evaluate((element) => element.dispatchEvent(new CompositionEvent('compositionend', { data: '가', bubbles: true })))
    await composer.press('Enter')
    await page.waitForTimeout(800)
    expect(await termText(page, 't160-claude')).not.toContain('HELD: second')
    await expect(queued).toHaveCount(2)
    await shot(page, '00c4df83')
    await expect.soft(chat(page).getByTestId('chat-queued-key')).toHaveText('· Enter sends the first now')
    // a deliberate Enter later: the oldest goes now, as its Send now button would send it
    await composer.press('Enter')
    await expect.poll(async () => (await termText(page, 't160-claude')).includes('HELD: second'), { timeout: 10_000 }).toBe(true)
    await expect.soft(queued.filter({ hasText: 'third' })).toHaveCount(1)
    expect(await termText(page, 't160-claude')).not.toContain('HELD: third')
    // with words in the box, Enter sends them (queued behind), not the waiting one
    await composer.fill('fourth')
    await expect.soft(chat(page).getByTestId('chat-queued-key')).toHaveCount(0)
    await composer.press('Enter')
    await expect(queued.filter({ hasText: 'fourth' })).toHaveCount(1, { timeout: 5_000 })
    expect(await termText(page, 't160-claude')).not.toContain('HELD: third')
})
