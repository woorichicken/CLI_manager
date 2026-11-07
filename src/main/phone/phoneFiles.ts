import { constants } from 'fs'
import { open, realpath, type FileHandle } from 'fs/promises'
import type http from 'http'
import os from 'os'
import path from 'path'
import { pipeline } from 'stream'
import type { PhoneFileInfo, PhoneFileRefusal, PhoneFileRefused, PhoneRole } from '../../shared/phone'
import { PHONE_API, PHONE_IMAGE_PREVIEW_BYTES, PHONE_MAX_DOWNLOAD_BYTES, PHONE_TEXT_PREVIEW_BYTES } from '../../shared/phone'
import { fileExtension, IMAGE_EXTENSIONS, SYSTEM_TYPES } from '../../shared/fileKinds'
import { isProtectedPath, usablePath, withinRoots } from './phoneFileAccess'
import { send } from './PhoneServer'

/**
 * A phone reads a file of the Mac (decision 0010). Eight steps, the first that refuses ends it:
 *
 *   1 the device may type (a view-only device sees no file)     5 the real path: symlinks resolved, the disk's own case
 *   2 the request came from the page, not from another site     6 inside home, the temp folder or the session's folder
 *   3 a well-formed absolute path; `..` is gone after this      7 not on the protected list — asked of both paths
 *   4 this source grants it (the session's chat named it)       8 opened without blocking, and a regular file
 *
 * Step 4 comes before the disk is touched, so nothing tells a phone whether a file it was not given exists. All of
 * it is asynchronous: main is the process that draws every terminal's output, and a slow disk must not stop that.
 */

const REFUSAL_STATUS: Record<PhoneFileRefusal, number> = {
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
    too_large: 413
}

const REFUSAL_MESSAGE: Record<PhoneFileRefusal, string> = {
    bad_path: 'This is not a path on the Mac.',
    revoked: 'This device was disconnected from the Mac.',
    view_only: 'This device can only watch. Pair it again with "Can type" to open files.',
    cross_site: 'Only the phone page can read files.',
    not_mentioned: 'Not named in this chat',
    outside_roots: 'Outside the home folder and this session’s folder',
    protected: 'Protected: keys and .env files stay on the Mac',
    unreadable: 'The Mac would not let the app read this file',
    unknown_session: 'That session is gone from the Mac.',
    not_found: 'Not on the Mac',
    not_a_file: 'Not a file',
    too_large: 'Larger than the 500 MB a phone can download'
}

const MIME: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    ico: 'image/x-icon',
    bmp: 'image/bmp',
    pdf: 'application/pdf',
    mp4: 'video/mp4',
    m4v: 'video/mp4',
    mov: 'video/quicktime',
    webm: 'video/webm',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    m4a: 'audio/mp4',
    aac: 'audio/aac',
    flac: 'audio/flac',
    ogg: 'audio/ogg',
    zip: 'application/zip',
    html: 'text/html',
    htm: 'text/html',
    xhtml: 'application/xhtml+xml'
}

const HTML_EXTENSIONS = new Set(['html', 'htm', 'xhtml'])
/** A NUL this early means a program's bytes, not words. */
const SNIFF_BYTES = 8 * 1024

/** A file's bytes run nowhere: a page or script in them cannot act with the phone page's origin. */
const RAW_CSP = "sandbox; default-src 'none'; style-src 'unsafe-inline'"

export type PhoneFileKind = 'image' | 'text' | 'html' | 'download'

/** What a source says: the path asked for, whether it is granted, and the folder it may lie in besides home and temp. */
export interface PhoneFileSource {
    path: string
    /** step 4, with the path of step 3 */
    grants(normalized: string): boolean | Promise<boolean>
    cwd?: string
}

/** Who asks, and from where. */
export interface PhoneFileAccess {
    role: PhoneRole
    /**
     * The request's `Sec-Fetch-Site`. Absent: a client that is not a browser. Pass `'same-origin'` only where a
     * file is loaded by a page in its own sandbox and that header is `cross-site` by design (decision 0011).
     */
    fetchSite: string | null
    /** the Mac's home folder */
    home: string
    /** this app's own data folder: on the list like the rest */
    protectedPlaces?: readonly string[]
}

