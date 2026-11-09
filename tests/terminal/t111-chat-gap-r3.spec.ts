import { test, expect, type Locator, type Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { closeApp, launchAppWithWorkspaces, LaunchResult, REPO_ROOT, resizeMainWindow, termText, waitForBufferText } from './helpers'

/**
 * T111 — Chat gaps, round 3, in the app (chat-gap-r3-1109).
 *
 * C-1 (fb 4c6ea086) work blocks start folded — the running one too — under Settings › Terminal › Chat view
 * «Collapse work» (on by default); off brings back the open running block. C-2 (d05e93fc) a drag that starts
 * on a file link selects the words and opens nothing; a click still opens. C-3 (d89cfc4a) a .md file opens
 * rendered in the Mac preview, with Preview / Source. C-4 (babcdbc9) the pinned last message opens in place
 * when it is cut and at most 8 lines; longer, it goes to the message. C-5 a Codex `exec` row names its
 * command; C-6 a Codex turn stopped with Esc shows «Stopped». New 1: a Codex started in the terminal shows
 * Terminal | Chat before its first message, and that message can go from the Chat. New 2: «Yes, proceed» in
 * the agent's answer does not block the next Chat send. Extra: the option-number hint fits at 390.
 *
 * Checks that the old build fails are soft (expect.soft), so a run on the old build goes to the end and
 * leaves every «before» capture. T111_SHOTS=<folder> and T111_LABEL=<before|after> save captures before
 * each check.
 */

const MOCK = path.join(REPO_ROOT, 'scripts/mock-cli/chat-mock.cjs')
const slug = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, '-')
const CLAUDE_ID = '00000000-0000-4000-8000-0000000c1111'
const LONG_ID = '00000000-0000-4000-8000-0000000c1112'
const CODEX_ID = '00000000-0000-4000-8000-0000000c1113'
const SHORT_LAST = ['Four short lines,', 'so the pin cuts them:', 'line three', 'and the last line here'].join('\n')
const LONG_LAST = Array.from({ length: 12 }, (_, index) => `A long message, line ${index + 1}`).join('\n')

let result: LaunchResult | null = null
test.afterEach(async () => {
    if (result) await closeApp(result)
    result = null
})

const chat = (page: Page): Locator => page.locator('[data-testid="chat-view"][data-session-id]:visible')

async function shot(page: Page, name: string, width = 1280, height = 800): Promise<void> {
    const dir = process.env.T111_SHOTS
    if (!dir) return
    fs.mkdirSync(dir, { recursive: true })
    await page.waitForTimeout(300)
    await page.screenshot({ path: path.join(dir, `${process.env.T111_LABEL ?? 'after'}-${name}.png`), clip: { x: 0, y: 0, width, height } })
}

