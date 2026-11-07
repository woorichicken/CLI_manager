import { randomBytes, createHash } from 'crypto'
import type { FileHandle } from 'fs/promises'
import { realpath } from 'fs/promises'
import type http from 'http'
import path from 'path'
import os from 'os'
import { pipeline } from 'stream'
import type { PhoneDocOpened, PhoneDocRefusal, PhoneDocRefused, PhoneRole, PhoneSessionsResponse } from '../../shared/phone'
import { PHONE_API, PHONE_DOC_PREFIX, PHONE_DOC_SANDBOX, PHONE_IMAGE_PREVIEW_BYTES, PHONE_MAX_DOC_BYTES } from '../../shared/phone'
import { fileExtension } from '../../shared/fileKinds'
import type { PhoneAccess } from './phoneAccess'
import { isLoopbackAddress } from './phoneAccess'
import { PHONE_DOC_BRIDGE } from './phoneDocBridge'
import { openGrantedFile, type GrantedFile, type PhoneFilesDeps } from './phoneFiles'
import { readJson, send } from './PhoneServer'

/**
 * A document in a sandboxed frame (decision 0011). The frame's page has an opaque origin, so Chromium sends the phone's
 * cookie with the page itself but not with the pictures beside it, and WebKit sends it with all of them, POSTs included.
 * Neither can be leaned on. So a press on a link asks for a token (through `/api/`, whose gates it passes), and the
 * token opens that one folder, for the files a page loads, while whoever asked for it may still ask.
 *
 * Every file still goes through openGrantedFile: the token only stands for step 4, "this source grants it".
 */

const TOKEN_TTL_MS = 30 * 60 * 1000
/** Past this a device's oldest token goes: a panel is one document, these are the ones not yet expired. */
const TOKENS_PER_OWNER = 8
const TITLE_SCAN_BYTES = 64 * 1024
const CHARSET_SCAN_BYTES = 1024

const DOCUMENT_EXTENSIONS = new Set(['html', 'htm'])

/** What a page may load from beside itself. Nothing else leaves the folder: `.env` and `.json` are not here. */
const FILE_TYPES: Record<string, string> = {
    css: 'text/css; charset=utf-8',
    js: 'text/javascript; charset=utf-8',
    mjs: 'text/javascript; charset=utf-8',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    avif: 'image/avif',
    svg: 'image/svg+xml',
    ico: 'image/x-icon',
    woff: 'font/woff',
    woff2: 'font/woff2',
    ttf: 'font/ttf',
    otf: 'font/otf'
}

/** A font or a module is requested with CORS even from the same host, and the page's origin is `null`. A module can be a `.js`. */
const CORS_EXTENSIONS = new Set(['woff', 'woff2', 'ttf', 'otf', 'mjs', 'js'])

export interface PhoneDocToken {
    token: string
    /** the document's folder, as the disk names it */
    root: string
    /** beside the document: files of this folder may load. Off when the folder is the home or a shared temp folder */
    sideFiles: boolean
    document: string
    access: Extract<PhoneAccess, { level: 'full' }>
    owner: string
    cwd?: string
    usedAt: number
}

/** The tokens: in memory, gone on quitting, on switching the phone off and when the device is disconnected. */
export class PhoneDocTokens {
    private readonly tokens = new Map<string, PhoneDocToken>()

    constructor(private readonly now: () => number = Date.now) {}

    mint(entry: Omit<PhoneDocToken, 'token' | 'usedAt'>): PhoneDocToken {
        this.sweep()
        const mine = [...this.tokens.values()].filter((token) => token.owner === entry.owner).sort((a, b) => a.usedAt - b.usedAt)
        for (const old of mine.slice(0, Math.max(0, mine.length - TOKENS_PER_OWNER + 1))) this.tokens.delete(old.token)
        const token: PhoneDocToken = { ...entry, token: randomBytes(32).toString('base64url'), usedAt: this.now() }
        this.tokens.set(token.token, token)
        return token
    }

    /** A live token, its half hour started again. */
    use(value: string): PhoneDocToken | null {
        const token = this.tokens.get(value)
        if (!token) return null
        if (this.now() - token.usedAt > TOKEN_TTL_MS) {
            this.tokens.delete(value)
            return null
        }
        token.usedAt = this.now()
        return token
    }

