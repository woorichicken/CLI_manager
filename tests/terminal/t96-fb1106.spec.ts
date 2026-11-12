import { test, expect, type CDPSession, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { closeApp, launchAppWithWorkspaces, type LaunchResult, REPO_ROOT, resizeMainWindow, waitForBufferText } from './helpers'
import { commandPieces, foldUserMessage, mayNameCommand } from '../../src/renderer/src/components/ChatView/chatLib'
import { checklistForAgent } from '../../src/renderer/src/utils/checklistForAgent'
import { screenAgentMode } from '../../src/main/screenLines'
import { foldMetadata } from '../../src/main/transcript/metadata'
import type { ChatCommand } from '../../src/shared/conversation'

/**
 * T96 — fb-1106: small settings and the feedback round, against the real app.
 *
 *  Mac Chat: e833d0b9 · 1fcd9008 · 85259f8e only the skill reads blue, wherever it stands · bcbbbec5 a long
 *  message folds to «+N lines» · 5c35cff8 the mode · edf2aef3 my last message stays on top (setting) ·
 *  0a17912b a path can open in the Mac's app instead of the preview (setting).
 *  Mac: 474b70f8 Below comes first in Related · ffbfb55e a checklist copies for an agent.
 *  Phone (CDP touch 390×844, scale 3): 183cbd1e the terminal sits at the bottom · the notices can be
 *  turned off, the dots stay · quick replies on by default when the Mac has phrases, also while working.
 *
 * T96_SHOTS=<dir> + T96_LABEL saves captures before the checks. T96_BEFORE=1 only takes the captures
 * (the old code has no such controls): the review's «before» column.
 */

const BEFORE = process.env.T96_BEFORE === '1'
const LABEL = process.env.T96_LABEL ?? 'run'
const MOCK = path.join(REPO_ROOT, 'scripts/mock-cli/chat-mock.cjs')
const CLAUDE = 't96-claude'
const CLAUDE_ID = '00000000-0000-4000-8000-00000000c96a'
const OTHER = 't96-other'
const OTHER_ID = '00000000-0000-4000-8000-00000000c96b'
const SCREEN = 't96-screen'
/** a full Claude-shaped screen at the terminal's size (the T77 fixture) */
const SCREEN_SCRIPT = path.join(__dirname, 'fixtures/phone-screen/claude-screen.cjs')
const OWNER = 'owner-t96@example.com'
const PORT = 47896
const PHRASES = ['컴팩트하게 진행하자', '좋아']
/** the bubble of the report (bcbbbec5): seven lines */
const LONG_MESSAGE = ['# /phone', 'Figma: (미설정)', '', '1. [기타] 코덱스를 보면 내가 마지막에 한 말을 위에 띄워주는데', '   · 상태: pending', '   · URL: https://desktop.climanager.solhun.com/phone?screen=session', '   · 스크린샷: 있음'].join('\n')

let result: LaunchResult | null = null
test.afterEach(async () => {
    if (!result) return
    const done = result
    result = null
    const closed = await Promise.race([closeApp(done).then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 20_000))])
    if (!closed) {
        done.app.process().kill('SIGKILL')
        fs.rmSync(done.userDataDir, { recursive: true, force: true })
    }
})

/** the checks; skipped when only taking the old code's captures */
async function check(run: () => Promise<void>): Promise<void> {
    if (!BEFORE) await run()
}

async function shot(page: Page, name: string): Promise<void> {
    const dir = process.env.T96_SHOTS
    if (!dir) return
    fs.mkdirSync(dir, { recursive: true })
    await page.waitForTimeout(400)
    await page.screenshot({ path: path.join(dir, `${name}-${LABEL}.png`) })
}

function seedTranscript(file: string): void {
    const entries: unknown[] = []
    let n = 0
    const ts = (): string => new Date(Date.UTC(2026, 10, 6, 1, 0, n++)).toISOString()
    const uuid = (): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
    const say = (role: 'user' | 'assistant', text: string): void => {
        entries.push({ type: role, uuid: uuid(), timestamp: ts(), ...(role === 'user' ? { permissionMode: 'bypassPermissions' } : {}), message: role === 'user' ? { role, content: text } : { role, model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text }] } })
    }
    say('user', LONG_MESSAGE)
    say('assistant', 'Read it. The file is `notes.md` — see notes.md.')
    say('user', '보고서는?')
    say('assistant', 'The page is `report.html` — its title is at `report.html:3`.')
    say('user', '이 표는 어디에서 왔나요?')
    say('assistant', Array.from({ length: 70 }, (_, i) => `The answer goes on, line ${i + 1}.\n`).join('\n'))
    fs.writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n')
}

interface Launched {
    app: ElectronApplication
    page: Page
    base: string
    project: string
}

