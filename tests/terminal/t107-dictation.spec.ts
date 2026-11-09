import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { closeApp, launchAppWithWorkspaces, LaunchResult, REPO_ROOT, resizeMainWindow, waitForBufferText } from './helpers'

/**
 * T107 — Chat dictation in the app (people's decision 11-08: Orca-style — it types, the person sends).
 *
 *  - the mic beside ＋ in a Claude session's Chat; click → listening (box read-only), the words grow at
 *    the cursor, Enter stops — the words stay and nothing reaches the agent; a second Enter sends them
 *  - Esc while listening takes this run's words back out; the text from before stays (people's decision 11-09)
 *  - ⌘⇧D starts and stops it from the box; in Terminal view the key does nothing
 *  - moving to another session while listening ends that run; its words never land in the other box
 *  - a refused run (microphone off) says why in the note; a Mac that cannot do it on the device has no mic
 *
 * The helper is tests/terminal/fixtures/fake-dictation.cjs (CLIMANAGER_DICTATION_HELPER): the real one
 * would ask macOS for permission and listen to a microphone. T107_SHOTS + T107_LABEL save captures.
 */

const FIRST = 't107-first'
const SECOND = 't107-second'
const MOCK = path.join(REPO_ROOT, 'scripts/mock-cli/chat-mock.cjs')
const FAKE = path.join(__dirname, 'fixtures/fake-dictation.cjs')
const LABEL = process.env.T107_LABEL ?? 'run'
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'
const HEARD = '안녕하세요 받아쓰기 시험입니다'

let result: LaunchResult | null = null
let callLog = ''
test.afterEach(async () => {
    if (result) {
        const done = result
        const closed = await Promise.race([closeApp(done).then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 20_000))])
        if (!closed) {
            done.app.process().kill('SIGKILL')
            fs.rmSync(done.userDataDir, { recursive: true, force: true })
        }
    }
    result = null
})

async function shot(page: Page, name: string): Promise<void> {
    const dir = process.env.T107_SHOTS
    if (!dir) return
    fs.mkdirSync(dir, { recursive: true })
    await page.waitForTimeout(300)
    await page.screenshot({ path: path.join(dir, `${name}-${LABEL}.png`) })
}

async function launch(mode = 'ok'): Promise<{ app: ElectronApplication; page: Page }> {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'climanager-t107-'))
    const project = path.join(home, 'project')
    fs.mkdirSync(project, { recursive: true })
    const claudeDir = path.join(home, 'claude')
    const transcripts = [FIRST, SECOND].map((_, index) => {
        const file = path.join(claudeDir, 'projects', 'x', `00000000-0000-4000-8000-0000000107a${index}.jsonl`)
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, '')
        return file
    })
    callLog = path.join(home, 'dictation-calls.log')
    result = await launchAppWithWorkspaces(
        [{
            id: 'w-t107',
            name: 'T107 project',
            path: project,
            sessions: [
                { id: FIRST, name: 'T107 First', cliSessionId: '00000000-0000-4000-8000-0000000107a0', cliToolName: 'claude', cliCommand: `node ${MOCK} --transcript ${transcripts[0]} --work-ms 300` },
                { id: SECOND, name: 'T107 Second', cliSessionId: '00000000-0000-4000-8000-0000000107a1', cliToolName: 'claude', cliCommand: `node ${MOCK} --transcript ${transcripts[1]} --work-ms 300` }
            ]
        }],
        { env: { CLAUDE_CONFIG_DIR: claudeDir, CLIMANAGER_DICTATION_HELPER: FAKE, FAKE_DICTATION_MODE: mode, FAKE_DICTATION_LOG: callLog } }
    )
    const { app, page } = result
    await resizeMainWindow(app, 1280, 800)
    await waitForBufferText(page, FIRST, 'Claude Code (mock)', 20_000)
    return { app, page }
}

const calls = (): string[] => (fs.existsSync(callLog) ? fs.readFileSync(callLog, 'utf8').trim().split('\n') : [])
const terminalLines = (page: Page, id: string): Promise<string> =>
    page.evaluate((sessionId) => window.api.feedbackTerminalContext(sessionId).then((c) => (c.terminal?.recentLines ?? []).join('\n')), id)
const chat = (page: Page) => page.locator('[data-testid="chat-view"][data-session-id]:visible')

async function openChat(page: Page, name: string): Promise<void> {
    await page.getByText(name, { exact: true }).first().click()
    await page.waitForTimeout(400)
    const toggle = page.getByTestId('view-toggle-chat')
    if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click()
    await expect(chat(page).getByTestId('chat-composer')).toBeVisible({ timeout: 15_000 })
}

