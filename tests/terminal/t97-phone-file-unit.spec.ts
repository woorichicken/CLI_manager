import { test, expect } from '@playwright/test'
import { execFileSync } from 'child_process'
import fs from 'fs'
import http from 'http'
import os from 'os'
import path from 'path'
import { ConversationService } from '../../src/main/ConversationService'
import { TranscriptReader } from '../../src/main/TranscriptReader'
import { PhoneDevices } from '../../src/main/phone/PhoneDevices'
import { PhoneServer } from '../../src/main/phone/PhoneServer'
import { isProtectedPath, MAX_PATH_BYTES, usablePath, withinRoots } from '../../src/main/phone/phoneFileAccess'
import { openGrantedFile, type PhoneFileAccess } from '../../src/main/phone/phoneFiles'
import { maskSecretLines } from '../../src/main/maskSecrets'
import { addLinkedText, mentionedPaths } from '../../src/renderer/src/components/ChatView/chatMentions'
import { PHONE_IMAGE_PREVIEW_BYTES, PHONE_MAX_DOWNLOAD_BYTES, PHONE_TEXT_PREVIEW_BYTES } from '../../src/shared/phone'
import type { PhoneFileInfo, PhoneFileRefused } from '../../src/shared/phone'
import type { ConversationTurn } from '../../src/shared/conversation'
import { parseClaudeTranscript } from '../../src/main/transcript/claudeTranscript'
import { parseCodexTranscript } from '../../src/main/transcript/codexTranscript'

/**
 * T97 — what a phone may read (decision 0010), without Electron: the real file system, the real PhoneServer on a
 * loopback port and a real paired device, with a home folder of its own. Written against the table in the design:
 * every refusal code, symlinks and `..`, a name in another case, decomposed Hangul, FIFOs and devices, the size
 * limits on both sides of the line, masking that keeps line numbers, the raw headers, another site, Funnel, a
 * view-only device, and a disconnect that ends a download on its way.
 */

const SESSION = 'S1'
const FIXTURES = path.join(__dirname, 'fixtures/transcripts')

interface Harness {
    home: string
    project: string
    named: Set<string>
    base: string
    devices: PhoneDevices
    logged: string[]
    drive: string
    /** runs while a file's text is being prepared: what can happen in the middle of a request */
    duringRead: () => void
    stop(): Promise<void>
}

/** A file on disk the chat names. */
function namedFile(h: Harness, relative: string, content: string | Buffer, root = h.project): string {
    const file = path.join(root, relative)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
    h.named.add(file)
    return file
}

async function startHarness(): Promise<Harness> {
    // realpath: on a Mac os.tmpdir() is behind /var → /private/var, and the home must be as the disk names it
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't97-home-')))
    const project = path.join(home, 'project')
    fs.mkdirSync(project)
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 't97-data-'))
    const devices = new PhoneDevices(path.join(data, 'devices.json'))
    const named = new Set<string>()
    const logged: string[] = []
    const harness = { duringRead: () => undefined } as Harness
    const push = { forgetOwner: () => undefined, publicKey: () => 'key', keysProblem: () => null, count: () => 0, onStatus: () => undefined }
    const server = new PhoneServer({
        devices,
        push: push as never,
        tailscale: { read: async () => ({ found: false, owner: null, dnsName: null }), peek: () => null } as never,
        staticDir: data,
        onStateChange: () => undefined,
        statusPoller: { start: () => undefined, stop: () => undefined },
        listSessions: () => ({ sessions: [] }) as never,
        sessionExists: (id: string) => id === SESSION,
        conversation: { mentionedPaths: async () => ({ paths: named, cwd: project }) } as never,
        saveAttachment: () => ({ status: 'attached', path: '/tmp/x' }) as never,
        maskLine: (text: string) => text,
        recordPhoneInput: () => undefined,
        terminals: {} as never,
        subscribeConversation: () => () => undefined,
        files: {
            home,
            protectedPlaces: [data],
            maskLines: (lines) => {
                harness.duringRead()
                return maskSecretLines(lines, { joinLines: false })
            },
            record: (_id, detail) => logged.push(detail)
        }
    })
    const state = await server.apply({ enabled: true, port: 0 } as never)
    expect(state.running).toBe(true)
    const { code } = devices.startPairing('drive')
    const paired = devices.pair(code, 'Phone')
    if ('error' in paired) throw new Error(paired.error)
    Object.assign(harness, { home, project, named, base: `http://127.0.0.1:${state.port}`, devices, logged, drive: `climanager_phone=${paired.token}`, stop: () => server.stop() })
    return harness
}

function ask(h: Harness, target: string, options: { raw?: boolean; session?: string; headers?: Record<string, string>; download?: boolean } = {}): Promise<Response> {
    const query = new URLSearchParams({ session: options.session ?? SESSION, path: target })
    if (options.download) query.set('download', '1')
    return fetch(`${h.base}/api/phone/file${options.raw ? '/raw' : ''}?${query}`, { headers: { cookie: h.drive, ...options.headers } })
}

