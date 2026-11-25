import { test, expect, type Frame, type Locator, type Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { DOC_PREVIEW_BRIDGE } from '../../src/main/docPreview'
import { closeApp, launchAppWithWorkspaces, type LaunchResult, REPO_ROOT, resizeMainWindow, waitForBufferText } from './helpers'

/**
 * T175 — fb-1125 ec4c1682: «여기서 무언갈 적고 저장(복사)을 안하고 나갈때, alert 등을 띄울 수 있는지». A review page's
 * comments live in the page only (the bridge's storage stands in for localStorage and is gone on close), so one press of
 * × used to throw them away. The bridge now tells the window when a person typed in a field of the page and has not
 * copied (`dirty`), and the preview window, a split pane and a link to another page ask first, in the app:
 * «Comments you typed here weren't copied…» [Keep open] [Close anyway].
 *
 * unit: the bridge run against a stub page — input after typing is dirty, a copy (event or clipboard.writeText) is clean,
 *       what a script does while loading (untrusted input, storage writes) is not.
 * app:  preview × / Escape / link / Side by side · split pane ×; a copy, an untouched page and a prefilled page close at once.
 *
 * T175_SHOTS=<dir> saves the confirm band's capture (after only: there was no «before» to see).
 */

const MOCK = path.join(REPO_ROOT, 'scripts/mock-cli/chat-mock.cjs')
const CLAUDE = 't175-claude'
const CLAUDE_ID = '00000000-0000-4000-8000-0000000c1750'
const QUESTION = "Comments you typed here weren't copied. They'll be lost when this closes."

// ---------- unit ----------

type Handler = (event: Record<string, unknown>) => void
function runBridge() {
    const handlers: Record<string, Handler[]> = {}
    const posted: Array<Record<string, unknown>> = []
    const stored: Record<string, string> = {}
    const win: Record<string, unknown> = { addEventListener: (type: string, fn: Handler) => (handlers[`window:${type}`] ??= []).push(fn) }
    const doc: Record<string, unknown> = { addEventListener: (type: string, fn: Handler) => (handlers[`document:${type}`] ??= []).push(fn) }
    const writes: string[] = []
    const clipboard = { writeText: (text: string) => { writes.push(text); return Promise.resolve() } }
    new Function('window', 'document', 'location', 'parent', 'navigator', `${DOC_PREVIEW_BRIDGE}`)(
        win,
        doc,
        { pathname: '/doc/tok/review.html', protocol: 'climanager-doc:', host: 'doc' },
        { postMessage: (message: Record<string, unknown>) => posted.push(message) },
        { clipboard }
    )
    const fire = (type: string, event: Record<string, unknown>) => (handlers[`document:${type}`] ?? []).forEach((fn) => fn(event))
    return {
        posted,
        writes,
        clipboard,
        storage: win.localStorage as Storage,
        stored,
        input: (target: Record<string, unknown>, trusted = true) => fire('input', { target, isTrusted: trusted }),
        copy: () => fire('copy', { isTrusted: true })
    }
}
const field = (value: string, extra: Record<string, unknown> = {}) => ({ nodeType: 1, tagName: 'TEXTAREA', value, ...extra })
const dirtyMessages = (posted: Array<Record<string, unknown>>) => posted.filter((m) => 'dirty' in m).map((m) => m.dirty)

test('T175 unit: the bridge says dirty after typing in a field, clean after a copy, and nothing for a script loading', () => {
    // a page that loads, fills its own fields and keeps a draft in storage: no person wrote anything
    const loading = runBridge()
    loading.storage.setItem('draft', 'x')
    loading.input(field('prefilled'), false)
    expect(loading.posted).toEqual([])

    // typing: dirty once (more keys do not repeat it), clean when the field is emptied again
    const typing = runBridge()
    const note = field('h')
    typing.input(note)
    typing.input(note)
    expect(typing.posted).toEqual([{ dirty: true, type: 'clim-doc-preview' }])
    note.value = 'hello'
    typing.input(note)
    expect(dirtyMessages(typing.posted)).toEqual([true])
    note.value = '   '
    typing.input(note)
    expect(dirtyMessages(typing.posted), 'only blanks left').toEqual([true, false])

    // a copy event takes what was typed: clean; typing again is dirty again
    const copying = runBridge()
    const second = field('abc')
    copying.input(second)
    copying.copy()
    expect(dirtyMessages(copying.posted)).toEqual([true, false])
    copying.copy()
    expect(dirtyMessages(copying.posted), 'a second copy changes nothing').toEqual([true, false])
    copying.input(second)
    expect(dirtyMessages(copying.posted)).toEqual([true, false, true])

    // a copy button that writes the clipboard itself fires no copy event: its write counts, and still goes through
    const writing = runBridge()
    writing.input(field('x'))
    void writing.clipboard.writeText('x')
    expect(dirtyMessages(writing.posted)).toEqual([true, false])
    expect(writing.writes).toEqual(['x'])

    // what is not writing: buttons, checkboxes, hidden fields, plain elements; a contenteditable is
    const other = runBridge()
    other.input({ nodeType: 1, tagName: 'INPUT', type: 'checkbox', value: 'on' })
    other.input({ nodeType: 1, tagName: 'INPUT', type: 'button', value: 'Go' })
    other.input({ nodeType: 1, tagName: 'DIV', textContent: 'x' })
    expect(other.posted).toEqual([])
    other.input({ nodeType: 1, tagName: 'INPUT', type: 'text', value: 'q' })
    expect(dirtyMessages(other.posted)).toEqual([true])
    const editable = runBridge()
    editable.input({ nodeType: 1, tagName: 'DIV', isContentEditable: true, textContent: 'typed' })
    expect(dirtyMessages(editable.posted)).toEqual([true])

    // the bridge's own rules: ASCII only, no closing script tag (it is written into the page's head)
    expect(/^[\x00-\x7f]*$/.test(DOC_PREVIEW_BRIDGE)).toBe(true)
    expect(DOC_PREVIEW_BRIDGE.toLowerCase().includes('</script')).toBe(false)
})

// ---------- app ----------

let result: LaunchResult | null = null
test.afterEach(async () => {
    if (result) await closeApp(result)
    result = null
})

const chat = (page: Page) => page.locator('[data-testid="chat-view"][data-session-id]:visible')
const preview = (page: Page) => page.getByTestId('chat-file-preview')
const confirmBand = (scope: Locator) => scope.getByTestId('html-doc-leave-confirm')

async function shot(page: Page, name: string): Promise<void> {
    const dir = process.env.T175_SHOTS
    if (!dir) return
    fs.mkdirSync(dir, { recursive: true })
    await page.waitForTimeout(300)
    await page.screenshot({ path: path.join(dir, `${name}.png`) })
}

async function launch(): Promise<{ page: Page; project: string }> {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't175-')))
    const project = path.join(dir, 'project')
    fs.mkdirSync(project, { recursive: true })
    fs.writeFileSync(path.join(project, 'review.html'), `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Review kit</title></head><body>
<h1 id="title">Review</h1><p><a id="next" href="details.html">Details</a></p>
<textarea id="note" rows="4" cols="40"></textarea>
<button id="copy" type="button">Copy</button> <button id="copy2" type="button">Copy 2</button>
<script>
document.getElementById('copy').onclick = function () { var t = document.getElementById('note'); t.focus(); t.select(); document.execCommand('copy') }
document.getElementById('copy2').onclick = function () { try { navigator.clipboard.writeText(document.getElementById('note').value).catch(function () {}) } catch (e) {} }
</script></body></html>
`)
    // a kit restoring a draft while it loads: a script, not a person
    fs.writeFileSync(path.join(project, 'prefilled.html'), `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Prefilled</title></head><body>
<textarea id="note" rows="3" cols="30"></textarea>
<script>var n = document.getElementById('note'); n.value = 'restored draft'; n.dispatchEvent(new Event('input', { bubbles: true })); localStorage.setItem('draft', n.value)</script>
</body></html>
`)
    fs.writeFileSync(path.join(project, 'details.html'), '<!doctype html>\n<html><head><meta charset="utf-8"><title>Details</title></head><body><h1 id="title">Release details</h1></body></html>\n')

    const claudeDir = path.join(dir, 'claude')
    const transcript = path.join(claudeDir, 'projects', project.replace(/[^a-zA-Z0-9]/g, '-'), `${CLAUDE_ID}.jsonl`)
    fs.mkdirSync(path.dirname(transcript), { recursive: true })
    const ts = (n: number): string => new Date(Date.UTC(2026, 10, 25, 1, 0, n)).toISOString()
    fs.writeFileSync(transcript, [
        { type: 'user', uuid: '00000000-0000-4000-8000-000000000001', timestamp: ts(1), message: { role: 'user', content: '리뷰 페이지 어디 있어?' } },
        { type: 'assistant', uuid: '00000000-0000-4000-8000-000000000002', timestamp: ts(2), message: { role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'The review is `review.html` and a restored one is `prefilled.html`.' }] } }
    ].map((entry) => JSON.stringify(entry)).join('\n') + '\n')
    result = await launchAppWithWorkspaces(
        [{ id: 'w-t175', name: 'T175 project', path: project, sessions: [{ id: CLAUDE, name: 'T175 Claude', cliSessionId: CLAUDE_ID, cliToolName: 'claude', cliCommand: `node ${MOCK} --transcript ${transcript} --continue --mode-row none` }, { id: 't175-other', name: 'T175 Other' }] }],
        { env: { CLAUDE_CONFIG_DIR: claudeDir, ARTIFACT_DOCK_SOCKET: path.join(dir, 'no-dock.sock') } }
    )
    const { app, page } = result
    await resizeMainWindow(app, 1280, 800)
    await waitForBufferText(page, CLAUDE, 'Claude Code (mock)', 20_000)
    await page.getByText('T175 Claude', { exact: true }).first().click()
    await page.getByTestId('view-toggle-chat').click()
    await expect(chat(page).getByTestId('chat-composer')).toBeVisible()
    await expect(chat(page).getByRole('button', { name: 'review.html', exact: true }).first()).toBeVisible({ timeout: 15_000 })
    return { page, project }
}