async function launch(chat: Record<string, unknown> = {}, config: Record<string, unknown> = {}): Promise<Launched> {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'climanager-t96-'))
    const project = path.join(home, 'project')
    fs.mkdirSync(project, { recursive: true })
    fs.writeFileSync(path.join(project, 'notes.md'), '# Notes\n')
    fs.writeFileSync(path.join(project, 'report.html'), '<!doctype html>\n<html>\n<head><title>T96 report</title></head>\n<body><h1>Report</h1></body>\n</html>\n')
    const statusFile = path.join(home, 'tailscale-status.json')
    fs.writeFileSync(statusFile, JSON.stringify({ BackendState: 'Running', Self: { UserID: 42, DNSName: 'mac.tail1234.ts.net.', TailscaleIPs: ['100.100.1.1'] }, User: { '42': { LoginName: OWNER } } }))
    const claudeDir = path.join(home, 'claude')
    for (const name of ['progress-report', 'eli5']) {
        fs.mkdirSync(path.join(claudeDir, 'skills', name), { recursive: true })
        fs.writeFileSync(path.join(claudeDir, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} skill\n---\n`)
    }
    const slug = project.replace(/[^a-zA-Z0-9]/g, '-')
    const transcript = path.join(claudeDir, 'projects', slug, `${CLAUDE_ID}.jsonl`)
    const otherTranscript = path.join(claudeDir, 'projects', slug, `${OTHER_ID}.jsonl`)
    fs.mkdirSync(path.dirname(transcript), { recursive: true })
    seedTranscript(transcript)
    fs.writeFileSync(otherTranscript, '')
    result = await launchAppWithWorkspaces(
        [{
            id: 'w-t96',
            name: 'T96 project',
            path: project,
            sessions: [
                { id: CLAUDE, name: 'T96 Claude', cliSessionId: CLAUDE_ID, cliToolName: 'claude', cliCommand: `node ${MOCK} --transcript ${transcript} --work-ms 6000 --continue --mode-row '⏵⏵ bypass permissions on (shift+tab to cycle)'` },
                { id: OTHER, name: 'T96 Other', cliSessionId: OTHER_ID, cliToolName: 'claude', cliCommand: `node ${MOCK} --transcript ${otherTranscript} --work-ms 300 --mode-row none` },
                { id: SCREEN, name: 'T96 Screen', initialCommand: `node '${SCREEN_SCRIPT}'` }
            ]
        }],
        {
            settings: { phone: { enabled: true, port: PORT }, chat: { quickReplies: PHRASES, ...chat } },
            config,
            env: { CLIMANAGER_PHONE_TAILSCALE_STATUS: statusFile, CLAUDE_CONFIG_DIR: claudeDir }
        }
    )
    const { app, page } = result
    await resizeMainWindow(app, 1280, 800)
    const state = await page.evaluate(() => window.api.getPhoneState())
    expect(state.running).toBe(true)
    await waitForBufferText(page, CLAUDE, 'Claude Code (mock)', 20_000)
    return { app, page, base: `http://127.0.0.1:${state.port}`, project }
}

const chat = (page: Page) => page.locator('[data-testid="chat-view"][data-session-id]:visible')

async function openMacChat(page: Page): Promise<void> {
    await page.getByText('T96 Claude', { exact: true }).first().click()
    await page.waitForTimeout(400)
    await page.getByTestId('view-toggle-chat').click()
    await expect(chat(page).getByTestId('chat-composer')).toBeVisible()
}

async function openPhone(app: ElectronApplication, url: string, partition: string): Promise<{ phone: Page; cdp: CDPSession }> {
    const opened = app.waitForEvent('window')
    await app.evaluate(({ BrowserWindow, session }, o) => {
        const jar = session.fromPartition(o.partition)
        jar.webRequest.onBeforeSendHeaders((details, callback) => {
            callback({ requestHeaders: { ...details.requestHeaders, 'Tailscale-User-Login': o.owner, 'X-Forwarded-For': '100.101.102.103' } })
        })
        const win = new BrowserWindow({ width: 390, height: 844, useContentSize: true, show: false, webPreferences: { partition: o.partition, backgroundThrottling: false } })
        void win.loadURL(o.url)
    }, { url, partition, owner: OWNER })
    const phone = await opened
    await phone.waitForLoadState('domcontentloaded')
    const cdp = await phone.context().newCDPSession(phone)
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true, screenOrientation: { type: 'portraitPrimary', angle: 0 } })
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
    await phone.reload()
    await phone.waitForLoadState('domcontentloaded')
    return { phone, cdp }
}

async function tap(cdp: CDPSession, page: Page, selector: string): Promise<void> {
    const box = await page.locator(selector).first().boundingBox()
    expect(box, selector).not.toBeNull()
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 }] })
    await page.waitForTimeout(60)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
}

async function tapScrim(cdp: CDPSession, page: Page): Promise<void> {
    const box = (await page.getByTestId('phone-scrim').boundingBox())!
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + box.width - 12, y: box.y + box.height / 2 }] })
    await page.waitForTimeout(60)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
}