/** Claude records: the person, then the agent's answer (with a Bash call when `tool`). */
function claudeTranscript(file: string, turns: { user: string; answer: string; tool?: boolean }[]): void {
    let n = 0
    const entries: unknown[] = []
    const ts = (): string => new Date(Date.UTC(2026, 10, 9, 1, 0, n++)).toISOString()
    const uuid = (): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
    for (const turn of turns) {
        entries.push({ type: 'user', uuid: uuid(), timestamp: ts(), message: { role: 'user', content: turn.user } })
        if (turn.tool) {
            entries.push({ type: 'assistant', uuid: uuid(), timestamp: ts(), message: { role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `toolu_${n}`, name: 'Bash', input: { command: 'ls docs' } }] } })
            entries.push({ type: 'user', uuid: uuid(), timestamp: ts(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${n - 1}`, content: 'notes.md' }] } })
        }
        entries.push({ type: 'assistant', uuid: uuid(), timestamp: ts(), message: { role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: turn.answer }] } })
    }
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n')
}

const LONG_ANSWER = Array.from({ length: 70 }, (_, index) => `The answer goes on, line ${index + 1}.`).join('\n\n')

function codexRollout(file: string, cwd: string): void {
    const at = (s: number): string => new Date(Date.UTC(2026, 10, 9, 2, 0, s)).toISOString()
    const records = [
        { timestamp: at(0), type: 'session_meta', payload: { id: CODEX_ID, cwd, source: 'cli', originator: 'codex_cli_rs' } },
        { timestamp: at(1), type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } },
        { timestamp: at(1), type: 'event_msg', payload: { type: 'user_message', message: 'Check the tree', kind: 'plain' } },
        { timestamp: at(2), type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'call_x1', status: 'completed', input: 'text(await tools.exec_command({cmd:"git status --short",max_output_tokens:1500}));\n' } },
        { timestamp: at(3), type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call_x1', output: 'Script completed\n M src/a.ts' } },
        { timestamp: at(4), type: 'event_msg', payload: { type: 'agent_message', message: 'One file changed.', phase: 'final_answer' } },
        { timestamp: at(4), type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1' } }
    ]
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n')
}

async function open(page: Page, name: string, id: string, ready: string): Promise<void> {
    await page.getByText(name, { exact: true }).first().click()
    await waitForBufferText(page, id, ready, 20_000)
    await page.getByTestId('view-toggle-chat').click()
    await expect(chat(page).getByTestId('chat-composer')).toBeVisible()
}

async function send(page: Page, text: string): Promise<void> {
    const composer = chat(page).getByTestId('chat-composer')
    await composer.fill(text)
    await composer.press('Enter')
}

test('T111 chat gaps round 3: fold work, link drag, md preview, pinned message, Codex rows and first message, output words', async () => {
    test.setTimeout(300_000)
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'climanager-t111-'))
    const project = path.join(home, 'project')
    fs.mkdirSync(path.join(project, 'docs'), { recursive: true })
    fs.writeFileSync(path.join(project, 'docs', 'notes.md'), '# Release notes\n\nThe **fold** is on by default.\n\n- one\n- two\n')
    const claudeDir = path.join(home, 'claude')
    const codexDir = path.join(home, 'codex')
    const transcript = path.join(claudeDir, 'projects', slug(project), `${CLAUDE_ID}.jsonl`)
    const longTranscript = path.join(claudeDir, 'projects', slug(project), `${LONG_ID}.jsonl`)
    const rollout = path.join(codexDir, 'sessions', '2026', '11', '09', `rollout-2026-11-09T11-00-00-${CODEX_ID}.jsonl`)
    claudeTranscript(transcript, [
        { user: 'Where are the notes?', answer: 'They are in docs/notes.md — open docs/notes.md to read the list.', tool: true },
        { user: SHORT_LAST, answer: LONG_ANSWER }
    ])
    claudeTranscript(longTranscript, [{ user: LONG_LAST, answer: LONG_ANSWER }])
    codexRollout(rollout, project)
    // a `codex` the shell can run: the mock, drawing Codex's screen (no rollout until the first message)
    const bin = path.join(home, 'bin')
    fs.mkdirSync(bin)
    const firstRollout = path.join(codexDir, 'sessions', '2026', '11', '09', 'rollout-2026-11-09T12-00-00-00000000-0000-4000-8000-0000000c1114.jsonl')
    fs.writeFileSync(path.join(bin, 'codex'), `#!/bin/sh\nexec node '${MOCK}' --agent codex --transcript '${firstRollout}' --work-ms 300\n`, { mode: 0o755 })

    result = await launchAppWithWorkspaces(
        [
            {
                id: 'w-t111',
                name: 'T111 project',
                path: project,
                sessions: [
                    { id: 't111-claude', name: 'T111 Claude', cliSessionId: CLAUDE_ID, cliToolName: 'claude', cliCommand: `node ${MOCK} --transcript ${transcript} --work-ms 4000 --continue` },
                    { id: 't111-long', name: 'T111 Long', cliSessionId: LONG_ID, cliToolName: 'claude', cliCommand: `node ${MOCK} --transcript ${longTranscript} --work-ms 300 --continue` },
                    { id: 't111-codex', name: 'T111 Codex', cliSessionId: CODEX_ID, cliToolName: 'codex', cliCommand: `node ${MOCK} --agent codex --transcript ${rollout} --work-ms 5000 --continue` },
                    { id: 't111-shell', name: 'T111 Shell' }
                ]
            }
        ],
        { settings: { chat: { pinLastMessage: true } }, env: { CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: codexDir } }
    )
    const { app, page } = result
    await resizeMainWindow(app, 1280, 800)
    await open(page, 'T111 Claude', 't111-claude', 'Claude Code (mock)')

    // --- C-4: the pinned last message (4 lines, cut to 2) opens where it is -------------------------------
    const scroll = chat(page).getByTestId('chat-scroll')
    await scroll.evaluate((element) => (element.scrollTop = element.scrollHeight))
    const pin = chat(page).getByTestId('chat-pinned-last')
    await expect(pin).toBeVisible()
    await shot(page, 'c4-pinned-cut')
    await pin.click()
    await page.waitForTimeout(300)
    await shot(page, 'c4-pinned-open')
    await expect.soft(pin, 'a short cut message opens in place').toBeVisible()
    await expect.soft(pin).toHaveAttribute('data-expanded', 'true')
    const fits = await chat(page).getByTestId('chat-pinned-last-text').evaluate((element) => element.scrollHeight <= element.clientHeight + 1).catch(() => false)
    expect.soft(fits, 'every line shows').toBe(true)
    const go = chat(page).getByTestId('chat-pinned-last-go')
    if (await go.count()) {
        await go.click()
        await expect(pin).toHaveCount(0)
    }

    // --- C-2: a drag that starts on a file link selects; C-3: a click opens it rendered -------------------
    await scroll.evaluate((element) => (element.scrollTop = 0))
    const link = chat(page).locator('[data-testid="chat-answer"]').first().getByTestId('chat-file-link').first()
    await expect(link).toHaveText('docs/notes.md')
    const box = (await link.boundingBox())!
    const paragraph = (await link.evaluate((element) => {
        const rect = element.closest('p')!.getBoundingClientRect()
        return { right: rect.right, y: rect.top + rect.height / 2 }
    }))
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2, { steps: 5 })
    await page.mouse.move(paragraph.right - 4, box.y + box.height / 2, { steps: 10 })
    await page.mouse.up()
    await shot(page, 'c2-drag')
    const selected = await page.evaluate(() => window.getSelection()?.toString() ?? '')
    expect.soft(selected, 'the dragged words are selected').toContain('notes.md')
    await expect.soft(page.getByTestId('chat-file-preview'), 'a drag opens nothing').toHaveCount(0)
    await page.keyboard.press('Escape')
    await page.evaluate(() => window.getSelection()?.removeAllRanges())
    await expect(page.getByTestId('chat-file-preview')).toHaveCount(0)

    await link.click()
    // the wrapper has no box of its own (its modal is fixed): counted, not «visible»
    const preview = page.getByTestId('chat-file-preview')
    await expect(preview).toHaveCount(1)
    await page.waitForTimeout(400)
    await shot(page, 'c3-md-preview')
    await expect.soft(preview.getByTestId('file-preview-rendered')).toHaveAttribute('aria-pressed', 'true')
    await expect.soft(preview.locator('.chat-md-h1'), 'the heading is drawn').toHaveText('Release notes')
    await expect.soft(preview.locator('strong')).toHaveText('fold')
    if (await preview.getByTestId('file-preview-source').count()) {
        await preview.getByTestId('file-preview-source').click()
        await expect(preview.locator('.chat-md-h1')).toHaveCount(0)
        await expect(preview).toContainText('# Release notes')
        await shot(page, 'c3-md-source')
    }
    await page.keyboard.press('Escape')
    await expect(preview).toHaveCount(0)

    // --- C-1: the running block starts folded (Collapse work on by default) -------------------------------
    await scroll.evaluate((element) => (element.scrollTop = element.scrollHeight))
    await send(page, 'PLAN')
    await expect(chat(page).getByTestId('chat-working')).toBeVisible({ timeout: 10_000 })
    const blocks = chat(page).getByTestId('chat-work-block')
    await expect(blocks.last()).toContainText('Working', { timeout: 10_000 })
    await shot(page, 'c1-running-folded')
    // read at once: a retrying check would wait for the turn to settle, when the old build folds it too
    expect.soft(await blocks.last().getAttribute('data-open'), 'the running block is folded').toBe('false')
    await expect(chat(page).getByTestId('chat-working')).toHaveCount(0, { timeout: 15_000 })
    await expect(blocks.last()).toHaveAttribute('data-open', 'false')

    // --- new 2: «Yes, proceed» in the answer does not block the next send ---------------------------------
    await send(page, 'Yes, proceed')
    await waitForBufferText(page, 't111-claude', 'Echo: Yes, proceed', 15_000)
    await expect(chat(page).getByTestId('chat-working')).toHaveCount(0, { timeout: 15_000 })
    await page.waitForTimeout(800)
    await send(page, 'after the words')
    await page.waitForTimeout(1500)
    await shot(page, 'new2-output-words')
    expect.soft(await termText(page, 't111-claude', 80), 'the next message reached the agent').toContain('after the words')

    // --- extra: the option-number hint fits at 390 --------------------------------------------------------
    await expect(chat(page).getByTestId('chat-working')).toHaveCount(0, { timeout: 15_000 })
    // typed in the terminal: the old build still refuses Chat sends here (new 2), and this check is about the hint
    await chat(page).getByTestId('chat-composer').fill('')
    for (const character of 'QUESTION\r') await page.evaluate(([id, value]) => window.api.writeTerminal(id, value), ['t111-claude', character])
    await expect(chat(page).getByTestId('chat-prompt-card')).toBeVisible({ timeout: 10_000 })
    // the chat itself 390 wide (the window stays: a resize redraws the agent's screen and the card blinks)
    const view = chat(page)
    const viewBox = (await view.boundingBox())!
    await view.evaluate((element) => {
        const el = element as HTMLElement
        el.style.right = 'auto'
        el.style.width = '390px'
    })
    await page.waitForTimeout(400)
    await shot(page, 'extra-hint-390', Math.round(viewBox.x + 390), 800)
    const hint = await view.getByTestId('chat-composer').evaluate((element) => {
        const area = element as HTMLTextAreaElement
        const style = getComputedStyle(area)
        const canvas = document.createElement('canvas').getContext('2d')!
        canvas.font = `${style.fontSize} ${style.fontFamily}`
        const room = area.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
        return { text: area.placeholder, width: canvas.measureText(area.placeholder).width, room }
    })
    expect(hint.text, 'the option hint is the placeholder').toMatch(/number/)
    expect.soft(hint.width, `«${hint.text}» fits on one line`).toBeLessThanOrEqual(hint.room)
    await view.evaluate((element) => {
        const el = element as HTMLElement
        el.style.right = ''
        el.style.width = ''
    })
    await chat(page).getByTestId('chat-prompt-option').first().click()
    await expect(chat(page).getByTestId('chat-prompt-card')).toHaveCount(0, { timeout: 10_000 })

    // --- C-1 off: Settings › Terminal › Chat view «Collapse work» --------------------------------------------
    await page.keyboard.press('Meta+Comma')
    await page.getByTestId('settings-category-terminal').click()
    const fold = page.getByTestId('chat-setting-fold-work')
    await fold.scrollIntoViewIfNeeded().catch(() => undefined)
    await shot(page, 'c1-setting')
    await expect.soft(fold, 'on by default').toHaveAttribute('aria-pressed', 'true')
    if (await fold.count()) {
        await fold.click()
        await expect(fold).toHaveAttribute('aria-pressed', 'false')
    }
    const hasSetting = (await fold.count()) > 0
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(chat(page).getByTestId('chat-composer')).toBeVisible()
    if (hasSetting) {
        await send(page, 'PLAN')
        await expect(blocks.last()).toContainText('Working', { timeout: 10_000 })
        expect(await blocks.last().getAttribute('data-open'), 'off: the running block opens').toBe('true')
        await expect(chat(page).getByTestId('chat-working')).toHaveCount(0, { timeout: 15_000 })
    }

    // --- C-4: a pinned message over 8 lines goes to the message ------------------------------------------
    await open(page, 'T111 Long', 't111-long', 'Claude Code (mock)')
    await chat(page).getByTestId('chat-scroll').evaluate((element) => (element.scrollTop = element.scrollHeight))
    const longPin = chat(page).getByTestId('chat-pinned-last')
    await expect(longPin).toBeVisible()
    await longPin.click()
    await expect(longPin, 'over 8 lines: it goes to the message').toHaveCount(0)

    // --- C-5: a Codex exec row names its command; C-6: a stopped Codex turn ---------------------------------
    await open(page, 'T111 Codex', 't111-codex', 'OpenAI Codex (mock)')
    const work = chat(page).getByTestId('chat-work-block').first()
    await work.locator('.chat-work-head').click()
    const row = chat(page).getByTestId('chat-tool').first()
    await expect(row).toHaveAttribute('data-tool', 'exec')
    await shot(page, 'c5-codex-exec')
    await expect.soft(row.locator('.chat-tool-summary'), 'the command, not the bare name').toHaveText('git status --short')
    await send(page, 'a long one')
    await expect(chat(page).getByTestId('chat-working')).toBeVisible({ timeout: 10_000 })
    await chat(page).getByTestId('chat-composer').press('Escape')
    await waitForBufferText(page, 't111-codex', 'INTERRUPTED', 10_000)
    await page.waitForTimeout(1500)
    await shot(page, 'c6-codex-stopped')
    await expect.soft(chat(page).getByTestId('chat-stopped'), 'the stop shows').toHaveCount(1)

    // --- new 1: Codex started in the terminal shows Chat before its first message -------------------------
    await page.getByText('T111 Shell', { exact: true }).first().click()
    await page.waitForTimeout(800)
    const write = (data: string) => page.evaluate(([id, value]) => window.api.writeTerminal(id, value), ['t111-shell', data])
    for (const character of `${path.join(bin, 'codex')}\r`) await write(character)
    await waitForBufferText(page, 't111-shell', 'OpenAI Codex (mock)', 15_000)
    await page.waitForTimeout(1500)
    await shot(page, 'new1-codex-started')
    const toggle = page.getByTestId('view-toggle-chat')
    await expect.soft(toggle, 'Chat before the first message').toBeVisible({ timeout: 5_000 })
    if (await toggle.isVisible().catch(() => false)) {
        await toggle.click()
        await expect(chat(page).getByTestId('chat-no-turns-yet')).toBeVisible()
        await shot(page, 'new1-codex-chat-empty')
        await send(page, 'first words from the chat')
        await waitForBufferText(page, 't111-shell', 'ANSWER[1]: first words from the chat', 10_000)
    }
})