async function refused(h: Harness, target: string, options?: Parameters<typeof ask>[2]): Promise<{ status: number; reason: string }> {
    const response = await ask(h, target, options)
    const body = (await response.json()) as PhoneFileRefused
    return { status: response.status, reason: body.reason }
}

const info = async (h: Harness, target: string): Promise<PhoneFileInfo> => (await ask(h, target)).json() as Promise<PhoneFileInfo>

let h: Harness
test.beforeEach(async () => {
    h = await startHarness()
})
test.afterEach(async () => {
    await h.stop()
    fs.rmSync(h.home, { recursive: true, force: true })
})

test.describe('T97 the list', () => {
    const HOME = '/Users/me'
    const refusedPaths = [
        '/Users/me/.ssh/id_rsa',
        '/Users/me/.ssh/config',
        '/Users/me/.SSH/config',
        '/Users/me/.gnupg/secring.gpg',
        '/Users/me/.aws/credentials',
        '/Users/me/.azure/accessTokens.json',
        '/Users/me/.kube/config',
        '/Users/me/.1password/agent.sock',
        '/Users/me/.config/gh/hosts.yml',
        '/Users/me/.config/gcloud/application_default_credentials.json',
        '/Users/me/.config/op/config',
        '/Users/me/.claude.json',
        '/Users/me/.claude/.credentials.json',
        '/Users/me/.codex/auth.json',
        '/Users/me/.docker/config.json',
        '/Users/me/.climanager/control-api.json',
        '/Users/me/.climanager/orch-token',
        '/Users/me/Library/Keychains/login.keychain-db',
        '/Users/me/Library/Cookies/Cookies.binarycookies',
        '/Users/me/Library/Group Containers/x/y',
        '/Users/me/Library/Application Support/Google/Chrome/Default/Login Data',
        '/Users/me/Library/Application Support/1Password/x.sqlite',
        '/Users/me/Library/Application Support/CLI Manager/config.json',
        '/Users/me/.zsh_history',
        '/Users/me/.bash_history',
        '/Users/me/.netrc',
        '/Users/me/.npmrc',
        '/Users/me/.pypirc',
        '/Users/me/.git-credentials',
        '/tmp/project/.env',
        '/tmp/project/.ENV',
        '/tmp/project/.env.local',
        '/tmp/project/.env.production',
        '/tmp/project/id_rsa',
        '/tmp/project/id_ed25519',
        '/tmp/project/server.pem',
        '/tmp/project/server.key',
        '/tmp/project/cert.p12',
        '/tmp/project/cert.pfx',
        '/tmp/project/app.keystore',
        '/tmp/project/app.jks',
        '/tmp/project/credentials',
        '/tmp/project/credentials.json',
        '/tmp/project/service-account-prod.json',
        '/tmp/project/.secret',
        '/tmp/project/.secrets/token.txt',
        '/tmp/project/.env/dump.txt',
        '/tmp/project/.git/config'
    ]
    for (const target of refusedPaths) {
        test(`refuses ${target}`, () => {
            expect(isProtectedPath(target, [HOME])).toBe(true)
        })
    }

    const allowedPaths = [
        '/Users/me/project/README.md',
        '/Users/me/.claude/skills/x/SKILL.md',
        '/Users/me/.climanager/chief/me/ME.md',
        '/Users/me/.config/karabiner/karabiner.json',
        '/Users/me/Library/Application Support/Code/User/settings.json',
        '/tmp/project/.env.example',
        '/tmp/project/.env.sample',
        '/tmp/project/.env.template',
        '/tmp/project/id_rsa.pub',
        '/tmp/project/src/credentials/index.ts',
        '/tmp/project/.github/config',
        '/tmp/project/environment.ts'
    ]
    for (const target of allowedPaths) {
        test(`allows ${target}`, () => {
            expect(isProtectedPath(target, [HOME])).toBe(false)
        })
    }

    test('the app’s own data folder joins the list, under whatever name', () => {
        expect(isProtectedPath('/data/phone/devices.json', [HOME], ['/data'])).toBe(true)
        expect(isProtectedPath('/data2/x.txt', [HOME], ['/data'])).toBe(false)
    })

    test('roots: inside counts, a neighbour with the same start does not, and `/` admits nothing', () => {
        expect(withinRoots('/Users/me/a.txt', ['/Users/me'])).toBe(true)
        expect(withinRoots('/Users/me', ['/Users/me'])).toBe(true)
        expect(withinRoots('/Users/mere/a.txt', ['/Users/me'])).toBe(false)
        expect(withinRoots('/etc/passwd', ['/'])).toBe(false)
        expect(withinRoots('/etc/passwd', [''])).toBe(false)
    })

    test('a request’s shape: absolute, `..` gone, no control characters, at most 4096 bytes', () => {
        expect(usablePath('/a/b/../../.ssh/x')).toBe('/.ssh/x')
        expect(usablePath('relative/x.txt')).toBeNull()
        expect(usablePath('')).toBeNull()
        expect(usablePath('/a/\u0000b')).toBeNull()
        expect(usablePath('/a/\nb')).toBeNull()
        expect(usablePath(`/${'a'.repeat(MAX_PATH_BYTES - 1)}`)).not.toBeNull()
        expect(usablePath(`/${'a'.repeat(MAX_PATH_BYTES)}`)).toBeNull()
    })
})

