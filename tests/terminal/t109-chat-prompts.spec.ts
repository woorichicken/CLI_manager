import { test, expect, type Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { closeApp, launchAppWithWorkspaces, LaunchResult, REPO_ROOT, resizeMainWindow, waitForBufferText } from './helpers'

/**
 * T109 — question cards answered from the Chat view, and the Chat button of a session started from
 * a template (round chat-gap-1109: Q-1 · Q-2 · Q-3 · Q-4 · Q-6 · S-1).
 *
 * chat-mock.cjs draws the menus as copied from real screens (Claude Code 2.1.319 FORM / PLANOK,
 * codex-cli 0.166.0 APPROVE — fixtures/prompts, read by T108) and prints `CHOSE: …` for what was
 * picked, so the check is the terminal's own output, not the card.
 *
 * Checked: the question tabs as steps (not context) and an answer by option; a multiple choice ticked
 * on the card and sent with its Submit button; the review card listing the answers and submitting
 * them; the card folds and its body scrolls past a height (390 wide too); the plan approval by option
 * and by typed words; Codex's approval answered by option and by Esc ("No"). S-1: a session whose
 * `initialCommand` is a Claude command (the template path) shows Terminal | Chat without a restart.
 * T109_SHOTS=<folder> saves captures at 1280 and 390, before each check.
 */

const claudeProjectSlug = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, '-')
const MOCK = path.join(REPO_ROOT, 'scripts/mock-cli/chat-mock.cjs')
const FIXTURES = path.join(__dirname, 'fixtures/transcripts')
const CLAUDE_ID = '00000000-0000-4000-8000-0000000c1091'
const CODEX_ID = '00000000-0000-4000-8000-0000000c1092'

let result: LaunchResult | null = null
test.afterEach(async () => {
    if (result) await closeApp(result)
    result = null
})

const chat = (page: Page) => page.locator(`[data-testid="chat-view"][data-session-id]:visible`)

async function shot(page: Page, name: string, width = 1280): Promise<void> {
    const dir = process.env.T109_SHOTS
    if (!dir) return
    fs.mkdirSync(dir, { recursive: true })
    await page.waitForTimeout(300)
    await page.screenshot({ path: path.join(dir, `${process.env.T109_LABEL ?? 'after'}-${name}`), clip: { x: 0, y: 0, width, height: 800 } })
}

