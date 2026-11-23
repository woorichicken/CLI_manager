import { test, expect, type Locator, type Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { closeApp, launchAppWithWorkspaces, LaunchResult, REPO_ROOT, resizeMainWindow, termText, waitForBufferText, writeToTerminal } from './helpers'

/**
 * T164 — fb-1123 round 2 Chat reports, in the app (chat-mock).
 *
 * 019248e1 «가끔 길어지면, 메세지 전송이 안된 상태로 없어져 있는게 있음»: a long message goes as a bracketed paste,
 * and Claude Code folds it into `[Pasted text #1 +N lines]`. The submit check looked for the message's first words in
 * the input box, so a placeholder read as «submitted»: an Enter lost there (chat-mock --lose-enters) left the message
 * in the terminal box while the Chat cleared its own and called it sent. Now the placeholder counts as still there:
 * Enter is pressed again; if it still does not go the Chat gets its words back with the reason — beside anything typed
 * since — and a queued one stays as a «Not sent» row with Retry. Whether the real Claude Code loses that Enter was not
 * measured (no turn sent to a real account); the check holds whatever keeps the text in the box.
 *
 * f7bff999 «이런 부분이 GUI 로 안보임»: four question tabs with previews (chat-mock FORM4, modelled on the reported
 * 2.1.330 screen). Before: the agent's words above the dialog naming «(esc to interrupt)» hid the card, and the card had
 * no preview and no count of answered tabs. Checks the old build fails are soft, so its run leaves every «before»
 * capture. T164_SHOTS=<folder> saves `<folder>/<report id8>/<T164_LABEL or after>.png` before the checks.
 */

const MOCK = path.join(REPO_ROOT, 'scripts/mock-cli/chat-mock.cjs')
const slug = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, '-')
const id = (n: number): string => `00000000-0000-4000-8000-0000000c164${n}`
const LONG = ['Here are the review comments.', 'Please apply each one.', '', '# Review: five items', '- first: tighten the header', '- second: keep the tab row'].join('\n')

let result: LaunchResult | null = null
test.afterEach(async () => {
    if (result) await closeApp(result)
    result = null
})

const chat = (page: Page): Locator => page.locator('[data-testid="chat-view"][data-session-id]:visible')

async function shot(page: Page, report: string, name = ''): Promise<void> {
    const dir = process.env.T164_SHOTS
    if (!dir) return
    fs.mkdirSync(path.join(dir, report), { recursive: true })
    await page.waitForTimeout(400)
    await page.screenshot({ path: path.join(dir, report, `${process.env.T164_LABEL ?? 'after'}${name ? `-${name}` : ''}.png`) })
}

/** Polls `check` until it is true or `ms` pass — a soft check's wait (expect.poll has no soft form). */
async function within(ms: number, check: () => Promise<boolean>): Promise<boolean> {
    const end = Date.now() + ms
    for (;;) {
        if (await check()) return true
        if (Date.now() >= end) return false
        await new Promise((resolve) => setTimeout(resolve, 250))
    }
}

async function openChat(page: Page, name: string, sessionId: string): Promise<void> {
    await page.getByText(name, { exact: true }).first().click()
    await waitForBufferText(page, sessionId, 'Claude Code (mock)', 20_000)
    await page.getByTestId('view-toggle-chat').click()
    await expect(chat(page)).toBeVisible()
}

async function launch(sessions: { id: string; name: string; args: string }[]): Promise<LaunchResult> {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'climanager-t164-'))
    const project = path.join(home, 'project')
    fs.mkdirSync(project)
    const claudeDir = path.join(home, 'claude')
    const seeded = sessions.map((session, index) => {
        const transcript = path.join(claudeDir, 'projects', slug(project), `${id(index)}.jsonl`)
        fs.mkdirSync(path.dirname(transcript), { recursive: true })
        fs.writeFileSync(transcript, '')
        return { id: session.id, name: session.name, cliSessionId: id(index), cliToolName: 'claude', cliCommand: `node ${MOCK} --transcript ${transcript} ${session.args}` }
    })
    const launched = await launchAppWithWorkspaces([{ id: 'w-t164', name: 'T164 project', path: project, sessions: seeded }], { env: { CLAUDE_CONFIG_DIR: claudeDir } })
    await resizeMainWindow(launched.app, 1280, 800)
    return launched
}

