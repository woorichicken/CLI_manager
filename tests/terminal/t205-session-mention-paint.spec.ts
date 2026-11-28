import { test, expect, type Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { closeApp, launchAppWithWorkspaces, type LaunchResult, REPO_ROOT, resizeMainWindow, waitForBufferText } from './helpers'
import { commandPieces, composerPieces } from '../../src/renderer/src/components/ChatView/chatLib'
import { mentionNameFor, sessionMentionText, setSessionCatalog } from '../../src/renderer/src/utils/sessionMentions'
import type { ChatCommand } from '../../src/shared/conversation'
import type { Workspace } from '../../src/shared/types'

/**
 * T205 — a session picked with `@` reads blue in the Chat box (a9ed0f1c).
 *
 * Unit: composerPieces cuts `<name> (climanager://session/<8>)` out as one piece (the name too when the app
 * knows that session), next to the skills' rule (T96); every character is kept. App: pick a session with `@`
 * → the mention is one blue span, the words underneath sit exactly under the box (T96's check), in the
 * middle and on a later line; a link to a session the app does not know paints the link alone.
 *
 * T205_SHOTS=<dir> + T205_LABEL save captures before the checks.
 */

const MOCK = path.join(REPO_ROOT, 'scripts/mock-cli/chat-mock.cjs')
const LABEL = process.env.T205_LABEL ?? 'run'
const ME = '205a0001-0000-4000-8000-000000000001'
const KID = '205b0002-0000-4000-8000-000000000002'
const OTHER = '205c0003-0000-4000-8000-000000000003'

const SKILLS: ChatCommand[] = [{ name: 'eli5', description: '', source: 'skill' }]

test.describe('T205 unit', () => {
    test('composerPieces: the mention is one piece, the name with it when known; the pieces add up to the text', () => {
        const name = (ref: string): string | undefined => (ref === '205b0002' ? 'T205: 캘린더 /eli5 목업' : undefined)
        const text = 'see T205: 캘린더 /eli5 목업 (climanager://session/205b0002) and /eli5\nthen (climanager://session/deadbeef) ok'
        const pieces = composerPieces(text, { commands: SKILLS, codex: false, sessionName: name })
        expect(pieces.map((piece) => piece.text).join('')).toBe(text)
        expect(pieces.filter((piece) => piece.kind).map((piece) => [piece.kind, piece.text])).toEqual([
            ['session', 'T205: 캘린더 /eli5 목업 (climanager://session/205b0002)'],
            ['command', '/eli5'],
            ['session', '(climanager://session/deadbeef)']
        ])
        // without the command list (not asked for yet) the sessions still paint
        expect(composerPieces(text, { commands: null, codex: false, sessionName: name }).filter((piece) => piece.kind).map((piece) => piece.kind)).toEqual(['session', 'session'])
        // the name has to be what stands before the link
        expect(composerPieces('other words (climanager://session/205b0002)', { commands: null, codex: false, sessionName: name }).filter((p) => p.kind).map((p) => p.text)).toEqual([
            '(climanager://session/205b0002)'
        ])
        // not a mention: no brackets, a longer word, too short a ref
        for (const words of ['climanager://session/205b0002', '(climanager://session/205b0002zz)', '(climanager://session/205b)']) {
            expect(composerPieces(words, { commands: null, codex: false }).every((piece) => piece.kind === null), words).toBe(true)
        }
        // commandPieces keeps its old answer
        expect(commandPieces('/eli5 x', SKILLS, false)).toEqual([
            { text: '/eli5', command: true },
            { text: ' x', command: false }
        ])
    })

    test('mentionNameFor: the name sessionMentionText writes, for one session only', () => {
        const long = '긴 이름 '.repeat(20)
        const workspaces = [
            { id: 'w', name: 'W', path: '/x', sessions: [{ id: KID, name: 'T205 kid' }, { id: OTHER, name: long }, { id: 'aaaa0000-1', name: 'a' }, { id: 'aaaa0000-2', name: 'b' }] }
        ] as unknown as Workspace[]
        setSessionCatalog({ workspaces, relations: [] })
        expect(mentionNameFor('205b0002')).toBe('T205 kid')
        expect(mentionNameFor(KID.toUpperCase())).toBe('T205 kid')
        expect(`${mentionNameFor('205c0003')} (climanager://session/205c0003)`).toBe(sessionMentionText({ id: OTHER, name: long }))
        expect(mentionNameFor('aaaa0000'), 'two sessions start with it').toBeUndefined()
        expect(mentionNameFor('ffffffff')).toBeUndefined()
        setSessionCatalog({ workspaces: [], relations: [] })
    })
})

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

async function shot(page: Page, name: string): Promise<void> {
    const dir = process.env.T205_SHOTS
    if (!dir) return
    fs.mkdirSync(dir, { recursive: true })
    await page.waitForTimeout(400)
    // above the status bar: its port list names folders on this Mac
    await page.screenshot({ path: path.join(dir, `${name}-${LABEL}.png`), clip: { x: 0, y: 0, width: 1280, height: 765 } })
}

test('T205 app: the picked session is one blue span, under the box exactly, also mid-text and on a later line', async () => {
    test.setTimeout(180_000)
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'climanager-t205-'))
    const project = path.join(home, 'project')
    fs.mkdirSync(project, { recursive: true })
    const claudeDir = path.join(home, 'claude')
    const transcript = path.join(claudeDir, 'projects', 'x', '00000000-0000-4000-8000-0000000c2050.jsonl')
    fs.mkdirSync(path.dirname(transcript), { recursive: true })
    fs.writeFileSync(transcript, '')
    result = await launchAppWithWorkspaces(
        [
            {
                id: 'w-t205',
                name: 'T205 project',
                path: project,
                sessions: [
                    {
                        id: ME,
                        name: 'T205 Claude',
                        cliSessionId: '00000000-0000-4000-8000-0000000c2050',
                        cliToolName: 'claude',
                        cliCommand: `node ${MOCK} --transcript ${transcript} --work-ms 300`
                    },
                    { id: KID, name: 'T205 캘린더 계획 목업' },
                    { id: OTHER, name: 'T205 other' }
                ]
            }
        ],
        { config: { sessionRelations: [{ from: ME, to: KID, kind: 'opened', at: 1 }] }, env: { CLAUDE_CONFIG_DIR: claudeDir } }
    )
    const { app, page } = result
    await resizeMainWindow(app, 1280, 800)
    await waitForBufferText(page, ME, 'Claude Code (mock)', 20_000)
    await page.getByText('T205 Claude', { exact: true }).first().click()
    await page.waitForTimeout(400)
    await page.getByTestId('view-toggle-chat').click()
    const chat = page.locator('[data-testid="chat-view"][data-session-id]:visible')
    const box = chat.getByTestId('chat-composer')
    await expect(box).toBeVisible({ timeout: 15_000 })
    const tokens = chat.getByTestId('chat-composer-token')
    const painted = (): Promise<string[][]> => tokens.evaluateAll((spans) => spans.map((span) => [span.getAttribute('data-kind') ?? '', span.textContent ?? '']))
    const mention = 'T205 캘린더 계획 목업 (climanager://session/205b0002)'
    const lined = async (): Promise<void> => {
        const sizes = await box.evaluate((el) => {
            const under = el.parentElement!.querySelector<HTMLElement>('[data-testid="chat-composer-backdrop"]')!
            const of = (node: HTMLElement) => {
                const style = getComputedStyle(node)
                return { font: style.font, padding: style.padding, inner: node.clientWidth, height: node.scrollHeight, top: node.scrollTop }
            }
            return { box: of(el as HTMLElement), under: of(under) }
        })
        expect(sizes.under, 'the painted words sit under the box').toEqual(sizes.box)
    }

    // pick it with `@`: the whole mention is one blue span, the box's own words go transparent
    await box.focus()
    await page.keyboard.type('이거 보고 @캘린더')
    await expect(chat.getByTestId('chat-complete').locator('[data-kind="session"]').first()).toBeVisible({ timeout: 10_000 })
    await page.keyboard.press('Enter')
    await expect(box).toHaveValue(`이거 보고 ${mention} `)
    await page.keyboard.type('정리해줘')
    await shot(page, 't205-picked')
    await expect.poll(painted).toEqual([['session', mention]])
    expect(await box.evaluate((el) => getComputedStyle(el).color)).toBe('rgba(0, 0, 0, 0)')
    expect(await tokens.first().evaluate((el) => getComputedStyle(el).color)).toBe('rgb(147, 197, 253)')
    await lined()

    // on a later line, wrapped across lines, next to a link the app does not know (the link alone)
    const long = `${'첫 줄 설명입니다 '.repeat(12)}\n둘째 줄 ${mention} 그리고 (climanager://session/deadbeef) 끝`
    await box.fill(long)
    await page.waitForTimeout(250)
    await shot(page, 't205-later-line')
    await expect.poll(painted).toEqual([
        ['session', mention],
        ['session', '(climanager://session/deadbeef)']
    ])
    await lined()
    expect((await box.evaluate((el) => el.scrollHeight)) > 60, 'it did wrap').toBe(true)

    // nothing to paint: the box's own colour comes back
    await box.fill('plain words')
    await expect.poll(painted).toEqual([])
    expect(await box.evaluate((el) => getComputedStyle(el).color)).not.toBe('rgba(0, 0, 0, 0)')
})