test.describe('T96 units', () => {
    const skill = (name: string): ChatCommand => ({ name, description: '', source: 'skill' })
    const builtin = (name: string): ChatCommand => ({ name, description: '', source: 'builtin' })
    const codexSkill = (name: string): ChatCommand => ({ name, description: '', source: 'skill', trigger: '$' })
    const blue = (text: string, commands: ChatCommand[], codex = false): string[] => commandPieces(text, commands, codex).filter((p) => p.command).map((p) => p.text)

    test('commandPieces: only known commands, in the menu\'s own rule; the pieces add up to the text', () => {
        const commands = [skill('eli5'), skill('progress-report'), builtin('clear')]
        expect(blue('/progress-report + 현재 투두', commands)).toEqual(['/progress-report'])
        expect(blue('1.빌드\n2.제출, /eli5 로 설명', commands)).toEqual(['/eli5'])
        expect(blue('한마디로\n\n/progress-report', commands)).toEqual(['/progress-report'])
        expect(blue('/eli5 그리고 /progress-report', commands)).toEqual(['/eli5', '/progress-report'])
        expect(blue('  /clear', commands), 'a built-in opening the message').toEqual(['/clear'])
        expect(blue('먼저 /clear', commands), 'a built-in mid-message is words').toEqual([])
        expect(blue('line\n/clear', commands), 'or on a later line').toEqual([])
        expect(blue('/usr/bin src/eli5 /nothing /eli5로', commands)).toEqual([])
        expect(blue('$eli5 먼저', commands), 'Claude has no $ skills').toEqual([])
        expect(blue('먼저 $tidy', [codexSkill('tidy')], true)).toEqual(['$tidy'])
        expect(blue('먼저 /tidy', [skill('tidy')], true), 'mid-message Codex reads only $').toEqual([])
        const text = 'a /eli5 b\n/eli5'
        expect(commandPieces(text, commands, false).map((p) => p.text).join('')).toBe(text)
        expect(mayNameCommand('words only src/a')).toBe(false)
        expect(mayNameCommand('words /x')).toBe(true)
    })

    test('foldUserMessage: lines, one long paragraph, short', () => {
        expect(foldUserMessage('short\nmessage')).toBeNull()
        expect(foldUserMessage(['1', '2', '3', '4', '5', '6'].join('\n')), 'six lines still show').toBeNull()
        expect(foldUserMessage(['1', '2', '3', '4', '5', '6', '7'].join('\n'))).toEqual({ head: '1\n2\n3\n4', hiddenLines: 3 })
        const paragraph = 'word '.repeat(300).trim()
        const fold = foldUserMessage(paragraph)!
        expect(fold.hiddenLines).toBe(0)
        expect(fold.head.length).toBeLessThanOrEqual(400)
        expect(fold.head.endsWith('word')).toBe(true)
    })

    test('screenAgentMode: the row under the box, not the same words above it', () => {
        const box = ['─'.repeat(40), '❯ ', '─'.repeat(40)]
        expect(screenAgentMode([...box, '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ←1 agent'])).toBe('bypass')
        expect(screenAgentMode([...box, '  ~/x | main', '  ⏸ plan mode on (shift+tab to cycle)'])).toBe('plan')
        expect(screenAgentMode([...box, '  ⏵⏵ accept edits on'])).toBe('accept edits')
        expect(screenAgentMode([...box, '  ⏵⏵ auto mode on'])).toBe('auto')
        expect(screenAgentMode(['  ⏵⏵ bypass permissions on — I said', ...box, '  ? for shortcuts']), 'the conversation above').toBeNull()
        expect(screenAgentMode(['no box at all', '  ⏵⏵ bypass permissions on']), 'no box: not read').toBeNull()
    })

    test('the record names the mode: Claude\'s last prompt, Codex\'s turn_context', () => {
        const prompt = (mode: string, extra = {}): string => JSON.stringify({ type: 'user', permissionMode: mode, message: { role: 'user', content: 'x' }, ...extra })
        expect(foldMetadata(prompt('bypassPermissions'), 'claude', null)?.mode).toBe('bypass')
        expect(foldMetadata(`${prompt('plan')}\n${prompt('default')}`, 'claude', null)?.mode, 'the default says nothing').toBeNull()
        expect(foldMetadata(prompt('plan', { isSidechain: true }), 'claude', { model: 'm', effort: null, mode: 'auto' })?.mode, 'a subagent is not the session').toBe('auto')
        const turn = (payload: object): string => JSON.stringify({ type: 'turn_context', payload: { model: 'gpt', ...payload } })
        expect(foldMetadata(turn({ sandbox_policy: { type: 'workspace-write' }, collaboration_mode: { mode: 'default' } }), 'codex', null)?.mode).toBe('workspace write')
        expect(foldMetadata(turn({ sandbox_policy: { type: 'danger-full-access' } }), 'codex', null)?.mode).toBe('full access')
        expect(foldMetadata(turn({ sandbox_policy: { type: 'read-only' }, collaboration_mode: { mode: 'plan' } }), 'codex', null)?.mode).toBe('plan')
        expect(foldMetadata(turn({}), 'codex', null)?.mode).toBeUndefined()
    })

    test('checklistForAgent: items by number, how to check one off', () => {
        const text = checklistForAgent({ id: 'abc', title: '배포', due: '2026-11-07', workspaceId: 'w', createdAt: 1, updatedAt: 1, items: [{ id: 'i1', text: '빌드', doneAt: 5 }, { id: 'i2', text: '공개' }] } as never, 'CLImanger')
        expect(text.split('\n').slice(0, 5)).toEqual(['Checklist "배포" (id abc)', 'Project: CLImanger · Due: 2026-11-07', '', '1. [x] 빌드', '2. [ ] 공개'])
        expect(text).toContain('checklist_check (checklist: "abc"')
    })
})

/** what the box paints: the words of its blue spans */
const blueWords = (page: Page) => chat(page).getByTestId('chat-composer-token').allTextContents()

test('T96 Mac Chat: only the skill reads blue, at the start, in the middle, on a later line (e833d0b9 · 1fcd9008 · 85259f8e)', async () => {
    test.setTimeout(180_000)
    const { page } = await launch()
    await openMacChat(page)
    const box = chat(page).getByTestId('chat-composer')
    const typed = async (text: string): Promise<void> => {
        await box.fill(text)
        await box.press('Escape') // the `/` menu, when the caret sits on a skill
        await page.waitForTimeout(250)
    }

    await typed('/progress-report + 현재 투두가 뭐지?')
    await shot(page, 't96-skill-start-1280')
    await check(async () => {
        await expect.poll(() => blueWords(page)).toEqual(['/progress-report'])
        expect(await box.evaluate((el) => getComputedStyle(el).color), 'the words are painted underneath').toBe('rgba(0, 0, 0, 0)')
        expect(await chat(page).getByTestId('chat-composer-token').evaluate((el) => getComputedStyle(el).color)).toBe('rgb(147, 197, 253)')
    })

    await typed('1.빌드 이야기\n2.빌드 & 제출 관련해서, /eli5 로 한번 설명해줘')
    await shot(page, 't96-skill-middle-1280')
    await check(async () => expect.poll(() => blueWords(page)).toEqual(['/eli5']))

    await typed('한마디로 따로 써야한다는거네,\n\n/progress-report')
    await shot(page, 't96-skill-line-1280')
    await check(async () => {
        await expect.poll(() => blueWords(page)).toEqual(['/progress-report'])
        // Chrome's page translation must leave the painted copy alone: it does not touch the textarea's value
        expect(await chat(page).getByTestId('chat-composer-backdrop').getAttribute('translate')).toBe('no')
        // the painted words sit exactly under the box's: same height, same scroll
        const sizes = await box.evaluate((el) => {
            const under = el.parentElement!.querySelector<HTMLElement>('[data-testid="chat-composer-backdrop"]')!
            return { box: el.scrollHeight, under: under.scrollHeight }
        })
        expect(sizes.under).toBe(sizes.box)
    })

    // not skills: an unknown name, a path, a built-in mid-message; a built-in at the very start is one
    await typed('/usr/bin/env 그리고 /nothing 그리고 src/eli5 그리고 /clear')
    await check(async () => {
        await page.waitForTimeout(300)
        expect(await blueWords(page)).toEqual([])
        expect(await box.evaluate((el) => getComputedStyle(el).color)).not.toBe('rgba(0, 0, 0, 0)')
    })
    await typed('/clear')
    await check(async () => expect.poll(() => blueWords(page)).toEqual(['/clear']))

    // a long draft scrolls with its painted words
    await typed(`${Array.from({ length: 24 }, (_, i) => `line ${i}`).join('\n')}\n/eli5`)
    await check(async () => {
        await expect.poll(() => blueWords(page)).toEqual(['/eli5'])
        await box.evaluate((el) => {
            el.scrollTop = 120
            el.dispatchEvent(new Event('scroll', { bubbles: true }))
        })
        await expect.poll(() => box.evaluate((el) => el.parentElement!.querySelector<HTMLElement>('[data-testid="chat-composer-backdrop"]')!.scrollTop)).toBe(120)
    })
})

