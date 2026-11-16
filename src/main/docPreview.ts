import { randomBytes } from 'crypto'
import type { FileHandle } from 'fs/promises'
import { open, realpath } from 'fs/promises'
import os from 'os'
import path from 'path'
import { Readable } from 'stream'
import { fileExtension } from '../shared/fileKinds'
import type { DocPreviewOpenResult, DocPreviewRefusal } from '../shared/docPreview'
import { DOC_PREVIEW_MAX_BYTES, DOC_PREVIEW_MESSAGE, DOC_PREVIEW_ORIGIN, DOC_PREVIEW_SANDBOX } from '../shared/docPreview'
import { bridgeOffset, documentCharset } from './phone/phoneDoc'

/**
 * The Mac's document frame (decision 0013): the phone's rules from 0011 on a custom scheme instead of a token route.
 *
 * The renderer asks for a document by its path (`doc-preview-open`); a token then names that document's folder, and
 * `climanager-doc://doc/<token>/<file>` serves the document and the files a page loads beside it — the same file types
 * as the phone, nothing from a dot folder, nothing beside a document kept directly in home, `~/Downloads` or a temp folder.
 *
 * No Electron here, so the unit test (T146) runs it on Node.
 */

const TOKENS_KEPT = 32
const HEAD_BYTES = 64 * 1024
/** Pictures and fonts beside a document: the phone's picture limit. */
const SIDE_FILE_MAX_BYTES = 10_000_000

const DOCUMENT_EXTENSIONS = new Set(['html', 'htm'])

/** What a page may load from beside itself (the phone's list). `.env` and `.json` are not here. */
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

/** Requested with CORS even from the page's own folder (a font, a module, a `crossorigin` stylesheet); the page's origin is `null`. */
const CORS_EXTENSIONS = new Set(['woff', 'woff2', 'ttf', 'otf', 'mjs', 'js', 'css'])

const REFUSAL_MESSAGE: Record<DocPreviewRefusal, string> = {
    not_found: 'File not found',
    not_html: 'Not an HTML document',
    too_large: 'Larger than the 64 MB the preview draws. Open it in the browser.',
    not_a_file: 'Not a file',
    bad_encoding: 'This page is not in an encoding the preview reads. Open it in the browser.'
}

export interface DocPreviewToken {
    token: string
    /** the document's folder, as the disk names it */
    root: string
    document: string
    /** off when the folder is the home, Downloads or a shared temp folder: only the document itself is served */
    sideFiles: boolean
}

/**
 * The tokens: in memory, gone on quitting. Not a secret kept from the person — the renderer is the app — but from the
 * page: a document knows only its own token, so it can reach nothing beside its own folder.
 */
export class DocPreviewTokens {
    private readonly tokens = new Map<string, DocPreviewToken>()

    mint(entry: Omit<DocPreviewToken, 'token'>): DocPreviewToken {
        while (this.tokens.size >= TOKENS_KEPT) {
            const oldest = this.tokens.keys().next().value
            if (oldest === undefined) break
            this.tokens.delete(oldest)
        }
        const token: DocPreviewToken = { ...entry, token: randomBytes(24).toString('base64url') }
        this.tokens.set(token.token, token)
        return token
    }

    get(value: string): DocPreviewToken | null {
        return this.tokens.get(value) ?? null
    }
}

/** `climanager-doc://doc/<token>/` */
export const docPreviewBase = (token: string): string => `${DOC_PREVIEW_ORIGIN}/${token}/`

/**
 * The policy of everything under one token. Sources are limited to the token's folder; `connect-src 'none'` and
 * `form-action 'none'` keep the page from sending anything; `sandbox` gives it an opaque origin even if it is opened
 * outside the frame. The window's own CSP (`frame-src climanager-doc:`) keeps the frame from navigating to the web.
 */
export function docPreviewContentSecurityPolicy(base: string): string {
    return [
        `sandbox ${DOC_PREVIEW_SANDBOX}`,
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
        "worker-src 'none'",
        "manifest-src 'none'"
    ].join('; ')
}

/**
 * Put in front of every document. A report was written for a browser tab: kits keep comments in `localStorage`, which
 * throws in an opaque origin and stops the page's script. This stands in for storage (kept in the page, gone when it
 * closes), passes Escape up so the preview closes from inside the page, and keeps links from leaving the folder.
 * It adds no power: the page could post the same message itself. ASCII only, no closing script tag.
 */