    /** `null`: every paired device. */
    forgetDevice(deviceId: string | null): void {
        for (const token of [...this.tokens.values()]) {
            const device = token.access.via === 'device' ? token.access.deviceId : undefined
            if (device !== undefined && (deviceId === null || device === deviceId)) this.tokens.delete(token.token)
        }
    }

    clear(): void {
        this.tokens.clear()
    }

    private sweep(): void {
        for (const token of [...this.tokens.values()]) if (this.now() - token.usedAt > TOKEN_TTL_MS) this.tokens.delete(token.token)
    }
}

/** The CSP of everything under one token. `base` limits what the page loads to its own token's folder: `'self'` would admit `/api/`. */
export function docContentSecurityPolicy(base: string): string {
    return [
        `sandbox ${PHONE_DOC_SANDBOX}`,
        "default-src 'none'",
        `script-src 'unsafe-inline' ${base}`,
        `style-src 'unsafe-inline' ${base}`,
        `img-src data: blob: ${base}`,
        `media-src data: blob: ${base}`,
        `font-src data: ${base}`,
        "connect-src 'none'",
        "form-action 'none'",
        "base-uri 'none'",
        "object-src 'none'",
        "frame-src 'none'",
        "frame-ancestors 'self'"
    ].join('; ')
}

const headerOf = (req: http.IncomingMessage, name: string): string | null => {
    const value = req.headers[name]
    return (Array.isArray(value) ? value[0] : value) ?? null
}

/** `<scheme>://<host>/doc/<token>/`. The Host passed `hostAllowed`; serve says https. */
function tokenBase(req: http.IncomingMessage, token: string): string {
    const scheme = headerOf(req, 'x-forwarded-proto') === 'https' ? 'https' : 'http'
    return `${scheme}://${headerOf(req, 'host')}${PHONE_DOC_PREFIX}${token}/`
}

/**
 * Where the bridge goes: past a BOM, blank space, comments and the doctype. Before `<html>` is fine — the parser opens
 * html and head for the script and merges the attributes of the real tag — and it needs no search for a `<head>` that
 * could be inside a comment.
 */
export function bridgeOffset(head: Buffer): number {
    const text = head.toString('latin1')
    let at = text.startsWith('\xef\xbb\xbf') ? 3 : 0
    for (;;) {
        while (at < text.length && /\s/.test(text[at])) at++
        if (text.startsWith('<!--', at)) {
            const end = text.indexOf('-->', at + 4)
            if (end < 0) return at
            at = end + 3
        } else if (/^<!doctype/i.test(text.slice(at, at + 9)) || text.startsWith('<?', at)) {
            const end = text.indexOf('>', at)
            if (end < 0) return at
            at = end + 1
        } else {
            return at
        }
    }
}

/**
 * The bridge pushes a page's `<meta charset>` past the 1024 bytes a browser looks in, so the header says it instead.
 * A BOM or nothing means UTF-8. An encoding that is not ASCII-compatible would garble the bridge: not offered.
 */
export function documentCharset(head: Buffer): string | null {
    if (head[0] === 0xff && head[1] === 0xfe) return null
    if (head[0] === 0xfe && head[1] === 0xff) return null
    const found = /<meta[^>]+charset\s*=\s*["']?\s*([\w.:-]{1,40})/i.exec(head.subarray(0, CHARSET_SCAN_BYTES).toString('latin1'))
    const name = found?.[1].toLowerCase() ?? 'utf-8'
    return name.startsWith('utf-16') ? null : name
}

export function documentTitle(head: Buffer): string | null {
    const found = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head.toString('utf8'))
    if (!found) return null
    const title = found[1]
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&')
    return title || null
}

async function headOf(handle: FileHandle, length: number): Promise<Buffer> {
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, 0)
    return buffer.subarray(0, bytesRead)
}

/** A path a chat names, compared as the request is. phoneFiles.ts has the same: not exported there yet. */
function pathNamed(paths: ReadonlySet<string>, normalized: string): boolean {
    for (const named of paths) if (path.normalize(named).normalize('NFC') === normalized) return true
    return false
}