/**
 * Hangul being composed in a painted box. The words in the box are transparent and the copy underneath paints them, so a
 * syllable still being composed must reach that copy too, in the same place. CDP's composition goes through Chromium's
 * IME path (the input events say isComposing), but it is not a real keyboard: macOS's and Samsung's IMEs are not exercised.
 */
async function composeHangul(app: ElectronApplication, page: Page, cdp: CDPSession, root: Locator, name: string): Promise<void> {
    const box = root.getByTestId('chat-composer')
    const under = root.getByTestId('chat-composer-backdrop')
    const tokens = root.getByTestId('chat-composer-token')
    await box.evaluate((el) => {
        const seen = { composing: 0 }
        ;(window as unknown as { __t96Ime: typeof seen }).__t96Ime = seen
        el.addEventListener('input', (event) => {
            if ((event as InputEvent).isComposing) seen.composing++
        })
    })
    const syllables = ['ㅎ', '하', '한', '한ㄱ', '한그', '한글']
    const compose = async (start: string): Promise<void> => {
        for (const text of syllables) {
            await cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length })
            await expect.poll(() => box.inputValue()).toBe(start + text)
            await expect.poll(() => under.evaluate((el) => el.textContent)).toBe(start + text)
            await expect.poll(() => tokens.allTextContents()).toEqual(['/progress-report'])
        }
    }

    // one line
    await box.fill('/progress-report + ')
    await box.press('Escape')
    await compose('/progress-report + ')
    expect(await box.evaluate(() => (window as unknown as { __t96Ime: { composing: number } }).__t96Ime.composing), 'really composing, not plain input').toBeGreaterThanOrEqual(syllables.length)
    await cdp.send('Input.insertText', { text: '한글' })
    await expect.poll(() => under.evaluate((el) => el.textContent)).toBe('/progress-report + 한글')

    // several wrapped lines and a later line, the caret still at the end: same lines, same place
    const long = `/progress-report ${'가나다라마바사아자차카타파하 '.repeat(8)}\n둘째 줄 `
    await box.fill(long)
    await box.press('Escape')
    await compose(long)
    const sizes = await box.evaluate((el) => {
        const copy = el.parentElement!.querySelector<HTMLElement>('[data-testid="chat-composer-backdrop"]')!
        const of = (node: HTMLElement) => {
            const style = getComputedStyle(node)
            return { font: style.font, spacing: style.letterSpacing, padding: style.padding, inner: node.clientWidth, height: node.scrollHeight, top: node.scrollTop }
        }
        return { box: of(el as HTMLElement), copy: of(copy) }
    })
    expect(sizes.copy, 'the copy wraps and scrolls with the box').toEqual(sizes.box)
    expect(sizes.box.height, 'it did wrap').toBeGreaterThan(60)

    // the pixels: what the copy paints against what the box itself would paint, with the same words in both
    const clip = (await box.boundingBox())!
    const painted = await page.screenshot({ clip })
    await shot(page, `t96-ime-${name}`)
    await box.evaluate((el) => {
        const copy = el.parentElement!.querySelector<HTMLElement>('[data-testid="chat-composer-backdrop"]')!
        copy.style.visibility = 'hidden'
        el.style.color = getComputedStyle(copy).color
    })
    const own = await page.screenshot({ clip })
    await box.evaluate((el) => {
        el.parentElement!.querySelector<HTMLElement>('[data-testid="chat-composer-backdrop"]')!.style.visibility = ''
        el.style.color = ''
    })
    const ink = await app.evaluate(({ nativeImage }, shots) => {
        const decode = (b64: string) => {
            const image = nativeImage.createFromBuffer(Buffer.from(b64, 'base64'))
            const { width, height } = image.getSize()
            const data = image.toBitmap()
            const inked = (x: number, y: number): boolean => {
                const at = (y * width + x) * 4
                return Math.abs(data[at] - data[0]) + Math.abs(data[at + 1] - data[1]) + Math.abs(data[at + 2] - data[2]) > 180
            }
            return { width, height, inked }
        }
        const a = decode(shots.painted)
        const b = decode(shots.own)
        const differ = (shift: number): number => {
            let count = 0
            for (let y = 0; y < a.height; y++) for (let x = 0; x < a.width - shift; x++) if (a.inked(x, y) !== b.inked(x + shift, y)) count++
            return count
        }
        let total = 0
        for (let y = 0; y < a.height; y++) for (let x = 0; x < a.width; x++) if (b.inked(x, y)) total++
        return { total, same: differ(0), shifted: differ(2) }
    }, { painted: painted.toString('base64'), own: own.toString('base64') })
    console.log(`[T96 ime ${name}]`, JSON.stringify(ink))
    expect(ink.total, 'there are words in the shot').toBeGreaterThan(200)
    expect(ink.same, 'painted where the box would paint: far less off than the same words moved 2px').toBeLessThan(ink.shifted / 3)

    // cancelling takes the syllable out of both
    await cdp.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 })
    await expect.poll(() => box.inputValue()).toBe(long)
    await expect.poll(() => under.evaluate((el) => el.textContent)).toBe(long)
}