test('T107 the mic types at the cursor, Enter stops it without sending, the next Enter sends', async () => {
    test.setTimeout(180_000)
    const { page } = await launch()
    await openChat(page, 'T107 First')
    const composer = chat(page).getByTestId('chat-composer')
    const mic = chat(page).getByTestId('chat-dictation')
    await expect(mic).toBeVisible({ timeout: 10_000 })
    await expect(mic).toHaveAttribute('title', /⌘⇧D|Ctrl\+Shift\+D/)
    await shot(page, 't107-1-idle')

    await composer.fill('이 문장 뒤에')
    await mic.click()
    await expect(mic).toHaveAttribute('data-state', 'listening', { timeout: 10_000 })
    await expect(composer).toHaveAttribute('readonly', '')
    await expect(composer).toHaveValue(`이 문장 뒤에 ${HEARD}`, { timeout: 10_000 })
    await shot(page, 't107-2-listening')

    await composer.press('Enter')
    await expect(mic).toHaveAttribute('data-state', 'idle', { timeout: 10_000 })
    await expect(composer).toHaveValue(`이 문장 뒤에 ${HEARD}.`)
    await expect(composer).not.toHaveAttribute('readonly', '')
    expect(calls()).toEqual(['status', 'listen', 'stop', 'end'])
    // dictation only types: the agent got nothing
    expect(await terminalLines(page, FIRST)).not.toContain('ANSWER[')
    await shot(page, 't107-3-stopped')

    await composer.press('Enter')
    await expect.poll(() => terminalLines(page, FIRST), { timeout: 15_000 }).toContain(`ANSWER[1]: 이 문장 뒤에 ${HEARD}.`)
})

test('T107 Esc while listening takes the words back out; the text from before stays', async () => {
    test.setTimeout(180_000)
    const { page } = await launch()
    await openChat(page, 'T107 First')
    const composer = chat(page).getByTestId('chat-composer')
    const mic = chat(page).getByTestId('chat-dictation')
    await expect(mic).toBeVisible({ timeout: 10_000 })
    await composer.fill('먼저 쓴 글')
    await mic.click()
    // the words show as they are heard
    await expect(composer).toHaveValue(/^먼저 쓴 글 안녕하세요/, { timeout: 10_000 })
    await composer.press('Escape')
    await expect(mic).toHaveAttribute('data-state', 'idle', { timeout: 10_000 })
    await expect(composer).toHaveValue('먼저 쓴 글')
    await expect.poll(calls, { timeout: 10_000 }).toContain('killed')
    // nothing late from that run lands in the box
    await page.waitForTimeout(800)
    await expect(composer).toHaveValue('먼저 쓴 글')
    expect(await terminalLines(page, FIRST)).not.toContain('ANSWER[')
})

test('T107 ⌘⇧D starts and stops it from the box; in Terminal view the key does nothing', async () => {
    test.setTimeout(180_000)
    const { page } = await launch()
    await openChat(page, 'T107 First')
    const composer = chat(page).getByTestId('chat-composer')
    const mic = chat(page).getByTestId('chat-dictation')
    await expect(mic).toBeVisible({ timeout: 10_000 })
    await composer.click()
    await page.keyboard.press(`${MOD}+Shift+KeyD`)
    await expect(mic).toHaveAttribute('data-state', 'listening', { timeout: 10_000 })
    await expect(composer).toHaveValue(HEARD, { timeout: 10_000 })
    await page.keyboard.press(`${MOD}+Shift+KeyD`)
    await expect(mic).toHaveAttribute('data-state', 'idle', { timeout: 10_000 })
    await expect(composer).toHaveValue(`${HEARD}.`)

    await page.getByTestId('view-toggle-terminal').click()
    await page.waitForTimeout(300)
    const before = calls().filter((line) => line === 'listen').length
    await page.keyboard.press(`${MOD}+Shift+KeyD`)
    await page.waitForTimeout(800)
    expect(calls().filter((line) => line === 'listen').length).toBe(before)
})

test('T107 another session while listening ends that run; its words stay out of the other box', async () => {
    test.setTimeout(180_000)
    const { page } = await launch()
    await openChat(page, 'T107 First')
    const mic = chat(page).getByTestId('chat-dictation')
    await expect(mic).toBeVisible({ timeout: 10_000 })
    await mic.click()
    await expect(mic).toHaveAttribute('data-state', 'listening', { timeout: 10_000 })
    await openChat(page, 'T107 Second')
    await expect.poll(calls, { timeout: 10_000 }).toContain('killed')
    const second = chat(page).getByTestId('chat-composer')
    await page.waitForTimeout(800)
    await expect(second).toHaveValue('')
    await expect(chat(page).getByTestId('chat-dictation')).toHaveAttribute('data-state', 'idle')
})

test('T107 a refused run says why; nothing lands in the box', async () => {
    test.setTimeout(180_000)
    const { page } = await launch('mic_denied')
    await openChat(page, 'T107 First')
    const composer = chat(page).getByTestId('chat-composer')
    const mic = chat(page).getByTestId('chat-dictation')
    await expect(mic).toBeVisible({ timeout: 10_000 })
    await composer.fill('keep me')
    await mic.click()
    await expect(chat(page).getByTestId('chat-composer-note')).toContainText('microphone is off', { timeout: 10_000 })
    await expect(mic).toHaveAttribute('data-state', 'idle')
    await expect(composer).toHaveValue('keep me')
    await shot(page, 't107-4-denied')
})

test('T107 a Mac that cannot recognize on the device shows no mic', async () => {
    test.setTimeout(180_000)
    const { page } = await launch('unsupported')
    await openChat(page, 'T107 First')
    await expect(chat(page).getByTestId('chat-attach')).toBeVisible()
    await page.waitForTimeout(1000)
    await expect(chat(page).getByTestId('chat-dictation')).toHaveCount(0)
})
