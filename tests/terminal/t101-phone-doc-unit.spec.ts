import { test, expect } from '@playwright/test'
import fs from 'fs'
import http from 'http'
import os from 'os'
import path from 'path'
import { sameOrigin } from '../../src/main/phone/phoneAccess'
import { PhoneDevices } from '../../src/main/phone/PhoneDevices'
import { PhoneServer } from '../../src/main/phone/PhoneServer'
import { bridgeOffset, docContentSecurityPolicy, docRelativePath, documentCharset, documentTitle, PhoneDocTokens } from '../../src/main/phone/phoneDoc'
import { PHONE_DOC_BRIDGE } from '../../src/main/phone/phoneDocBridge'
import { commentTooLong, composeComment, frameAddress, fromDocFrame, keepDocStore, parseDocMessage, readDocStore, sendOutcome } from '../../src/renderer/src/phone/docMessages'
import { PHONE_DOC_SANDBOX, PHONE_MAX_COMMENT_CHARS, PHONE_MAX_DOC_BYTES, PHONE_MAX_DOC_STORE_BYTES, type PhoneDocOpened, type PhoneDocRefused } from '../../src/shared/phone'
import type { ChatSendResult } from '../../src/shared/conversation'

/**
 * T101 — a report's sandboxed frame (decision 0011), without Electron: the real file system, the real PhoneServer on a
 * real port, a real paired device. The token stands for step 4 of the file judgement and for nothing else, so the same
 * refusals apply beside a document as anywhere else. Plain requests here carry no cookie on purpose: that is what a
 * sandboxed page's pictures look like in Chromium.
 */

const SESSION = 's-doc'
const SHELL = 's-shell'

interface Harness {
    home: string
    project: string
    named: Set<string>
    base: string
    devices: PhoneDevices
    logged: string[]
    drive: string
    server: PhoneServer
    stop(): Promise<void>
}

function namedFile(h: Harness, relative: string, content: string | Buffer, root = h.project): string {
    const file = path.join(root, relative)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
    h.named.add(file)
    return file
}

async function startHarness(): Promise<Harness> {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't101-home-')))
    const project = path.join(home, 'project')
    fs.mkdirSync(project)
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 't101-data-'))
    const devices = new PhoneDevices(path.join(data, 'devices.json'))
    const named = new Set<string>()
    const logged: string[] = []
    const push = { forgetOwner: () => undefined, publicKey: () => 'key', keysProblem: () => null, count: () => 0, onStatus: () => undefined }
    const server = new PhoneServer({
        devices,
        push: push as never,
        tailscale: { read: async () => ({ found: false, owner: null, dnsName: null }), peek: () => null } as never,
        staticDir: data,
        onStateChange: () => undefined,
        statusPoller: { start: () => undefined, stop: () => undefined },
        listSessions: () =>
            ({
                sessions: [
                    { id: SESSION, name: 'Agent', workspaceId: 'w', workspaceName: 'W', agent: 'claude', state: 'idle' },
                    { id: SHELL, name: 'Shell', workspaceId: 'w', workspaceName: 'W', agent: null, state: 'idle' }
                ],
                sessionFolders: []
            }) as never,
        sessionExists: (id: string) => id === SESSION || id === SHELL,
        conversation: { mentionedPaths: async () => ({ paths: named, cwd: project }), send: async () => ({ status: 'sent' }) } as never,
        saveAttachment: () => ({ status: 'attached', path: '/tmp/x' }) as never,
        maskLine: (text: string) => text,
        recordPhoneInput: () => undefined,
        terminals: {} as never,
        subscribeConversation: () => () => undefined,
        files: {
            home,
            protectedPlaces: [data],
            maskLines: (lines) => ({ lines, masked: 0 }),
            record: (_id, detail) => logged.push(detail)
        }
    })
    const state = await server.apply({ enabled: true, port: 0 } as never)
    expect(state.running).toBe(true)
    const { code } = devices.startPairing('drive')
    const paired = devices.pair(code, 'Phone')
    if ('error' in paired) throw new Error(paired.error)
    return { home, project, named, base: `http://127.0.0.1:${state.port}`, devices, logged, drive: `climanager_phone=${paired.token}`, server, stop: () => server.stop() }
}