/** A file that passed. The caller reads through `handle` and closes it. */
export interface GrantedFile {
    handle: FileHandle
    name: string
    size: number
    modifiedAt: string
    mime: string
    kind: PhoneFileKind
    /** why `kind` is `download` */
    why?: 'type' | 'binary'
    /** the extension, the word a code block's fence would use (`null` without one) */
    language: string | null
}

export type GrantedFileResult = { ok: true; file: GrantedFile } | { ok: false; reason: PhoneFileRefusal }

const refusal = (reason: PhoneFileRefusal): GrantedFileResult => ({ ok: false, reason })

/** Absent: a client that is not a browser, with no page to ride on. */
const fromThePage = (fetchSite: string | null): boolean => fetchSite === null || fetchSite === 'same-origin' || fetchSite === 'none'

/** The folders a phone's files may be in, as the disk names them. A folder that cannot be read counts as named. */
async function realRoots(home: string, cwd: string | undefined): Promise<string[]> {
    const roots = [home, os.tmpdir(), '/private/tmp', '/tmp', ...(cwd ? [cwd] : [])]
    const real = await Promise.all(roots.map((root) => realpath(root).catch(() => root)))
    return [...new Set([...roots, ...real])]
}

function systemError(error: unknown): PhoneFileRefusal {
    const code = (error as NodeJS.ErrnoException)?.code
    return code === 'EACCES' || code === 'EPERM' ? 'unreadable' : 'not_found'
}

async function bytesOf(handle: FileHandle, length: number): Promise<Buffer> {
    const buffer = Buffer.alloc(length)
    let got = 0
    while (got < length) {
        const { bytesRead } = await handle.read(buffer, got, length - got, got)
        if (bytesRead === 0) break
        got += bytesRead
    }
    return buffer.subarray(0, got)
}

/**
 * The eight steps. Everything that hands a phone a file of the Mac goes through here (the chat's links; Dock rows
 * and documents add a source of their own), so the list and the checks cannot differ from one door to the next.
 */
export async function openGrantedFile(source: PhoneFileSource, access: PhoneFileAccess): Promise<GrantedFileResult> {
    if (access.role !== 'drive') return refusal('view_only')
    if (!fromThePage(access.fetchSite)) return refusal('cross_site')
    const requested = usablePath(source.path)
    if (requested === null) return refusal('bad_path')
    if (!(await source.grants(requested.normalize('NFC')))) return refusal('not_mentioned')

    let real: string
    let realHome: string
    try {
        real = await realpath(requested)
    } catch (error) {
        return refusal(systemError(error))
    }
    try {
        realHome = await realpath(access.home)
    } catch {
        realHome = access.home
    }
    if (!withinRoots(real, await realRoots(access.home, source.cwd))) return refusal('outside_roots')
    const homes = [access.home, realHome]
    // a place behind a symlink (a moved data folder) is protected where it really is, too
    const named = access.protectedPlaces ?? []
    const places = [...named, ...(await Promise.all(named.map((place) => realpath(place).catch(() => place))))]
    if (isProtectedPath(requested, homes, places) || isProtectedPath(real, homes, places)) return refusal('protected')

    let handle: FileHandle
    try {
        // a FIFO would hold a blocking open until a writer came, and a device would never end: T79 F05's reason
        handle = await open(real, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOCTTY ?? 0))
    } catch (error) {
        return refusal(systemError(error))
    }
    try {
        const stat = await handle.stat()
        if (!stat.isFile()) {
            await handle.close()
            return refusal('not_a_file')
        }
        const extension = fileExtension(real)
        const common = {
            handle,
            // the name the person knows: a link's own name, not what it points at
            name: path.basename(requested).normalize('NFC'),
            size: stat.size,
            modifiedAt: stat.mtime.toISOString(),
            language: extension || null
        }
        if (IMAGE_EXTENSIONS.includes(extension)) return { ok: true, file: { ...common, kind: 'image', mime: MIME[extension] ?? 'application/octet-stream' } }
        if (SYSTEM_TYPES.has(extension)) return { ok: true, file: { ...common, kind: 'download', why: 'type', mime: MIME[extension] ?? 'application/octet-stream' } }
        if (HTML_EXTENSIONS.has(extension)) return { ok: true, file: { ...common, kind: 'html', mime: MIME[extension] ?? 'text/html' } }
        const head = await bytesOf(handle, Math.min(SNIFF_BYTES, stat.size))
        if (head.includes(0)) return { ok: true, file: { ...common, kind: 'download', why: 'binary', mime: 'application/octet-stream' } }
        return { ok: true, file: { ...common, kind: 'text', mime: 'text/plain; charset=utf-8' } }
    } catch (error) {
        await handle.close().catch(() => undefined)
        return refusal(systemError(error))
    }
}