test('T164 019248e1: a long Chat message is either sent or kept, never silently gone', async () => {
    test.setTimeout(240_000)
    result = await launch([
        { id: 't164-lost1', name: 'T164 One lost Enter', args: '--paste-placeholder --lose-enters 1' },
        { id: 't164-lost3', name: 'T164 Lost Enters', args: '--paste-placeholder --lose-enters 3' },
        { id: 't164-queue', name: 'T164 Queued', args: '--paste-placeholder --lose-enters 3 --work-ms 4000' }
    ])
    const { page } = result
    const lines = LONG.split('\n').length

    // one Enter lost on the placeholder: pressed again, the message goes
    await openChat(page, 'T164 One lost Enter', 't164-lost1')
    const composer = chat(page).getByTestId('chat-composer')
    await composer.fill(LONG)
    await composer.press('Enter')
    expect.soft(await within(20_000, async () => (await termText(page, 't164-lost1')).includes(`ANSWER[1]: lines=${lines}`)), 'the second Enter submitted it').toBe(true)

    // every Enter lost: the words come back into the Chat box with the reason, next to what was typed since
    await openChat(page, 'T164 Lost Enters', 't164-lost3')
    await composer.fill(LONG)
    await composer.press('Enter')
    await expect(composer).toHaveValue('')
    await waitForBufferText(page, 't164-lost3', `[Pasted text #1 +${lines - 1} lines]`, 10_000)
    await composer.fill('and one more thing')
    // Enter pressed three times over ~10s, then refused: the words come back
    await expect.soft(composer).toHaveValue(`${LONG}\n\nand one more thing`, { timeout: 25_000 })
    await shot(page, '019248e1', 'box')
    expect(await termText(page, 't164-lost3')).not.toContain('ANSWER[')
    await expect.soft(chat(page).getByTestId('chat-composer-note')).toContainText('not submitted')

    // queued while the agent works, then not submitted: a «Not sent» row with the reason, Retry sends it
    await openChat(page, 'T164 Queued', 't164-queue')
    await composer.fill('WORK')
    await composer.press('Enter')
    await expect(chat(page).getByTestId('chat-working')).toBeVisible({ timeout: 10_000 })
    await composer.fill(LONG)
    await composer.press('Enter')
    await expect(chat(page).getByTestId('chat-queued-item')).toHaveCount(1, { timeout: 5_000 })
    await waitForBufferText(page, 't164-queue', `[Pasted text #1 +${lines - 1} lines]`, 20_000)
    const unsent = chat(page).getByTestId('chat-unsent-item')
    await expect.soft(unsent).toHaveCount(1, { timeout: 30_000 })
    await shot(page, '019248e1')
    await expect.soft(unsent).toContainText('Review: five items')
    await expect.soft(unsent.getByTestId('chat-unsent-reason')).toContainText('not submitted')
    expect(await termText(page, 't164-queue')).not.toContain('ANSWER[2]')
    if ((await unsent.count()) === 1) {
        // its words sit in the terminal's box: no Retry (Enter there sends them; a Retry could send them twice)
        await expect(unsent.getByTestId('chat-unsent-retry')).toHaveCount(0)
        await expect(unsent).toHaveAttribute('data-reason', 'not_submitted')
        // the person presses Enter in the terminal: it goes, and the row says it left the input line
        await writeToTerminal(page, 't164-queue', '\r')
        await expect.poll(async () => (await termText(page, 't164-queue')).includes(`ANSWER[2]: lines=${lines}`), { timeout: 20_000 }).toBe(true)
        await expect(unsent).toHaveAttribute('data-reason', 'left_input', { timeout: 10_000 })
        await expect(unsent.getByTestId('chat-unsent-reason')).toContainText('no longer in the terminal input line')
        await expect(unsent.getByTestId('chat-unsent-retry')).toHaveCount(0)
        await shot(page, '019248e1', 'left')
        // ✕ removes it; nothing was sent twice
        await unsent.getByTestId('chat-unsent-discard').click()
        await expect(unsent).toHaveCount(0, { timeout: 5_000 })
        expect(await termText(page, 't164-queue')).not.toContain('ANSWER[3]')
    }
})

