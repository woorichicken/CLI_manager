import { test, expect, type Locator, type Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { closeApp, launchAppWithWorkspaces, LaunchResult, REPO_ROOT, resizeMainWindow, termText, waitForBufferText } from './helpers'

/**
 * T113 — question cards, round chat-gap-r3-1109 round 4, in the app.
 *
 * Q-5 (fb 58814f80): an MCP server's Accept / Decline answered from the Chat — Decline, Cancel (Esc) and
 * Accept, each checked by what the mock prints (`CHOSE: …`), the keys measured on Claude Code 2.1.319.
 * Q-7: Codex's request_user_input — a pick on question 1, then typed words for question 2 («None of the
 * above», Tab, the words, Enter, measured on codex-cli 0.166.0). chat-mock MCPOK / ASKCX draw the screens
 * as copied (T112 reads the copies). Old-build failures are soft so a run there leaves every «before»
 * capture; T113_SHOTS=<folder>, T113_LABEL=<before|after>.
 */

const MOCK = path.join(REPO_ROOT, 'scripts/mock-cli/chat-mock.cjs')
const FIXTURES = path.join(__dirname, 'fixtures/transcripts')
const CLAUDE_ID = '00000000-0000-4000-8000-0000000c1131'
const CODEX_ID = '00000000-0000-4000-8000-0000000c1132'

let result: LaunchResult | null = null
test.afterEach(async () => {
    if (result) await closeApp(result)
    result = null
})

const chat = (page: Page): Locator => page.locator('[data-testid="chat-view"][data-session-id]:visible')

async function shot(page: Page, name: string): Promise<void> {
    const dir = process.env.T113_SHOTS
    if (!dir) return
    fs.mkdirSync(dir, { recursive: true })
    await page.waitForTimeout(300)
    await page.screenshot({ path: path.join(dir, `${process.env.T113_LABEL ?? 'after'}-${name}.png`), clip: { x: 0, y: 0, width: 1280, height: 800 } })
}

async function send(page: Page, text: string): Promise<void> {
    const composer = chat(page).getByTestId('chat-composer')
    await composer.fill(text)
    await composer.press('Enter')
}

/** the card's option button by its words, if the card drew it */
const option = (page: Page, words: string): Locator => chat(page).getByTestId('chat-prompt-option').filter({ hasText: new RegExp(`^[\\d•]*${words}`) }).first()

async function choose(page: Page, id: string, words: string, printed: string): Promise<void> {
    const button = option(page, words)
    if (await button.isEnabled().catch(() => false)) {
        await button.click()
        await waitForBufferText(page, id, printed, 10_000).catch(() => undefined)
    }
    expect.soft(await termText(page, id, 40), `${words} reached the agent`).toContain(printed)
    // nothing answered (old build): close the menu in the terminal, so the next step starts clean
    if (!(await termText(page, id, 40)).includes(printed)) await page.evaluate(([session]) => window.api.writeTerminal(session, '\x1b'), [id])
    // soft: the old build left the card up here (a read the poll never saw — T112), and a run there goes on to Q-7
    await expect.soft(chat(page).getByTestId('chat-prompt-card'), 'the card goes once answered').toHaveCount(0, { timeout: 10_000 })
}

test('T113 cards: an MCP server\'s Accept / Decline, and Codex\'s request_user_input', async () => {
    test.setTimeout(240_000)
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'climanager-t113-'))
    const project = path.join(home, 'project')
    fs.mkdirSync(project)
    const claudeDir = path.join(home, 'claude')
    const codexDir = path.join(home, 'codex')
    const transcript = path.join(claudeDir, 'projects', project.replace(/[^A-Za-z0-9]/g, '-'), `${CLAUDE_ID}.jsonl`)
    const rollout = path.join(codexDir, 'sessions', '2026', '11', '09', `rollout-2026-11-09T13-00-00-${CODEX_ID}.jsonl`)
    fs.mkdirSync(path.dirname(transcript), { recursive: true })
    fs.mkdirSync(path.dirname(rollout), { recursive: true })
    fs.copyFileSync(path.join(FIXTURES, 'claude/tools.jsonl'), transcript)
    fs.copyFileSync(path.join(FIXTURES, 'codex/rollout-2026-11-03T10-00-00-00000000-0000-4000-8000-0000000000c1.jsonl'), rollout)

    result = await launchAppWithWorkspaces(
        [
            {
                id: 'w-t113',
                name: 'T113 project',
                path: project,
                sessions: [
                    { id: 't113-claude', name: 'T113 Claude', cliSessionId: CLAUDE_ID, cliToolName: 'claude', cliCommand: `node ${MOCK} --transcript ${transcript} --work-ms 300` },
                    { id: 't113-codex', name: 'T113 Codex', cliSessionId: CODEX_ID, cliToolName: 'codex', cliCommand: `node ${MOCK} --agent codex --transcript ${rollout} --work-ms 300` }
                ]
            }
        ],
        { env: { CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: codexDir } }
    )
    const { app, page } = result
    await resizeMainWindow(app, 1280, 800)

    // --- Q-5: Accept / Decline ---------------------------------------------------------------------------
    await page.getByText('T113 Claude', { exact: true }).first().click()
    await waitForBufferText(page, 't113-claude', 'Claude Code (mock)', 20_000)
    await page.getByTestId('view-toggle-chat').click()
    const card = chat(page).getByTestId('chat-prompt-card')
    for (const [words, printed, label] of [
        ['Decline', 'CHOSE: decline', 'q5-mcp-card'],
        ['Cancel', 'CHOSE: cancel', null],
        ['Accept', 'CHOSE: accept', null]
    ] as const) {
        await send(page, 'MCPOK')
        await expect(card).toBeVisible({ timeout: 10_000 })
        if (label) await shot(page, label)
        await expect.soft(card.getByTestId('chat-prompt-question')).toHaveText('Run it on project abcdefghijklmnopqrst?')
        await expect.soft(card.getByTestId('chat-prompt-option'), 'Accept · Decline · Cancel').toHaveText(['•Accept', '•Decline', '•Cancel'])
        await choose(page, 't113-claude', words, printed)
    }

    // --- Q-7: Codex asks two questions -----------------------------------------------------------------------
    await page.getByText('T113 Codex', { exact: true }).first().click()
    await waitForBufferText(page, 't113-codex', 'OpenAI Codex (mock)', 20_000)
    await page.getByTestId('view-toggle-chat').click()
    await expect(chat(page).getByTestId('chat-composer')).toBeVisible()
    await send(page, 'ASKCX')
    await waitForBufferText(page, 't113-codex', 'Question 1/2', 10_000)
    await page.waitForTimeout(1500)
    await shot(page, 'q7-codex-q1')
    await expect.soft(card, 'a card for the question').toBeVisible({ timeout: 5_000 })
    if (await card.isVisible().catch(() => false)) {
        await expect(card.getByTestId('chat-prompt-question')).toHaveText('Which color?')
        await expect(card.getByTestId('chat-prompt-context')).toHaveText('Question 1 of 2')
        await option(page, 'Blue').click()
        await expect(card.getByTestId('chat-prompt-question')).toHaveText('Which size?', { timeout: 10_000 })
        await card.getByTestId('chat-prompt-custom-input').fill('Medium please')
        await shot(page, 'q7-codex-q2-typed')
        await card.getByTestId('chat-prompt-custom-send').click()
        await waitForBufferText(page, 't113-codex', 'CHOSE: ask color=Blue; size=None of the above (note: Medium please)', 10_000)
        await expect(card).toHaveCount(0, { timeout: 10_000 })
    }
})
