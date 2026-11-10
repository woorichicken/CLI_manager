import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { closeApp, launchAppWithWorkspaces, LaunchResult, REPO_ROOT, resizeMainWindow, waitForBufferText } from './helpers'

/**
 * T115 — the dictation log in the app (people's decision 11-09, decision 0012), with T107's fake helper.
 *
 *  - Settings › Terminal › Chat view: "Keep dictation log" (off) and "Also keep audio" (off, only with the log)
 *  - on: dictate across a pause → fix the words → send. userData/dictation-log/<day>.jsonl holds one line:
 *    the whole run heard (final) next to the box as sent, agent, locale; folder 0700, file 0600
 *  - off (the default): the same run leaves no folder at all
 *  - audio on: a WAV next to it (0600) named in the line; "Open log folder" hands that folder to Finder
 *    (main's shell.openPath is replaced — nothing opens); "Delete all" asks once, then the folder is gone
 *  - Esc keeps a `cancelled` line; emptying the box keeps `edited-away`
 *
 * No microphone, no Finder, no macOS prompt. T115_SHOTS + T115_LABEL save captures of the settings.
 */

const SESSION = 't115-session'
const MOCK = path.join(REPO_ROOT, 'scripts/mock-cli/chat-mock.cjs')
const FAKE = path.join(__dirname, 'fixtures/fake-dictation.cjs')
const LABEL = process.env.T115_LABEL ?? 'run'
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'
/** fake-dictation's words in `pause` mode: the result restarts after the second word */
const HEARD = '안녕하세요 받아쓰기 시험입니다'

let result: LaunchResult | null = null
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
    const dir = process.env.T115_SHOTS
    if (!dir) return
    fs.mkdirSync(dir, { recursive: true })
    await page.waitForTimeout(300)
    await page.screenshot({ path: path.join(dir, `${name}-${LABEL}.png`) })
}

async function launch(chat: Record<string, unknown> = {}): Promise<{ app: ElectronApplication; page: Page; logDir: string }> {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'climanager-t115-'))
    const project = path.join(home, 'project')
    fs.mkdirSync(project, { recursive: true })
    const claudeDir = path.join(home, 'claude')
    const transcript = path.join(claudeDir, 'projects', 'x', '00000000-0000-4000-8000-000000011500.jsonl')
    fs.mkdirSync(path.dirname(transcript), { recursive: true })
    fs.writeFileSync(transcript, '')
    result = await launchAppWithWorkspaces(
        [{
            id: 'w-t115',
            name: 'T115 project',
            path: project,
            sessions: [{ id: SESSION, name: 'T115 Session', cliSessionId: '00000000-0000-4000-8000-000000011500', cliToolName: 'claude', cliCommand: `node ${MOCK} --transcript ${transcript} --work-ms 300` }]
        }],
        { env: { CLAUDE_CONFIG_DIR: claudeDir, CLIMANAGER_DICTATION_HELPER: FAKE, FAKE_DICTATION_MODE: 'pause' }, settings: Object.keys(chat).length ? { chat } : {} }
    )
    const { app, page } = result
    await resizeMainWindow(app, 1280, 800)
    await waitForBufferText(page, SESSION, 'Claude Code (mock)', 20_000)
    return { app, page, logDir: path.join(result.userDataDir, 'dictation-log') }
}

const chatView = (page: Page) => page.locator('[data-testid="chat-view"][data-session-id]:visible')
const terminalLines = (page: Page): Promise<string> =>
    page.evaluate((sessionId) => window.api.feedbackTerminalContext(sessionId).then((c) => (c.terminal?.recentLines ?? []).join('\n')), SESSION)
const mode = (file: string): number => fs.statSync(file).mode & 0o777

interface Line {
    finalText: string
    sentText: string | null
    outcome: string
    agent: string | null
    locale: string
    partialCount: number
    audioFile: string | null
}
const readLines = (logDir: string): Line[] =>
    fs.existsSync(logDir)
        ? fs
              .readdirSync(logDir)
              .filter((name) => name.endsWith('.jsonl'))
              .flatMap((name) => fs.readFileSync(path.join(logDir, name), 'utf8').trim().split('\n'))
              .filter(Boolean)
              .map((line) => JSON.parse(line) as Line)
        : []

async function openChat(page: Page): Promise<void> {
    await page.getByText('T115 Session', { exact: true }).first().click()
    await page.waitForTimeout(400)
    const toggle = page.getByTestId('view-toggle-chat')
    if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click()
    await expect(chatView(page).getByTestId('chat-composer')).toBeVisible({ timeout: 15_000 })
}

/** Dictates the fake's words (across its pause), stops with Enter, fixes them, sends. */
async function dictateFixAndSend(page: Page, answer: number): Promise<string> {
    const composer = chatView(page).getByTestId('chat-composer')
    const mic = chatView(page).getByTestId('chat-dictation')
    await expect(mic).toBeVisible({ timeout: 10_000 })
    await mic.click()
    await expect(mic).toHaveAttribute('data-state', 'listening', { timeout: 10_000 })
    // the words before the pause stay in the box (BRIEF-add1)
    await expect(composer).toHaveValue(HEARD, { timeout: 10_000 })
    await composer.press('Enter')
    await expect(mic).toHaveAttribute('data-state', 'idle', { timeout: 10_000 })
    await expect(composer).toHaveValue(`${HEARD}.`)
    // the person fixes a word before sending
    const sent = '안녕하세요 받아 쓰기 시험입니다. 고쳐 보냄'
    await composer.fill(sent)
    await composer.press('Enter')
    await expect.poll(() => terminalLines(page), { timeout: 15_000 }).toContain(`ANSWER[${answer}]: ${sent}`)
    return sent
}