test('T164 f7bff999: four question tabs with previews — a card with the preview, answered tab by tab, then Submit', async () => {
    test.setTimeout(180_000)
    result = await launch([{ id: 't164-form', name: 'T164 Form', args: '' }])
    const { page } = result
    await openChat(page, 'T164 Form', 't164-form')
    const composer = chat(page).getByTestId('chat-composer')
    await composer.fill('FORM4')
    await composer.press('Enter')
    await waitForBufferText(page, 't164-form', 'Tab to switch questions', 15_000)
    const card = chat(page).getByTestId('chat-prompt-card')
    await expect.soft(card).toBeVisible({ timeout: 10_000 })
    await shot(page, 'f7bff999')
    if (!(await card.isVisible())) {
        // the old build: no card at all — open the terminal for the «before» picture of what it shows
        await page.getByTestId('view-toggle-terminal').click()
        await shot(page, 'f7bff999', 'terminal')
        expect.soft(false, 'the four-tab dialog has a card').toBe(true)
        return
    }
    await expect(card.getByTestId('chat-prompt-question')).toContainText('어떻게 할까요?')
    await expect(card.getByTestId('chat-prompt-option')).toHaveCount(3)
    await expect(card.getByTestId('chat-prompt-step')).toHaveCount(5)
    await expect.soft(card.getByTestId('chat-prompt-progress')).toHaveText('0 of 4 answered')
    const preview = card.getByTestId('chat-prompt-preview')
    await expect.soft(preview).toContainText('‹ › proj > item')
    await expect.soft(preview).toContainText('(미리 보기 1)')

    // the preview follows the highlight: option 2 picked moves the mock to tab 2
    await card.getByTestId('chat-prompt-option').nth(1).click()
    await expect(card.getByTestId('chat-prompt-question')).toHaveText('줄 모양은 어느 쪽이 좋을까요?', { timeout: 10_000 })
    await expect.soft(card.getByTestId('chat-prompt-progress')).toHaveText('1 of 4 answered')
    await expect.soft(preview).toContainText('줄 모양 1')
    // the first option of tabs 2 and 3, each taking the card to the next question
    for (const next of ['0a1b2c3d 는 이번에 같이 고칠까요?', '마무리는 어떻게 할까요?']) {
        await card.getByTestId('chat-prompt-option').first().click()
        await expect(card.getByTestId('chat-prompt-question')).toHaveText(next, { timeout: 10_000 })
    }
    await card.getByTestId('chat-prompt-option').nth(2).click()
    // the Submit tab: the review, answered with its Submit button
    await expect(card.getByTestId('chat-prompt-question')).toHaveText('Ready to submit your answers?', { timeout: 10_000 })
    await expect(card).toHaveAttribute('data-kind', 'review')
    await shot(page, 'f7bff999', 'review')
    await card.getByTestId('chat-prompt-option').filter({ hasText: 'Submit answers' }).click()
    await waitForBufferText(page, 't164-form', 'CHOSE: submit4 목록 칸만 내림; 한 줄; 같이 고침; 보류', 10_000)
    await expect(card).toHaveCount(0, { timeout: 10_000 })
})

const DROPPED = 'API Error: Connection dropped (ECONNRESET). A VPN, firewall, or security software can cause this. Check those or switch networks, then try again.'
const ANSWERED_AT = '2026-11-23T09:15:00.000Z'