export const DOC_PREVIEW_BRIDGE = String.raw`(function () {
    'use strict'
    var post = function (message) { message.type = '${DOC_PREVIEW_MESSAGE}'; parent.postMessage(message, '*') }
    var makeStore = function () {
        var data = {}
        var has = function (key) { return Object.prototype.hasOwnProperty.call(data, key) }
        return {
            getItem: function (key) { return has(key) ? data[key] : null },
            setItem: function (key, value) { data[key] = String(value) },
            removeItem: function (key) { delete data[key] },
            clear: function () { Object.keys(data).forEach(function (key) { delete data[key] }) },
            key: function (index) { return Object.keys(data)[index] || null },
            get length() { return Object.keys(data).length }
        }
    }
    try { Object.defineProperty(window, 'localStorage', { value: makeStore(), configurable: true }) } catch (e) {}
    try { Object.defineProperty(window, 'sessionStorage', { value: makeStore(), configurable: true }) } catch (e) {}
    try { Object.defineProperty(document, 'cookie', { get: function () { return '' }, set: function () {}, configurable: true }) } catch (e) {}
    window.addEventListener('keydown', function (event) {
        if (event.key === 'Escape' && !event.defaultPrevented) post({ key: 'Escape' })
    })
    var base = location.pathname.split('/').slice(0, 2).join('/') + '/'
    document.addEventListener('click', function (event) {
        var anchor = event.target && event.target.closest && event.target.closest('a[href]')
        if (!anchor) return
        var raw = anchor.getAttribute('href') || ''
        if (raw.charAt(0) === '#') return
        var url
        try { url = new URL(anchor.href) } catch (e) { event.preventDefault(); return }
        // Another page of this folder replaces this one. Anything else (the web, the Mac's files) is the browser's job.
        if (url.protocol === location.protocol && url.host === location.host && url.pathname.indexOf(base) === 0 && /\.html?$/i.test(url.pathname)) {
            event.preventDefault()
            location.replace(url.href)
            return
        }
        event.preventDefault()
    }, true)
})()`

const refused = (reason: DocPreviewRefusal): DocPreviewOpenResult => ({ status: 'refused', reason, message: REFUSAL_MESSAGE[reason] })

/** A document's folder that holds far more than its own files: the document loads, nothing beside it does. */
async function sharedFolders(home: string): Promise<Set<string>> {
    const folders = [home, path.join(home, 'Downloads'), os.tmpdir(), '/tmp', '/private/tmp']
    const real = await Promise.all(folders.map((folder) => realpath(folder).catch(() => folder)))
    return new Set([...folders, ...real].map((folder) => folder.replace(/\/+$/, '')))
}

/** `doc-preview-open`: the frame's address for a document the person picked, or why not. */
export async function openDocPreview(target: unknown, tokens: DocPreviewTokens, home: string = os.homedir()): Promise<DocPreviewOpenResult> {
    if (typeof target !== 'string' || !path.isAbsolute(target)) return refused('not_found')
    let real: string
    try {
        real = await realpath(target)
    } catch {
        return refused('not_found')
    }
    // the name on disk: a link called report.html that points at notes.txt is notes.txt
    if (!DOCUMENT_EXTENSIONS.has(fileExtension(real))) return refused('not_html')
    let handle: FileHandle | null = null
    try {
        handle = await open(real, 'r')
        const stat = await handle.stat()
        if (!stat.isFile()) return refused('not_a_file')
        if (stat.size > DOC_PREVIEW_MAX_BYTES) return refused('too_large')
        if (documentCharset(await headOf(handle, Math.min(stat.size, HEAD_BYTES))) === null) return refused('bad_encoding')
        const root = path.dirname(real)
        const token = tokens.mint({ root, document: path.basename(real), sideFiles: !(await sharedFolders(home)).has(root) })
        return { status: 'ok', url: `${docPreviewBase(token.token)}${encodeURIComponent(token.document)}`, size: stat.size }
    } catch {
        return refused('not_found')
    } finally {
        await handle?.close().catch(() => undefined)
    }
}

async function headOf(handle: FileHandle, length: number): Promise<Buffer> {
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, 0)
    return buffer.subarray(0, bytesRead)
}

const namesOnlyPlainSegments = (relative: string): boolean => relative.split('/').every((segment) => segment !== '' && !segment.startsWith('.'))

const mayLoad = (name: string): boolean => {
    const extension = fileExtension(name)
    return DOCUMENT_EXTENSIONS.has(extension) || FILE_TYPES[extension] !== undefined
}

