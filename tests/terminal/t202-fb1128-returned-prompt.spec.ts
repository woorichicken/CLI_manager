import { test, expect, type Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { closeApp, launchAppWithWorkspaces, LaunchResult, REPO_ROOT, resizeMainWindow, waitForBufferText, writeToTerminal } from './helpers'
import type { ConversationTurn } from '../../src/shared/conversation'
import { returnedPromptTurns } from '../../src/renderer/src/components/ChatView/chatLib'

/**
 * T202 — fb-1128 f49af50a: Stop before Claude answered. Claude Code puts the prompt back in its input box and Chat's
 * Stop takes it into the message box (682ea4de, T156) — so the prompt is no sent message any more. Its bubble folds
 * into one dim line («… went back to the message box», the words in the tooltip) instead of sitting above the same
 * words in the box. Both record shapes: with the «[Request interrupted by user]» marker (older Claude, chat-mock) and
 * without it (the reported 2.1.3xx screen — chat-mock --quiet-stop). A turn that was answered stays a bubble, and the
 * next message brings the folded one back as history.
 *
 * T202_SHOTS=<dir> (+ T202_LABEL) saves captures before the checks.
 */

const ID = 't202-claude'
const CLAUDE_ID = '00000000-0000-4000-8000-00000000f202'
const MOCK = path.join(REPO_ROOT, 'scripts/mock-cli/chat-mock.cjs')
const FIXTURES = path.join(__dirname, 'fixtures/transcripts')
const LABEL = process.env.T202_LABEL ?? 'run'
const PROMPT = 'good, then ship that one'
const claudeProjectSlug = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, '-')

let result: LaunchResult | null = null
test.afterEach(async () => {
    if (result) await closeApp(result)
    result = null
})

async function shot(page: Page, name: string): Promise<void> {
    const dir = process.env.T202_SHOTS
    if (!dir) return
    fs.mkdirSync(dir, { recursive: true })
    await page.waitForTimeout(400)
    await page.screenshot({ path: path.join(dir, `${name}-${LABEL}.png`) })
}

const user = (text: string): ConversationTurn => ({ role: 'user', ts: null, parts: [{ kind: 'text', text }] })
const answer = (text: string): ConversationTurn => ({ role: 'assistant', ts: null, parts: [{ kind: 'text', text }] })
const MARKER = '[Request interrupted by user]'

test('T202 unit: which turns fold — the unanswered last prompt with the returned words, and markers after it', () => {
    const asked = [user('first'), answer('ok'), user(PROMPT)]
    expect(returnedPromptTurns(asked, PROMPT)).toEqual({ prompt: 2, markers: [] })
    expect(returnedPromptTurns([...asked, user(MARKER)], PROMPT)).toEqual({ prompt: 2, markers: [3] })
    // spacing and line breaks are not the words
    expect(returnedPromptTurns(asked, `  good,  then\nship that one `)).toEqual({ prompt: 2, markers: [] })
    // nothing returned, other words, or an answer after it: nothing folds
    expect(returnedPromptTurns(asked, null)).toBeNull()
    expect(returnedPromptTurns(asked, 'something else')).toBeNull()
    expect(returnedPromptTurns([...asked, answer('done')], PROMPT)).toBeNull()
    // a stop after part of an answer (marker after the answer) is no returned prompt
    expect(returnedPromptTurns([...asked, answer('half'), user(MARKER)], PROMPT)).toBeNull()
    // only the conversation's last prompt: an older one with the same words stays
    expect(returnedPromptTurns([user(PROMPT), answer('ok'), user('later')], PROMPT)).toBeNull()
    // bound to the stopped turn's time: the same words sent again later are a new turn, not folded
    const stopped = { ...user(PROMPT), ts: '2026-11-28T01:00:00.000Z' }
    const again = { ...user(PROMPT), ts: '2026-11-28T01:05:00.000Z' }
    expect(returnedPromptTurns([answer('ok'), stopped], PROMPT, stopped.ts)).toEqual({ prompt: 1, markers: [] })
    expect(returnedPromptTurns([answer('ok'), stopped, user(MARKER), again], PROMPT, stopped.ts)).toBeNull()
})