async function open(h: Harness, target: string, options: { session?: string; cookie?: string; headers?: Record<string, string> } = {}): Promise<{ status: number; body: PhoneDocOpened | PhoneDocRefused }> {
    const response = await fetch(`${h.base}/api/phone/doc/open`, {
        method: 'POST',
        headers: { cookie: options.cookie ?? h.drive, 'Content-Type': 'application/json', ...options.headers },
        body: JSON.stringify({ session: options.session ?? SESSION, path: target })
    })
    return { status: response.status, body: (await response.json()) as PhoneDocOpened | PhoneDocRefused }
}

async function opened(h: Harness, target: string): Promise<PhoneDocOpened> {
    const { status, body } = await open(h, target)
    expect(status, JSON.stringify(body)).toBe(200)
    return body as PhoneDocOpened
}

/** No cookie: a sandboxed page's own request. */
const fromFrame = (h: Harness, url: string, init?: RequestInit): Promise<Response> => fetch(`${h.base}${url}`, init)
const beside = (doc: PhoneDocOpened, relative: string): string => `${doc.url.slice(0, doc.url.lastIndexOf('/'))}/${relative}`

let h: Harness
test.beforeEach(async () => {
    h = await startHarness()
})
test.afterEach(async () => {
    await h.stop()
})