/** The relative path asked for, or null when it could leave the folder or names a hidden file. The document itself may be hidden. */
export function docPreviewRelativePath(encoded: string, document: string): string | null {
    let decoded: string
    try {
        decoded = decodeURIComponent(encoded)
    } catch {
        return null
    }
    if (!decoded || decoded.includes('\\') || decoded.includes('\0') || decoded.startsWith('/')) return null
    if (decoded === document) return decoded
    return namesOnlyPlainSegments(decoded) ? decoded : null
}

const notFound = (): Response => new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } })

/**
 * `climanager-doc://doc/<token>/<path>` — what `protocol.handle` answers. Order: the method, the token, the path's
 * shape, the type, then the disk: what the path really is must still be inside the folder and of a type a page loads.
 */
export async function serveDocPreview(url: string, method: string, tokens: DocPreviewTokens): Promise<Response> {
    if (method !== 'GET' && method !== 'HEAD') return new Response(null, { status: 405 })
    let parsed: URL
    try {
        parsed = new URL(url)
    } catch {
        return notFound()
    }
    if (`${parsed.protocol}//${parsed.host}` !== DOC_PREVIEW_ORIGIN) return notFound()
    const match = /^\/([A-Za-z0-9_-]+)\/(.+)$/.exec(parsed.pathname)
    const token = match ? tokens.get(match[1]) : null
    if (!match || !token) return notFound()
    const relative = docPreviewRelativePath(match[2], token.document)
    if (relative === null || !mayLoad(relative)) return notFound()
    if (!token.sideFiles && relative !== token.document) return notFound()

    const real = await realpath(path.join(token.root, relative)).catch(() => null)
    if (real === null || !real.startsWith(`${token.root}/`)) return notFound()
    // a link answers for what it points at: `data.js` → `data.json` is not a script
    const actual = real.slice(token.root.length + 1)
    if (!(actual === token.document || (namesOnlyPlainSegments(actual) && mayLoad(actual)))) return notFound()
    const isDocument = DOCUMENT_EXTENSIONS.has(fileExtension(actual))

    let handle: FileHandle
    try {
        handle = await open(real, 'r')
    } catch {
        return notFound()
    }
    let size: number
    try {
        const stat = await handle.stat()
        size = stat.size
        if (!stat.isFile() || size > (isDocument ? DOC_PREVIEW_MAX_BYTES : SIDE_FILE_MAX_BYTES)) throw new Error('refused')
    } catch {
        await handle.close().catch(() => undefined)
        return notFound()
    }
    const headers: Record<string, string> = {
        'Content-Security-Policy': docPreviewContentSecurityPolicy(docPreviewBase(match[1])),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
    }
    if (method === 'HEAD') {
        await handle.close().catch(() => undefined)
        return new Response(null, { status: 200, headers })
    }
    if (!isDocument) {
        const extension = fileExtension(actual)
        headers['Content-Type'] = FILE_TYPES[extension]
        if (CORS_EXTENSIONS.has(extension)) headers['Access-Control-Allow-Origin'] = 'null'
        return new Response(streamOf(handle, 0, null), { status: 200, headers })
    }
    let head: Buffer
    try {
        head = await headOf(handle, Math.min(size, HEAD_BYTES))
    } catch {
        await handle.close().catch(() => undefined)
        return notFound()
    }
    const charset = documentCharset(head)
    if (charset === null) {
        await handle.close().catch(() => undefined)
        return notFound()
    }
    headers['Content-Type'] = `text/html; charset=${charset}`
    const at = bridgeOffset(head)
    const before = Buffer.concat([head.subarray(0, at), Buffer.from(`<script>${DOC_PREVIEW_BRIDGE}</script>`, 'latin1')])
    return new Response(streamOf(handle, at, before), { status: 200, headers })
}

/** Never read whole: a report can be tens of MB, and main draws every terminal's output. */
function streamOf(handle: FileHandle, start: number, before: Buffer | null): ReadableStream<Uint8Array> {
    async function* chunks(): AsyncGenerator<Buffer> {
        try {
            if (before) yield before
            for await (const chunk of handle.createReadStream({ start, autoClose: false })) yield chunk as Buffer
        } finally {
            await handle.close().catch(() => undefined)
        }
    }
    return Readable.toWeb(Readable.from(chunks())) as unknown as ReadableStream<Uint8Array>
}