test('T96 Mac Chat: Hangul being composed after a skill stays under the box, same words, same place (CDP composition, not a real IME)', async () => {
    test.setTimeout(120_000)
    const { app, page } = await launch()
    await openMacChat(page)
    await chat(page).getByTestId('chat-composer').click()
    const cdp = await page.context().newCDPSession(page)
    await composeHangul(app, page, cdp, chat(page), 'mac')
})

test('T96 phone: Hangul being composed after a skill stays under the box, at 390 (CDP composition, not a real IME)', async () => {
    test.setTimeout(120_000)
    const { app, base } = await launch()
    const { phone, cdp } = await openPhone(app, `${base}/?session=${CLAUDE}&view=chat`, 't96-phone-ime')
    await expect(phone.getByTestId('chat-composer')).toBeVisible({ timeout: 15_000 })
    await tap(cdp, phone, '[data-testid="chat-composer"]')
    await composeHangul(app, phone, cdp, phone.locator('body'), 'phone')
})

test('T96 Mac Chat: a long message folds to «+N lines» and opens (bcbbbec5)', async () => {
    test.setTimeout(120_000)
    const { page } = await launch()
    await openMacChat(page)
    const bubble = chat(page).getByTestId('chat-user-text').first()
    await bubble.scrollIntoViewIfNeeded()
    await shot(page, 't96-fold-1280')
    await check(async () => {
        const fold = bubble.getByTestId('chat-user-fold')
        await expect(fold).toHaveText('… +3 lines')
        await expect(bubble).not.toContainText('스크린샷')
        await fold.click()
        await expect(bubble).toContainText('스크린샷')
        await expect(fold).toHaveText('Show less')
        // a short one has no fold
        await expect(chat(page).getByTestId('chat-user-text').nth(1).getByTestId('chat-user-fold')).toHaveCount(0)
    })
})

test('T96 Mac Chat: the mode shows, from the screen first and the record otherwise (5c35cff8)', async () => {
    test.setTimeout(120_000)
    const { page } = await launch()
    await openMacChat(page)
    await shot(page, 't96-mode-1280')
    await check(async () => {
        await expect(chat(page).getByTestId('chat-mode-chip')).toHaveText('bypass')
        // no row on the screen, nothing recorded: no chip — the default mode says nothing
        await page.getByText('T96 Other', { exact: true }).first().click()
        await page.getByTestId('view-toggle-chat').click()
        await expect(chat(page).getByTestId('chat-composer')).toBeVisible()
        await expect(chat(page).getByTestId('chat-mode-chip')).toHaveCount(0)
    })
})

test('T96 Mac Chat: my last message stays on top once it has scrolled away (edf2aef3)', async () => {
    test.setTimeout(120_000)
    const { page } = await launch({ pinLastMessage: true })
    await openMacChat(page)
    const scroll = chat(page).getByTestId('chat-scroll')
    await scroll.evaluate((el) => (el.scrollTop = el.scrollHeight))
    await shot(page, 't96-pinned-1280')
    await check(async () => {
        const pin = chat(page).getByTestId('chat-pinned-last')
        await expect(pin).toHaveText(/이 표는 어디에서 왔나요\?/)
        expect(await pin.evaluate((el) => getComputedStyle(el).backgroundColor), 'solid: the answer must not show through').toMatch(/^rgb\(/)
        // its own bubble in sight: no copy of it
        await pin.click()
        await expect(pin).toHaveCount(0)
        await scroll.evaluate((el) => (el.scrollTop = el.scrollHeight))
        await expect(pin).toBeVisible()
    })
})

test('T96 Mac Settings: the new Chat switches; off by default, and pinned stays off', async () => {
    test.setTimeout(120_000)
    const { page } = await launch()
    await openMacChat(page)
    const scroll = chat(page).getByTestId('chat-scroll')
    await scroll.evaluate((el) => (el.scrollTop = el.scrollHeight))
    await check(async () => {
        await page.waitForTimeout(300)
        await expect(chat(page).getByTestId('chat-pinned-last')).toHaveCount(0)
    })
    await page.locator('button[title^="Settings ("]').click()
    await page.getByTestId('settings-category-terminal').click()
    const panel = page.getByTestId('chat-view-settings')
    await panel.scrollIntoViewIfNeeded()
    await shot(page, 't96-settings-1280')
    await check(async () => {
        const pinSwitch = page.getByTestId('chat-setting-pin-last')
        await expect(pinSwitch).toHaveAttribute('aria-pressed', 'false')
        await pinSwitch.click()
        await expect(pinSwitch).toHaveAttribute('aria-pressed', 'true')
        await expect(page.getByTestId('chat-setting-open-in-app')).toHaveAttribute('aria-pressed', 'true')
    })
})

test('T96 Mac Chat: a named path opens in the preview, or in the Mac\'s app with the setting off (0a17912b)', async () => {
    test.setTimeout(120_000)
    const { app, page, project } = await launch({ openFilesInApp: false })
    await app.evaluate(({ shell }) => {
        const opened: string[] = []
        ;(globalThis as unknown as { __opened: string[] }).__opened = opened
        shell.openPath = async (target: string) => {
            opened.push(target)
            return ''
        }
    })
    await openMacChat(page)
    const link = chat(page).getByRole('button', { name: 'notes.md' }).first()
    await link.scrollIntoViewIfNeeded()
    await link.click()
    await shot(page, 't96-file-off-1280')
    await check(async () => {
        await expect.poll(() => app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened)).toEqual([path.join(project, 'notes.md')])
        await expect(page.getByTestId('chat-file-preview')).toHaveCount(0)
    })
})