// ---------------------------------------------------------------------------
// The two routes
// ---------------------------------------------------------------------------

/** What the file routes need from the app. Absent: no route, as with the feedback relay. */
export interface PhoneFilesDeps {
    home: string
    protectedPlaces?: readonly string[]
    /** the file's lines with secrets hidden, the line count unchanged (maskSecretLines with `joinLines: false`) */
    maskLines(lines: string[]): { lines: string[]; masked: number }
    /** the session's event log: what kind and how big, never the path */
    record(sessionId: string, detail: string): void
}

export interface PhoneFileRouteDeps {
    files: PhoneFilesDeps
    role: PhoneRole
    sessionExists(id: string): boolean
    mentionedPaths(sessionId: string): Promise<{ paths: ReadonlySet<string>; cwd?: string }>
    stillAllowed(): boolean
    /** a download a revoked device must not finish: the server calls `stop`. Returns the way to stop watching. */
    trackDownload(stop: () => void): () => void
}

export const isPhoneFilePath = (route: string): boolean => route === PHONE_API.file || route === PHONE_API.fileRaw

function refuse(res: http.ServerResponse, reason: PhoneFileRefusal): void {
    const body: PhoneFileRefused = { status: 'refused', reason, message: REFUSAL_MESSAGE[reason] }
    send(res, REFUSAL_STATUS[reason], body)
}

const headerOf = (req: http.IncomingMessage, name: string): string | null => {
    const value = req.headers[name]
    return (Array.isArray(value) ? value[0] : value) ?? null
}

/** The source a request names. A Dock row (`dock=<key>`) joins here when it lands (decision 0010). */
async function sourceOf(url: URL, deps: PhoneFileRouteDeps): Promise<{ source: PhoneFileSource; sessionId: string } | PhoneFileRefusal> {
    const sessionId = url.searchParams.get('session') ?? ''
    const raw = url.searchParams.get('path') ?? ''
    if (deps.role !== 'drive') return 'view_only'
    if (!deps.sessionExists(sessionId)) return 'unknown_session'
    const named = await deps.mentionedPaths(sessionId)
    return {
        sessionId,
        source: {
            path: raw,
            cwd: named.cwd,
            grants: (normalized) => pathNamed(named.paths, normalized)
        }
    }
}

/** A path the chat names, compared as the request is: normalized and composed. */
function pathNamed(paths: ReadonlySet<string>, normalized: string): boolean {
    for (const named of paths) if (path.normalize(named).normalize('NFC') === normalized) return true
    return false
}

export function rawUrlOf(url: URL): string {
    const query = new URLSearchParams(url.search)
    return `${PHONE_API.fileRaw}?${query}`
}

