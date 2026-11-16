import { test, expect } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { DocPreviewTokens, docPreviewBase, docPreviewContentSecurityPolicy, docPreviewRelativePath, openDocPreview, serveDocPreview, DOC_PREVIEW_BRIDGE } from '../../src/main/docPreview'
import { DOC_PREVIEW_MAX_BYTES, DOC_PREVIEW_SANDBOX } from '../../src/shared/docPreview'
import { docSideBlockedReason, isDocPaneId, sessionPaneIds, splitAfterRemove, splitWithDoc } from '../../src/renderer/src/utils/docPanes'
import { MAX_LINKED_SESSIONS } from '../../src/renderer/src/utils/sessionLink'

/**
 * T146 — the Mac draws an HTML report in the app (backlog 「앱 안 브라우저」, decision 0013). Electron-free:
 *
 *  - the split's list with document panes: put beside (from one session, into a split, refused at 4), close (one session
 *    left → single view, a document alone stays, nothing left → the session it was put beside), `doc:` ids skipped
 *  - the scheme's contract: a token per document folder, the policy (sandbox, `connect-src 'none'`, sources = the
 *    token's folder), what may load beside (types, dot files, links out, shared folders), the 64 MB limit, the bridge
 *    put after the doctype and before the page
 */

test.describe('T146 split view with document panes', () => {
    test('from the single view a document opens a split beside the session on screen, which stays active', () => {
        expect(splitWithDoc(null, 0, 's1', 'doc:1')).toEqual({ kind: 'layout', sessionIds: ['s1', 'doc:1'], activeIndex: 0 })
        // no session on screen: the document alone
        expect(splitWithDoc(null, 0, null, 'doc:1')).toEqual({ kind: 'layout', sessionIds: ['doc:1'], activeIndex: 0 })
    })

    test('in split view it takes the next place; at the limit it is refused, with the reason', () => {
        expect(splitWithDoc(['s1', 's2'], 1, null, 'doc:1')).toEqual({ kind: 'layout', sessionIds: ['s1', 's2', 'doc:1'], activeIndex: 1 })
        expect(splitWithDoc(['s1', 's2', 's3'], 2, null, 'doc:1')).toEqual({ kind: 'layout', sessionIds: ['s1', 's2', 's3', 'doc:1'], activeIndex: 2 })
        const full = ['s1', 's2', 's3', 'doc:1']
        expect(full.length).toBe(MAX_LINKED_SESSIONS)
        expect(splitWithDoc(full, 0, null, 'doc:2')).toEqual({ kind: 'full' })
        expect(docSideBlockedReason(full)).toContain(`${MAX_LINKED_SESSIONS} panes`)
        expect(docSideBlockedReason(['s1', 's2', 's3'])).toBeNull()
        expect(docSideBlockedReason(null)).toBeNull()
    })

    test('closing a pane: one session left is the single view; a document alone stays; nothing left returns', () => {
        expect(splitAfterRemove(['s1', 'doc:1'], 1, 'doc:1', 's1')).toEqual({ kind: 'single', sessionId: 's1' })
        expect(splitAfterRemove(['s1', 'doc:1'], 0, 's1', 's1')).toEqual({ kind: 'layout', sessionIds: ['doc:1'], activeIndex: 0 })
        expect(splitAfterRemove(['doc:1'], 0, 'doc:1', 's1')).toEqual({ kind: 'single', sessionId: 's1' })
        expect(splitAfterRemove(['doc:1'], 0, 'doc:1', null)).toEqual({ kind: 'none' })
        // the old rule for sessions is unchanged: the active index follows the removed one
        expect(splitAfterRemove(['s1', 's2', 's3'], 2, 's1', null)).toEqual({ kind: 'layout', sessionIds: ['s2', 's3'], activeIndex: 1 })
        expect(splitAfterRemove(['s1', 's2', 's3'], 0, 's3', null)).toEqual({ kind: 'layout', sessionIds: ['s1', 's2'], activeIndex: 0 })
        expect(splitAfterRemove(['s1', 's2', 'doc:1', 'doc:2'], 3, 'doc:2', null)).toEqual({ kind: 'layout', sessionIds: ['s1', 's2', 'doc:1'], activeIndex: 2 })
        expect(splitAfterRemove(['s1', 's2'], 1, 's2', null)).toEqual({ kind: 'single', sessionId: 's1' })
    })

    test('document ids are not sessions', () => {
        expect(isDocPaneId('doc:3')).toBe(true)
        expect(isDocPaneId('7d2a-doc:')).toBe(false)
        expect(sessionPaneIds(['s1', 'doc:1', 's2', 'doc:2'])).toEqual(['s1', 's2'])
    })
})

