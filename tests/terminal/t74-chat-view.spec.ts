import { test, expect, type Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { closeApp, launchAppWithWorkspaces, LaunchResult, REPO_ROOT, resizeMainWindow, termText, waitForBufferText, writeToTerminal } from './helpers'

/**
 * T74 — Chat view in the app (Terminal / Chat per session).
 *
 * The sessions run chat-mock.cjs, which draws a Claude Code (or Codex) screen
 * and appends to the agent's transcript file the way the real CLI does. Seeded
 * with a synthetic transcript (fixtures/transcripts) under a temp
 * CLAUDE_CONFIG_DIR / CODEX_HOME. The session's stored `cliCommand` is the mock,
 * so the app's own resume at start launches the mock, never a real agent.
 *
 * Checked: the toggle (agent sessions only, remembered per session), reading
 * (Markdown table, colored code, folded work), the terminal still alive behind
 * the chat, sending (typed into the terminal, recorded, shown), queueing while
 * working, refusing while the terminal input line holds text, the question
 * card (refused when the menu changed, answered by option and by typed words),
 * Codex reading and sending (its card only offers the terminal), and 390 wide.
 * CHAT_VIEW_SHOTS=<folder> saves captures at 1280 and 390.
 */

/** Claude's project folder name (every non-alphanumeric → "-"), written here so the spec runs on old code too. */
const claudeProjectSlug = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, '-')
const MOCK = path.join(REPO_ROOT, 'scripts/mock-cli/chat-mock.cjs')
const FIXTURES = path.join(__dirname, 'fixtures/transcripts')
const CLAUDE_ID = '00000000-0000-4000-8000-00000000c74a'
const CODEX_ID = '00000000-0000-4000-8000-00000000c74b'
const CLAUDE = 't74-claude'
const CODEX = 't74-codex'
const SHELL = 't74-shell'

let result: LaunchResult | null = null
test.afterEach(async () => {
    if (result) await closeApp(result)
    result = null
})

const chat = (page: Page) => page.locator(`[data-testid="chat-view"][data-session-id]:visible`)

async function shot(page: Page, name: string, width = 1280): Promise<void> {
    const dir = process.env.CHAT_VIEW_SHOTS
    if (!dir) return
    fs.mkdirSync(dir, { recursive: true })
    await page.waitForTimeout(300)
    await page.screenshot({ path: path.join(dir, name), clip: { x: 0, y: 0, width, height: 800 } })
}

async function selectSession(page: Page, name: string): Promise<void> {
    await page.getByText(name, { exact: true }).first().click()
    await page.waitForTimeout(400)
}

