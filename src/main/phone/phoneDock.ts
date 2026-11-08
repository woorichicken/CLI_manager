import { createHash } from 'crypto'
import { existsSync } from 'fs'
import net from 'net'
import { join } from 'path'
import type { PhoneDockItem, PhoneDockResponse } from '../../shared/phone'

/**
 * The Artifact Dock list for the phone. The Chrome extension owns the list and its order
 * (`src/lib/dockList.js`, the same function its side panel draws from): this asks its socket, checks
 * what came back and passes the rows on in the order they came — it has no sort, and neither does the page.
 *
 * Only reading: the bytes sent are the constant below and nothing a phone sends reaches the socket. `open`
 * is never sent — it reloads the tab and moves the document up the list. Absolute paths stay on the Mac:
 * the phone gets the folder the extension shortened to `~` and an opaque key (the extension's own key holds
 * the path), and asks for a document by that key (`docFor`).
 *
 * The last good list is kept in memory only, so a phone can still see it while Chrome is off.
 */

export const DOCK_REQUEST = '{"cmd":"list","v":1}\n'
export const DOCK_PROTOCOL = 1
/** An extension older than 0.7.0 ignores `list`, and the host only gives up after 8 s (measured 8,012 ms). */
export const DOCK_ANSWER_TIMEOUT_MS = 2_500
/** How long a non-answer is believed before asking again — each new ask would hold a host thread for 8 s. */
export const DOCK_OUTDATED_HOLD_MS = 30_000
/** Answers this fresh are reused: phones polling together are one connection. */
export const DOCK_REUSE_MS = 1_000
export const DOCK_MAX_RESPONSE_BYTES = 2 * 1024 * 1024
export const DOCK_MAX_ROWS = 500
export const DOCK_MAX_TITLE = 300

const HOST_NAME = 'dev.artifactdock.host'
const FILE_DOC = /\.(html?|xhtml)$/i
const LINK_HOST = /(^|\.)(claude\.ai|claude\.site)$/

/** What the extension sends for one document. Checked before anything uses it. */
interface DockRow {
    key: string
    url: string
    title: string
    sub: string
    at: number
    pinned: boolean
    missing: boolean
    sessionId?: string
}

export type DockDoc =
    | { kind: 'file'; path: string; session: { id: string; name: string } | null }
    | { kind: 'link'; url: string }

export interface PhoneDockOptions {
    /** null: this process must not open a socket (not macOS, or a test that named none) */
    socketPath: string | null
    /** the socket was named on purpose: its file being absent means Chrome is off, not "no Dock" */
    assumeInstalled: boolean
    /** the extension host's registration files (install.sh); any of them means the Dock is installed */
    hostFiles: string[]
    sessionName(id: string): string | null
    maskLine(text: string): string
    now?(): number
}

/** What the phone calls a document: stable across reads, and without the path the extension's key contains. */
export function dockItemKey(extensionKey: string): string {
    return createHash('sha256').update(extensionKey).digest('base64url').slice(0, 22)
}

export function dockHostFiles(home: string): string[] {
    const support = join(home, 'Library', 'Application Support')
    return ['Google/Chrome', 'Google/Chrome Canary', 'Chromium', 'BraveSoftware/Brave-Browser', 'Microsoft Edge'].map((browser) =>
        join(support, browser, 'NativeMessagingHosts', `${HOST_NAME}.json`)
    )
}

export function dockLocation(env: Record<string, string | undefined>, platform: string, home: string): Pick<PhoneDockOptions, 'socketPath' | 'assumeInstalled'> {
    if (env.ARTIFACT_DOCK_SOCKET) return { socketPath: env.ARTIFACT_DOCK_SOCKET, assumeInstalled: true }
    // a test without its own socket must not read the person's real Dock
    if (env.CLIMANGER_TEST_USERDATA || platform !== 'darwin') return { socketPath: null, assumeInstalled: false }
    return { socketPath: join(home, 'Library', 'Application Support', 'ArtifactDock', 'dock.sock'), assumeInstalled: false }
}