test.describe('T97 the eight steps', () => {
    test('a file the chat names opens; one it does not name is refused before the disk is asked', async () => {
        const file = namedFile(h, 'notes.txt', 'hello\n')
        const body = await info(h, file)
        expect(body).toMatchObject({ status: 'ok', kind: 'text', name: 'notes.txt', content: 'hello\n', maskedValues: 0, size: 6 })
        fs.writeFileSync(path.join(h.project, 'other.txt'), 'x')
        expect(await refused(h, path.join(h.project, 'other.txt'))).toEqual({ status: 403, reason: 'not_mentioned' })
        // the same answer for a path that does not exist: nothing tells a phone what is on the disk
        expect(await refused(h, path.join(h.project, 'no-such.txt'))).toEqual({ status: 403, reason: 'not_mentioned' })
    })

    test('every refusal code', async () => {
        expect(await refused(h, 'relative/x.txt')).toEqual({ status: 400, reason: 'bad_path' })
        expect(await refused(h, '/x', { session: 'nope' })).toEqual({ status: 404, reason: 'unknown_session' })
        expect(await refused(h, path.join(h.project, 'gone.txt'))).toEqual({ status: 403, reason: 'not_mentioned' })
        h.named.add(path.join(h.project, 'gone.txt'))
        expect(await refused(h, path.join(h.project, 'gone.txt'))).toEqual({ status: 404, reason: 'not_found' })
        h.named.add(h.project)
        expect(await refused(h, h.project)).toEqual({ status: 404, reason: 'not_a_file' })
        h.named.add('/etc/hosts')
        expect(await refused(h, '/etc/hosts')).toEqual({ status: 403, reason: 'outside_roots' })
        const env = namedFile(h, '.env', 'TOKEN=abc\n')
        expect(await refused(h, env)).toEqual({ status: 403, reason: 'protected' })
        const key = namedFile(h, '.ssh/id_rsa', 'x', h.home)
        expect(await refused(h, key)).toEqual({ status: 403, reason: 'protected' })
        // the raw route judges again from the first step
        expect(await refused(h, env, { raw: true })).toEqual({ status: 403, reason: 'protected' })
    })

    test('a file the system will not read: unreadable, not a crash', async () => {
        const file = namedFile(h, 'locked.txt', 'x')
        fs.chmodSync(file, 0o000)
        try {
            expect(await refused(h, file)).toEqual({ status: 403, reason: 'unreadable' })
        } finally {
            fs.chmodSync(file, 0o600)
        }
    })

    test('symlinks are judged by where they lead, in both directions', async () => {
        const key = namedFile(h, '.ssh/id_rsa', 'PRIVATE', h.home)
        const trap = path.join(h.project, 'report.png')
        fs.symlinkSync(key, trap)
        h.named.add(trap)
        expect(await refused(h, trap)).toEqual({ status: 403, reason: 'protected' })

        // an ordinary link inside home is fine, under the name the chat used
        const target = namedFile(h, 'skills/SKILL.md', '# skill\n', h.home)
        const link = path.join(h.project, 'link-to-skill.md')
        fs.symlinkSync(target, link)
        h.named.add(link)
        expect(await info(h, link)).toMatchObject({ status: 'ok', name: 'link-to-skill.md' })

        // out of the allowed places
        const out = path.join(h.project, 'out.txt')
        fs.symlinkSync('/etc/hosts', out)
        h.named.add(out)
        expect(await refused(h, out)).toEqual({ status: 403, reason: 'outside_roots' })

        // a folder behind a link
        const folder = path.join(h.project, 'ssh-folder')
        fs.symlinkSync(path.join(h.home, '.ssh'), folder)
        h.named.add(path.join(folder, 'id_rsa'))
        expect(await refused(h, path.join(folder, 'id_rsa'))).toEqual({ status: 403, reason: 'protected' })
    })

    test('`..` is gone before anything is judged', async () => {
        namedFile(h, '.ssh/id_rsa', 'PRIVATE', h.home)
        const climbing = `${h.project}/../.ssh/id_rsa`
        // the climb leads to a path the chat never named, whatever the words were
        h.named.delete(path.join(h.home, '.ssh/id_rsa'))
        expect(await refused(h, climbing)).toEqual({ status: 403, reason: 'not_mentioned' })
        // named in the chat as it resolves: the list still has the last word
        h.named.add(climbing)
        expect(await refused(h, climbing)).toEqual({ status: 403, reason: 'protected' })
    })

    test('another case of a protected name: `~/.SSH` is `~/.ssh` on this disk', async () => {
        namedFile(h, '.ssh/id_rsa', 'PRIVATE', h.home)
        const shouting = path.join(h.home, '.SSH/id_rsa')
        h.named.add(shouting)
        expect(await refused(h, shouting)).toEqual({ status: 403, reason: 'protected' })
    })

    test('decomposed Hangul: a name the chat wrote composed opens the file the disk holds decomposed', async () => {
        const composed = '보고서.txt'
        const file = path.join(h.project, composed.normalize('NFD'))
        fs.writeFileSync(file, '내용\n')
        h.named.add(path.join(h.project, composed))
        expect(await info(h, path.join(h.project, composed))).toMatchObject({ status: 'ok', name: composed, content: '내용\n' })
        // a request in the decomposed form (what a Mac's own path often is) is the same file
        expect(await info(h, file)).toMatchObject({ status: 'ok', name: composed })
    })

    test('a FIFO and a device do not stop the server', async () => {
        const fifo = path.join(h.project, 'pipe.txt')
        execFileSync('mkfifo', [fifo])
        h.named.add(fifo)
        expect(await refused(h, fifo)).toEqual({ status: 404, reason: 'not_a_file' })
        const device = path.join(h.project, 'zero.txt')
        fs.symlinkSync('/dev/zero', device)
        h.named.add(device)
        // outside the allowed places before it would be opened
        expect(await refused(h, device)).toEqual({ status: 403, reason: 'outside_roots' })
        // the step 8 guard on its own, with the device's folder allowed
        const access: PhoneFileAccess = { role: 'drive', fetchSite: null, home: h.home }
        const opened = await openGrantedFile({ path: '/dev/zero', grants: () => true, cwd: '/dev' }, access)
        expect(opened).toEqual({ ok: false, reason: 'not_a_file' })
    })

    test('a protected place behind a symlink is protected where it really is', async () => {
        const real = path.join(h.home, 'moved-data')
        const place = path.join(h.home, 'data-link')
        fs.mkdirSync(real)
        fs.writeFileSync(path.join(real, 'vapid.json'), '{}')
        fs.symlinkSync(real, place)
        const other = path.join(h.project, 'other-link')
        fs.symlinkSync(real, other)
        const access: PhoneFileAccess = { role: 'drive', fetchSite: null, home: h.home, protectedPlaces: [place] }
        for (const target of [path.join(place, 'vapid.json'), path.join(real, 'vapid.json'), path.join(other, 'vapid.json')]) {
            expect(await openGrantedFile({ path: target, grants: () => true }, access), target).toEqual({ ok: false, reason: 'protected' })
        }
    })

    test('the session’s folder counts as an allowed place, even outside home', async () => {
        const elsewhere = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't97-elsewhere-')))
        // os.tmpdir() is itself allowed: only a source's own `cwd` is under test, so ask for a folder outside it
        const access: PhoneFileAccess = { role: 'drive', fetchSite: null, home: h.home }
        const file = path.join(elsewhere, 'a.txt')
        fs.writeFileSync(file, 'x')
        const granted = await openGrantedFile({ path: file, grants: () => true, cwd: elsewhere }, access)
        expect(granted.ok).toBe(true)
        if (granted.ok) await granted.file.handle.close()
        fs.rmSync(elsewhere, { recursive: true, force: true })
    })

    test('`openGrantedFile` hands back an open file for another route to read (the document view)', async () => {
        const file = namedFile(h, 'report.html', '<p>hello</p>')
        const access: PhoneFileAccess = { role: 'drive', fetchSite: 'same-origin', home: h.home }
        const granted = await openGrantedFile({ path: file, grants: (p) => p === file, cwd: h.project }, access)
        expect(granted.ok).toBe(true)
        if (!granted.ok) return
        expect(granted.file).toMatchObject({ kind: 'html', name: 'report.html', size: 12 })
        const buffer = Buffer.alloc(12)
        await granted.file.handle.read(buffer, 0, 12, 0)
        expect(buffer.toString()).toBe('<p>hello</p>')
        await granted.file.handle.close()
        // refusals come through the same way
        expect(await openGrantedFile({ path: file, grants: () => false }, access)).toEqual({ ok: false, reason: 'not_mentioned' })
        expect(await openGrantedFile({ path: file, grants: () => true }, { ...access, role: 'watch' })).toEqual({ ok: false, reason: 'view_only' })
        expect(await openGrantedFile({ path: file, grants: () => true }, { ...access, fetchSite: 'cross-site' })).toEqual({ ok: false, reason: 'cross_site' })
    })
})