const REFUSAL_STATUS: Record<PhoneDocRefusal, number> = {
    bad_path: 400,
    revoked: 401,
    view_only: 403,
    cross_site: 403,
    not_mentioned: 403,
    outside_roots: 403,
    protected: 403,
    unreadable: 403,
    unknown_session: 404,
    not_found: 404,
    not_a_file: 404,
    too_large: 413,
    not_html: 415
}

const REFUSAL_MESSAGE: Record<PhoneDocRefusal, string> = {
    bad_path: 'This is not a path on the Mac.',
    revoked: 'This device was disconnected from the Mac.',
    view_only: 'This device can only watch. Pair it again with "Can type" to open documents.',
    cross_site: 'Only the phone page can open documents.',
    not_mentioned: 'Not named in this chat',
    outside_roots: 'Outside the home folder and this session’s folder',
    protected: 'Protected: keys and .env files stay on the Mac',
    unreadable: 'The Mac would not let the app read this file',
    unknown_session: 'That session is gone from the Mac.',
    not_found: 'Not on the Mac',
    not_a_file: 'Not a file',
    too_large: 'Larger than the 64 MB a phone opens. Open it on the Mac.',
    not_html: 'Not an HTML document'
}

function refuse(res: http.ServerResponse, reason: PhoneDocRefusal): void {
    const body: PhoneDocRefused = { status: 'refused', reason, message: REFUSAL_MESSAGE[reason] }
    send(res, REFUSAL_STATUS[reason], body)
}

/** A document's folder that holds far more than its own files: its pictures load, nothing beside them does. */
async function sharedFolders(home: string): Promise<Set<string>> {
    const folders = [home, path.join(home, 'Downloads'), os.tmpdir(), '/tmp', '/private/tmp']
    const real = await Promise.all(folders.map((folder) => realpath(folder).catch(() => folder)))
    return new Set([...folders, ...real].map((folder) => folder.replace(/\/+$/, '')))
}

function displayFolder(folder: string, homes: string[]): string {
    for (const home of homes) {
        if (folder === home) return '~'
        if (folder.startsWith(`${home}/`)) return `~/${folder.slice(home.length + 1)}`
    }
    return folder
}

export interface PhoneDocOpenDeps {
    files: PhoneFilesDeps
    tokens: PhoneDocTokens
    access: Extract<PhoneAccess, { level: 'full' }>
    owner: string
    role: PhoneRole
    sessionExists(id: string): boolean
    listSessions(): PhoneSessionsResponse
    mentionedPaths(sessionId: string): Promise<{ paths: ReadonlySet<string>; cwd?: string }>
    stillAllowed(): boolean
}