test('T96 Mac Chat: a web page opens in the browser; with a line, the preview offers the browser (90043d9d)', async () => {
    test.setTimeout(120_000)
    const { app, page, project } = await launch()
    await app.evaluate(({ shell }) => {
        const opened: string[] = []
        ;(globalThis as unknown as { __opened: string[] }).__opened = opened
        shell.openPath = async (target: string) => {
            opened.push(target)
            return ''
        }
    })
    const opened = (): Promise<string[]> => app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened)
    const report = path.join(project, 'report.html')
    await openMacChat(page)
    const pageLink = chat(page).getByRole('button', { name: 'report.html', exact: true }).first()
    await pageLink.scrollIntoViewIfNeeded()
    await pageLink.click()
    await expect.poll(opened).toEqual([report])
    await expect(page.getByTestId('chat-file-preview')).toHaveCount(0)
    // a line is a place in the source: the preview, with the browser one click away
    await chat(page).getByRole('button', { name: /report\.html:3/ }).first().click()
    // the wrapper only carries the path (the modal is fixed): what is seen is the modal's own button and text
    await expect(page.getByTestId('chat-file-preview')).toHaveAttribute('data-path', report)
    await expect(page.getByTestId('file-preview-browser')).toBeVisible()
    await expect(page.getByTestId('chat-file-preview')).toContainText('T96 report')
    await shot(page, 't96-html-preview-1280')
    await page.getByTestId('file-preview-browser').click()
    await expect.poll(opened).toEqual([report, report])
    // a page that is not HTML has no such button
    await page.locator('[data-testid="chat-file-preview"] button[title^="Close"]').click()
    await expect(page.getByTestId('chat-file-preview')).toHaveCount(0)
    await chat(page).getByRole('button', { name: 'notes.md', exact: true }).first().click()
    await expect(page.getByTestId('chat-file-preview')).toHaveAttribute('data-path', path.join(project, 'notes.md'))
    await expect(page.getByTestId('file-preview-browser')).toHaveCount(0)
})

test('T96 phone: a slow Mac is said on the loading screens (fb-1112)', async () => {
    test.setTimeout(150_000)
    const { app, base } = await launch()
    // a busy Mac: who-am-I and the conversation answer after 6 s (Electron holds the request until the callback)
    await app.evaluate(({ session }) => {
        session.fromPartition('t96-slow').webRequest.onBeforeRequest({ urls: ['*://*/api/phone/me', '*://*/api/phone/chat/*/conversation*'] }, (_details, callback) => {
            setTimeout(() => callback({}), 6_000)
        })
    })
    const { phone } = await openPhone(app, `${base}/?session=${OTHER}&view=chat`, 't96-slow')
    await expect(phone.getByTestId('phone-connecting')).toBeVisible()
    await expect(phone.getByTestId('phone-connecting-slow')).toHaveCount(0)
    await expect(phone.getByTestId('phone-connecting-slow')).toBeVisible({ timeout: 6_000 })
    await shot(phone, 't96-phone-connecting-slow-390')
    await expect(phone.getByTestId('chat-reading')).toBeVisible({ timeout: 10_000 })
    await expect(phone.getByTestId('chat-reading-slow')).toBeVisible({ timeout: 6_000 })
    await shot(phone, 't96-phone-reading-slow-390')
    // it answers: the notes go with the loading screens
    await expect(phone.getByTestId('chat-composer')).toBeVisible({ timeout: 15_000 })
    await expect(phone.getByTestId('chat-reading-slow')).toHaveCount(0, { timeout: 20_000 })
})

test('T96 Mac: Tailscale switched off is said on the badge and in Settings › Phone (fb-1112)', async () => {
    test.setTimeout(120_000)
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'climanager-t96-ts-'))
    const statusFile = path.join(folder, 'tailscale-status.json')
    // the state this Mac was in when the phone stopped connecting: signed in, named, switched off
    fs.writeFileSync(statusFile, JSON.stringify({ BackendState: 'Stopped', Self: { UserID: 42, DNSName: 'mac.tail1234.ts.net.', TailscaleIPs: [] }, User: { '42': { LoginName: OWNER } } }))
    result = await launchAppWithWorkspaces([{ id: 'w-ts', name: 'TS', path: folder, sessions: [{ id: 't96-ts', name: 'TS shell' }] }], {
        settings: { phone: { enabled: true, port: PORT } },
        env: { CLIMANAGER_PHONE_TAILSCALE_STATUS: statusFile }
    })
    const { app, page } = result
    await resizeMainWindow(app, 1280, 800)
    await expect(page.getByTestId('phone-badge-tailscale-off')).toHaveText('Phone on · Tailscale off', { timeout: 15_000 })
    expect((await page.evaluate(() => window.api.getPhoneState())).tailscale.stopped).toBe(true)
    await page.locator('[title^="Settings"]').first().click()
    await page.getByTestId('settings-category-phone').click()
    await expect(page.getByTestId('phone-tailscale-stopped')).toBeVisible()
    await shot(page, 't96-tailscale-off-1280')
    // switched on again: Settings opening reads it fresh, and the badge counts phones again
    fs.writeFileSync(statusFile, JSON.stringify({ BackendState: 'Running', Self: { UserID: 42, DNSName: 'mac.tail1234.ts.net.', TailscaleIPs: ['100.100.1.1'] }, User: { '42': { LoginName: OWNER } } }))
    // Settings › Phone reads Tailscale fresh each time it opens: leave the page and come back
    await page.getByTestId('settings-category-terminal').click()
    await page.getByTestId('settings-category-phone').click()
    await expect(page.getByTestId('phone-tailscale-stopped')).toHaveCount(0, { timeout: 10_000 })
    await expect(page.getByTestId('phone-badge')).toContainText('connected')
})