for (const shape of ['marker', 'quiet'] as const) {
    test(`T202 f49af50a (${shape}): the prompt Stop sent back folds into one line, the words in the box below`, async () => {
        test.setTimeout(120_000)
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'climanager-t202-'))
        const project = path.join(home, 'project')
        fs.mkdirSync(project)
        const claudeDir = path.join(home, 'claude')
        const transcript = path.join(claudeDir, 'projects', claudeProjectSlug(project), `${CLAUDE_ID}.jsonl`)
        fs.mkdirSync(path.dirname(transcript), { recursive: true })
        fs.copyFileSync(path.join(FIXTURES, 'claude/tools.jsonl'), transcript)
        const quiet = shape === 'quiet' ? ' --quiet-stop' : ''
        result = await launchAppWithWorkspaces(
            [{ id: 'w-t202', name: 'T202 project', path: project, sessions: [
                { id: ID, name: 'T202 Claude', cliSessionId: CLAUDE_ID, cliToolName: 'claude', cliCommand: `node ${MOCK} --transcript ${transcript} --restore-on-esc${quiet} --work-ms 8000` }
            ] }],
            { env: { CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: path.join(home, 'codex'), CLIMANAGER_HOME: path.join(home, 'clim') } }
        )
        const { app, page } = result
        await resizeMainWindow(app, 1280, 800)
        await waitForBufferText(page, ID, 'Claude Code (mock)', 20_000)
        await page.getByText('T202 Claude', { exact: true }).first().click()
        await page.getByTestId('view-toggle-chat').click()
        const chat = page.locator('[data-testid="chat-view"][data-session-id]:visible')
        const composer = chat.getByTestId('chat-composer')
        const userBubbles = chat.locator('[data-testid="chat-turn"][data-role="user"]')
        await expect(composer).toBeVisible({ timeout: 15_000 })
        // the fixture's own answered prompt is a bubble, and stays one
        const answered = await userBubbles.count()
        expect(answered).toBeGreaterThan(0)

        await composer.fill(PROMPT)
        await composer.press('Enter')
        await waitForBufferText(page, ID, `ANSWER[1]: ${PROMPT}`, 10_000)
        await expect(userBubbles.filter({ hasText: PROMPT })).toHaveCount(1, { timeout: 10_000 })
        await chat.getByTestId('chat-stop').click({ timeout: 10_000 })
        await waitForBufferText(page, ID, 'INTERRUPTED', 10_000)
        // the words are back in the message box (T156) …
        await expect(composer).toHaveValue(PROMPT, { timeout: 6000 })
        await shot(page, `t202-${shape}-after-stop`)
        // … and the record's prompt is one dim line, not a sent bubble over the same words (before: the bubble stayed)
        const folded = chat.getByTestId('chat-returned-prompt')
        await expect(folded).toHaveCount(1, { timeout: 5000 })
        await expect(folded).toHaveAttribute('title', PROMPT)
        await expect(userBubbles.filter({ hasText: PROMPT })).toHaveCount(0)
        await expect(chat.getByTestId('chat-stopped')).toHaveCount(0)
        await expect(userBubbles).toHaveCount(answered)

        // the same words sent again from the terminal (not this Chat's send) are a new turn: a bubble, not folded
        await writeToTerminal(page, ID, `${PROMPT}\r`)
        await waitForBufferText(page, ID, `ANSWER[2]: ${PROMPT}`, 10_000)
        await expect(userBubbles.filter({ hasText: PROMPT }).last()).toBeVisible({ timeout: 10_000 })
        await expect(folded).toHaveCount(0)
        await waitForBufferText(page, ID, `Echo: ${PROMPT}`, 20_000)

        // a new message: the folded line goes back to being history, the new words are a bubble
        await composer.fill('just list them')
        await composer.press('Enter')
        await waitForBufferText(page, ID, 'ANSWER[3]: just list them', 10_000)
        await expect(userBubbles.filter({ hasText: 'just list them' })).toHaveCount(1, { timeout: 10_000 })
        await expect(folded).toHaveCount(0)
    })
}