test('T74 Chat view: toggle, read, send, queue, question card, Codex, 390 wide', async () => {
    test.setTimeout(240_000)
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'climanager-t74-'))
    const project = path.join(home, 'project')
    fs.mkdirSync(project)
    const claudeDir = path.join(home, 'claude')
    const codexDir = path.join(home, 'codex')
    const transcript = path.join(claudeDir, 'projects', claudeProjectSlug(project), `${CLAUDE_ID}.jsonl`)
    const rollout = path.join(codexDir, 'sessions', '2026', '11', '03', `rollout-2026-11-03T10-00-00-${CODEX_ID}.jsonl`)
    fs.mkdirSync(path.dirname(transcript), { recursive: true })
    fs.mkdirSync(path.dirname(rollout), { recursive: true })
    fs.copyFileSync(path.join(FIXTURES, 'claude/tools.jsonl'), transcript)
    fs.copyFileSync(path.join(FIXTURES, 'codex/rollout-2026-11-03T10-00-00-00000000-0000-4000-8000-0000000000c1.jsonl'), rollout)

    result = await launchAppWithWorkspaces(
        [
            {
                id: 'w-t74',
                name: 'T74 project',
                path: project,
                sessions: [
                    { id: CLAUDE, name: 'T74 Claude', cliSessionId: CLAUDE_ID, cliToolName: 'claude', cliCommand: `node ${MOCK} --transcript ${transcript} --work-ms 2500` },
                    { id: CODEX, name: 'T74 Codex', cliSessionId: CODEX_ID, cliToolName: 'codex', cliCommand: `node ${MOCK} --agent codex --transcript ${rollout} --work-ms 800` },
                    { id: SHELL, name: 'T74 Shell' }
                ]
            }
        ],
        { env: { CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: codexDir } }
    )
    const { app, page } = result
    await resizeMainWindow(app, 1280, 800)

    // --- the toggle: agent sessions only ---------------------------------------------------
    await selectSession(page, 'T74 Shell')
    await expect(page.getByTestId('view-toggle')).toHaveCount(0)
    await selectSession(page, 'T74 Claude')
    await waitForBufferText(page, CLAUDE, 'Claude Code (mock)', 20_000)
    await expect(page.getByTestId('view-toggle')).toBeVisible()
    await expect(page.getByTestId('view-toggle')).toHaveAttribute('data-mode', 'terminal')
    await shot(page, 'terminal-1280.png')

    // --- reading: the seeded transcript as a chat -----------------------------------------
    await page.getByTestId('view-toggle-chat').click()
    const view = chat(page)
    await expect(view).toBeVisible()
    await expect(view.locator('[data-testid="chat-turn"][data-role="user"]').first()).toContainText('Add a guard to src/a.ts')
    // the answer's Markdown: a real table and a colored code block
    await expect(view.locator('.chat-md table th').first()).toHaveText('file')
    await expect(view.locator('[data-chat-code="ts"] .hl-keyword').first()).toBeVisible()
    // the turn's work is folded under one row once the turn is over
    const work = view.getByTestId('chat-work-block').first()
    await expect(work).toHaveAttribute('data-open', 'false')
    await expect(work).toContainText('1 edit')
    await work.locator('.chat-work-head').click()
    await expect(work.getByTestId('chat-tool')).toHaveCount(2)
    await shot(page, 'chat-1280.png')

    // the terminal is alive under the chat, and the choice is remembered per session
    await page.getByTestId('view-toggle-terminal').click()
    await expect(chat(page)).toHaveCount(0)
    expect(await termText(page, CLAUDE)).toContain('Claude Code (mock)')
    await page.getByTestId('view-toggle-chat').click()
    await selectSession(page, 'T74 Shell')
    await expect(chat(page)).toHaveCount(0)
    await selectSession(page, 'T74 Claude')
    await expect(chat(page)).toBeVisible()
    expect(await page.evaluate(() => localStorage.getItem('session-view-modes'))).toContain(CLAUDE)

    // --- sending: into the terminal, recorded, shown ---------------------------------------
    const composer = chat(page).getByTestId('chat-composer')
    await composer.fill('hello from chat')
    await composer.press('Enter')
    await waitForBufferText(page, CLAUDE, 'ANSWER[1]: hello from chat', 15_000)
    await expect(chat(page).getByTestId('chat-working')).toBeVisible({ timeout: 10_000 })
    // sent while the agent works: held, then sent when the turn ends
    await composer.fill('second while working')
    await composer.press('Enter')
    await expect(chat(page).getByTestId('chat-composer-note')).toContainText('is working')
    await expect(chat(page).getByTestId('chat-queued')).toContainText('second while working')
    await waitForBufferText(page, CLAUDE, 'ANSWER[2]: second while working', 20_000)
    await expect(chat(page).getByTestId('chat-queued')).toHaveCount(0)
    await expect(chat(page).locator('[data-testid="chat-user-text"]', { hasText: 'second while working' })).toBeVisible({ timeout: 10_000 })
    await expect(chat(page).locator('[data-testid="chat-answer"]', { hasText: 'Echo: hello from chat' })).toBeVisible({ timeout: 15_000 })

    // the terminal's input line already holds text: refused, nothing typed over it
    await expect(chat(page).getByTestId('chat-working')).toHaveCount(0, { timeout: 15_000 })
    await writeToTerminal(page, CLAUDE, 'half typed')
    await page.waitForTimeout(400)
    await composer.fill('should not mix')
    await composer.press('Enter')
    await expect(chat(page).getByTestId('chat-composer-note')).toContainText('input line already has text')
    expect(await termText(page, CLAUDE)).not.toContain('should not mix')
    await writeToTerminal(page, CLAUDE, '\x15')
    await composer.fill('')

    // --- the question card ------------------------------------------------------------------
    await composer.fill('ASK')
    await composer.press('Enter')
    const card = chat(page).getByTestId('chat-prompt-card')
    await expect(card).toBeVisible({ timeout: 10_000 })
    await expect(card).toHaveAttribute('data-kind', 'permission')
    await expect(card.getByTestId('chat-prompt-question')).toHaveText('Do you want to proceed?')
    await expect(card.getByTestId('chat-prompt-option')).toHaveCount(4)
    await expect(composer).toBeDisabled()
    await shot(page, 'card-1280.png')
    // the menu moved in the terminal after the card was drawn: an answer for the old menu is refused
    const before = await page.evaluate((id) => window.api.getConversation(id), CLAUDE)
    await writeToTerminal(page, CLAUDE, '\x1b[B')
    await page.waitForTimeout(500)
    const stale = await page.evaluate(([id, signature]) => window.api.answerPrompt(id, { signature, optionIndex: 0 }), [CLAUDE, before!.prompt!.signature] as const)
    expect(stale).toMatchObject({ status: 'rejected', reason: 'prompt_changed' })
    expect(await termText(page, CLAUDE)).not.toContain('CHOSE:')
    // the card follows the new menu, and its button answers it
    await expect(card.locator('.chat-prompt-option.is-selected')).toHaveAttribute('data-index', '1', { timeout: 5_000 })
    await card.locator('[data-testid="chat-prompt-option"][data-index="3"]').click()
    await waitForBufferText(page, CLAUDE, 'CHOSE: No', 10_000)
    await expect(card).toHaveCount(0, { timeout: 10_000 })
    await expect(chat(page).locator('[data-testid="chat-answer"]', { hasText: 'I did not run it' })).toBeVisible({ timeout: 10_000 })

    // a question with "Type something.": the card takes the words
    await composer.fill('QUESTION')
    await composer.press('Enter')
    await expect(card).toHaveAttribute('data-kind', 'question', { timeout: 10_000 })
    await expect(card.getByTestId('chat-prompt-question')).toHaveText('어떤 색이 좋아?')
    await shot(page, 'question-1280.png')
    await card.getByTestId('chat-prompt-custom-input').fill('초록')
    await card.getByTestId('chat-prompt-custom-send').click()
    await waitForBufferText(page, CLAUDE, 'CHOSE: custom 초록', 10_000)
    await expect(chat(page).locator('[data-testid="chat-answer"]', { hasText: 'You picked custom 초록' })).toBeVisible({ timeout: 10_000 })

    // --- Codex: read and send; its question is answered in the terminal ---------------------
    await selectSession(page, 'T74 Codex')
    await waitForBufferText(page, CODEX, 'OpenAI Codex (mock)', 20_000)
    await page.getByTestId('view-toggle-chat').click()
    await expect(chat(page).locator('[data-testid="chat-turn"][data-role="user"]').first()).toContainText('List the files')
    await expect(chat(page).locator('.chat-turn-label').first()).toHaveText('Codex')
    const codexComposer = chat(page).getByTestId('chat-composer')
    await codexComposer.fill('hi codex')
    await codexComposer.press('Enter')
    await waitForBufferText(page, CODEX, 'ANSWER[1]: hi codex', 15_000)
    await expect(chat(page).locator('[data-testid="chat-answer"]', { hasText: 'Echo: hi codex' })).toBeVisible({ timeout: 15_000 })
    await shot(page, 'codex-chat-1280.png')
    await codexComposer.fill('ASK')
    await codexComposer.press('Enter')
    const codexCard = chat(page).getByTestId('chat-prompt-card')
    await expect(codexCard).toHaveAttribute('data-answerable', 'false', { timeout: 10_000 })
    await expect(codexCard.getByTestId('chat-prompt-option').first()).toBeDisabled()
    await shot(page, 'codex-card-1280.png')
    await codexCard.getByTestId('chat-prompt-terminal').click()
    await expect(page.getByTestId('view-toggle')).toHaveAttribute('data-mode', 'terminal')
    await writeToTerminal(page, CODEX, '\r')
    await waitForBufferText(page, CODEX, 'CHOSE: Yes, continue', 10_000)

    // --- 390 wide ---------------------------------------------------------------------------
    await selectSession(page, 'T74 Claude')
    const closeSidebar = page.locator('[title^="Close Sidebar"]').first()
    if (await closeSidebar.isVisible().catch(() => false)) await closeSidebar.click()
    await resizeMainWindow(app, 390, 800)
    await page.waitForTimeout(600)
    await page.getByTestId('view-toggle-terminal').click()
    await shot(page, 'terminal-390.png', 390)
    await page.getByTestId('view-toggle-chat').click()
    await expect(chat(page)).toBeVisible()
    const toggleBox = await page.getByTestId('view-toggle').boundingBox()
    expect(toggleBox!.x + toggleBox!.width).toBeLessThanOrEqual(390)
    const sendBox = await chat(page).getByTestId('chat-send').boundingBox()
    expect(sendBox!.x + sendBox!.width).toBeLessThanOrEqual(390)
    // nothing in the chat is wider than the window (a table scrolls inside its own box)
    const overflow = await chat(page).locator('.chat-scroll').evaluate((element) => element.scrollWidth - element.clientWidth)
    expect(overflow).toBeLessThanOrEqual(0)
    await shot(page, 'chat-390.png', 390)
    await composer.fill('ASK')
    await composer.press('Enter')
    await expect(card).toBeVisible({ timeout: 10_000 })
    const cardBox = await card.boundingBox()
    expect(cardBox!.x + cardBox!.width).toBeLessThanOrEqual(390)
    // a long option wraps inside its button instead of being cut
    const cut = await card.getByTestId('chat-prompt-option').evaluateAll((buttons) => buttons.filter((b) => b.scrollWidth > b.clientWidth + 1).length)
    expect(cut).toBe(0)
    await shot(page, 'card-390.png', 390)

    expect(result.pageErrors).toEqual([])
})
