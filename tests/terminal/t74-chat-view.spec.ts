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

/**
 * CHAT_VIEW_SHOTS: the same moment at 1280 and at 390 (sidebar folded for it). The sidebar button
 * is clicked by script — a real mousedown would close an open popover, the state being captured.
 */
async function shotBoth(app: LaunchResult['app'], page: Page, name: string): Promise<void> {
    if (!process.env.CHAT_VIEW_SHOTS) return
    await shot(page, `${name}-1280.png`)
    const close = page.locator('[title^="Close Sidebar"]').first()
    const wasOpen = await close.isVisible().catch(() => false)
    if (wasOpen) await close.evaluate((element) => (element as HTMLElement).click())
    await resizeMainWindow(app, 390, 800)
    await page.waitForTimeout(700)
    await shot(page, `${name}-390.png`, 390)
    await resizeMainWindow(app, 1280, 800)
    await page.waitForTimeout(500)
    if (wasOpen) await page.locator('[title^="Open Sidebar"]').first().evaluate((element) => (element as HTMLElement).click())
    await page.waitForTimeout(300)
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
    // the box stays open for the card's numbers; anything else waits for the answer
    await composer.fill('something else')
    await composer.press('Enter')
    await expect(chat(page).getByTestId('chat-composer-note')).toContainText('Answer the question above first')
    await composer.fill('')
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

// ------------------------------------------------------------------------------------------------
// T74 r2 — what the 2nd round added (ovis gap): shortcuts, files in and out, work state (stop,
// elapsed time, the faded sent bubble, queued messages one by one), the model chip and its
// change, the plan, `/` and `@` completion, terminal-only commands, the card's numbers,
// pictures, cut outputs, diffs, copying, quick replies, the Enter setting, Codex's chips.
// ------------------------------------------------------------------------------------------------

const R2_CLAUDE_ID = '00000000-0000-4000-8000-00000000c74c'
const R2_SLOW_ID = '00000000-0000-4000-8000-00000000c74d'
const R2_CODEX_ID = '00000000-0000-4000-8000-00000000c74e'
const R2 = 't74r2-claude'
const R2_SLOW = 't74r2-slow'
const R2_CODEX = 't74r2-codex'
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/** A synthetic history: many short exchanges, a picture, a long tool output, an edit, a long paste, a file path. */
function seedHistory(): { lines: string; longOutput: string; answerWithPath: string } {
    const entries: unknown[] = []
    let n = 0
    const ts = (): string => new Date(Date.UTC(2026, 10, 3, 1, 0, n++)).toISOString()
    const uuid = (): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
    for (let i = 0; i < 205; i++) {
        entries.push({ type: 'user', uuid: uuid(), timestamp: ts(), message: { role: 'user', content: `question ${i}` } })
        entries.push({ type: 'assistant', uuid: uuid(), timestamp: ts(), message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: `answer ${i}` }] } })
    }
    const imageUuid = '00000000-0000-4000-8000-0000000ffff1'
    entries.push({ type: 'user', uuid: imageUuid, timestamp: ts(), message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }, { type: 'text', text: 'What is in this picture?' }] } })
    const longOutput = Array.from({ length: 300 }, (_, i) => `row ${i} ${'y'.repeat(30)}`).join('\n')
    entries.push({ type: 'assistant', uuid: uuid(), timestamp: ts(), message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_long', name: 'Bash', input: { command: 'seq 300', description: 'List rows' } }] } })
    entries.push({ type: 'user', uuid: uuid(), timestamp: ts(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_long', content: longOutput }] } })
    entries.push({ type: 'assistant', uuid: uuid(), timestamp: ts(), message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_edit', name: 'Edit', input: { file_path: 'notes.md', old_string: 'old line', new_string: 'new line' } }] } })
    entries.push({ type: 'user', uuid: uuid(), timestamp: ts(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_edit', content: 'The file notes.md has been updated.' }] } })
    const answerWithPath = 'It is a single pixel. I also wrote `notes.md` — see notes.md for the details.'
    entries.push({ type: 'assistant', uuid: uuid(), timestamp: ts(), message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: answerWithPath }] } })
    entries.push({ type: 'user', uuid: uuid(), timestamp: ts(), message: { role: 'user', content: Array.from({ length: 30 }, (_, i) => `pasted line ${i}`).join('\n') } })
    entries.push({ type: 'assistant', uuid: uuid(), timestamp: ts(), message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Read the paste.' }] } })
    return { lines: entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n', longOutput, answerWithPath }
}

test('T74 r2: shortcuts, files, stop, send now, model chip, plan, completion, terminal commands, pictures', async () => {
    test.setTimeout(420_000)
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'climanager-t74r2-'))
    const project = path.join(home, 'project')
    fs.mkdirSync(project)
    fs.writeFileSync(path.join(project, 'notes.md'), '# Notes\nnew line\n')
    const claudeDir = path.join(home, 'claude')
    const codexDir = path.join(home, 'codex')
    const transcript = path.join(claudeDir, 'projects', claudeProjectSlug(project), `${R2_CLAUDE_ID}.jsonl`)
    const slowTranscript = path.join(claudeDir, 'projects', claudeProjectSlug(project), `${R2_SLOW_ID}.jsonl`)
    const rollout = path.join(codexDir, 'sessions', '2026', '11', '03', `rollout-2026-11-03T10-00-00-${R2_CODEX_ID}.jsonl`)
    fs.mkdirSync(path.dirname(transcript), { recursive: true })
    fs.mkdirSync(path.dirname(rollout), { recursive: true })
    const history = seedHistory()
    fs.writeFileSync(transcript, history.lines)
    fs.copyFileSync(path.join(FIXTURES, 'claude/short.jsonl'), slowTranscript)
    fs.copyFileSync(path.join(FIXTURES, 'codex/rollout-2026-11-03T10-00-00-00000000-0000-4000-8000-0000000000c1.jsonl'), rollout)
    // a skill the `/` menu offers
    fs.mkdirSync(path.join(claudeDir, 'skills', 'tidy-notes'), { recursive: true })
    fs.writeFileSync(path.join(claudeDir, 'skills', 'tidy-notes', 'SKILL.md'), '---\nname: tidy-notes\ndescription: Tidy the notes file\n---\n')

    result = await launchAppWithWorkspaces(
        [
            {
                id: 'w-t74r2',
                name: 'T74r2 project',
                path: project,
                sessions: [
                    { id: R2, name: 'R2 Claude', cliSessionId: R2_CLAUDE_ID, cliToolName: 'claude', cliCommand: `node ${MOCK} --transcript ${transcript} --work-ms 4000` },
                    { id: R2_SLOW, name: 'R2 Slow', cliSessionId: R2_SLOW_ID, cliToolName: 'claude', cliCommand: `node ${MOCK} --transcript ${slowTranscript} --work-ms 1500 --user-delay-ms 6500` },
                    { id: R2_CODEX, name: 'R2 Codex', cliSessionId: R2_CODEX_ID, cliToolName: 'codex', cliCommand: `node ${MOCK} --agent codex --transcript ${rollout} --work-ms 800` }
                ]
            }
        ],
        { env: { CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: codexDir }, settings: { chat: { showQuickReplies: true, quickReplies: ['continue', 'yes'] } } }
    )
    const { app, page } = result
    await resizeMainWindow(app, 1280, 800)
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

    // --- shortcuts: Terminal ⇄ Chat (⌘⇧M), the tooltip names it, focus lands in the box ---------
    await selectSession(page, 'R2 Claude')
    await waitForBufferText(page, R2, 'Claude Code (mock)', 20_000)
    await expect(page.getByTestId('view-toggle')).toHaveAttribute('data-mode', 'terminal')
    expect(await page.getByTestId('view-toggle-chat').getAttribute('title')).toMatch(/⌘⇧M|Ctrl\+Shift\+M/)
    await page.keyboard.press(`${mod}+Shift+KeyM`)
    await expect(page.getByTestId('view-toggle')).toHaveAttribute('data-mode', 'chat')
    const composer = chat(page).getByTestId('chat-composer')
    await expect(composer).toBeFocused({ timeout: 5_000 })
    await page.keyboard.press(`${mod}+Shift+KeyM`)
    await expect(page.getByTestId('view-toggle')).toHaveAttribute('data-mode', 'terminal')
    await page.keyboard.press(`${mod}+Shift+KeyM`)
    await expect(chat(page)).toBeVisible()
    // ⌘⇧I takes the box back from anywhere in the chat
    // (the box takes focus a moment after the chat opens: let that pass, then leave it)
    await page.waitForTimeout(400)
    await composer.evaluate((element) => (element as HTMLTextAreaElement).blur())
    await expect(composer).not.toBeFocused()
    await page.keyboard.press(`${mod}+Shift+KeyI`)
    await expect(composer).toBeFocused()

    // --- reading: 200 of 4xx turns, Show earlier, the rail, folded paste, picture, cut output, diff, file link
    const older = chat(page).getByTestId('chat-older-note')
    await expect(older).toContainText('Showing the last 200 of')
    const total = Number((await older.textContent())!.match(/of (\d+)/)![1])
    await expect(chat(page).getByTestId('chat-rail')).toBeVisible()
    await expect(chat(page).getByTestId('chat-user-fold')).toBeVisible()
    // PageUp / PageDown read the chat from the box, the draft stays
    await composer.fill('draft stays')
    const scroll = chat(page).getByTestId('chat-scroll')
    const bottom = await scroll.evaluate((element) => element.scrollTop)
    await composer.press('PageUp')
    await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBeLessThan(bottom)
    const afterUp = await scroll.evaluate((element) => element.scrollTop)
    await page.keyboard.press(`${mod}+Shift+PageUp`)
    await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBeLessThan(afterUp)
    await expect(composer).toHaveValue('draft stays')
    await composer.fill('')
    // the picture a prompt held, read back from the transcript, full size on a click
    const thumb = chat(page).getByTestId('chat-image').last()
    await thumb.scrollIntoViewIfNeeded()
    await expect(thumb).toHaveAttribute('data-loaded', 'true', { timeout: 10_000 })
    expect(await thumb.locator('img').getAttribute('src')).toBe(`data:image/png;base64,${PNG}`)
    await thumb.click()
    await expect(page.getByTestId('chat-lightbox')).toBeVisible()
    await shotBoth(app, page, 'r2-lightbox')
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('chat-lightbox')).toHaveCount(0)
    // a cut tool output, read back whole
    const works = chat(page).getByTestId('chat-work-block')
    const lastWork = works.last()
    await lastWork.locator('.chat-work-head').click()
    const bash = lastWork.locator('[data-testid="chat-tool"][data-tool="Bash"]')
    await bash.locator('.chat-tool-toggle').click()
    await bash.getByTestId('chat-tool-whole').click()
    await expect(bash.getByTestId('chat-tool-output')).toHaveText(history.longOutput, { timeout: 10_000 })
    // the edit as changed lines
    const edit = lastWork.locator('[data-testid="chat-tool"][data-tool="Edit"]')
    await edit.locator('.chat-tool-toggle').click()
    await expect(edit.locator('.chat-diff-line.is-del')).toHaveText(['−old line'])
    await expect(edit.locator('.chat-diff-line.is-add')).toHaveText(['+new line'])
    await edit.scrollIntoViewIfNeeded()
    await shotBoth(app, page, 'r2-tools')
    // the tool row's ↗ opens the file it edited
    await edit.getByTestId('chat-tool-open').click()
    await expect(page.getByTestId('chat-file-preview')).toHaveAttribute('data-path', path.join(project, 'notes.md'))
    await page.getByTestId('chat-file-preview').locator('button').filter({ has: page.locator('svg.lucide-x') }).first().click()
    await expect(page.getByTestId('chat-file-preview')).toHaveCount(0)
    // a path in an answer opens in the preview (relative to the session folder)
    await chat(page).locator('[data-testid="chat-answer"]', { hasText: 'single pixel' }).getByTestId('chat-file-link').first().click()
    await expect(page.getByTestId('chat-file-preview')).toHaveAttribute('data-path', path.join(project, 'notes.md'))
    await expect(page.getByTestId('chat-file-preview')).toContainText('new line')
    await shotBoth(app, page, 'r2-preview')
    await page.keyboard.press('Escape')
    await page.getByTestId('chat-file-preview').locator('button').filter({ has: page.locator('svg.lucide-x') }).first().click().catch(() => undefined)
    await expect(page.getByTestId('chat-file-preview')).toHaveCount(0)
    // copying an answer as Markdown
    await chat(page).locator('[data-role="assistant"]', { hasText: 'single pixel' }).hover()
    await chat(page).locator('[data-role="assistant"]', { hasText: 'single pixel' }).getByTestId('chat-copy-markdown').click()
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(history.answerWithPath)
    // Show earlier reads 200 more
    await older.getByTestId('chat-show-earlier').click()
    const shown = Math.min(total, 400)
    await expect(chat(page).locator('[data-testid="chat-turn"]')).toHaveCount(shown, { timeout: 10_000 })
    await expect(older).toContainText(`Showing the last ${shown} of ${total}`)
    // the chat comes back where it was left (not at its end) after another session
    await scroll.evaluate((element) => (element.scrollTop = Math.round(element.scrollHeight / 3)))
    await page.waitForTimeout(200)
    const left = await scroll.evaluate((element) => element.scrollTop)
    await selectSession(page, 'R2 Slow')
    await selectSession(page, 'R2 Claude')
    await expect(chat(page).locator('[data-testid="chat-turn"]').first()).toBeVisible()
    await expect.poll(() => chat(page).getByTestId('chat-scroll').evaluate((element) => element.scrollTop)).toBeGreaterThan(left - 400)
    expect(Math.abs((await chat(page).getByTestId('chat-scroll').evaluate((element) => element.scrollTop)) - left)).toBeLessThan(400)
    await shotBoth(app, page, 'r2-reading')

    // --- quick replies (on in Settings): one tap sends -------------------------------------------
    const quick = chat(page).getByTestId('chat-quick-replies')
    await expect(quick).toBeVisible()
    await shotBoth(app, page, 'r2-quick')
    await quick.getByRole('button', { name: 'continue' }).click()
    await waitForBufferText(page, R2, 'ANSWER[1]: continue', 15_000)

    // --- work state: elapsed time, Stop button, Esc --------------------------------------------
    await expect(chat(page).getByTestId('chat-working')).toBeVisible({ timeout: 10_000 })
    await expect(chat(page).getByTestId('chat-working-time')).toHaveText(/^\d+s$/)
    await shotBoth(app, page, 'r2-working')
    await chat(page).getByTestId('chat-stop').click()
    await waitForBufferText(page, R2, 'INTERRUPTED', 10_000)
    await expect(chat(page).getByTestId('chat-working')).toHaveCount(0, { timeout: 10_000 })
    await expect(chat(page).getByTestId('chat-stopped').last()).toBeVisible({ timeout: 10_000 })
    await shotBoth(app, page, 'r2-stopped')
    await composer.fill('stop me with esc')
    await composer.press('Enter')
    await expect(chat(page).getByTestId('chat-working')).toBeVisible({ timeout: 10_000 })
    await composer.press('Escape')
    await expect.poll(async () => (await termText(page, R2)).split('INTERRUPTED').length - 1, { timeout: 10_000 }).toBe(2)

    // --- queued messages one by one: Send now, discard, edit -----------------------------------
    await expect(chat(page).getByTestId('chat-working')).toHaveCount(0, { timeout: 10_000 })
    await composer.fill('first')
    await composer.press('Enter')
    await expect(chat(page).getByTestId('chat-working')).toBeVisible({ timeout: 10_000 })
    for (const text of ['second', 'third', 'fourth']) {
        await composer.fill(text)
        await composer.press('Enter')
    }
    const queued = chat(page).getByTestId('chat-queued-item')
    await expect(queued).toHaveCount(3)
    await shotBoth(app, page, 'r2-queued')
    await queued.filter({ hasText: 'second' }).getByTestId('chat-queued-send-now').click()
    await waitForBufferText(page, R2, 'HELD: second', 10_000)
    await queued.filter({ hasText: 'third' }).getByTestId('chat-queued-discard').click()
    await queued.filter({ hasText: 'fourth' }).getByTestId('chat-queued-edit').click()
    await expect(queued).toHaveCount(0)
    await expect(composer).toHaveValue('fourth')
    await composer.fill('')
    await waitForBufferText(page, R2, ': second', 20_000)
    expect(await termText(page, R2)).not.toContain('third')

    // --- the plan: work row and chip ------------------------------------------------------------
    await expect(chat(page).getByTestId('chat-working')).toHaveCount(0, { timeout: 20_000 })
    await composer.fill('PLAN')
    await composer.press('Enter')
    const planChip = chat(page).getByTestId('chat-plan-chip')
    await expect(planChip).toContainText('1/3', { timeout: 15_000 })
    await planChip.click()
    await expect(chat(page).getByTestId('chat-plan-panel').locator('.chat-todo')).toHaveCount(3)
    await expect(chat(page).getByTestId('chat-plan-panel').locator('.chat-todo.is-in_progress')).toContainText('Writing the fix')
    await shotBoth(app, page, 'r2-plan')
    await page.keyboard.press('Escape')

    // --- model chip: names the recorded model; a change asks first ------------------------------
    await expect(chat(page).getByTestId('chat-working')).toHaveCount(0, { timeout: 20_000 })
    const modelChip = chat(page).getByTestId('chat-model-chip')
    await expect(modelChip.getByTestId('chat-model-name')).toHaveText('Opus 5.5', { timeout: 10_000 })
    await expect(modelChip.getByTestId('chat-model-effort')).toContainText('high')
    await expect(chat(page).getByTestId('chat-context-chip')).toContainText(/ctx \d+k/)
    await modelChip.click()
    await chat(page).locator('[data-testid="chat-model-option"][data-alias="sonnet"]').click()
    await expect(chat(page).getByTestId('chat-model-confirm')).toContainText('default for new sessions')
    await shotBoth(app, page, 'r2-model-confirm')
    await chat(page).getByTestId('chat-model-confirm-cancel').click()
    await page.keyboard.press('Escape')
    await page.waitForTimeout(500)
    expect(await termText(page, R2)).not.toContain('MODEL:')
    await modelChip.click()
    await chat(page).locator('[data-testid="chat-model-option"][data-alias="sonnet"]').click()
    await chat(page).getByTestId('chat-model-confirm-ok').click()
    await waitForBufferText(page, R2, 'MODEL: sonnet', 10_000)
    await expect(modelChip.getByTestId('chat-model-name')).toHaveText('Sonnet 5', { timeout: 10_000 })
    // the context chip's Compact sends /compact like a typed message
    await chat(page).getByTestId('chat-context-chip').click()
    await chat(page).getByTestId('chat-compact').click()
    await waitForBufferText(page, R2, ': /compact', 10_000)
    await expect(chat(page).getByTestId('chat-working')).toHaveCount(0, { timeout: 20_000 })
    // the picker only the terminal shows: the chat opens the terminal with "Back to Chat"
    await modelChip.click()
    await chat(page).getByTestId('chat-model-picker').click()
    await chat(page).getByTestId('chat-model-confirm-ok').click()
    await waitForBufferText(page, R2, 'PANEL: /model', 10_000)
    await expect(page.getByTestId('view-toggle')).toHaveAttribute('data-mode', 'terminal')
    await expect(page.getByTestId('chat-peek-bar')).toContainText('/model')
    await shotBoth(app, page, 'r2-peek')
    await writeToTerminal(page, R2, '\x1b')
    await waitForBufferText(page, R2, 'PANEL CLOSED', 10_000)
    await page.getByTestId('chat-peek-back').click()
    await expect(chat(page)).toBeVisible()

    // --- `/` and `@` completion; a terminal-only command; Keep Terminal --------------------------
    await composer.fill('/tidy')
    await expect(chat(page).getByTestId('chat-complete-row').first()).toContainText('/tidy-notes')
    await composer.fill('/conf')
    const configRow = chat(page).locator('[data-testid="chat-complete-row"]', { hasText: '/config' }).first()
    await expect(configRow).toContainText('terminal')
    await shotBoth(app, page, 'r2-slash')
    await composer.press('Enter')
    await expect(composer).toHaveValue('/config ')
    await composer.press('Enter')
    await waitForBufferText(page, R2, 'PANEL: /config', 10_000)
    await expect(page.getByTestId('chat-peek-bar')).toContainText('/config')
    await page.getByTestId('chat-peek-keep').click()
    await expect(page.getByTestId('chat-peek-bar')).toHaveCount(0)
    await expect(page.getByTestId('view-toggle')).toHaveAttribute('data-mode', 'terminal')
    await writeToTerminal(page, R2, '\x1b')
    await waitForBufferText(page, R2, 'PANEL CLOSED', 10_000)
    await page.getByTestId('view-toggle-chat').click()
    // F18: the same command sent while the agent works waits in the queue; when it goes on its own,
    // the terminal shows (before, the chat stayed and the panel could not be seen)
    const count = async (words: string): Promise<number> => (await termText(page, R2)).split(words).length - 1
    const panels = await count('PANEL: /config')
    const closed = await count('PANEL CLOSED')
    await composer.fill('work before the panel')
    await composer.press('Enter')
    await expect(chat(page).getByTestId('chat-working')).toBeVisible({ timeout: 10_000 })
    await composer.fill('/conf')
    await composer.press('Enter')
    await expect(composer).toHaveValue('/config ')
    await composer.press('Enter')
    await expect(chat(page).getByTestId('chat-queued-item').filter({ hasText: '/config' })).toHaveCount(1)
    await expect.poll(() => count('PANEL: /config'), { timeout: 20_000 }).toBe(panels + 1)
    await expect(page.getByTestId('chat-peek-bar')).toContainText('/config', { timeout: 10_000 })
    await page.getByTestId('chat-peek-keep').click()
    await writeToTerminal(page, R2, '\x1b')
    await expect.poll(() => count('PANEL CLOSED'), { timeout: 10_000 }).toBe(closed + 1)
    await page.getByTestId('view-toggle-chat').click()
    await composer.fill('look at @note')
    await expect(chat(page).getByTestId('chat-complete-row').first()).toContainText('notes.md', { timeout: 10_000 })
    await composer.press('Tab')
    await expect(composer).toHaveValue('look at @notes.md ')
    await composer.fill('')

    // --- files in: ＋ picker (its own path), paste and drop (stored by the app) ------------------
    const picked = path.join(project, 'report data.txt')
    fs.writeFileSync(picked, 'report')
    await chat(page).getByTestId('chat-attach-input').setInputFiles(picked)
    const tiles = chat(page).getByTestId('chat-attachment')
    await expect(tiles).toHaveCount(1)
    await expect(tiles.first()).toHaveAttribute('data-state', 'ready')
    await chat(page).locator('.chat-composer').evaluate((element, png) => {
        const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0))
        const file = new File([bytes], 'clip.png', { type: 'image/png' })
        const data = new DataTransfer()
        data.items.add(file)
        element.querySelector('textarea')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    }, PNG)
    await chat(page).getByTestId('chat-scroll').evaluate((element) => {
        const data = new DataTransfer()
        data.items.add(new File(['dropped'], 'drop.txt', { type: 'text/plain' }))
        element.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }))
    })
    await expect(tiles).toHaveCount(3)
    await expect(chat(page).locator('[data-testid="chat-attachment"][data-state="ready"]')).toHaveCount(3, { timeout: 10_000 })
    // the pasted picture's thumbnail is drawn (the page allows data: pictures only, not blob:)
    const thumbnail = tiles.filter({ hasText: 'clip.png' }).locator('img')
    await expect(thumbnail).toHaveAttribute('src', /^data:image\/png;base64,/)
    await expect.poll(() => thumbnail.evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
    await shotBoth(app, page, 'r2-attach')
    await composer.fill('see these')
    await composer.press('Enter')
    await expect(tiles).toHaveCount(0)
    // what reached the agent, as it recorded the prompt (the terminal wraps long lines)
    const lastPrompt = async (): Promise<string> =>
        fs.readFileSync(transcript, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter((entry) => entry.type === 'user' && typeof entry.message?.content === 'string').at(-1)?.message.content ?? ''
    await expect.poll(lastPrompt, { timeout: 10_000 }).toContain('see these')
    const prompt = await lastPrompt()
    expect(prompt.startsWith(`@"${picked}" `)).toBe(true)
    const stored = [...prompt.matchAll(/@(\S*climanager-chat\/\d{4}-\d{2}-\d{2}\/\d+-[0-9a-f]{8}\.(png|txt))/g)]
    expect(stored.map((match) => match[2]).sort()).toEqual(['png', 'txt'])
    for (const match of stored) expect(fs.existsSync(match[1])).toBe(true)
    expect(prompt.endsWith(' see these')).toBe(true)

    // --- the card's numbers: type 4, Enter confirms --------------------------------------------
    await expect(chat(page).getByTestId('chat-working')).toHaveCount(0, { timeout: 20_000 })
    await composer.fill('ASK')
    await composer.press('Enter')
    const card = chat(page).getByTestId('chat-prompt-card')
    await expect(card).toBeVisible({ timeout: 10_000 })
    await expect(card.getByTestId('chat-prompt-option')).toHaveCount(4)
    await expect(card).toHaveAttribute('data-answerable', 'true')
    await composer.fill('4')
    await composer.press('Enter')
    await expect(card.getByTestId('chat-prompt-picked')).toBeVisible()
    await expect(card.locator('.chat-prompt-option.is-picked')).toHaveAttribute('data-index', '3')
    await shotBoth(app, page, 'r2-card-pick')
    // a capture's resize redraws the menu (a new signature), which drops the pick on purpose: pick again
    if ((await card.getByTestId('chat-prompt-picked').count()) === 0) {
        await expect(card.getByTestId('chat-prompt-option')).toHaveCount(4)
        await composer.fill('4')
        await composer.press('Enter')
        await expect(card.getByTestId('chat-prompt-picked')).toBeVisible()
    }
    await composer.press('Enter')
    await waitForBufferText(page, R2, 'CHOSE: No', 10_000)
    // the card goes with the menu, though nothing more is printed (the screen is read after it is drawn)
    await expect(card).toHaveCount(0, { timeout: 10_000 })

    // --- Settings › Terminal › Chat view: Enter starts a line, ⌘Enter sends ---------------------
    await page.keyboard.press(`${mod}+Comma`)
    if (process.env.CHAT_VIEW_SHOTS) {
        await page.getByTestId('settings-category-keyboard').click()
        await page.getByText('Chat View', { exact: true }).scrollIntoViewIfNeeded()
        await shotBoth(app, page, 'r2-keyboard-settings')
    }
    await page.getByTestId('settings-category-terminal').click()
    await page.getByTestId('chat-view-settings').scrollIntoViewIfNeeded()
    await shotBoth(app, page, 'r2-chat-settings')
    await page.getByTestId('chat-setting-enter-sends').click()
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(chat(page)).toBeVisible()
    await composer.fill('line one')
    await composer.press('Enter')
    await expect(composer).toHaveValue('line one\n')
    await composer.pressSequentially('line two')
    await composer.press(`${mod}+Enter`)
    await waitForBufferText(page, R2, 'lines=2', 15_000)

    // --- the faded sent bubble: shown at once, a clock after 5s, gone when the turn is written ---
    await selectSession(page, 'R2 Slow')
    await waitForBufferText(page, R2_SLOW, 'Claude Code (mock)', 20_000)
    await page.getByTestId('view-toggle-chat').click()
    const slowComposer = chat(page).getByTestId('chat-composer')
    await slowComposer.fill('hello slow')
    await slowComposer.press(`${mod}+Enter`)
    const bubble = chat(page).getByTestId('chat-sent-bubble')
    await expect(bubble).toHaveText('hello slow')
    await expect(chat(page).getByTestId('chat-sent-clock')).toBeVisible({ timeout: 8_000 })
    await shotBoth(app, page, 'r2-sent')
    await expect(bubble).toHaveCount(0, { timeout: 15_000 })
    await expect(chat(page).locator('[data-testid="chat-user-text"]', { hasText: 'hello slow' })).toBeVisible()

    // --- Codex: model, effort and a context share; its model picker in the terminal --------------
    await selectSession(page, 'R2 Codex')
    await waitForBufferText(page, R2_CODEX, 'OpenAI Codex (mock)', 20_000)
    await page.getByTestId('view-toggle-chat').click()
    const codexComposer = chat(page).getByTestId('chat-composer')
    await codexComposer.fill('hi codex')
    await codexComposer.press(`${mod}+Enter`)
    await expect(chat(page).getByTestId('chat-model-name')).toHaveText('gpt-6-luna', { timeout: 15_000 })
    await expect(chat(page).getByTestId('chat-model-effort')).toContainText('medium')
    await expect(chat(page).getByTestId('chat-context-chip')).toContainText(/ctx \d+%/)
    await shotBoth(app, page, 'r2-codex')
    await chat(page).getByTestId('chat-model-chip').click()
    await chat(page).getByTestId('chat-model-picker').click()
    await chat(page).getByTestId('chat-model-confirm-ok').click()
    await waitForBufferText(page, R2_CODEX, 'PANEL: /model', 10_000)
    await expect(page.getByTestId('chat-peek-bar')).toContainText('/model')

    // --- 390 wide: the composer's row stays inside -----------------------------------------------
    await page.getByTestId('chat-peek-back').click()
    await selectSession(page, 'R2 Claude')
    const closeSidebar = page.locator('[title^="Close Sidebar"]').first()
    if (await closeSidebar.isVisible().catch(() => false)) await closeSidebar.click()
    await resizeMainWindow(app, 390, 800)
    await page.waitForTimeout(600)
    const status = chat(page).locator('.chat-composer-status')
    const statusBox = await status.boundingBox()
    expect(statusBox!.x + statusBox!.width).toBeLessThanOrEqual(390)
    const chipBox = await chat(page).getByTestId('chat-model-chip').boundingBox()
    expect(chipBox!.x + chipBox!.width).toBeLessThanOrEqual(390)
    await expect(chat(page).getByTestId('chat-rail')).toHaveCount(0)
    await shot(page, 'r2-chat-390.png', 390)
    await composer.fill('/')
    await expect(chat(page).getByTestId('chat-complete')).toBeVisible()
    const menuBox = await chat(page).getByTestId('chat-complete').boundingBox()
    expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(390)
    await shot(page, 'r2-slash-390.png', 390)
    await composer.fill('')

    expect(result.pageErrors).toEqual([])
})