test.describe('T146 the document scheme', () => {
    let dir = ''
    let home = ''
    let project = ''
    let tokens: DocPreviewTokens
    test.beforeEach(() => {
        dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't146-')))
        home = path.join(dir, 'home')
        project = path.join(home, 'work', 'review')
        fs.mkdirSync(project, { recursive: true })
        tokens = new DocPreviewTokens()
    })
    test.afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

    const write = (relative: string, content: string | Buffer, root = project): string => {
        const file = path.join(root, relative)
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, content)
        return file
    }
    const opened = async (file: string): Promise<string> => {
        const result = await openDocPreview(file, tokens, home)
        if (result.status !== 'ok') throw new Error(`refused: ${result.reason}`)
        return result.url
    }
    const besideOf = (url: string, name: string): string => url.replace(/[^/]+$/, name)
    const get = (url: string, method = 'GET'): Promise<Response> => serveDocPreview(url, method, tokens)

    test('a document gets an address under a token; refusals say why', async () => {
        const report = write('report.html', '<!doctype html><title>R</title><p>hi')
        const url = await opened(report)
        expect(url).toMatch(/^climanager-doc:\/\/doc\/[A-Za-z0-9_-]{32}\/report\.html$/)
        expect(new URL(url).host).toBe('doc')
        expect(await openDocPreview(path.join(project, 'missing.html'), tokens, home)).toMatchObject({ status: 'refused', reason: 'not_found' })
        expect(await openDocPreview('relative/report.html', tokens, home)).toMatchObject({ status: 'refused', reason: 'not_found' })
        expect(await openDocPreview(write('notes.txt', 'x'), tokens, home)).toMatchObject({ status: 'refused', reason: 'not_html' })
        // the name on disk decides: report2.html → notes.txt is not a page
        fs.symlinkSync(path.join(project, 'notes.txt'), path.join(project, 'report2.html'))
        expect(await openDocPreview(path.join(project, 'report2.html'), tokens, home)).toMatchObject({ status: 'refused', reason: 'not_html' })
        fs.mkdirSync(path.join(project, 'folder.html'))
        expect(await openDocPreview(path.join(project, 'folder.html'), tokens, home)).toMatchObject({ status: 'refused', reason: 'not_a_file' })
        expect(await openDocPreview(write('utf16.html', Buffer.from([0xff, 0xfe, 0x3c, 0x00])), tokens, home)).toMatchObject({ status: 'refused', reason: 'bad_encoding' })
    })

    test('64 MB is drawn; one byte more is refused (a sparse file, nothing written)', async () => {
        const edge = path.join(project, 'edge.html')
        fs.writeFileSync(edge, '<p>x')
        fs.truncateSync(edge, DOC_PREVIEW_MAX_BYTES)
        expect((await openDocPreview(edge, tokens, home)).status).toBe('ok')
        fs.truncateSync(edge, DOC_PREVIEW_MAX_BYTES + 1)
        expect(await openDocPreview(edge, tokens, home)).toMatchObject({ status: 'refused', reason: 'too_large' })
    })

    test('the document comes with the policy and the bridge, after the doctype and before the page', async () => {
        const body = '<!doctype html>\n<!-- note --><html lang="ko"><head><meta charset="utf-8"><title>보고서</title></head><body><p>본문</p></body></html>'
        const url = await opened(write('report.html', body))
        const response = await get(url)
        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
        expect(response.headers.get('cache-control')).toBe('no-store')
        const base = besideOf(url, '')
        const csp = response.headers.get('content-security-policy') ?? ''
        expect(csp).toBe(docPreviewContentSecurityPolicy(base))
        expect(csp.startsWith(`sandbox ${DOC_PREVIEW_SANDBOX};`)).toBe(true)
        expect(DOC_PREVIEW_SANDBOX).not.toContain('allow-same-origin')
        expect(csp).toContain("connect-src 'none'")
        expect(csp).toContain("form-action 'none'")
        expect(csp).toContain(`img-src data: blob: ${base}`)
        expect(csp).not.toContain("'self'")
        const text = await response.text()
        expect(text).toBe(`<!doctype html>\n<!-- note --><script>${DOC_PREVIEW_BRIDGE}</script><html lang="ko"><head><meta charset="utf-8"><title>보고서</title></head><body><p>본문</p></body></html>`)
        expect(/^[\x00-\x7f]*$/.test(DOC_PREVIEW_BRIDGE), 'the bridge is ASCII, whatever the page').toBe(true)
        expect(DOC_PREVIEW_BRIDGE).not.toMatch(/<\/script/i)
        expect((await get(url, 'HEAD')).status).toBe(200)
        expect((await get(url, 'POST')).status).toBe(405)
    })

    test('beside the document: the types a page loads, nothing hidden, nothing out of the folder', async () => {
        const url = await opened(write('report.html', '<p>x'))
        write('pic.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]))
        write('assets/app.js', 'void 0')
        write('assets/font.woff2', 'wOF2')
        write('data.json', '{"secret":1}')
        write('.env', 'KEY=1')
        write('.hidden/pic.png', 'x')
        write('other.html', '<p>other')
        const outside = write('secret.png', 'outside', path.join(home, 'work'))
        fs.symlinkSync(outside, path.join(project, 'escape.png'))
        fs.symlinkSync(path.join(project, 'data.json'), path.join(project, 'data.js'))

        const png = await get(besideOf(url, 'pic.png'))
        expect(png.status).toBe(200)
        expect(png.headers.get('content-type')).toBe('image/png')
        expect(png.headers.get('access-control-allow-origin')).toBeNull()
        const font = await get(besideOf(url, 'assets/font.woff2'))
        expect(font.status).toBe(200)
        expect(font.headers.get('access-control-allow-origin'), 'a font is a CORS request from the null origin').toBe('null')
        expect((await get(besideOf(url, 'assets/app.js'))).status).toBe(200)
        expect((await get(besideOf(url, 'other.html'))).status, 'another page of the folder').toBe(200)
        for (const refused of ['data.json', '.env', '.hidden/pic.png', 'escape.png', 'data.js', '..%2Fsecret.png', '%2E%2E/secret.png', 'missing.png', '%E0%A4%A']) {
            expect((await get(besideOf(url, refused))).status, refused).toBe(404)
        }
        // another token, or none
        expect((await get(url.replace(/doc\/[^/]+\//, 'doc/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/'))).status).toBe(404)
        expect((await get('climanager-doc://other/x/report.html')).status).toBe(404)
        expect((await get('https://doc/x/report.html')).status).toBe(404)
    })

    test('a document kept directly in a shared folder (home, Downloads, temp) loads alone', async () => {
        const inHome = write('home-report.html', '<p>x', home)
        write('pic.png', 'png', home)
        const url = await opened(inHome)
        expect((await get(url)).status).toBe(200)
        expect((await get(besideOf(url, 'pic.png'))).status).toBe(404)
        const downloads = write('report.html', '<p>x', path.join(home, 'Downloads'))
        write('pic.png', 'png', path.join(home, 'Downloads'))
        const downloadsUrl = await opened(downloads)
        expect((await get(besideOf(downloadsUrl, 'pic.png'))).status).toBe(404)
    })

    test('the relative path is plain segments; the document may be hidden', () => {
        expect(docPreviewRelativePath('a/b.png', 'r.html')).toBe('a/b.png')
        expect(docPreviewRelativePath('.r.html', '.r.html')).toBe('.r.html')
        expect(docPreviewRelativePath('.x.png', '.r.html')).toBeNull()
        expect(docPreviewRelativePath('a//b.png', 'r.html')).toBeNull()
        expect(docPreviewRelativePath('a%5Cb.png', 'r.html')).toBeNull()
        expect(docPreviewRelativePath('a%00.png', 'r.html')).toBeNull()
    })

    test('tokens: one per open, the oldest go past 32', async () => {
        const report = write('report.html', '<p>x')
        const first = await opened(report)
        const second = await opened(report)
        expect(first).not.toBe(second)
        for (let i = 0; i < 32; i++) await opened(report)
        expect((await get(first)).status).toBe(404)
        expect(docPreviewBase('T')).toBe('climanager-doc://doc/T/')
    })
})