test('T96 Related: Below comes first (474b70f8)', async () => {
    test.setTimeout(120_000)
    const CHIEF = 't96-rel-chief'
    const LEAD = 't96-rel-lead'
    const PEER = 't96-rel-peer'
    const WORKER = 't96-rel-worker'
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'climanager-t96-rel-'))
    result = await launchAppWithWorkspaces(
        [{ id: 'w-rel', name: 'Rel', path: folder, sessions: [{ id: CHIEF, name: 'Chief' }, { id: LEAD, name: 'Lead' }, { id: PEER, name: 'Peer' }, { id: WORKER, name: 'Worker' }] }],
        { config: { sessionRelations: [relationFor(CHIEF, LEAD), relationFor(CHIEF, PEER), relationFor(LEAD, WORKER)] } }
    )
    const { app, page } = result
    await resizeMainWindow(app, 1280, 800)
    await page.getByText('Lead', { exact: true }).first().click()
    await page.locator(`[data-related-button="${LEAD}"]`).click()
    const dialog = page.locator('[data-related-modal]')
    await expect(dialog.locator(`[data-related-row="${WORKER}"]`)).toBeVisible()
    await shot(page, 't96-related-1280')
    await check(async () => {
        const order = await dialog.locator('[data-related-tree]').evaluateAll((els) => els.map((el) => el.getAttribute('data-related-tree')))
        expect(order).toEqual(['down', 'up', 'side'])
    })
})

test('T96 Checklist: copies for an agent, with how to check an item off (ffbfb55e)', async () => {
    test.setTimeout(120_000)
    const { app, page } = await launch()
    const clipboardBefore = await app.evaluate(({ clipboard }) => clipboard.readText())
    const id = await page.evaluate(async () => {
        const made = await window.api.createChecklist('v1.27 배포', undefined)
        await window.api.addChecklistItem(made!, '빌드')
        await window.api.addChecklistItem(made!, '공개')
        return made!
    })
    await page.getByText('T96 Claude', { exact: true }).first().click()
    await page.getByTestId('checklist-chip').click()
    await expect(page.getByTestId('checklist-panel')).toBeVisible()
    await shot(page, 't96-checklist-1280')
    await check(async () => {
        await page.getByTestId('checklist-copy-agent').click()
        await expect(page.getByTestId('checklist-copy-agent')).toHaveText(/Copied/)
        const copied = await app.evaluate(({ clipboard }) => clipboard.readText())
        expect(copied).toContain('v1.27 배포')
        expect(copied).toContain(id)
        expect(copied).toContain('1. [ ] 빌드')
        expect(copied).toContain('2. [ ] 공개')
        expect(copied).toContain('checklist_check')
    })
    await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), clipboardBefore)
})

test('T96 phone: the terminal sits at the bottom, not over a blank half (183cbd1e)', async () => {
    test.setTimeout(150_000)
    const { app, base } = await launch()
    const { phone } = await openPhone(app, `${base}/?session=${SCREEN}&view=terminal`, 't96-term')
    await expect(phone.getByTestId('phone-terminal')).toHaveAttribute('data-status', 'live', { timeout: 15_000 })
    await phone.waitForTimeout(500)
    await shot(phone, 't96-terminal-390')
    await check(async () => {
        const scroller = (await phone.getByTestId('phone-terminal-scroller').boundingBox())!
        const sizer = (await phone.locator('.phone-term-sizer').boundingBox())!
        expect(sizer.height, 'the fitted terminal is shorter than the room').toBeLessThan(scroller.height - 50)
        expect(Math.abs(sizer.y + sizer.height - (scroller.y + scroller.height))).toBeLessThanOrEqual(1)
        expect(sizer.y).toBeGreaterThan(scroller.y + 40)
        // zoomed past the room it is an ordinary scroll: nothing cut off above
        await phone.getByTestId('phone-terminal-zoom-in').click()
        await phone.getByTestId('phone-terminal-zoom-in').click()
        await phone.getByTestId('phone-terminal-zoom-in').click()
        await phone.getByTestId('phone-terminal-zoom-in').click()
        await expect.poll(() => phone.getByTestId('phone-terminal-scroller').evaluate((el) => el.scrollHeight > el.clientHeight && el.scrollWidth > el.clientWidth)).toBe(true)
        const top = await phone.getByTestId('phone-terminal-scroller').evaluate((el) => {
            el.scrollTop = 0
            return el.querySelector('.phone-term-sizer')!.getBoundingClientRect().top - el.getBoundingClientRect().top
        })
        expect(top).toBeCloseTo(0, 0)
    })
})