async function frameOf(scope: Locator): Promise<Frame> {
    const handle = await scope.getByTestId('html-doc-frame').elementHandle({ timeout: 15_000 })
    const frame = await handle?.contentFrame()
    if (!frame) throw new Error('no document frame')
    return frame
}

/** type like a person (trusted key events) and give the bridge's message a moment to land */
async function typeNote(frame: Frame, text: string): Promise<void> {
    await frame.locator('#note').click()
    await frame.locator('#note').pressSequentially(text)
    await expect(frame.locator('#note')).toHaveValue(new RegExp(text))
    await frame.waitForTimeout(250)
}

const openPage = async (page: Page, name: string): Promise<Frame> => {
    await chat(page).getByRole('button', { name, exact: true }).first().click()
    await expect(preview(page).getByTestId('html-doc-frame')).toBeVisible({ timeout: 15_000 })
    return frameOf(preview(page))
}
const closeX = (page: Page) => page.locator('[data-testid="chat-file-preview"] button[title^="Close"]')

test('T175 preview window: typed and not copied asks before × / Escape / a link / Side by side; a copy, a clean page and a prefilled page do not', async () => {
    test.setTimeout(180_000)
    const { page, project } = await launch()

    // a page nobody wrote in closes at once
    let frame = await openPage(page, 'review.html')
    await closeX(page).click()
    await expect(preview(page)).toHaveCount(0)

    // a kit that fills its own field and fires input while it loads is not a person writing
    frame = await openPage(page, 'prefilled.html')
    await expect(frame.locator('#note')).toHaveValue('restored draft')
    await frame.waitForTimeout(250)
    await closeX(page).click()
    await expect(preview(page)).toHaveCount(0)

    // typed, not copied: × asks; Keep open (focused at once) leaves the page and the words as they were
    frame = await openPage(page, 'review.html')
    await typeNote(frame, 'my comment')
    await closeX(page).click()
    const band = confirmBand(preview(page))
    await expect(band).toBeVisible()
    await expect(band).toContainText(QUESTION)
    await expect(band.getByTestId('html-doc-leave-keep')).toBeFocused()
    await shot(page, 'after-preview-1280')
    await band.getByTestId('html-doc-leave-keep').click()
    await expect(band).toHaveCount(0)
    await expect(preview(page)).toHaveCount(1)
    await expect(frame.locator('#note')).toHaveValue('my comment')

    // Escape on the question is «Keep open» too, and does not close the window behind it
    await closeX(page).click()
    await expect(band).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(band).toHaveCount(0)
    await expect(preview(page)).toHaveCount(1)

    // the window's Escape (focus outside the page) asks, and «Close anyway» closes
    await preview(page).getByText('project/review.html').first().click()
    await page.keyboard.press('Escape')
    await expect(band).toBeVisible()
    await band.getByTestId('html-doc-leave-anyway').click()
    await expect(preview(page)).toHaveCount(0)

    // a copy button (document.execCommand → the copy event) takes it: × closes at once, then typing again is dirty again
    frame = await openPage(page, 'review.html')
    await typeNote(frame, 'copied one')
    await frame.locator('#copy').click()
    await frame.waitForTimeout(250)
    await closeX(page).click()
    await expect(preview(page)).toHaveCount(0)
    frame = await openPage(page, 'review.html')
    await typeNote(frame, 'copied two')
    await frame.locator('#copy').click()
    await frame.waitForTimeout(200)
    await typeNote(frame, ' and more')
    await closeX(page).click()
    await expect(band).toBeVisible()
    await band.getByTestId('html-doc-leave-anyway').click()
    await expect(preview(page)).toHaveCount(0)

    // …and one that writes the clipboard itself (navigator.clipboard.writeText) counts too
    frame = await openPage(page, 'review.html')
    await typeNote(frame, 'via clipboard')
    await frame.locator('#copy2').click()
    await frame.waitForTimeout(250)
    await closeX(page).click()
    await expect(preview(page)).toHaveCount(0)

    // a link to another page of the folder replaces this page: ask first; Keep open stays, Close anyway goes
    frame = await openPage(page, 'review.html')
    await typeNote(frame, 'before the link')
    await frame.locator('#next').click()
    await expect(band).toBeVisible()
    await band.getByTestId('html-doc-leave-keep').click()
    await expect(preview(page)).toHaveAttribute('data-path', path.join(project, 'review.html'))
    await expect(frame.locator('#note')).toHaveValue('before the link')
    await frame.locator('#next').click()
    await band.getByTestId('html-doc-leave-anyway').click()
    await expect(preview(page)).toHaveAttribute('data-path', path.join(project, 'details.html'))
    const details = await frameOf(preview(page))
    await expect(details.locator('#title')).toHaveText('Release details')
    // the new page starts clean
    await closeX(page).click()
    await expect(preview(page)).toHaveCount(0)

    // Side by side moves the page out of this window: ask too
    frame = await openPage(page, 'review.html')
    await typeNote(frame, 'before the split')
    await page.getByTestId('file-preview-side-by-side').click()
    await expect(band).toBeVisible()
    await band.getByTestId('html-doc-leave-keep').click()
    await expect(page.locator('[data-doc-pane]')).toHaveCount(0)
    await page.getByTestId('file-preview-side-by-side').click()
    await band.getByTestId('html-doc-leave-anyway').click()
    await expect(preview(page)).toHaveCount(0)
    await expect(page.locator('[data-doc-pane]')).toHaveCount(1)
})

