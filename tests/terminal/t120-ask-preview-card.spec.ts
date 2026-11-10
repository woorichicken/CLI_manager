import { test, expect, type Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { closeApp, launchAppWithWorkspaces, LaunchResult, REPO_ROOT, resizeMainWindow, waitForBufferText } from './helpers'

/**
 * T120 — fb-1110 4f10a0fc in the app: Claude Code 2.1.322's AskUserQuestion with option previews, as a card.
 * The session's terminal shows a copy of the real screen (fixtures/prompts/claude-2.1.322-ask-preview-*.txt,
 * neutral words in the reported layout: two questions under tabs, a question wrapped behind «│» that ends in
 * «.)», a preview box to the right of the options). The card must name that question — not the key hint —
 * and the options without the box. T120_SHOTS=<dir> + T120_LABEL saves the card before the checks.
 */

const PROMPTS = path.join(REPO_ROOT, 'tests/terminal/fixtures/prompts')
const SHOW = path.join(REPO_ROOT, 'tests/terminal/fixtures/show-screen.cjs')
const TRANSCRIPTS = path.join(REPO_ROOT, 'tests/terminal/fixtures/transcripts')
const SESSION = 't120-claude'
const CONVERSATION = '00000000-0000-4000-8000-0000000c1200'
const slug = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, '-')
const chat = (page: Page) => page.locator(`[data-testid="chat-view"][data-session-id]:visible`)

let result: LaunchResult | null = null
test.afterEach(async () => {
    if (result) await closeApp(result).catch(() => result?.app.process().kill('SIGKILL'))
    result = null
})

async function shot(page: Page, name: string): Promise<void> {
    const dir = process.env.T120_SHOTS
    if (!dir) return
    fs.mkdirSync(dir, { recursive: true })
    await page.waitForTimeout(500)
    await page.screenshot({ path: path.join(dir, `${name}-${process.env.T120_LABEL ?? 'run'}.png`) })
}

for (const [fixture, question, labels] of [
    [
        'claude-2.1.322-ask-preview-q1.txt',
        "주말 장보기 목록을 다시 확인했습니다. 마감은 토요일 10:00이고, 예산은 지난주와 같습니다. 새로 확인한 것: 냉장고 칸은 두 칸이 비었고, 손님은 네 명이 오며, 메모에는 '간단하지만 따뜻한 음식'을 원한다고 적혀 있습니다. 어떤 요리를 중심으로 장을 볼까요? (날씨가 추워서 국물 요리를 추천합니다.)",
        ['A. 김치찌개와 계란말이 (추천)', 'B. 샐러드와 파스타', 'C. 떡볶이와 순대 포장']
    ],
    [
        'claude-2.1.322-ask-preview-q2.txt',
        "장보기는 마트에서만 해도 되지만, 시장에 들러 채소를 따로 사면 '신선도'와 '비용'을 함께 챙길 수 있습니다. 이 방향으로 갈까요? (지난주 메모: 시장은 토요일 오후에 붐비므로, 오전에 다녀오는 쪽을 권했습니다.)",
        // «Type something.» is the card's own answer box, not a row
        ['마트 + 시장 (추천)', '마트만', '온라인 주문', 'Chat about this']
    ]
] as const) {
    test(`T120 the question card of a 2.1.322 AskUserQuestion — ${fixture}`, async () => {
        test.setTimeout(120_000)
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'climanager-t120-'))
        const project = path.join(home, 'project')
        fs.mkdirSync(project)
        const claudeDir = path.join(home, 'claude')
        const transcript = path.join(claudeDir, 'projects', slug(project), `${CONVERSATION}.jsonl`)
        fs.mkdirSync(path.dirname(transcript), { recursive: true })
        fs.copyFileSync(path.join(TRANSCRIPTS, 'claude/tools.jsonl'), transcript)
        // the real screen, then nothing more: Claude prints nothing while a question waits (captured)
        const screen = path.join(home, 'screen.txt')
        fs.writeFileSync(screen, fs.readFileSync(path.join(PROMPTS, fixture), 'utf8').replace(/\s+$/, ''))
        // an executable named «claude» (the app resumes a command it recognizes as Claude's): it shows the screen
        const bin = path.join(home, 'bin')
        fs.mkdirSync(bin)
        const claude = path.join(bin, 'claude')
        fs.writeFileSync(claude, `#!/bin/sh\nexec node '${SHOW}' '${screen}'\n`, { mode: 0o755 })
        result = await launchAppWithWorkspaces(
            [{ id: 'w-t120', name: 'T120 project', path: project, sessions: [{ id: SESSION, name: 'T120 Claude', cliSessionId: CONVERSATION, cliToolName: 'claude', cliCommand: `'${claude}'` }] }],
            { env: { CLAUDE_CONFIG_DIR: claudeDir } }
        )
        const { app, page } = result
        // wide enough for the copied 115-column screen: a narrower terminal folds its rows where Claude would not
        await resizeMainWindow(app, 1800, 1000)
        await page.getByText('T120 Claude', { exact: true }).first().click()
        await waitForBufferText(page, SESSION, 'Enter to select', 20_000)
        await page.getByTestId('view-toggle-chat').click()
        const card = chat(page).getByTestId('chat-prompt-card')
        await expect(card).toBeVisible({ timeout: 15_000 })
        await shot(page, fixture.replace('.txt', ''))
        await expect(card.getByTestId('chat-prompt-question')).toHaveText(question)
        await expect(card.getByTestId('chat-prompt-option')).toHaveCount(labels.length)
        const shown = await card.getByTestId('chat-prompt-option').allTextContents()
        for (const [index, label] of labels.entries()) expect(shown[index]).toContain(label)
        for (const text of shown) expect(text, 'no preview box in an option').not.toMatch(/[─┌│└]{2,}|├─/)
    })
}