test.describe('T101 opening a document: a token, through the same judgement as any file', () => {
    test('the answer holds a token address, the title, the folder as ~ and the session', async () => {
        const file = namedFile(h, 'review/report.html', '<!doctype html><title>The &amp; report</title><p>hi')
        const doc = await opened(h, file)
        expect(doc.url).toMatch(/^\/doc\/[A-Za-z0-9_-]{43}\/report\.html$/)
        expect(doc.url, 'the Mac path is not in the address').not.toContain('project')
        expect(doc.title).toBe('The & report')
        expect(doc.displayRoot).toBe('~/project/review')
        expect(doc.rel).toBe('report.html')
        expect(doc.target).toEqual({ id: SESSION, name: 'Agent', agent: 'claude' })
        expect(doc.storeKey).toMatch(/^[0-9a-f]{32}$/)
        expect(doc.rawUrl).toContain('/api/phone/file/raw?')
        expect(h.logged.some((line) => /^document opened \(html, /.test(line))).toBe(true)
        expect(h.logged.join(' '), 'the log has no paths').not.toContain('review')
    })

    test('a session without an agent has no target: the sheet asks', async () => {
        const file = namedFile(h, 'a.html', '<p>x')
        const { body } = await open(h, file, { session: SHELL })
        expect((body as PhoneDocOpened).target).toBeNull()
    })

    test('no title: the file name', async () => {
        expect((await opened(h, namedFile(h, 'plain.html', '<p>x'))).title).toBe('plain.html')
    })

    test('refused as the file route refuses', async () => {
        const unnamed = path.join(h.project, 'never.html')
        fs.writeFileSync(unnamed, '<p>x')
        const asked = async (target: string, session?: string): Promise<[number, string]> => {
            const { status, body } = await open(h, target, { session })
            return [status, (body as PhoneDocRefused).reason]
        }
        expect(await asked(unnamed)).toEqual([403, 'not_mentioned'])
        expect(await asked(namedFile(h, '.secrets/inside.html', '<p>x'))).toEqual([403, 'protected'])
        expect(await asked(namedFile(h, 'notes.txt', 'words'))).toEqual([415, 'not_html'])
        h.named.add(path.join(h.project, 'gone.html'))
        expect(await asked(path.join(h.project, 'gone.html'))).toEqual([404, 'not_found'])
        expect(await asked(namedFile(h, 'a.html', '<p>x'), 'no-such-session')).toEqual([404, 'unknown_session'])
        expect(await asked('relative/path.html')).toEqual([400, 'bad_path'])
    })

    test('64 MB: the limit is the document’s own, far past the 500 KB of a text preview', async () => {
        const at = namedFile(h, 'at-limit.html', '')
        fs.truncateSync(at, PHONE_MAX_DOC_BYTES)
        expect((await open(h, at)).status).toBe(200)
        const over = namedFile(h, 'over-limit.html', '')
        fs.truncateSync(over, PHONE_MAX_DOC_BYTES + 1)
        const { status, body } = await open(h, over)
        expect(status).toBe(413)
        expect((body as PhoneDocRefused).reason).toBe('too_large')
    })

    test('a link named report.html that points at a text file is not a document', async () => {
        const text = namedFile(h, 'notes.txt', 'words')
        const link = path.join(h.project, 'report.html')
        fs.symlinkSync(text, link)
        h.named.add(link)
        const { status, body } = await open(h, link)
        expect(status).toBe(415)
        expect((body as PhoneDocRefused).reason).toBe('not_html')
    })

    test('a UTF-16 page is refused: the bridge in front of it would be garbage', async () => {
        const file = namedFile(h, 'wide.html', Buffer.from([0xff, 0xfe, 0x3c, 0x00, 0x70, 0x00]))
        expect((await open(h, file)).status).toBe(415)
    })

    test('a view-only device gets no document', async () => {
        const file = namedFile(h, 'a.html', '<p>x')
        const { code } = h.devices.startPairing('watch')
        const paired = h.devices.pair(code, 'Watcher')
        if ('error' in paired) throw new Error(paired.error)
        const { status, body } = await open(h, file, { cookie: `climanager_phone=${paired.token}` })
        expect(status).toBe(403)
        expect((body as PhoneDocRefused).reason).toBe('view_only')
    })

    test('no cookie, and a page of another origin: refused before any of it', async () => {
        const file = namedFile(h, 'a.html', '<p>x')
        expect((await open(h, file, { cookie: 'none=1' })).status).toBe(401)
        // a sandboxed frame's Origin. WebKit sends the phone's cookie with it, so this refusal is what stands (decision 0011)
        expect((await open(h, file, { headers: { Origin: 'null' } })).status).toBe(403)
        expect((await open(h, file, { headers: { Origin: 'https://evil.example' } })).status).toBe(403)
    })

    test('GET mints nothing: a page could ask for it with an <img>', async () => {
        const response = await fetch(`${h.base}/api/phone/doc/open`, { headers: { cookie: h.drive } })
        expect(response.status).toBe(405)
    })
})

test.describe('T101 what a token serves', () => {
    test('the document: sandboxed, its folder only, the bridge in front, nothing cached', async () => {
        const doc = await opened(h, namedFile(h, 'review/report.html', '<!doctype html><html lang="ko"><title>한글</title><p>본문</p></html>'))
        const response = await fromFrame(h, doc.url)
        expect(response.status).toBe(200)
        const token = doc.url.split('/')[2]
        const policy = response.headers.get('content-security-policy')!
        expect(policy).toBe(docContentSecurityPolicy(`${h.base}/doc/${token}/`))
        expect(policy.startsWith(`sandbox ${PHONE_DOC_SANDBOX};`)).toBe(true)
        expect(policy).not.toContain('allow-same-origin')
        expect(policy).toContain("connect-src 'none'")
        expect(policy).toContain("form-action 'none'")
        // the token's folder, not 'self': 'self' lets <img src="/api/…"> reach the server (measured)
        expect(policy).not.toContain("'self' ")
        expect(policy).toContain("frame-ancestors 'self'")
        expect(response.headers.get('cache-control')).toBe('no-store')
        expect(response.headers.get('x-content-type-options')).toBe('nosniff')
        expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
        const body = await response.text()
        expect(body.startsWith('<!doctype html><script>')).toBe(true)
        expect(body).toContain('__climDocBridge')
        expect(body).toContain('<html lang="ko"><title>한글</title><p>본문</p></html>')
        expect(Number(response.headers.get('content-length'))).toBe(Buffer.byteLength(body))
    })

    test('https behind serve: the policy names https and the MagicDNS host', async () => {
        const doc = await opened(h, namedFile(h, 'a.html', '<p>x'))
        const token = doc.url.split('/')[2]
        const url = new URL(`${h.base}${doc.url}`)
        const policy = await new Promise<string>((resolve, reject) => {
            const request = http.request({ host: '127.0.0.1', port: url.port, path: url.pathname, headers: { Host: 'mac.tail1234.ts.net', 'X-Forwarded-Proto': 'https' } }, (response) => {
                response.resume()
                resolve(String(response.headers['content-security-policy']))
            })
            request.on('error', reject)
            request.end()
        })
        expect(policy).toBe(docContentSecurityPolicy(`https://mac.tail1234.ts.net/doc/${token}/`))
    })

    test('files a page loads come without a cookie, typed', async () => {
        const doc = await opened(h, namedFile(h, 'review/report.html', '<p>x'))
        namedFile(h, 'review/shots/a.png', Buffer.from([1, 2, 3]))
        namedFile(h, 'review/s.css', 'p{}')
        namedFile(h, 'review/f.woff2', Buffer.from([4]))
        h.named.clear()
        const image = await fromFrame(h, beside(doc, 'shots/a.png'))
        expect(image.status).toBe(200)
        expect(image.headers.get('content-type')).toBe('image/png')
        expect(image.headers.get('content-security-policy')).toContain('sandbox')
        expect(image.headers.get('access-control-allow-origin')).toBeNull()
        expect(Buffer.from(await image.arrayBuffer())).toEqual(Buffer.from([1, 2, 3]))
        expect((await fromFrame(h, beside(doc, 's.css'))).headers.get('content-type')).toContain('text/css')
        // a font is requested with CORS even from the same host, and the page's origin is null
        expect((await fromFrame(h, beside(doc, 'f.woff2'))).headers.get('access-control-allow-origin')).toBe('null')
    })

    test('a page beside it gets the bridge too', async () => {
        const doc = await opened(h, namedFile(h, 'report.html', '<p>x'))
        namedFile(h, 'other.html', '<p>y')
        expect(await (await fromFrame(h, beside(doc, 'other.html'))).text()).toContain('__climDocBridge')
    })

    test('nothing else leaves the folder', async () => {
        const doc = await opened(h, namedFile(h, 'review/report.html', '<p>x'))
        const refused = async (relative: string): Promise<number> => (await fromFrame(h, beside(doc, relative))).status
        namedFile(h, 'review/.env', 'API_TOKEN=abc')
        namedFile(h, 'review/data.json', '{}')
        namedFile(h, 'review/notes.txt', 'words')
        namedFile(h, 'review/.hidden/a.png', Buffer.from([1]))
        namedFile(h, 'review/key.pem', 'x')
        namedFile(h, 'review/credentials.png', Buffer.from([1]))
        namedFile(h, 'outside.png', Buffer.from([1]))
        namedFile(h, 'review/huge.png', '')
        fs.truncateSync(path.join(h.project, 'review/huge.png'), 10_000_001)
        expect(await refused('.env')).toBe(404)
        expect(await refused('data.json')).toBe(404)
        expect(await refused('notes.txt')).toBe(404)
        expect(await refused('.hidden/a.png')).toBe(404)
        expect(await refused('key.pem')).toBe(404)
        expect(await refused('credentials.png')).toBe(404)
        expect(await refused('huge.png')).toBe(404)
        expect(await refused('..%2Foutside.png')).toBe(404)
        expect(await refused('a%2F..%2F..%2Foutside.png')).toBe(404)
        expect(await refused('%2e%2e/outside.png')).toBe(404)
        expect(await refused('..\\outside.png')).toBe(404)
        expect(await refused('missing.png')).toBe(404)
        expect(await refused('%E0%A4%A')).toBe(404)
    })

    test('a link out of the folder is out of the folder, wherever it points', async () => {
        const doc = await opened(h, namedFile(h, 'review/report.html', '<p>x'))
        const outside = namedFile(h, 'outside.png', Buffer.from([1]))
        fs.symlinkSync(outside, path.join(h.project, 'review/out.png'))
        const inside = namedFile(h, 'review/real.png', Buffer.from([2]))
        fs.symlinkSync(inside, path.join(h.project, 'review/in.png'))
        fs.mkdirSync(path.join(h.home, '.ssh'))
        fs.writeFileSync(path.join(h.home, '.ssh/id.png'), 'x')
        fs.symlinkSync(path.join(h.home, '.ssh/id.png'), path.join(h.project, 'review/key.png'))
        expect((await fromFrame(h, beside(doc, 'out.png'))).status).toBe(404)
        expect((await fromFrame(h, beside(doc, 'key.png'))).status).toBe(404)
        expect((await fromFrame(h, beside(doc, 'in.png'))).status).toBe(200)
    })

    test('a document in a shared folder brings nothing beside it', async () => {
        const doc = await opened(h, namedFile(h, 'home-report.html', '<p>x', h.home))
        namedFile(h, 'beside.png', Buffer.from([1]), h.home)
        expect((await fromFrame(h, doc.url)).status).toBe(200)
        expect((await fromFrame(h, beside(doc, 'beside.png'))).status).toBe(404)
        const downloads = await opened(h, namedFile(h, 'Downloads/d.html', '<p>x', h.home))
        namedFile(h, 'Downloads/photo.png', Buffer.from([1]), h.home)
        expect((await fromFrame(h, beside(downloads, 'photo.png'))).status).toBe(404)
    })

    test('HEAD has the headers and no body; other methods are refused', async () => {
        const doc = await opened(h, namedFile(h, 'a.html', '<p>x'))
        const head = await fromFrame(h, doc.url, { method: 'HEAD' })
        expect(head.status).toBe(200)
        expect(head.headers.get('content-security-policy')).toContain('sandbox')
        expect(await head.text()).toBe('')
        expect((await fromFrame(h, doc.url, { method: 'POST', body: 'x' })).status).toBe(405)
    })

    test('Funnel is refused whatever the token: this route is outside /api/, so it asks itself', async () => {
        const doc = await opened(h, namedFile(h, 'a.html', '<p>x'))
        const response = await fromFrame(h, doc.url, { headers: { 'Tailscale-Funnel-Request': '?1' } })
        expect(response.status).toBe(403)
        expect(((await response.json()) as { error: string }).error).toBe('funnel')
    })

    test('a wrong Host is refused before the token is looked at', async () => {
        const doc = await opened(h, namedFile(h, 'a.html', '<p>x'))
        const status = await new Promise<number>((resolve, reject) => {
            const url = new URL(`${h.base}${doc.url}`)
            const request = http.request({ host: '127.0.0.1', port: url.port, path: url.pathname, headers: { Host: 'evil.example' } }, (response) => {
                response.resume()
                resolve(response.statusCode ?? 0)
            })
            request.on('error', reject)
            request.end()
        })
        expect(status).toBe(421)
    })

    test('a made-up token, or none, is the same 404 as a missing file', async () => {
        const doc = await opened(h, namedFile(h, 'a.html', '<p>x'))
        expect((await fromFrame(h, doc.url.replace(/\/doc\/[^/]+/, '/doc/wrongwrongwrong'))).status).toBe(404)
        expect((await fromFrame(h, '/doc/')).status).toBe(404)
    })

    test('disconnecting the device ends its tokens and the bytes on their way', async () => {
        const doc = await opened(h, namedFile(h, 'big.html', Buffer.alloc(40 * 1024 * 1024, 0x20)))
        const device = h.devices.list()[0]
        const url = new URL(`${h.base}${doc.url}`)
        const received = await new Promise<{ bytes: number; ended: boolean }>((resolve, reject) => {
            const request = http.get({ host: '127.0.0.1', port: url.port, path: url.pathname }, (response) => {
                let bytes = 0
                let revoked = false
                response.on('data', (chunk: Buffer) => {
                    bytes += chunk.length
                    if (!revoked) {
                        revoked = true
                        h.devices.revoke(device.id)
                    }
                })
                response.on('end', () => resolve({ bytes, ended: true }))
                response.on('error', () => resolve({ bytes, ended: false }))
                response.on('close', () => resolve({ bytes, ended: false }))
            })
            request.on('error', reject)
        })
        expect(received.bytes, 'not all of it').toBeLessThan(40 * 1024 * 1024)
        expect(received.ended, 'the stream was cut').toBe(false)
        expect((await fromFrame(h, doc.url)).status).toBe(404)
    })

    test('switching the phone off ends every token', async () => {
        const doc = await opened(h, namedFile(h, 'a.html', '<p>x'))
        const state = await h.server.apply({ enabled: false } as never)
        expect(state.running).toBe(false)
        const again = await h.server.apply({ enabled: true, port: Number(new URL(h.base).port) } as never)
        expect(again.running).toBe(true)
        expect((await fromFrame(h, doc.url)).status).toBe(404)
    })

    test('a 50 MB document streams: the process keeps running while it goes', async () => {
        const file = namedFile(h, 'big.html', Buffer.alloc(50 * 1024 * 1024, 0x20))
        const doc = await opened(h, file)
        let worst = 0
        let last = performance.now()
        const timer = setInterval(() => {
            const now = performance.now()
            worst = Math.max(worst, now - last)
            last = now
        }, 5)
        const response = await fromFrame(h, doc.url)
        const size = (await response.arrayBuffer()).byteLength
        clearInterval(timer)
        expect(size).toBe(Number(response.headers.get('content-length')))
        expect(size).toBeGreaterThan(50 * 1024 * 1024)
        // a readFileSync and one big write would be one long stall; the machine may be busy, so the bound is generous
        expect(worst).toBeLessThan(1000)
    })

    test('the tokens: half an hour from the last request, eight per device', () => {
        let now = 1_000_000
        const tokens = new PhoneDocTokens(() => now)
        const access = { level: 'full', role: 'drive', via: 'device', deviceId: 'd1' } as never
        const mint = (owner: string, deviceAccess = access): string => tokens.mint({ root: '/r', sideFiles: true, document: 'a.html', access: deviceAccess, owner }).token
        const first = mint('device:d1')
        now += 29 * 60 * 1000
        expect(tokens.use(first)).not.toBeNull()
        now += 29 * 60 * 1000
        expect(tokens.use(first), 'a request started the half hour again').not.toBeNull()
        now += 31 * 60 * 1000
        expect(tokens.use(first)).toBeNull()

        const minted = Array.from({ length: 9 }, () => {
            now += 1
            return mint('device:d1')
        })
        expect(tokens.use(minted[0]), 'the oldest of nine went').toBeNull()
        expect(tokens.use(minted[8])).not.toBeNull()
        const other = mint('tailscale:me', { level: 'full', role: 'drive', via: 'tailscale', login: 'me' } as never)
        expect(tokens.use(other), 'another device has its own eight').not.toBeNull()

        tokens.forgetDevice('someone-else')
        expect(tokens.use(minted[8])).not.toBeNull()
        tokens.forgetDevice('d1')
        expect(tokens.use(minted[8])).toBeNull()
        expect(tokens.use(other), 'the owner cannot be disconnected').not.toBeNull()
        tokens.clear()
        expect(tokens.use(other)).toBeNull()
    })
})

test.describe('T101 where the bridge goes', () => {
    const offset = (text: string): number => bridgeOffset(Buffer.from(text, 'latin1'))

    test('past what must stay first, before anything else', () => {
        expect(offset('<!doctype html><html><head>')).toBe('<!doctype html>'.length)
        expect(offset('<!DOCTYPE html>\n  <html>')).toBe('<!DOCTYPE html>\n  '.length)
        expect(offset('<html><head>')).toBe(0)
        expect(offset('<p>no head at all')).toBe(0)
        expect(offset('')).toBe(0)
        expect(offset('\xef\xbb\xbf<!doctype html><p>')).toBe(3 + '<!doctype html>'.length)
        expect(offset('<?xml version="1.0"?><!doctype html><p>')).toBe('<?xml version="1.0"?><!doctype html>'.length)
    })

    test('a comment holding <head> is a comment', () => {
        const text = '<!-- <head> in a comment --><!doctype html><head><title>x'
        expect(offset(text)).toBe('<!-- <head> in a comment --><!doctype html>'.length)
    })

    test('an unclosed comment or doctype: stops rather than running off the end', () => {
        expect(offset('<!-- never closed')).toBe(0)
        expect(offset('<!doctype html')).toBe(0)
    })

    test('the charset is said in the header: the bridge pushes the meta past what a browser reads', () => {
        const ascii = (text: string): Buffer => Buffer.from(text, 'latin1')
        expect(documentCharset(ascii('<meta charset="euc-kr">'))).toBe('euc-kr')
        expect(documentCharset(ascii('<meta http-equiv="Content-Type" content="text/html; charset=EUC-KR">'))).toBe('euc-kr')
        expect(documentCharset(ascii('<p>none'))).toBe('utf-8')
        expect(documentCharset(Buffer.from([0xef, 0xbb, 0xbf, 0x3c]))).toBe('utf-8')
        expect(documentCharset(Buffer.from([0xff, 0xfe, 0x3c, 0x00]))).toBeNull()
        expect(documentCharset(Buffer.from([0xfe, 0xff, 0x00, 0x3c]))).toBeNull()
        expect(documentCharset(ascii('<meta charset="utf-16">'))).toBeNull()
        // what a page wrote must not become a header
        expect(documentCharset(ascii('<meta charset="a\r\nX-Evil: 1">'))).toBe('a')
    })

    test('the title', () => {
        expect(documentTitle(Buffer.from('<title>  두 줄\n제목 &lt;b&gt; </title>'))).toBe('두 줄 제목 <b>')
        expect(documentTitle(Buffer.from('<p>none'))).toBeNull()
        expect(documentTitle(Buffer.from('<title></title>'))).toBeNull()
    })

    test('the script itself: ASCII, one script, valid', () => {
        // eslint-disable-next-line no-control-regex
        expect(/^[\x00-\x7f]*$/.test(PHONE_DOC_BRIDGE)).toBe(true)
        expect(PHONE_DOC_BRIDGE.toLowerCase()).not.toContain('</script')
        expect(() => new Function(PHONE_DOC_BRIDGE)).not.toThrow()
    })

    test('a relative path names segments, or nothing', () => {
        expect(docRelativePath('a.png')).toBe('a.png')
        expect(docRelativePath('shots/%ED%95%9C%EA%B8%80.png')).toBe('shots/한글.png')
        for (const bad of ['', '..%2Fa.png', 'a%2F..%2Fb.png', '.env', 'a/.git/config', '%2Fetc%2Fpasswd', 'a%5Cb.png', 'a//b.png', '%E0%A4%A']) expect(docRelativePath(bad), bad).toBeNull()
    })

    test('the rule the frame leans on: an opaque origin is never this page’s', () => {
        expect(sameOrigin('null', '127.0.0.1:47830')).toBe(false)
        expect(sameOrigin('https://mac.tail.ts.net', 'mac.tail.ts.net')).toBe(true)
    })
})

test.describe('T101 what a frame may say', () => {
    test('only what is well formed', () => {
        expect(parseDocMessage({ type: 'doc-comment', text: 'hi', via: 'clipboard' })).toEqual({ type: 'doc-comment', text: 'hi', via: 'clipboard' })
        expect(parseDocMessage({ type: 'doc-ready', title: 't', path: 'a.html', extra: 1 })).toEqual({ type: 'doc-ready', title: 't', path: 'a.html' })
        expect(parseDocMessage({ type: 'doc-store', value: '{}' })).toEqual({ type: 'doc-store', value: '{}' })
        expect(parseDocMessage({ type: 'doc-link', url: 'https://a.example/x' })?.type).toBe('doc-link')
        expect(parseDocMessage({ type: 'doc-link', url: 'mailto:a@b.c' })?.type).toBe('doc-link')
        expect(parseDocMessage({ type: 'doc-open', path: '/Users/x/a.html' })?.type).toBe('doc-open')
        expect(parseDocMessage({ type: 'doc-missing', count: 3 })?.type).toBe('doc-missing')
        for (const bad of [
            null,
            'text',
            42,
            {},
            { type: 'doc-comment', text: '   ', via: 'clipboard' },
            { type: 'doc-comment', text: 'hi' },
            { type: 'doc-comment', text: 'hi', via: 'carrier-pigeon' },
            { type: 'doc-comment', text: 7, via: 'clipboard' },
            { type: 'doc-comment', text: 'x'.repeat(PHONE_MAX_COMMENT_CHARS * 4 + 1), via: 'clipboard' },
            { type: 'doc-link', url: 'javascript:alert(1)' },
            { type: 'doc-link', url: 'data:text/html,x' },
            { type: 'doc-open', path: 'relative.html' },
            { type: 'doc-missing', count: -1 },
            { type: 'doc-missing', count: 1.5 },
            { type: 'doc-ready', title: 'x'.repeat(5000), path: 'a' },
            { type: 'send', text: 'hi' }
        ]) {
            expect(parseDocMessage(bad), JSON.stringify(bad)?.slice(0, 60)).toBeNull()
        }
    })

    test('only from this frame, whose origin is opaque', () => {
        const frame = {}
        expect(fromDocFrame(frame, 'null', frame)).toBe(true)
        expect(fromDocFrame({}, 'null', frame)).toBe(false)
        expect(fromDocFrame(frame, 'https://evil.example', frame)).toBe(false)
        expect(fromDocFrame(null, 'null', null)).toBe(false)
        expect(fromDocFrame(null, 'null', undefined)).toBe(false)
    })
})

test.describe('T101 what a comment becomes', () => {
    const doc = { url: '/doc/TOKENTOKEN/report.html', displayRoot: '~/project/review' }

    test('the path first, and no token anywhere', () => {
        expect(composeComment(doc, 'report.html', '## [1] 큰 그림\n사진부터\n\n', 'https://mac.ts.net')).toBe('[Phone comment] ~/project/review/report.html\n## [1] 큰 그림\n사진부터')
        const quoted = composeComment(doc, 'report.html', '{"source":"https://mac.ts.net/doc/TOKENTOKEN/report.html","other":"/doc/TOKENTOKEN/a.png"}', 'https://mac.ts.net')
        expect(quoted).not.toContain('TOKENTOKEN')
        expect(quoted).toContain('"source":"~/project/review/report.html"')
        expect(quoted).toContain('"other":"~/project/review/a.png"')
    })

    test('the page now in the frame is the one named', () => {
        expect(composeComment(doc, 'other.html', 'x', 'https://mac.ts.net')).toContain('~/project/review/other.html\n')
    })

    test('50,000 characters, the most that survives the send route', () => {
        expect(commentTooLong('가'.repeat(PHONE_MAX_COMMENT_CHARS))).toBe(false)
        expect(commentTooLong('가'.repeat(PHONE_MAX_COMMENT_CHARS + 1))).toBe(true)
        // the longest comment, all Korean, in the JSON the sheet posts: under what readJson takes
        expect(Buffer.byteLength(JSON.stringify({ text: '가'.repeat(PHONE_MAX_COMMENT_CHARS) }))).toBeLessThan(256 * 1024)
    })

    test('what each answer of the send route means', () => {
        const target = { id: 's', name: 'AI: fb', agent: 'claude' as const }
        const rejected = (reason: string, extra: object = {}): ChatSendResult => ({ status: 'rejected', reason, message: `server says ${reason}`, ...extra }) as ChatSendResult
        expect(sendOutcome({ status: 'sent' }, target)).toEqual({ kind: 'done', notice: 'Sent to AI: fb' })
        expect(sendOutcome({ status: 'queued' }, target)).toEqual({ kind: 'done', notice: 'Claude is working — it gets this when the turn ends.' })
        expect(sendOutcome({ status: 'queued' }, { ...target, agent: 'codex' })).toMatchObject({ notice: expect.stringContaining('Codex') })
        expect(sendOutcome(rejected('awaiting_input'), target)).toMatchObject({ kind: 'refused', retry: true, openChat: true, pick: false })
        expect(sendOutcome(rejected('input_busy', { draft: 'left' }), target)).toEqual({ kind: 'busy', draft: 'left' })
        expect(sendOutcome(rejected('input_busy'), target)).toMatchObject({ kind: 'refused', retry: true, message: 'server says input_busy' })
        // already in the box, and a second send would type it twice
        expect(sendOutcome(rejected('not_submitted'), target)).toMatchObject({ kind: 'refused', retry: false, openChat: true })
        for (const reason of ['no_agent', 'exited', 'not_running', 'unknown_session', 'conversation_changed']) {
            expect(sendOutcome(rejected(reason), target), reason).toMatchObject({ kind: 'refused', retry: true, pick: true })
        }
        for (const reason of ['revoked', 'too_large', 'empty']) expect(sendOutcome(rejected(reason), target), reason).toMatchObject({ kind: 'refused', retry: false, pick: false })
    })
})

test.describe('T101 what this phone keeps', () => {
    const memory = (): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> & { values: Map<string, string> } => {
        const values = new Map<string, string>()
        return { values, getItem: (key) => values.get(key) ?? null, setItem: (key, value) => void values.set(key, value), removeItem: (key) => void values.delete(key) }
    }

    test('kept and read back, by document', () => {
        const storage = memory()
        expect(readDocStore('a', storage)).toBe('')
        expect(keepDocStore('a', '{"x":"1"}', storage)).toBe(true)
        expect(readDocStore('a', storage)).toBe('{"x":"1"}')
        expect(readDocStore('b', storage)).toBe('')
    })

    test('256 KB at most, in bytes: it travels in the frame’s address', () => {
        const storage = memory()
        expect(keepDocStore('a', 'x'.repeat(PHONE_MAX_DOC_STORE_BYTES), storage)).toBe(true)
        expect(keepDocStore('a', 'x'.repeat(PHONE_MAX_DOC_STORE_BYTES + 1), storage)).toBe(false)
        expect(keepDocStore('b', '가'.repeat(Math.floor(PHONE_MAX_DOC_STORE_BYTES / 3) + 1), storage)).toBe(false)
        expect(readDocStore('a', storage).length, 'the last that fitted stays').toBe(PHONE_MAX_DOC_STORE_BYTES)
    })

    test('fifty documents; the one used longest ago goes', () => {
        const storage = memory()
        for (let index = 0; index < 51; index++) keepDocStore(`d${index}`, 'x', storage)
        expect(readDocStore('d0', storage)).toBe('')
        expect(readDocStore('d1', storage)).toBe('x')
        keepDocStore('d1', 'y', storage)
        keepDocStore('d51', 'x', storage)
        expect(readDocStore('d1', storage), 'written again: the newest').toBe('y')
        expect(readDocStore('d2', storage)).toBe('')
    })

    test('a phone with no storage: nothing kept, nothing broken', () => {
        const broken = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') }, removeItem: () => undefined }
        expect(readDocStore('a', broken)).toBe('')
        expect(keepDocStore('a', 'x', broken)).toBe(false)
    })

    test('the seed is in the fragment: it never reaches the server', () => {
        expect(frameAddress('/doc/t/a.html', '')).toBe('/doc/t/a.html')
        const address = frameAddress('/doc/t/a.html', '{"k":"한 글#&"}')
        expect(address.startsWith('/doc/t/a.html#seed=')).toBe(true)
        expect(decodeURIComponent(address.split('#seed=')[1])).toBe('{"k":"한 글#&"}')
        expect(address.split('#').length).toBe(2)
    })
})