test('T175 split pane: closing a pane with uncopied words asks inside the pane', async () => {
    test.setTimeout(180_000)
    const { page } = await launch()
    const docPanes = page.locator('[data-doc-pane]')

    await openPage(page, 'review.html')
    await page.getByTestId('file-preview-side-by-side').click()
    await expect(preview(page)).toHaveCount(0)
    await expect(docPanes).toHaveCount(1)
    // untouched: the pane's × closes it at once
    await docPanes.first().getByTestId('doc-pane-close').click()
    await expect(docPanes).toHaveCount(0)

    await openPage(page, 'review.html')
    await page.getByTestId('file-preview-side-by-side').click()
    await expect(docPanes).toHaveCount(1)
    const frame = await frameOf(docPanes.first())
    await typeNote(frame, 'pane words')
    await docPanes.first().getByTestId('doc-pane-close').click()
    const band = confirmBand(docPanes.first())
    await expect(band).toBeVisible()
    await expect(band).toContainText(QUESTION)
    await expect(band.getByTestId('html-doc-leave-keep')).toBeFocused()
    await shot(page, 'after-pane-1280')
    // Keep open: the pane and the words stay
    await band.getByTestId('html-doc-leave-keep').click()
    await expect(docPanes).toHaveCount(1)
    await expect(frame.locator('#note')).toHaveValue('pane words')
    // copy → × closes at once
    await frame.locator('#copy').click()
    await frame.waitForTimeout(250)
    await docPanes.first().getByTestId('doc-pane-close').click()
    await expect(docPanes).toHaveCount(0)

    // a link inside the pane replaces its page: ask there too
    await openPage(page, 'review.html')
    await page.getByTestId('file-preview-side-by-side').click()
    const frame2 = await frameOf(docPanes.first())
    await typeNote(frame2, 'unsaved in the pane')
    await frame2.locator('#next').click()
    await expect(confirmBand(docPanes.first())).toBeVisible()
    await confirmBand(docPanes.first()).getByTestId('html-doc-leave-anyway').click()
    await expect(docPanes.first()).toHaveAttribute('data-path', /details\.html$/)
    // and «Close anyway» on a close ends the pane
    await docPanes.first().getByTestId('doc-pane-close').click()
    await expect(docPanes).toHaveCount(0)
})