test('T164 3239a243 · 45127b82: a turn that ended on a dropped connection is a red dot; an answer copies for an agent', async () => {
    test.setTimeout(180_000)
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'climanager-t164-'))
    const project = path.join(home, 'project')
    fs.mkdirSync(project)
    const claudeDir = path.join(home, 'claude')
    const transcript = path.join(claudeDir, 'projects', slug(project), `${id(7)}.jsonl`)
    fs.mkdirSync(path.dirname(transcript), { recursive: true })
    // what Claude Code 2.1.330 writes when the connection drops (shape read from real transcripts; words synthetic)
    // (one chain of uuids: the reader shows the branch the last record is on, and chat-mock --continue goes on from it)
    const record = (uuid: string, parentUuid: string | null, type: 'user' | 'assistant', text: string, at: string, extra: Record<string, unknown> = {}): string =>
        JSON.stringify({ type, uuid, parentUuid, timestamp: at, message: { role: type, ...(type === 'assistant' ? { model: 'claude-opus-5-5' } : {}), content: [{ type: 'text', text }] }, ...extra })
    fs.writeFileSync(transcript, [
        record('u1', null, 'user', 'Plan the review', '2026-11-23T09:14:00.000Z'),
        record('a1', 'u1', 'assistant', 'Here is the plan.\n\n- tighten the header\n- keep the tab row', ANSWERED_AT),
        record('u2', 'a1', 'user', 'go on', '2026-11-23T09:20:00.000Z'),
        record('e1', 'u2', 'assistant', DROPPED, '2026-11-23T09:20:05.000Z', { apiError: 'connection_failed', error: 'server_error', isApiErrorMessage: true })
    ].join('\n').replace('"model":"claude-opus-5-5","content":[{"type":"text","text":"API Error', '"model":"<synthetic>","content":[{"type":"text","text":"API Error') + '\n')
    fs.copyFileSync(transcript, path.join(path.dirname(transcript), `${id(8)}.jsonl`))
    const bin = path.join(home, 'bin')
    fs.mkdirSync(bin)
    const gone = path.join(bin, 'claude')
    fs.writeFileSync(gone, '#!/bin/sh\necho "agent gone"\nexit 0\n', { mode: 0o755 })
    result = await launchAppWithWorkspaces(
        [{
            id: 'w-t164e',
            name: 'T164 project',
            path: project,
            sessions: [
                { id: 't164-home', name: 'T164 Home' },
                { id: 't164-dropped', name: 'T164 Dropped', cliSessionId: id(7), cliToolName: 'claude', cliCommand: `node ${MOCK} --transcript ${transcript} --continue` },
                // the same failed turn, but the agent is gone (its command ends at once — as Ctrl+C back to the shell).
                // An executable named «claude» the app resumes as Claude's: anything else, and the app falls back to
                // the real `claude` (seen: it started — never let a test do that)
                { id: 't164-exited', name: 'T164 Exited', cliSessionId: id(8), cliToolName: 'claude', cliCommand: `'${gone}'` }
            ]
        }],
        { env: { CLAUDE_CONFIG_DIR: claudeDir }, settings: { showSessionStatus: true } }
    )
    const { app, page } = result
    await resizeMainWindow(app, 1280, 800)
    await page.getByText('T164 Dropped', { exact: true }).first().click()
    await waitForBufferText(page, 't164-dropped', 'Claude Code (mock)', 20_000)
    await page.getByText('T164 Exited', { exact: true }).first().click()
    // its command ran and ended: the shell is in front
    await expect.poll(async () => (await termText(page, 't164-exited')).includes('agent gone'), { timeout: 20_000 }).toBe(true)
    await page.getByText('T164 Home', { exact: true }).first().click()

    // --- 3239a243: red while the last turn is the error ------------------------------------------
    const dot = page.locator('[data-session-item="t164-dropped"] [data-session-status]')
    await expect.soft(dot).toHaveAttribute('data-session-status', 'error', { timeout: 10_000 })
    await shot(page, '3239a243')
    await expect.soft(dot).toHaveAttribute('title', /Connection dropped \(ECONNRESET\)/)
    // the shell in front (no agent to retry): no red dot for the same failed turn
    await expect(page.locator('[data-session-item="t164-exited"] [data-session-status]')).toHaveCount(0)
    // the next turn starts (and answers): the dot goes
    await writeToTerminal(page, 't164-dropped', 'try again\r')
    await expect(dot).toHaveCount(0, { timeout: 15_000 })

    // --- 45127b82: «Copy for agent» beside the answer's copy buttons ------------------------------
    await page.getByText('T164 Dropped', { exact: true }).first().click()
    await page.getByTestId('view-toggle-chat').click()
    await expect(chat(page)).toBeVisible()
    const answer = chat(page).locator('[data-testid="chat-turn"][data-role="assistant"]').filter({ hasText: 'Here is the plan.' })
    await answer.hover()
    const button = answer.getByTestId('chat-copy-for-agent')
    await expect.soft(button).toBeVisible({ timeout: 5_000 })
    await shot(page, '45127b82')
    if (await button.isVisible()) {
        const saved = await app.evaluate(({ clipboard }) => clipboard.readText())
        try {
            await button.click()
            const pad = (n: number): string => String(n).padStart(2, '0')
            const local = new Date(ANSWERED_AT)
            const offset = -local.getTimezoneOffset()
            const zone = `UTC${offset >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`
            const when = `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())} ${pad(local.getHours())}:${pad(local.getMinutes())} (${zone})`
            await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText()), { timeout: 5_000 }).toContain('Here is the plan.')
            const copied = (await app.evaluate(({ clipboard }) => clipboard.readText())).split('\n')
            expect(copied[0]).toBe(`From "T164 Dropped" in CLI Manager · climanager://session/${'t164-dropped'.slice(0, 8)}`)
            // the first of the conversation's answers (the API error and the echo after it are answers too)
            expect(copied[1]).toBe(`Answer 1 of 3 · answered ${when}`)
            expect(copied.slice(2).join('\n')).toBe('\nHere is the plan.\n\n- tighten the header\n- keep the tab row')
        } finally {
            await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), saved)
        }
    }
})
