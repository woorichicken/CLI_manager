import { test, expect, type Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { closeApp, launchAppWithWorkspaces, LaunchResult, REPO_ROOT, resizeMainWindow, waitForBufferText } from './helpers'

/**
 * T122 — fb-1110 a0ba98c4 in the app: under Claude's answer the chat shows the turn-end line («Took 29s ·
 * done …», record `turn_duration`) and the idle recap («※ recap …», record `away_summary`), and the
 * composer row counts what runs in the background («1 shell · 1 agent», the row under Claude's input box).
 * The terminal shows a copied Claude screen (an executable named «claude», as T120). T122_SHOTS=<dir> +
 * T122_LABEL saves the chat before the checks.
 */

const SHOW = path.join(REPO_ROOT, 'tests/terminal/fixtures/show-screen.cjs')
const SESSION = 't122-claude'
const CONVERSATION = '00000000-0000-4000-8000-0000000c1220'
const RECAP = 'Codex 팀장 세션이 동화를 쓰고 있고, 저는 그 세션을 지켜보고 있습니다. 다음 질문이 오면 답하겠습니다.'
const slug = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, '-')
const chat = (page: Page) => page.locator(`[data-testid="chat-view"][data-session-id]:visible`)

let result: LaunchResult | null = null
test.afterEach(async () => {
    if (result) await closeApp(result).catch(() => result?.app.process().kill('SIGKILL'))
    result = null
})

function transcript(file: string, cwd: string): void {
    let counter = 0
    let parent: string | null = null
    const record = (fields: Record<string, unknown>): string => {
        const uuid = `22000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`
        const line = JSON.stringify({ uuid, parentUuid: parent, timestamp: new Date(Date.now() - 60_000 + counter * 1000).toISOString(), sessionId: 's', cwd, ...fields })
        parent = uuid
        return line
    }
    const usage = { input_tokens: 1, output_tokens: 1 }
    const answer = ['Codex 세션이 세 번째 질문을 올렸고, 제가 판단해서 답했습니다.', '', '| 질문 | 제 답 |', '|---|---|', '| 심사평을 못 읽는다 | 공고 문구로 임시 기준을 잡고 계속합니다 |', '', '감시는 다시 걸어 두었습니다.'].join('\n')
    const lines = [
        record({ type: 'user', message: { role: 'user', content: '진행 상황 알려줘' } }),
        record({ type: 'assistant', message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: answer }], stop_reason: 'end_turn', usage } }),
        record({ type: 'system', subtype: 'stop_hook_summary', hookCount: 1, hookInfos: [], hookErrors: [], preventedContinuation: false, level: 'suggestion' }),
        record({ type: 'system', subtype: 'turn_duration', durationMs: 29_000, messageCount: 3, isMeta: false }),
        record({ type: 'system', subtype: 'away_summary', content: RECAP, isMeta: false })
    ]
    fs.writeFileSync(file, `${lines.join('\n')}\n`)
}

test('T122 the turn-end line, the recap and the background count show in the chat', async () => {
    test.setTimeout(120_000)
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'climanager-t122-'))
    const project = path.join(home, 'project')
    fs.mkdirSync(project)
    const claudeDir = path.join(home, 'claude')
    const file = path.join(claudeDir, 'projects', slug(project), `${CONVERSATION}.jsonl`)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    transcript(file, project)
    const rule = '─'.repeat(90)
    const screen = path.join(home, 'screen.txt')
    fs.writeFileSync(screen, ['⏺ 감시는 다시 걸어 두었습니다.', '', '✻ Crunched for 29s · done 2:14 PM · 1 shell still running', '', rule, '❯ ', rule, '  ~/project | branch:main | Opus', '  ⏵⏵ bypass permissions on · 1 shell · ← 1 agent'].join('\n'))
    const bin = path.join(home, 'bin')
    fs.mkdirSync(bin)
    const claude = path.join(bin, 'claude')
    fs.writeFileSync(claude, `#!/bin/sh\nexec node '${SHOW}' '${screen}'\n`, { mode: 0o755 })
    result = await launchAppWithWorkspaces(
        [{ id: 'w-t122', name: 'T122 project', path: project, sessions: [{ id: SESSION, name: 'T122 Claude', cliSessionId: CONVERSATION, cliToolName: 'claude', cliCommand: `'${claude}'` }] }],
        { env: { CLAUDE_CONFIG_DIR: claudeDir } }
    )
    const { app, page } = result
    await resizeMainWindow(app, 1280, 800)
    await page.getByText('T122 Claude', { exact: true }).first().click()
    await waitForBufferText(page, SESSION, 'bypass permissions on', 20_000)
    await page.getByTestId('view-toggle-chat').click()
    const view = chat(page)
    await expect(view.getByTestId('chat-answer').first()).toContainText('세 번째 질문', { timeout: 15_000 })
    if (process.env.T122_SHOTS) {
        fs.mkdirSync(process.env.T122_SHOTS, { recursive: true })
        await page.waitForTimeout(800)
        await page.screenshot({ path: path.join(process.env.T122_SHOTS, `a0ba-chat-${process.env.T122_LABEL ?? 'run'}.png`) })
    }
    // the time follows the Mac's region (as every time in the chat): the expected words are made in the
    // app's own window the way ChatTurn's clockTime makes them, from the record's timestamp — «2:14 PM»
    // in English, «오후 2:14» in Korean (v1.32 preflight ran with ko_KR and failed on a hand-written pattern)
    const doneAt = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)).find((entry) => entry.subtype === 'turn_duration').timestamp as string
    const doneTime = await page.evaluate((ts) => {
        const date = new Date(ts)
        const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
        return date.toDateString() === new Date().toDateString() ? time : `${date.toLocaleDateString([], { month: 'numeric', day: 'numeric' })} ${time}`
    }, doneAt)
    await expect(view.getByTestId('chat-turn-done')).toHaveText(`Took 29s · done ${doneTime}`)
    await expect(view.getByTestId('chat-recap')).toHaveText(`※ recap ${RECAP}`)
    await expect(view.getByTestId('chat-background-chip')).toHaveText('1 shell · 1 agent')
    // the table in the answer is a table, as before
    await expect(view.locator('.chat-md table td').first()).toHaveText('심사평을 못 읽는다')
})