async function openChatSettings(page: Page): Promise<void> {
    await page.keyboard.press(`${MOD}+Comma`)
    await page.getByTestId('settings-category-terminal').click()
    await page.getByTestId('chat-view-settings').scrollIntoViewIfNeeded()
}

test('T115 on from Settings: one line — the whole run heard next to the message as sent', async () => {
    test.setTimeout(180_000)
    const { page, logDir } = await launch()
    await openChatSettings(page)
    const logSwitch = page.getByTestId('chat-setting-dictation-log')
    const audioSwitch = page.getByTestId('chat-setting-dictation-audio')
    await expect(logSwitch).toHaveAttribute('aria-pressed', 'false')
    // sound needs the log first
    await expect(audioSwitch).toBeDisabled()
    await shot(page, 't115-1-settings-off')
    await logSwitch.click()
    await expect(audioSwitch).toBeEnabled()
    await expect(audioSwitch).toHaveAttribute('aria-pressed', 'false')
    await shot(page, 't115-2-settings-on')
    await page.getByRole('button', { name: 'Save', exact: true }).click()

    await openChat(page)
    const sent = await dictateFixAndSend(page, 1)
    await expect.poll(() => readLines(logDir).length, { timeout: 10_000 }).toBe(1)
    const [line] = readLines(logDir)
    expect(line).toMatchObject({ finalText: `${HEARD}.`, sentText: sent, outcome: 'sent', agent: 'claude', locale: 'ko_KR', partialCount: 3, audioFile: null })
    expect(mode(logDir)).toBe(0o700)
    const day = fs.readdirSync(logDir).find((name) => name.endsWith('.jsonl')) as string
    expect(day).toMatch(/^\d{4}-\d{2}-\d{2}\.jsonl$/)
    expect(mode(path.join(logDir, day))).toBe(0o600)
    expect(fs.existsSync(path.join(logDir, 'audio'))).toBe(false)

    // Esc keeps a cancelled line; dictating then emptying the box keeps edited-away
    const composer = chatView(page).getByTestId('chat-composer')
    const mic = chatView(page).getByTestId('chat-dictation')
    await mic.click()
    await expect(composer).toHaveValue(/안녕하세요/, { timeout: 10_000 })
    await composer.press('Escape')
    await expect(mic).toHaveAttribute('data-state', 'idle', { timeout: 10_000 })
    await mic.click()
    await expect(composer).toHaveValue(HEARD, { timeout: 10_000 })
    await composer.press('Enter')
    await expect(composer).toHaveValue(`${HEARD}.`, { timeout: 10_000 })
    await composer.fill('')
    await expect.poll(() => readLines(logDir).map((entry) => entry.outcome), { timeout: 10_000 }).toEqual(['sent', 'cancelled', 'edited-away'])
    expect(readLines(logDir)[2]).toMatchObject({ finalText: `${HEARD}.`, sentText: null })
})

test('T115 off (the default): the same run leaves no folder', async () => {
    test.setTimeout(180_000)
    const { page, logDir } = await launch()
    await openChat(page)
    await dictateFixAndSend(page, 1)
    await page.waitForTimeout(800)
    expect(fs.existsSync(logDir)).toBe(false)
})

test('T115 audio on: a WAV next to the line; Open log folder; Delete all asks once', async () => {
    test.setTimeout(180_000)
    const { app, page, logDir } = await launch({ dictationLog: true, dictationLogAudio: true })
    await app.evaluate(({ shell }) => {
        const opened: string[] = []
        ;(globalThis as unknown as { __opened: string[] }).__opened = opened
        shell.openPath = async (target: string) => {
            opened.push(target)
            return ''
        }
    })
    await openChat(page)
    await dictateFixAndSend(page, 1)
    await expect.poll(() => readLines(logDir).length, { timeout: 10_000 }).toBe(1)
    const [line] = readLines(logDir)
    expect(line.audioFile).toMatch(/^audio\/[0-9a-f-]{36}\.wav$/)
    const wav = path.join(logDir, line.audioFile as string)
    const bytes = fs.readFileSync(wav)
    expect(bytes.subarray(0, 4).toString()).toBe('RIFF')
    expect(bytes.subarray(8, 12).toString()).toBe('WAVE')
    expect(mode(wav)).toBe(0o600)
    expect(mode(path.join(logDir, 'audio'))).toBe(0o700)

    await openChatSettings(page)
    await expect(page.getByTestId('chat-setting-dictation-audio')).toHaveAttribute('aria-pressed', 'true')
    await page.getByTestId('chat-setting-dictation-open').click()
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened)).toEqual([logDir])

    const remove = page.getByTestId('chat-setting-dictation-delete')
    await remove.click()
    await expect(remove).toHaveAttribute('data-state', 'confirm')
    await shot(page, 't115-3-delete-confirm')
    // the first click only asks
    expect(fs.existsSync(logDir)).toBe(true)
    await remove.click()
    await expect.poll(() => fs.existsSync(logDir), { timeout: 10_000 }).toBe(false)
    await expect(page.getByTestId('chat-setting-dictation-note')).toContainText('Deleted')
    // nothing kept now: the folder button says so instead of opening Finder
    await page.getByTestId('chat-setting-dictation-open').click()
    await expect(page.getByTestId('chat-setting-dictation-note')).toContainText('Nothing kept yet')
    expect(await app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened)).toEqual([logDir])
})