test.describe('T97 what kind, and the size limits', () => {
    test('text at the limit shows; one byte over downloads', async () => {
        const at = await info(h, namedFile(h, 'at.txt', 'a'.repeat(PHONE_TEXT_PREVIEW_BYTES)))
        expect(at.kind).toBe('text')
        const over = await info(h, namedFile(h, 'over.txt', 'a'.repeat(PHONE_TEXT_PREVIEW_BYTES + 1)))
        expect(over).toMatchObject({ kind: 'download', why: 'too_large_to_preview' })
    })

    test('a picture at the limit shows; one byte over downloads', async () => {
        const at = await info(h, namedFile(h, 'at.png', Buffer.alloc(PHONE_IMAGE_PREVIEW_BYTES, 1)))
        expect(at.kind).toBe('image')
        const over = await info(h, namedFile(h, 'over.png', Buffer.alloc(PHONE_IMAGE_PREVIEW_BYTES + 1, 1)))
        expect(over).toMatchObject({ kind: 'download', why: 'too_large_to_preview' })
    })

    test('a download over 500 MiB is refused (a sparse file: nothing is written)', async () => {
        const file = path.join(h.project, 'huge.mp4')
        const fd = fs.openSync(file, 'w')
        fs.ftruncateSync(fd, PHONE_MAX_DOWNLOAD_BYTES + 1)
        fs.closeSync(fd)
        h.named.add(file)
        expect(await refused(h, file)).toEqual({ status: 413, reason: 'too_large' })
        expect(await refused(h, file, { raw: true })).toEqual({ status: 413, reason: 'too_large' })
    })

    test('kinds: system types and NUL bytes download, HTML is its own, a name without an extension is text', async () => {
        expect(await info(h, namedFile(h, 'a.pdf', 'text'))).toMatchObject({ kind: 'download', why: 'type', mime: 'application/pdf' })
        expect(await info(h, namedFile(h, 'b.mp4', 'text'))).toMatchObject({ kind: 'download', why: 'type', mime: 'video/mp4' })
        expect(await info(h, namedFile(h, 'prog.bin', Buffer.from([1, 2, 0, 3])))).toMatchObject({ kind: 'download', why: 'binary' })
        expect(await info(h, namedFile(h, 'late-nul.txt', Buffer.concat([Buffer.alloc(9000, 97), Buffer.from([0])])))).toMatchObject({ kind: 'text' })
        expect(await info(h, namedFile(h, 'r.html', '<p>x</p>'))).toMatchObject({ kind: 'html', content: '<p>x</p>', language: 'html' })
        expect(await info(h, namedFile(h, 'Makefile', 'all:\n'))).toMatchObject({ kind: 'text', language: null })
        expect(await info(h, namedFile(h, 'empty.txt', ''))).toMatchObject({ kind: 'text', content: '', size: 0 })
        expect(await info(h, namedFile(h, 's.svg', '<svg/>'))).toMatchObject({ kind: 'image', mime: 'image/svg+xml' })
    })

    test('HTML over the text limit downloads until the document view takes it', async () => {
        const body = await info(h, namedFile(h, 'big.html', 'a'.repeat(PHONE_TEXT_PREVIEW_BYTES + 1)))
        expect(body).toMatchObject({ kind: 'download', why: 'too_large_to_preview' })
        // the file itself stays `html` for that route
        const granted = await openGrantedFile({ path: path.join(h.project, 'big.html'), grants: () => true }, { role: 'drive', fetchSite: null, home: h.home })
        expect(granted.ok && granted.file.kind).toBe('html')
        if (granted.ok) await granted.file.handle.close()
    })

    test('masking hides the value and keeps every line where it was', async () => {
        const source = ['line one', 'API_TOKEN=abcdefghijklmnop', 'const a', '= 1', 'ghp_012345678901234567890123', 'end'].join('\n')
        const body = await info(h, namedFile(h, 'config.txt', source))
        expect(body.kind).toBe('text')
        if (body.kind !== 'text') return
        const lines = body.content.split('\n')
        expect(lines).toHaveLength(6)
        expect(lines[1]).not.toContain('abcdefghijklmnop')
        expect(lines[3]).toBe('= 1')
        expect(lines[5]).toBe('end')
        expect(body.maskedValues).toBeGreaterThanOrEqual(2)
    })

    test('a private key block: every line hidden, the count unchanged', async () => {
        const source = ['before', '-----BEGIN RSA PRIVATE KEY-----', 'AAAA', 'BBBB', '-----END RSA PRIVATE KEY-----', 'after'].join('\n')
        const body = await info(h, namedFile(h, 'notes.txt', source))
        if (body.kind !== 'text') throw new Error(body.kind)
        expect(body.content.split('\n')).toHaveLength(6)
        expect(body.content).not.toContain('AAAA')
        expect(body.content.endsWith('after')).toBe(true)
    })
})