export async function handlePhoneDocOpen(req: http.IncomingMessage, res: http.ServerResponse, deps: PhoneDocOpenDeps): Promise<void> {
    if (req.method !== 'POST') {
        send(res, 405, { error: 'method' })
        return
    }
    const body = await readJson(req)
    if (deps.role !== 'drive') return refuse(res, 'view_only')
    if (!deps.stillAllowed()) return refuse(res, 'revoked')
    const sessionId = typeof body?.session === 'string' ? body.session : ''
    const asked = typeof body?.path === 'string' ? body.path : ''
    if (!deps.sessionExists(sessionId)) return refuse(res, 'unknown_session')
    const named = await deps.mentionedPaths(sessionId)
    const result = await openGrantedFile(
        { path: asked, cwd: named.cwd, grants: (normalized) => pathNamed(named.paths, normalized) },
        { role: deps.role, fetchSite: headerOf(req, 'sec-fetch-site'), home: deps.files.home, ...(deps.files.protectedPlaces ? { protectedPlaces: deps.files.protectedPlaces } : {}) }
    )
    if (!result.ok) {
        if (result.reason === 'protected' || result.reason === 'outside_roots' || result.reason === 'not_mentioned') deps.files.record(sessionId, `document refused (${result.reason})`)
        return refuse(res, result.reason)
    }
    const { file } = result
    try {
        // the name on disk: a link called report.html that points at notes.txt is notes.txt
        const real = await realpath(path.normalize(asked))
        if (!DOCUMENT_EXTENSIONS.has(fileExtension(real))) return refuse(res, 'not_html')
        if (file.size > PHONE_MAX_DOC_BYTES) return refuse(res, 'too_large')
        if (!deps.stillAllowed()) return refuse(res, 'revoked')
        const head = await headOf(file.handle, Math.min(file.size, TITLE_SCAN_BYTES))
        if (documentCharset(head) === null) return refuse(res, 'not_html')
        const root = path.dirname(real)
        const realHome = await realpath(deps.files.home).catch(() => deps.files.home)
        const sideFiles = !(await sharedFolders(deps.files.home)).has(root)
        const token = deps.tokens.mint({
            root,
            sideFiles,
            document: path.basename(real),
            access: deps.access,
            owner: deps.owner,
            ...(named.cwd ? { cwd: named.cwd } : {})
        })
        const session = deps.listSessions().sessions.find((candidate) => candidate.id === sessionId)
        const query = new URLSearchParams({ session: sessionId, path: asked })
        const opened: PhoneDocOpened = {
            status: 'ok',
            url: `${PHONE_DOC_PREFIX}${token.token}/${encodeURIComponent(path.basename(real))}`,
            title: documentTitle(head) ?? file.name,
            displayRoot: displayFolder(root, [deps.files.home, realHome]).normalize('NFC'),
            rel: path.basename(real).normalize('NFC'),
            size: file.size,
            modifiedAt: file.modifiedAt,
            storeKey: createHash('sha256').update(real.normalize('NFC')).digest('hex').slice(0, 32),
            target: session?.agent ? { id: session.id, name: session.name, agent: session.agent } : null,
            rawUrl: `${PHONE_API.fileRaw}?${query}`
        }
        deps.files.record(sessionId, `document opened (html, ${file.size < 1024 * 1024 ? `${Math.ceil(file.size / 1024)} KB` : `${(file.size / 1024 / 1024).toFixed(1)} MB`})`)
        send(res, 200, opened)
    } finally {
        await file.handle.close().catch(() => undefined)
    }
}

export const isPhoneDocPath = (route: string): boolean => route.startsWith(PHONE_DOC_PREFIX)

export interface PhoneDocServeDeps {
    files: PhoneFilesDeps | undefined
    tokens: PhoneDocTokens
    stillAllowed(access: Extract<PhoneAccess, { level: 'full' }>): boolean
    /** a document on its way to a device: stopped if the device is disconnected */
    trackDownload(access: Extract<PhoneAccess, { level: 'full' }>, stop: () => void): () => void
}

/** The relative path of a request, as named segments; null when one of them could leave the folder or is hidden. */
export function docRelativePath(encoded: string): string | null {
    let decoded: string
    try {
        decoded = decodeURIComponent(encoded)
    } catch {
        return null
    }
    if (!decoded || decoded.includes('\\') || decoded.startsWith('/')) return null
    // `..` gone from the URL may come back from `%2F..%2F`; a dot folder holds what a page has no use for
    if (decoded.split('/').some((segment) => segment === '' || segment.startsWith('.'))) return null
    return decoded
}

const notFound = (res: http.ServerResponse): void => send(res, 404, { error: 'not_found' })

/**
 * `GET /doc/<token>/<path>`. Order: the method, Funnel and this Mac (what decidePhoneAccess asks first — this route is
 * outside `/api/`, so nothing else asks), the token, whoever minted it may still, the path, then openGrantedFile.
 */