test('T96 phone: the notices turn off, the dots stay; quick replies on by default, also while working', async () => {
    test.setTimeout(200_000)
    const { app, page, base } = await launch()
    const { phone, cdp } = await openPhone(app, `${base}/?session=${CLAUDE}&view=chat`, 't96-phone')
    const box = phone.getByTestId('chat-composer')
    await expect(box).toBeVisible({ timeout: 15_000 })

    // the mode and the blue skill, at 390
    await box.fill('좀 더 /eli5 로')
    await phone.getByTestId('chat-composer').press('Escape').catch(() => undefined)
    await phone.waitForTimeout(600)
    await shot(phone, 't96-phone-skill-mode-390')
    await check(async () => {
        await expect(phone.getByTestId('chat-composer-token')).toHaveText(['/eli5'])
        await expect(phone.getByTestId('chat-mode-chip')).toHaveText('bypass')
        expect(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no sideways scroll').toBe(true)
    })
    await box.fill('')

    // the Mac has phrases: on without touching the phone
    await shot(phone, 't96-phone-quick-390')
    await check(async () => {
        await expect(phone.getByTestId('chat-quick-replies')).toContainText(PHRASES[0])
    })

    // while working: still there (a tap waits for the turn)
    await box.fill('긴 일을 시작')
    await phone.getByTestId('chat-send').click()
    await expect(phone.getByTestId('chat-working')).toBeVisible({ timeout: 15_000 })
    await shot(phone, 't96-phone-working-390')
    await check(async () => {
        await expect(phone.getByTestId('chat-quick-replies')).toBeVisible()
    })

    // another session asks: the pill and ☰'s number, with the dot
    await page.getByText('T96 Other', { exact: true }).first().click()
    await page.getByTestId('view-toggle-chat').click()
    const macBox = chat(page).getByTestId('chat-composer')
    await macBox.fill('ASK')
    await macBox.press('Enter')
    await expect(phone.getByTestId('phone-menu-badge')).toBeVisible({ timeout: 20_000 })
    await shot(phone, 't96-phone-notices-on-390')

    // the phone's settings
    await tap(cdp, phone, '[data-testid="phone-menu-button"]')
    await tap(cdp, phone, '[data-testid="phone-settings-button"]')
    await expect(phone.getByTestId('phone-settings-menu')).toBeVisible()
    await shot(phone, 't96-phone-settings-390')
    await check(async () => {
        await expect(phone.getByTestId('phone-setting-quick-replies')).toBeChecked()
        await expect(phone.getByTestId('phone-setting-alerts')).toBeChecked()
        await phone.getByTestId('phone-setting-alerts').uncheck()
        await phone.getByTestId('phone-setting-quick-replies').uncheck()
        await tapScrim(cdp, phone)
        await expect(phone.getByTestId('phone-menu-badge')).toHaveCount(0)
        await expect(phone.getByTestId('phone-droplet')).toHaveCount(0)
        await expect(phone.locator('.phone-header .phone-dot')).toBeVisible()
        await shot(phone, 't96-phone-notices-off-390')
        // what was turned off stays off
        await phone.reload()
        await expect(phone.getByTestId('chat-composer')).toBeVisible({ timeout: 15_000 })
        await phone.waitForTimeout(800)
        await expect(phone.getByTestId('chat-quick-replies')).toHaveCount(0)
        await expect(phone.getByTestId('phone-menu-badge')).toHaveCount(0)
    })
})

test('T96 phone: a quick reply goes once when the Mac answers slowly (b17fa869)', async () => {
    test.setTimeout(150_000)
    const { app, base } = await launch()
    const { phone, cdp } = await openPhone(app, `${base}/?session=${OTHER}&view=chat`, 't96-quick-once')
    await expect(phone.getByTestId('chat-quick-replies')).toContainText(PHRASES[1], { timeout: 15_000 })
    // 21f4d88a: Chat and Terminal are the two halves of one switch
    const chatTab = (await phone.getByTestId('phone-lens-chat').boundingBox())!
    const terminalTab = (await phone.getByTestId('phone-lens-terminal').boundingBox())!
    expect(Math.abs(chatTab.width - terminalTab.width), 'Chat and Terminal are as wide as each other').toBeLessThanOrEqual(1)
    expect(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no sideways scroll').toBe(true)
    // a busy Mac: every send answers after 4 s. Counted in the page, before anything reaches main
    await phone.evaluate(() => {
        const w = window as unknown as { __sends: string[]; fetch: typeof fetch }
        w.__sends = []
        const original = w.fetch.bind(window)
        w.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
            if (/\/send$/.test(url) && init?.method === 'POST') {
                w.__sends.push(String(init.body))
                await new Promise((resolve) => setTimeout(resolve, 4_000))
            }
            return original(input, init)
        }
    })
    const chip = phone.getByTestId('chat-quick-replies').getByRole('button', { name: PHRASES[1], exact: true })
    const chipSelector = `[data-testid="chat-quick-replies"] button[title="Send “${PHRASES[1]}”"]`
    await tap(cdp, phone, chipSelector)
    // the thumb comes down again (and on the other chip) while the first is on its way
    const box = (await chip.boundingBox())!
    for (let i = 0; i < 3; i++) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }] })
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
        await phone.waitForTimeout(150)
    }
    await phone.getByTestId('chat-quick-replies').getByRole('button', { name: PHRASES[0], exact: true }).click({ force: true }).catch(() => undefined)
    expect(await phone.evaluate(() => (window as unknown as { __sends: string[] }).__sends.length), 'one tap went, the others waited').toBe(1)
    // still on its way: the tapped chip says so
    await expect(chip).toHaveAttribute('data-sending', 'true')
    await shot(phone, 't96-phone-quick-sending-390')
    // answered: the chips take taps again
    await expect(chip).not.toHaveAttribute('data-sending', 'true', { timeout: 10_000 })
    await expect(chip).toBeEnabled()
    const sends = await phone.evaluate(() => (window as unknown as { __sends: string[] }).__sends)
    expect(sends).toHaveLength(1)
    expect(JSON.parse(sends[0]).text).toBe(PHRASES[1])
})

test('T96 phone: my last message on top follows the Mac until the phone chooses (edf2aef3)', async () => {
    test.setTimeout(150_000)
    const { app, base } = await launch({ pinLastMessage: true })
    const { phone, cdp } = await openPhone(app, `${base}/?session=${CLAUDE}&view=chat`, 't96-pin')
    await expect(phone.getByTestId('chat-composer')).toBeVisible({ timeout: 15_000 })
    const toEnd = (): Promise<unknown> => phone.getByTestId('chat-scroll').evaluate((el) => (el.scrollTop = el.scrollHeight))
    await toEnd()
    await shot(phone, 't96-phone-pinned-390')
    await check(async () => {
        await expect(phone.getByTestId('chat-pinned-last')).toHaveText(/이 표는 어디에서 왔나요\?/)
        await tap(cdp, phone, '[data-testid="phone-menu-button"]')
        await tap(cdp, phone, '[data-testid="phone-settings-button"]')
        await expect(phone.getByTestId('phone-setting-pin-last')).toBeChecked()
        await phone.getByTestId('phone-setting-pin-last').uncheck()
        await tapScrim(cdp, phone)
        await expect(phone.getByTestId('chat-pinned-last')).toHaveCount(0)
        await phone.reload()
        await expect(phone.getByTestId('chat-composer')).toBeVisible({ timeout: 15_000 })
        await toEnd()
        await phone.waitForTimeout(500)
        await expect(phone.getByTestId('chat-pinned-last'), 'the phone said no; the Mac still says yes').toHaveCount(0)
    })
})

function relationFor(from: string, to: string): Record<string, unknown> {
    return { from, to, kind: 'opened', at: 1 }
}