test.describe('T97 the raw route', () => {
    test('bytes, and the headers that keep them from acting as the page', async () => {
        const picture = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64')
        const file = namedFile(h, 'a.png', picture)
        const response = await ask(h, file, { raw: true })
        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toBe('image/png')
        expect(response.headers.get('content-disposition')).toBe('inline')
        expect(response.headers.get('content-security-policy')).toContain('sandbox')
        expect(response.headers.get('cross-origin-resource-policy')).toBe('same-origin')
        expect(response.headers.get('cache-control')).toBe('no-store')
        expect(response.headers.get('x-content-type-options')).toBe('nosniff')
        expect(Buffer.from(await response.arrayBuffer()).equals(picture)).toBe(true)

        const saved = await ask(h, file, { raw: true, download: true })
        expect(saved.headers.get('content-disposition')).toBe("attachment; filename*=UTF-8''a.png")
        await saved.arrayBuffer()
    })

    test('HTML and SVG cannot run with the page’s origin', async () => {
        const html = await ask(h, namedFile(h, 'r.html', '<script>alert(1)</script>'), { raw: true })
        expect(html.headers.get('content-disposition')).toContain('attachment')
        expect(html.headers.get('content-type')).toBe('application/octet-stream')
        await html.arrayBuffer()
        const svg = await ask(h, namedFile(h, 's.svg', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), { raw: true })
        expect(svg.headers.get('content-disposition')).toBe('inline')
        expect(svg.headers.get('content-security-policy')).toContain('sandbox')
        await svg.arrayBuffer()
    })

    test('a Hangul name reaches the header encoded', async () => {
        const response = await ask(h, namedFile(h, '보고서 (최종).pdf', 'x'), { raw: true })
        expect(response.headers.get('content-disposition')).toBe(`attachment; filename*=UTF-8''${encodeURIComponent('보고서 (최종).pdf').replace(/[()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`)
        await response.arrayBuffer()
    })

    test('an empty file answers with nothing, not an error', async () => {
        const response = await ask(h, namedFile(h, 'empty.pdf', ''), { raw: true })
        expect(response.status).toBe(200)
        expect((await response.arrayBuffer()).byteLength).toBe(0)
    })

    test('only GET', async () => {
        const file = namedFile(h, 'a.txt', 'x')
        const response = await fetch(`${h.base}/api/phone/file?session=${SESSION}&path=${encodeURIComponent(file)}`, { method: 'POST', headers: { cookie: h.drive, origin: h.base } })
        expect(response.status).toBe(405)
    })
})