type Answer =
    | { kind: 'rows'; open: DockRow[]; closed: DockRow[] }
    | { kind: 'off' }
    | { kind: 'outdated' }
    | { kind: 'broken' }

export class PhoneDock {
    private last: { open: DockRow[]; closed: DockRow[]; byKey: Map<string, DockRow>; at: number } | null = null
    private asked: { at: number; status: PhoneDockResponse['status'] } | null = null
    private outdatedUntil = 0
    private inFlight: Promise<PhoneDockResponse> | null = null

    constructor(private readonly options: PhoneDockOptions) {}

    private now(): number {
        return this.options.now?.() ?? Date.now()
    }

    installed(): boolean {
        const { socketPath, assumeInstalled, hostFiles } = this.options
        if (socketPath === null) return false
        return assumeInstalled || existsSync(socketPath) || hostFiles.some((file) => existsSync(file))
    }

    /** null: no Dock on this Mac. */
    read(): Promise<PhoneDockResponse | null> {
        if (!this.installed()) return Promise.resolve(null)
        if (this.inFlight) return this.inFlight
        const now = this.now()
        if (this.asked && now - this.asked.at < DOCK_REUSE_MS) return Promise.resolve(this.response(this.asked.status))
        if (now < this.outdatedUntil) return Promise.resolve(this.response('outdated'))
        this.inFlight = this.ask().finally(() => {
            this.inFlight = null
        })
        return this.inFlight
    }

    /** What a row of the current list opens. The phone names a key, never a path, and only keys from the list exist. */
    docFor(key: string): DockDoc | null {
        const row = this.last?.byKey.get(key)
        if (!row || row.missing) return null
        const link = linkAddress(row.url)
        if (link) return { kind: 'link', url: link }
        const path = fileDocPath(row.url)
        return path ? { kind: 'file', path, session: this.session(row).session } : null
    }

    private async ask(): Promise<PhoneDockResponse> {
        const answer = await askSocket(this.options.socketPath as string)
        const at = this.now()
        let status: PhoneDockResponse['status']
        if (answer.kind === 'rows') {
            status = 'live'
            this.last = { open: answer.open, closed: answer.closed, byKey: new Map([...answer.open, ...answer.closed].map((row) => [dockItemKey(row.key), row])), at }
        } else if (answer.kind === 'off') {
            status = 'chrome_off'
        } else if (answer.kind === 'outdated') {
            status = 'outdated'
            this.outdatedUntil = at + DOCK_OUTDATED_HOLD_MS
        } else {
            status = 'error'
        }
        this.asked = { at, status }
        return this.response(status)
    }

    /** Names and masks are applied here, on every answer: a session can be renamed or closed after the list was read. */
    private response(status: PhoneDockResponse['status']): PhoneDockResponse {
        const last = this.last
        return {
            status,
            asOf: last?.at ?? null,
            open: last?.open.map((row) => this.item(row)) ?? [],
            closed: last?.closed.map((row) => this.item(row)) ?? []
        }
    }

    private session(row: DockRow): { session: PhoneDockItem['session']; sessionGone?: true } {
        if (!row.sessionId) return { session: null }
        const name = this.options.sessionName(row.sessionId)
        return name === null ? { session: null, sessionGone: true } : { session: { id: row.sessionId, name } }
    }

    private item(row: DockRow): PhoneDockItem {
        const link = linkAddress(row.url)
        return {
            key: dockItemKey(row.key),
            // a title is what the document chose to call itself, so it counts as untrusted text too
            title: this.options.maskLine(row.title).slice(0, DOCK_MAX_TITLE),
            sub: this.options.maskLine(row.sub),
            at: row.at,
            pinned: row.pinned,
            missing: row.missing,
            kind: isFileUrl(row.url) ? 'file' : 'link',
            ...(link ? { url: link } : {}),
            ...this.session(row)
        }
    }
}