async function shotBoth(app: LaunchResult['app'], page: Page, name: string): Promise<void> {
    if (!process.env.T109_SHOTS) return
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

async function send(page: Page, text: string): Promise<void> {
    const composer = chat(page).getByTestId('chat-composer')
    await composer.fill(text)
    await composer.press('Enter')
}

test('T109 cards: question tabs, multiple choice, review, fold, plan, Codex approval', async () => {
    test.setTimeout(240_000)
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'climanager-t109-'))
    const project = path.join(home, 'project')
    fs.mkdirSync(project)
    const claudeDir = path.join(home, 'claude')
    const codexDir = path.join(home, 'codex')
    const transcript = path.join(claudeDir, 'projects', claudeProjectSlug(project), `${CLAUDE_ID}.jsonl`)
    const rollout = path.join(codexDir, 'sessions', '2026', '11', '09', `rollout-2026-11-09T10-00-00-${CODEX_ID}.jsonl`)
    fs.mkdirSync(path.dirname(transcript), { recursive: true })
    fs.mkdirSync(path.dirname(rollout), { recursive: true })
    // a resume needs the conversation on disk (the app will not resume one it cannot find): the synthetic T74 ones
    fs.copyFileSync(path.join(FIXTURES, 'claude/tools.jsonl'), transcript)
    fs.copyFileSync(path.join(FIXTURES, 'codex/rollout-2026-11-03T10-00-00-00000000-0000-4000-8000-0000000000c1.jsonl'), rollout)

    result = await launchAppWithWorkspaces(
        [
            {
                id: 'w-t109',
                name: 'T109 project',
                path: project,
                sessions: [
                    { id: 't109-claude', name: 'T109 Claude', cliSessionId: CLAUDE_ID, cliToolName: 'claude', cliCommand: `node ${MOCK} --transcript ${transcript} --work-ms 400` },
                    { id: 't109-codex', name: 'T109 Codex', cliSessionId: CODEX_ID, cliToolName: 'codex', cliCommand: `node ${MOCK} --agent codex --transcript ${rollout} --work-ms 400` }
                ]
            }
        ],
        { env: { CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: codexDir } }
    )
    const { app, page } = result
    await resizeMainWindow(app, 1280, 800)
    await selectSession(page, 'T109 Claude')
    await waitForBufferText(page, 't109-claude', 'Claude Code (mock)', 20_000)
    await page.getByTestId('view-toggle-chat').click()
    await expect(chat(page)).toBeVisible()

    // --- Q-3: the question tabs are steps, the card answers a pick ------------------------------
    await send(page, 'FORM')
    const card = chat(page).getByTestId('chat-prompt-card')
    await expect(card.getByTestId('chat-prompt-question')).toHaveText('Which color?', { timeout: 10_000 })
    await shotBoth(app, page, 'q1-steps')
    await expect(card.getByTestId('chat-prompt-step')).toHaveText(['Color', 'Fruits', 'Submit'])
    await expect(card.getByTestId('chat-prompt-context')).toHaveCount(0)
    await card.locator('[data-testid="chat-prompt-option"][data-index="1"]').click()

    // --- Q-2: a multiple choice ticked on the card ----------------------------------------------
    await expect(card.getByTestId('chat-prompt-question')).toHaveText('Which fruits?', { timeout: 10_000 })
    await expect(card.getByTestId('chat-prompt-step').first()).toHaveAttribute('data-answered', 'true')
    const apple = card.locator('[data-testid="chat-prompt-option"][data-index="0"]')
    const cherry = card.locator('[data-testid="chat-prompt-option"][data-index="2"]')
    await expect(apple).toHaveAttribute('role', 'checkbox')
    await apple.click()
    await cherry.click()
    await expect(apple).toHaveAttribute('aria-checked', 'true')
    const submit = card.getByTestId('chat-prompt-multi-submit')
    await expect(submit).toHaveText('Submit · 2 picked')
    await shotBoth(app, page, 'q2-multi')
    await submit.click()

    // --- Q-1: the review lists the answers and submits them --------------------------------------
    await expect(card).toHaveAttribute('data-kind', 'review', { timeout: 10_000 })
    await expect(card.getByTestId('chat-prompt-context')).toContainText('Which color? → Blue')
    await expect(card.getByTestId('chat-prompt-context')).toContainText('Which fruits? → Apple, Cherry')
    await shotBoth(app, page, 'review')
    // the card folds away and opens again
    await card.getByTestId('chat-prompt-collapse').click()
    await expect(card).toHaveAttribute('data-collapsed', 'true')
    await expect(card.getByTestId('chat-prompt-body')).toHaveCount(0)
    await shot(page, 'review-folded-1280.png')
    await card.getByTestId('chat-prompt-collapse').click()
    await card.locator('[data-testid="chat-prompt-option"][data-index="0"]').click()
    await waitForBufferText(page, 't109-claude', 'CHOSE: submit color=Blue; fruits=Apple, Cherry', 10_000)
    await expect(card).toHaveCount(0, { timeout: 10_000 })

    // --- Q-4: the plan approval — by option, and by typed words; its body scrolls at 390 ----------
    await send(page, 'PLANOK')
    await expect(card).toHaveAttribute('data-kind', 'plan', { timeout: 10_000 })
    await expect(card.getByTestId('chat-prompt-context')).toContainText('Plan: add a greeting')
    await expect(card.getByTestId('chat-prompt-option')).toHaveCount(2)
    await shotBoth(app, page, 'plan')
    const body = card.getByTestId('chat-prompt-body')
    const maxHeight = await body.evaluate((element) => getComputedStyle(element).maxHeight)
    expect(maxHeight).not.toBe('none')
    await card.getByTestId('chat-prompt-custom-input').fill('add a test')
    await card.getByTestId('chat-prompt-custom-send').click()
    await waitForBufferText(page, 't109-claude', 'CHOSE: custom add a test', 10_000)
    await expect(card).toHaveCount(0, { timeout: 10_000 })
    await send(page, 'PLANOK')
    await expect(card).toHaveAttribute('data-kind', 'plan', { timeout: 10_000 })
    await card.locator('[data-testid="chat-prompt-option"][data-index="1"]').click()
    await waitForBufferText(page, 't109-claude', 'CHOSE: Yes, manually approve edits', 10_000)

    // --- Q-6: Codex's command approval answers from the card; "No" is Esc -------------------------
    await selectSession(page, 'T109 Codex')
    await waitForBufferText(page, 't109-codex', 'OpenAI Codex (mock)', 20_000)
    await page.getByTestId('view-toggle-chat').click()
    await expect(chat(page)).toBeVisible()
    await send(page, 'APPROVE')
    const codexCard = chat(page).getByTestId('chat-prompt-card')
    await expect(codexCard).toHaveAttribute('data-answerable', 'true', { timeout: 10_000 })
    await expect(codexCard.getByTestId('chat-prompt-question')).toHaveText('Would you like to run the following command?')
    await expect(codexCard.getByTestId('chat-prompt-context')).toContainText('$ touch hello.txt')
    await expect(codexCard.getByTestId('chat-prompt-option')).toHaveText([/Yes, proceed$/, /don't ask again/, /No, and tell Codex/])
    await shotBoth(app, page, 'codex-approve')
    await codexCard.locator('[data-testid="chat-prompt-option"][data-index="2"]').click()
    await waitForBufferText(page, 't109-codex', 'CHOSE: esc', 10_000)
    await expect(codexCard).toHaveCount(0, { timeout: 10_000 })
    await send(page, 'APPROVE')
    await expect(codexCard).toHaveAttribute('data-answerable', 'true', { timeout: 10_000 })
    await codexCard.locator('[data-testid="chat-prompt-option"][data-index="0"]').click()
    await waitForBufferText(page, 't109-codex', 'CHOSE: option y', 10_000)

    // --- 390 wide: the terminal narrows, the CLIs wrap their dialogs; the cards still read and answer ---
    const close = page.locator('[title^="Close Sidebar"]').first()
    if (await close.isVisible().catch(() => false)) await close.evaluate((element) => (element as HTMLElement).click())
    await resizeMainWindow(app, 390, 800)
    await page.waitForTimeout(700)
    await send(page, 'APPROVE')
    await expect(codexCard).toHaveAttribute('data-answerable', 'true', { timeout: 10_000 })
    await codexCard.locator('[data-testid="chat-prompt-option"][data-index="2"]').click()
    await waitForBufferText(page, 't109-codex', 'CHOSE: esc', 10_000)
    await page.locator('[title^="Open Sidebar"]').first().evaluate((element) => (element as HTMLElement).click())
    await selectSession(page, 'T109 Claude')
    await page.locator('[title^="Close Sidebar"]').first().evaluate((element) => (element as HTMLElement).click())
    await page.waitForTimeout(500)
    await send(page, 'PLANOK')
    await expect(card).toHaveAttribute('data-kind', 'plan', { timeout: 10_000 })
    // the question wraps over rows in a narrow terminal: the plan is still the context
    await expect(card.getByTestId('chat-prompt-context')).toContainText('Plan: add a greeting')
    await expect(card.getByTestId('chat-prompt-question')).toHaveText('Claude has written up a plan and is ready to execute. Would you like to proceed?')
    const cardBox = await card.boundingBox()
    expect(cardBox!.x + cardBox!.width).toBeLessThanOrEqual(390)
    // the card leaves room for the chat: its body scrolls instead of growing past the window
    expect(cardBox!.height).toBeLessThanOrEqual(800 * 0.75)
    await shot(page, 'plan-narrow-390.png', 390)
    await card.locator('[data-testid="chat-prompt-option"][data-index="0"]').click()
    await waitForBufferText(page, 't109-claude', 'CHOSE: Yes, and use auto mode', 10_000)
})

test('T109 S-1: a session started from a template command shows Terminal | Chat without a restart', async () => {
    test.setTimeout(180_000)
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'climanager-t109s-'))
    const project = path.join(home, 'project')
    const bin = path.join(home, 'bin')
    fs.mkdirSync(project)
    fs.mkdirSync(bin)
    const claudeDir = path.join(home, 'claude')
    // a `claude` that runs the mock, its transcript where Claude Code keeps the --session-id it was given
    fs.writeFileSync(
        path.join(bin, 'claude'),
        [
            '#!/bin/sh',
            'id=""',
            'while [ $# -gt 0 ]; do if [ "$1" = "--session-id" ]; then id="$2"; fi; shift; done',
            `dir="${claudeDir}/projects/$(pwd | sed 's/[^A-Za-z0-9]/-/g')"`,
            'mkdir -p "$dir"',
            `exec node '${MOCK}' --transcript "$dir/$id.jsonl" --work-ms 300`,
            ''
        ].join('\n'),
        { mode: 0o755 }
    )
    fs.writeFileSync(path.join(home, '.zshrc'), `export PATH='${bin}':"$PATH"\nPROMPT='T109> '\nunset HISTFILE\n`)

    result = await launchAppWithWorkspaces(
        [{ id: 'w-t109s', name: 'T109S project', path: project, sessions: [{ id: 't109-template', name: 'T109 Template', initialCommand: `${bin}/claude` }] }],
        { env: { HOME: home, ZDOTDIR: home, CLAUDE_CONFIG_DIR: claudeDir, PATH: `${bin}:${process.env.PATH ?? ''}` } }
    )
    const { app, page } = result
    await resizeMainWindow(app, 1280, 800)
    await selectSession(page, 'T109 Template')
    await waitForBufferText(page, 't109-template', 'Claude Code (mock)', 30_000)
    await shot(page, 's1-template-1280.png')
    await expect(page.getByTestId('view-toggle')).toBeVisible({ timeout: 10_000 })
    await page.getByTestId('view-toggle-chat').click()
    await send(page, 'hello template')
    await waitForBufferText(page, 't109-template', 'ANSWER[1]: hello template', 10_000)
    await expect(chat(page).locator('[data-testid="chat-answer"]', { hasText: 'Echo: hello template' })).toBeVisible({ timeout: 15_000 })
    await shot(page, 's1-chat-1280.png')
})