test.describe('T97 who may ask', () => {
    test('another site: refused by Sec-Fetch-Site, on both routes', async () => {
        const file = namedFile(h, 'a.txt', 'x')
        for (const site of ['cross-site', 'same-site']) {
            expect(await refused(h, file, { headers: { 'sec-fetch-site': site } })).toEqual({ status: 403, reason: 'cross_site' })
            expect(await refused(h, file, { raw: true, headers: { 'sec-fetch-site': site } })).toEqual({ status: 403, reason: 'cross_site' })
        }
        for (const site of ['same-origin', 'none']) expect((await ask(h, file, { headers: { 'sec-fetch-site': site } })).status).toBe(200)
    })

    test('no cookie: the server’s own gate, before any of this', async () => {
        const file = namedFile(h, 'a.txt', 'x')
        const response = await fetch(`${h.base}/api/phone/file?session=${SESSION}&path=${encodeURIComponent(file)}`)
        expect(response.status).toBe(401)
    })

    test('Funnel: the public internet is refused as everywhere', async () => {
        const file = namedFile(h, 'a.txt', 'x')
        const response = await ask(h, file, { headers: { 'tailscale-funnel-request': '1' } })
        expect(response.status).toBe(403)
        expect(((await response.json()) as { error: string }).error).toBe('funnel')
    })

    test('a view-only device is refused whatever it asks', async () => {
        const file = namedFile(h, 'a.txt', 'x')
        const { code } = h.devices.startPairing('watch')
        const paired = h.devices.pair(code, 'Watcher')
        if ('error' in paired) throw new Error(paired.error)
        const cookie = `climanager_phone=${paired.token}`
        for (const raw of [false, true]) {
            const response = await fetch(`${h.base}/api/phone/file${raw ? '/raw' : ''}?session=${SESSION}&path=${encodeURIComponent(file)}`, { headers: { cookie } })
            expect(response.status).toBe(403)
            expect(((await response.json()) as PhoneFileRefused).reason).toBe('view_only')
        }
    })

    test('a disconnect ends a download on its way', async () => {
        const file = namedFile(h, 'big.mp4', Buffer.alloc(40 * 1024 * 1024, 7))
        const device = h.devices.list()[0]
        const query = new URLSearchParams({ session: SESSION, path: file })
        const received = await new Promise<{ bytes: number; aborted: boolean }>((resolve, reject) => {
            const request = http.get(`${h.base}/api/phone/file/raw?${query}`, { headers: { cookie: h.drive } }, (response) => {
                let bytes = 0
                let revoked = false
                response.on('data', (chunk: Buffer) => {
                    bytes += chunk.length
                    if (!revoked) {
                        revoked = true
                        h.devices.revoke(device.id)
                        // read slowly enough that the file cannot finish first
                        response.pause()
                        setTimeout(() => response.resume(), 100)
                    }
                })
                response.on('close', () => resolve({ bytes, aborted: !response.complete }))
            })
            request.on('error', (error) => reject(error))
        })
        expect(received.aborted).toBe(true)
        expect(received.bytes).toBeLessThan(40 * 1024 * 1024)
        // and it cannot come back
        expect((await ask(h, file)).status).toBe(401)
    })

    test('a device disconnected while its file was being read gets no words', async () => {
        const file = namedFile(h, 'notes.txt', 'the words\n')
        const device = h.devices.list()[0]
        h.duringRead = () => h.devices.revoke(device.id)
        const response = await ask(h, file)
        expect(response.status).toBe(401)
        const text = await response.text()
        expect(JSON.parse(text).reason).toBe('revoked')
        expect(text).not.toContain('the words')
        expect(h.logged).toEqual([])
    })

    test('what is logged says what kind and how big, never the path', async () => {
        const file = namedFile(h, 'secret-project-name.txt', 'x')
        await info(h, file)
        const env = namedFile(h, '.env', 'x')
        await ask(h, env)
        expect(h.logged).toEqual(['file opened (text, 1 KB)', 'file refused (protected)'])
    })
})