function isFileUrl(url: string): boolean {
    return url.startsWith('file:')
}

function linkAddress(url: string): string | null {
    try {
        const parsed = new URL(url)
        return parsed.protocol === 'https:' && LINK_HOST.test(parsed.hostname) ? url : null
    } catch {
        return null
    }
}

function fileDocPath(url: string): string | null {
    try {
        const parsed = new URL(url)
        if (parsed.protocol !== 'file:') return null
        const path = decodeURIComponent(parsed.pathname)
        // %2F survives URL parsing: `a%2F..%2F..` only becomes a climb once decoded
        if (path.includes('\0') || path.split('/').includes('..')) return null
        return FILE_DOC.test(path) ? path : null
    } catch {
        return null
    }
}

function toRow(value: unknown): DockRow | null {
    if (!value || typeof value !== 'object') return null
    const row = value as Record<string, unknown>
    if (typeof row.key !== 'string' || !row.key || typeof row.url !== 'string' || typeof row.title !== 'string') return null
    return {
        key: row.key,
        url: row.url,
        title: row.title,
        sub: typeof row.sub === 'string' ? row.sub : '',
        at: typeof row.at === 'number' ? row.at : 0,
        pinned: row.pinned === true,
        missing: row.missing === true,
        ...(typeof row.sessionId === 'string' && row.sessionId ? { sessionId: row.sessionId } : {})
    }
}

/** A row that does not check out is dropped alone: one odd title must not cost the whole list. */
const toRows = (values: unknown[]): DockRow[] =>
    values
        .slice(0, DOCK_MAX_ROWS)
        .map(toRow)
        .filter((row): row is DockRow => row !== null)

function parseAnswer(line: string): Answer {
    let parsed: unknown
    try {
        parsed = JSON.parse(line)
    } catch {
        return { kind: 'broken' }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { kind: 'broken' }
    const reply = parsed as Record<string, unknown>
    if (reply.ok !== true || reply.protocol !== DOCK_PROTOCOL) return { kind: 'outdated' }
    if (!Array.isArray(reply.open) || !Array.isArray(reply.closed)) return { kind: 'broken' }
    return { kind: 'rows', open: toRows(reply.open), closed: toRows(reply.closed) }
}

/** One request, one line back. Always settles and always closes the connection. */
function askSocket(socketPath: string): Promise<Answer> {
    return new Promise((resolve) => {
        const chunks: Buffer[] = []
        let size = 0
        let settled = false
        const socket = net.createConnection(socketPath)
        const settle = (answer: Answer): void => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            socket.destroy()
            resolve(answer)
        }
        const timer = setTimeout(() => settle({ kind: 'outdated' }), DOCK_ANSWER_TIMEOUT_MS)
        socket.on('connect', () => socket.write(DOCK_REQUEST))
        socket.on('data', (chunk: Buffer) => {
            size += chunk.length
            if (size > DOCK_MAX_RESPONSE_BYTES) return settle({ kind: 'broken' })
            const end = chunk.indexOf(0x0a)
            if (end === -1) {
                chunks.push(chunk)
                return
            }
            chunks.push(chunk.subarray(0, end))
            settle(parseAnswer(Buffer.concat(chunks).toString('utf8')))
        })
        // ENOENT: never started, or the host removed it on exit. ECONNREFUSED: a crash left the file behind.
        socket.on('error', (error: NodeJS.ErrnoException) => {
            settle(error.code === 'ENOENT' || error.code === 'ECONNREFUSED' ? { kind: 'off' } : { kind: 'broken' })
        })
        // the host went away mid-answer (Chrome quitting): nothing at all is "off", half a line is broken
        socket.on('close', () => settle(size === 0 ? { kind: 'off' } : { kind: 'broken' }))
    })
}