const formatSize = (bytes: number): string => (bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`)

/** The header filename: RFC 5987, what a phone's download folder names it. */
function attachmentName(name: string): string {
    return `attachment; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`
}

export async function handlePhoneFile(req: http.IncomingMessage, res: http.ServerResponse, url: URL, deps: PhoneFileRouteDeps): Promise<void> {
    if (req.method !== 'GET') {
        send(res, 405, { error: 'method' })
        return
    }
    const fetchSite = headerOf(req, 'sec-fetch-site')
    // before the session is looked up: another site learns nothing, not even which sessions exist
    if (deps.role === 'drive' && !fromThePage(fetchSite)) return refuse(res, 'cross_site')
    const asked = await sourceOf(url, deps)
    if (typeof asked === 'string') return refuse(res, asked)
    const result = await openGrantedFile(asked.source, { role: deps.role, fetchSite, home: deps.files.home, ...(deps.files.protectedPlaces ? { protectedPlaces: deps.files.protectedPlaces } : {}) })
    if (!result.ok) {
        // what was refused is worth a line in the log; not the path
        if (result.reason === 'protected' || result.reason === 'outside_roots' || result.reason === 'not_mentioned') deps.files.record(asked.sessionId, `file refused (${result.reason})`)
        return refuse(res, result.reason)
    }
    const { file } = result
    // the device may have been disconnected during the awaits above
    if (!deps.stillAllowed()) {
        await file.handle.close().catch(() => undefined)
        return refuse(res, 'revoked')
    }
    if (url.pathname === PHONE_API.fileRaw) return serveRaw(res, url, file, asked.sessionId, deps)
    try {
        if (file.size > PHONE_MAX_DOWNLOAD_BYTES) return refuse(res, 'too_large')
        const info = await describe(file, url, deps.files)
        // reading took a while too: what was read does not go to a device disconnected meanwhile
        if (!deps.stillAllowed()) return refuse(res, 'revoked')
        deps.files.record(asked.sessionId, `file opened (${info.kind}, ${formatSize(file.size)})`)
        send(res, 200, info)
    } finally {
        await file.handle.close().catch(() => undefined)
    }
}

async function describe(file: GrantedFile, url: URL, files: PhoneFilesDeps): Promise<PhoneFileInfo> {
    const common = { status: 'ok' as const, name: file.name, size: file.size, modifiedAt: file.modifiedAt, mime: file.mime, rawUrl: rawUrlOf(url) }
    if (file.kind === 'image') {
        return file.size > PHONE_IMAGE_PREVIEW_BYTES ? { ...common, kind: 'download', why: 'too_large_to_preview' } : { ...common, kind: 'image' }
    }
    if (file.kind === 'download') return { ...common, kind: 'download', why: file.why ?? 'type' }
    // HTML's limit is its own place: until the document view fills it (decision 0011) it reads as code, like the Mac's preview
    if (file.size > PHONE_TEXT_PREVIEW_BYTES) return { ...common, kind: 'download', why: 'too_large_to_preview' }
    const text = (await bytesOf(file.handle, Math.min(file.size, PHONE_TEXT_PREVIEW_BYTES))).toString('utf8')
    const { lines, masked } = files.maskLines(text.split('\n'))
    return { ...common, kind: file.kind, content: lines.join('\n'), maskedValues: masked, language: file.language }
}

function serveRaw(res: http.ServerResponse, url: URL, file: GrantedFile, sessionId: string, deps: PhoneFileRouteDeps): void {
    if (file.size > PHONE_MAX_DOWNLOAD_BYTES) {
        void file.handle.close().catch(() => undefined)
        return refuse(res, 'too_large')
    }
    const wanted = url.searchParams.get('download') === '1'
    const inline = file.kind === 'image' && !wanted
    res.statusCode = 200
    res.setHeader('Content-Security-Policy', RAW_CSP)
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
    res.setHeader('Cache-Control', 'no-store')
    // a page saved by a phone's browser stays a file: it is never rendered from this origin
    res.setHeader('Content-Type', file.kind === 'html' ? 'application/octet-stream' : file.mime)
    res.setHeader('Content-Disposition', inline ? 'inline' : attachmentName(file.name))
    res.setHeader('Content-Length', String(file.size))
    if (file.size === 0) {
        void file.handle.close().catch(() => undefined)
        res.end()
        return
    }
    if (wanted) deps.files.record(sessionId, `file downloaded (${file.kind}, ${formatSize(file.size)})`)
    const stream = file.handle.createReadStream({ start: 0, end: file.size - 1 })
    const untrack = deps.trackDownload(() => {
        stream.destroy()
        res.destroy()
    })
    pipeline(stream, res, () => {
        untrack()
        // a file cut while it was read: the length promised was not sent, and the phone must not wait for the rest
        if (stream.bytesRead < file.size) res.destroy()
        void file.handle.close().catch(() => undefined)
    })
}