test('T175 Preview → Source drops the drawn page: asks first, in the window and in a pane (fb-1125 round 2)', async () => {
    test.setTimeout(180_000)
    const { page } = await launch()
    const band = confirmBand(preview(page))

    // the window
    const frame = await openPage(page, 'review.html')
    await typeNote(frame, 'before the source')
    await page.getByTestId('file-preview-source').click()
    await expect(band).toBeVisible()
    await expect(band.getByTestId('html-doc-leave-anyway')).toHaveText('Switch anyway')
    await expect(band.getByTestId('html-doc-leave-keep')).toBeFocused()
    await band.getByTestId('html-doc-leave-keep').click()
    await expect(page.getByTestId('file-preview-rendered')).toHaveAttribute('aria-pressed', 'true')
    await expect(frame.locator('#note')).toHaveValue('before the source')
    await page.getByTestId('file-preview-source').click()
    await band.getByTestId('html-doc-leave-anyway').click()
    await expect(preview(page).getByTestId('html-doc-source')).toBeVisible()
    // back to Preview: a fresh page, nothing typed — × closes at once
    await page.getByTestId('file-preview-rendered').click()
    await expect(preview(page).getByTestId('html-doc-frame')).toBeVisible()
    await closeX(page).click()
    await expect(preview(page)).toHaveCount(0)

    // a clean page switches at once
    await openPage(page, 'review.html')
    await page.getByTestId('file-preview-source').click()
    await expect(preview(page).getByTestId('html-doc-source')).toBeVisible()
    await closeX(page).click()

    // a pane
    await openPage(page, 'review.html')
    await page.getByTestId('file-preview-side-by-side').click()
    const pane = page.locator('[data-doc-pane]').first()
    const paneFrame = await frameOf(pane)
    await typeNote(paneFrame, 'pane before source')
    await pane.getByTestId('doc-pane-source').click()
    await expect(confirmBand(pane)).toBeVisible()
    await confirmBand(pane).getByTestId('html-doc-leave-keep').click()
    await expect(pane.getByTestId('html-doc-frame')).toBeVisible()
    await pane.getByTestId('doc-pane-source').click()
    await confirmBand(pane).getByTestId('html-doc-leave-anyway').click()
    await expect(pane.getByTestId('html-doc-source')).toBeVisible()
})