test.describe('T97 what a chat names', () => {
    const CWD = '/repo'
    const HOME = '/Users/me'
    const assistant = (text: string): ConversationTurn => ({ role: 'assistant', ts: null, parts: [{ kind: 'text', text }] })
    const user = (text: string): ConversationTurn => ({ role: 'user', ts: null, parts: [{ kind: 'text', text }] })
    const names = (turns: ConversationTurn[]): string[] => [...mentionedPaths(turns, CWD, HOME)].sort()

    test('paths in words, code and links, resolved as the chat resolves them, line suffixes off', () => {
        expect(names([assistant('Saved to docs/a.png and `src/b.ts:12`, see [c](c.md) and [d](/abs/d.txt#L3), ~/notes/e.txt too.')])).toEqual(
            ['/Users/me/notes/e.txt', '/abs/d.txt', '/repo/c.md', '/repo/docs/a.png', '/repo/src/b.ts'].sort()
        )
    })

    test('walks every block the screen draws', () => {
        const text = ['# in/heading.md', '- in/list.md', '  - in/nested.md', '> in/quote.md', '', '| in/head.md |', '| --- |', '| in/cell.md |', '', '**in/bold.md** _in/em.md_ ~~in/del.md~~'].join('\n')
        expect(names([assistant(text)])).toEqual(['heading', 'list', 'nested', 'quote', 'head', 'cell', 'bold', 'em', 'del'].map((n) => `/repo/in/${n}.md`).sort())
    })

    test('a code block and a link’s label are not links', () => {
        expect(names([assistant('```\nin/block.md\n```\n\n[in/label.md](https://example.com)')])).toEqual([])
    })

    test('a person’s words and the attachment they sent', () => {
        expect(names([user('look at docs/a.png @/tmp/x/climanager-chat/2026-11-07/p.png please')])).toEqual(['/repo/docs/a.png', '/tmp/x/climanager-chat/2026-11-07/p.png'])
    })

    test('a long message: the folded head draws its own links, whatever the whole text does', () => {
        // over the chat's count, the whole text links nothing; folded, its first lines still do
        const many = Array.from({ length: 501 }, (_, i) => `/repo/file${i}.ts`).join('\n')
        const shown = names([user(many)])
        expect(shown.length).toBeGreaterThan(0)
        expect(shown).toContain('/repo/file0.ts')
        expect(shown).not.toContain('/repo/file500.ts')
    })

    test('a tool’s file and its output; not its command', () => {
        const turn: ConversationTurn = {
            role: 'assistant',
            ts: null,
            parts: [{ kind: 'tool', name: 'Read', summary: 'x', input: JSON.stringify({ file_path: '/repo/read.ts' }), output: 'wrote out/result.md' }]
        }
        expect(names([turn])).toEqual(['/repo/out/result.md', '/repo/read.ts'])
        const bash: ConversationTurn = { role: 'assistant', ts: null, parts: [{ kind: 'tool', name: 'Bash', summary: 'x', input: JSON.stringify({ command: 'cat secret/thing.txt' }), output: '' }] }
        expect(names([bash])).toEqual([])
    })

    test('thinking and a shell’s output draw as plain text: not links', () => {
        const turn: ConversationTurn = {
            role: 'assistant',
            ts: null,
            parts: [{ kind: 'thinking', text: 'maybe in/thought.md' }, { kind: 'shell', command: 'cat in/cmd.md', stdout: 'in/out.md' }]
        }
        expect(names([turn])).toEqual([])
    })

    test('what the screen does not link is not named: a plan, a notice in an agent’s turn, a tool in a person’s', () => {
        const plan: ConversationTurn = {
            role: 'assistant',
            ts: null,
            parts: [{ kind: 'tool', name: 'TodoWrite', summary: 'x', input: JSON.stringify({ todos: [{ content: 'read', status: 'pending', activeForm: 'reading' }] }), output: 'wrote in/plan.md' }]
        }
        expect(names([plan])).toEqual([])
        // a plan that cannot be read draws as an ordinary tool row, so its output is linked
        const broken: ConversationTurn = { role: 'assistant', ts: null, parts: [{ kind: 'tool', name: 'TodoWrite', summary: 'x', input: 'not json', output: 'wrote in/plan.md' }] }
        expect(names([broken])).toEqual(['/repo/in/plan.md'])
        const agentTurn: ConversationTurn = { role: 'assistant', ts: null, parts: [{ kind: 'notice', text: 'see in/notice.md' }, { kind: 'compact', text: 'see in/compact.md' }] }
        expect(names([agentTurn])).toEqual([])
        const personTurn: ConversationTurn = { role: 'user', ts: null, parts: [{ kind: 'tool', name: 'Read', summary: 'x', input: JSON.stringify({ file_path: '/repo/read.ts' }), output: '' }] }
        expect(names([personTurn])).toEqual([])
    })

    test('notes, summaries and task results', () => {
        const turn: ConversationTurn = {
            role: 'user',
            ts: null,
            parts: [
                { kind: 'notice', text: 'see in/notice.md' },
                { kind: 'compact', text: 'see in/compact.md' },
                { kind: 'task_result', tasks: [{ id: '1', title: 't', agent: null, model: null, status: 'completed', duration_ms: null, turns: null, tool_calls: null, tokens: null, result: 'see in/task.md' }] }
            ]
        }
        expect(names([turn])).toEqual(['/repo/in/compact.md', '/repo/in/notice.md', '/repo/in/task.md'])
    })

    test('the chat’s own limits: too long a text and too many paths link nothing', () => {
        const long = new Set<string>()
        addLinkedText(long, `in/a.md ${'x'.repeat(256 * 1024)}`, CWD, HOME)
        expect(long.size).toBe(0)
        const many = new Set<string>()
        addLinkedText(many, Array.from({ length: 501 }, (_, i) => `in/f${i}.md`).join(' '), CWD, HOME)
        expect(many.size).toBe(0)
    })

    test('a tool output read whole: its paths count while that tool is in the chat, and no longer', async () => {
        const cut: ConversationTurn = { role: 'assistant', ts: null, parts: [{ kind: 'tool', name: 'Bash', summary: 'x', input: '{}', output: 'start', output_ref: 'r1', output_size: 9 }] }
        const other: ConversationTurn = user('a new request')
        let turns = [cut]
        const reader = new TranscriptReader({ claudeConfigDir: () => '/nonexistent', codexHome: () => '/nonexistent' })
        reader.read = () => ({ turns, truncated: false, changed: false, meta: null })
        reader.toolOutput = async () => 'start of it, then in/deep.md at the end'
        const service = new ConversationService({
            session: () => ({ cwd: CWD, cliSessionId: 'c1', cliToolName: 'claude' }),
            reader,
            mirror: { screen: () => [], flush: async () => undefined, lastOutputAt: () => 0, hasExited: () => false, showsAwaitingInput: () => false, inputBox: () => ({ typed: '' }) },
            hasTerminal: () => true,
            writeInput: () => undefined,
            type: async () => true,
            onChange: () => undefined,
            home: HOME
        })
        expect([...(await service.mentionedPaths('A')).paths]).toEqual([])
        expect(await service.getToolOutput('A', 'r1')).toContain('in/deep.md')
        const named = await service.mentionedPaths('A')
        expect([...named.paths]).toEqual(['/repo/in/deep.md'])
        expect(named.cwd).toBe(CWD)
        expect([...(await service.mentionedPaths('B')).paths]).toEqual([])
        // a `/resume` or a rewind: that tool is no longer in the chat, so its links are not either
        turns = [other]
        expect([...(await service.mentionedPaths('A')).paths]).toEqual([])
        // the output finishes reading after the chat has moved on: the same
        expect(await service.getToolOutput('A', 'r1')).toContain('in/deep.md')
        expect([...(await service.mentionedPaths('A')).paths]).toEqual([])
        turns = [cut]
        expect([...(await service.mentionedPaths('A')).paths]).toEqual(['/repo/in/deep.md'])
        service.forget('A')
        expect([...(await service.mentionedPaths('A')).paths]).toEqual([])
    })

    test('the synthetic Claude and Codex records', () => {
        const project = '/Users/someone/project'
        const claude = parseClaudeTranscript(fs.readFileSync(path.join(FIXTURES, 'claude/tools.jsonl'), 'utf8'))
        expect([...mentionedPaths(claude, project, HOME)].sort()).toEqual([`${project}/src/a.ts`, `${project}/src/b.ts`])
        const codex = parseCodexTranscript(fs.readFileSync(path.join(FIXTURES, 'codex/rollout-2026-11-03T10-00-00-00000000-0000-4000-8000-0000000000c1.jsonl'), 'utf8'))
        expect([...mentionedPaths(codex, project, HOME)].sort()).toEqual([`${project}/a.ts`, `${project}/b.ts`])
    })
})