export async function handlePhoneDocFile(req: http.IncomingMessage, res: http.ServerResponse, url: URL, deps: PhoneDocServeDeps): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        send(res, 405, { error: 'method' })
        return
    }
    if (req.headers['tailscale-funnel-request'] !== undefined) {
        send(res, 403, { error: 'funnel' })
        return
    }
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
        send(res, 403, { error: 'not_local' })
        return
    }
    const match = /^\/doc\/([A-Za-z0-9_-]+)\/(.+)$/.exec(url.pathname)
    const token = match ? deps.tokens.use(match[1]) : null
    if (!match || !token || !deps.files || !deps.stillAllowed(token.access)) return notFound(res)
    const relative = docRelativePath(match[2])
    if (relative === null) return notFound(res)
    const extension = fileExtension(relative)
    const isDocument = DOCUMENT_EXTENSIONS.has(extension)
    if (!isDocument && !FILE_TYPES[extension]) return notFound(res)
    // the document itself; anything else only when the folder is its own
    if (!token.sideFiles && relative !== token.document) return notFound(res)

    const target = path.join(token.root, relative)
    const inside = async (): Promise<boolean> => {
        const real = await realpath(target).catch(() => null)
        return real !== null && real.startsWith(`${token.root}/`)
    }
    // fetchSite: a sandboxed page's own files are `cross-site` by design. The token is what grants them here
    const result = await openGrantedFile(
        { path: target, ...(token.cwd ? { cwd: token.cwd } : {}), grants: inside },
        { role: token.access.role, fetchSite: 'same-origin', home: deps.files.home, ...(deps.files.protectedPlaces ? { protectedPlaces: deps.files.protectedPlaces } : {}) }
    )
    if (!result.ok) return notFound(res)
    const { file } = result
    const stop = (): void => void file.handle.close().catch(() => undefined)
    if (!deps.stillAllowed(token.access) || file.size > (isDocument ? PHONE_MAX_DOC_BYTES : PHONE_IMAGE_PREVIEW_BYTES)) {
        stop()
        return notFound(res)
    }
    res.statusCode = 200
    res.setHeader('Content-Security-Policy', docContentSecurityPolicy(tokenBase(req, match[1])))
    res.setHeader('Cache-Control', 'no-store')
    if (isDocument) return void serveDocument(req, res, file, token.access, deps)
    res.setHeader('Content-Type', FILE_TYPES[extension])
    if (CORS_EXTENSIONS.has(extension)) res.setHeader('Access-Control-Allow-Origin', 'null')
    res.setHeader('Content-Length', String(file.size))
    streamBytes(req, res, file, 0, null, token.access, deps)
}

async function serveDocument(req: http.IncomingMessage, res: http.ServerResponse, file: GrantedFile, access: Extract<PhoneAccess, { level: 'full' }>, deps: PhoneDocServeDeps): Promise<void> {
    let head: Buffer
    try {
        head = await headOf(file.handle, Math.min(file.size, TITLE_SCAN_BYTES))
    } catch {
        await file.handle.close().catch(() => undefined)
        res.removeHeader('Content-Security-Policy')
        return notFound(res)
    }
    const charset = documentCharset(head)
    // the read above can outlast the device: from here on nothing would stop it, and a disconnect has no stream to cut yet
    if (charset === null || !deps.stillAllowed(access)) {
        await file.handle.close().catch(() => undefined)
        res.removeHeader('Content-Security-Policy')
        return notFound(res)
    }
    const at = bridgeOffset(head)
    const bridge = Buffer.from(`<script>${PHONE_DOC_BRIDGE}</script>`, 'latin1')
    res.setHeader('Content-Type', `text/html; charset=${charset}`)
    res.setHeader('Content-Length', String(file.size + bridge.length))
    streamBytes(req, res, file, at, Buffer.concat([head.subarray(0, at), bridge]), access, deps)
}

/** Never read whole: a report can be 42 MB, and main draws every terminal's output. */
function streamBytes(req: http.IncomingMessage, res: http.ServerResponse, file: GrantedFile, start: number, before: Buffer | null, access: Extract<PhoneAccess, { level: 'full' }>, deps: PhoneDocServeDeps): void {
    const close = (): void => void file.handle.close().catch(() => undefined)
    if (req.method === 'HEAD') {
        close()
        res.end()
        return
    }
    if (before) res.write(before)
    if (start >= file.size) {
        close()
        res.end()
        return
    }
    const stream = file.handle.createReadStream({ start, end: file.size - 1, autoClose: false })
    const untrack = deps.trackDownload(access, () => {
        stream.destroy()
        res.destroy()
    })
    pipeline(stream, res, () => {
        untrack()
        close()
    })
}