test('T175 a sidebar click that would replace the active document pane asks first (fb-1125 round 2)', async () => {
    test.setTimeout(180_000)
    const { page } = await launch()
    const docPanes = page.locator('[data-doc-pane]')
    await openPage(page, 'review.html')
    await page.getByTestId('file-preview-side-by-side').click()
    await expect(docPanes).toHaveCount(1)
    const frame = await frameOf(docPanes.first())
    // a click inside the page makes its pane the active one; typing there
    await typeNote(frame, 'replaced soon')
    await page.getByText('T175 Other', { exact: true }).first().click()
    await expect(confirmBand(docPanes.first())).toBeVisible()
    await shot(page, 'after-replace-1280')
    await confirmBand(docPanes.first()).getByTestId('html-doc-leave-keep').click()
    await expect(docPanes).toHaveCount(1)
    await expect(frame.locator('#note')).toHaveValue('replaced soon')
    // copy first: the same click now replaces the pane at once
    await frame.locator('#copy').click()
    await frame.waitForTimeout(250)
    await page.getByText('T175 Other', { exact: true }).first().click()
    await expect(docPanes).toHaveCount(0)
})

test('T175 Close Other Tabs that would end the split and a typed document pane: Keep open leaves the tabs as they were (fb-1125 round 3)', async () => {
    test.setTimeout(180_000)
    const { page } = await launch()
    const docPanes = page.locator('[data-doc-pane]')
    const tabs = (): Promise<string[]> => page.locator('[data-session-tab]').evaluateAll((els) => els.map((el) => el.getAttribute('data-session-tab') ?? ''))
    // two session tabs, then the page beside the session on screen
    await page.getByText('T175 Other', { exact: true }).first().click()
    await page.getByText('T175 Claude', { exact: true }).first().click()
    await expect.poll(async () => (await tabs()).length).toBe(2)
    const before = await tabs()
    expect(before).toContain(CLAUDE)
    expect(before).toContain('t175-other')
    await openPage(page, 'review.html')
    await page.getByTestId('file-preview-side-by-side').click()
    await expect(docPanes).toHaveCount(1)
    const frame = await frameOf(docPanes.first())
    await typeNote(frame, 'tabs stay')
    const tabsInSplit = await tabs()
    expect(tabsInSplit).toContain('t175-other')

    // Close Other Tabs from the other session's tab: the session pane would go, the split would end, the page with it
    await page.locator('[data-session-tab="t175-other"]').click({ button: 'right' })
    await page.locator('[data-tab-menu-item="close-others"]').click()
    await expect(confirmBand(docPanes.first())).toBeVisible()
    await confirmBand(docPanes.first()).getByTestId('html-doc-leave-keep').click()
    // Keep open: nothing happened — the tabs, the split and the words
    expect(await tabs()).toEqual(tabsInSplit)
    await expect(docPanes).toHaveCount(1)
    await expect(frame.locator('#note')).toHaveValue('tabs stay')

    // Close anyway: the tabs go and the split ends
    await page.locator('[data-session-tab="t175-other"]').click({ button: 'right' })
    await page.locator('[data-tab-menu-item="close-others"]').click()
    await confirmBand(docPanes.first()).getByTestId('html-doc-leave-anyway').click()
    await expect(docPanes).toHaveCount(0)
    await expect.poll(tabs).toEqual(['t175-other'])
})
