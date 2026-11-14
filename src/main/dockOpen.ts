/**
 * Opening a web page through Artifact Dock (fc98b340).
 *
 * A page the Chat names (`report.html`) used to go to `shell.openPath`, which asks Chrome for a new tab. When
 * Artifact Dock already holds that page, the extension treats the new tab as a duplicate: it reloads the old
 * tab and closes the new one — and because the tab came from outside Chrome, its focus guard leaves the old tab
 * where it was. The person saw the page open fully and close again, every click.
 *
 * The Dock's own `open` command (the one `artifact-open` sends) reuses the tab instead of opening a second one;
 * with `activate` it also brings that tab forward, which is what a click in the app asked for. When the Dock is
 * not there (no socket, Chrome off, an older host), the caller falls back to the Mac's own opener.
 *
 * Only the person's click reaches this: the phone's Dock reader stays read-only (phoneDock.ts).
 */
import net from 'net'
import { pathToFileURL } from 'url'

/** The extension may need a moment to wake its host; past this the Mac's opener takes over. */
export const DOCK_OPEN_TIMEOUT_MS = 5_000
const MAX_REPLY_BYTES = 64 * 1024
const SESSION_ID = /^[\w-]{1,64}$/

export type DockOpenResult = 'opened' | 'unavailable'

/** The request line the Dock reads — the same fields `artifact-open` sends. */
export function dockOpenRequest(filePath: string, sessionId?: string): string {
    const request: Record<string, unknown> = { cmd: 'open', url: pathToFileURL(filePath).href, activate: true }
    if (sessionId && SESSION_ID.test(sessionId)) request.sessionId = sessionId
    return `${JSON.stringify(request)}\n`
}

/**
 * Asks the Dock to open (or bring forward) `filePath`. `opened` only when it answered `ok: true`; anything else —
 * no socket, refused, a refusal, a broken or late answer — is `unavailable`, and the caller opens it itself.
 */
export function openInDock(socketPath: string | null, filePath: string, sessionId?: string, timeoutMs = DOCK_OPEN_TIMEOUT_MS): Promise<DockOpenResult> {
    if (!socketPath) return Promise.resolve('unavailable')
    return new Promise((resolve) => {
        const chunks: Buffer[] = []
        let size = 0
        let settled = false
        const socket = net.createConnection(socketPath)
        const settle = (result: DockOpenResult): void => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            socket.destroy()
            resolve(result)
        }
        const timer = setTimeout(() => settle('unavailable'), timeoutMs)
        socket.on('connect', () => socket.write(dockOpenRequest(filePath, sessionId)))
        socket.on('data', (chunk: Buffer) => {
            size += chunk.length
            if (size > MAX_REPLY_BYTES) return settle('unavailable')
            const end = chunk.indexOf(0x0a)
            if (end === -1) {
                chunks.push(chunk)
                return
            }
            chunks.push(chunk.subarray(0, end))
            try {
                const reply = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { ok?: unknown }
                settle(reply && reply.ok === true ? 'opened' : 'unavailable')
            } catch {
                settle('unavailable')
            }
        })
        socket.on('error', () => settle('unavailable'))
        socket.on('close', () => settle('unavailable'))
    })
}
