import http from 'http'
import type { AddressInfo, Socket } from 'net'
import { existsSync, readFileSync } from 'fs'
import { extname, join, normalize } from 'path'
import { WebSocketServer, type WebSocket } from 'ws'
import type { PhoneMe, PhoneRole } from '../../shared/phone'
import { PHONE_API } from '../../shared/phone'
import type { PhoneSettings, PhoneState, SessionScreenStatus } from '../../shared/types'
import { DEFAULT_PHONE } from '../../shared/types'
import { decidePhoneAccess, hostAllowed, isLoopbackAddress, sameOrigin, type PhoneAccess } from './phoneAccess'
import { describeBrowser, PhoneConnections } from './phoneConnections'
import type { PhoneDevices } from './PhoneDevices'
import type { PhonePush } from './PhonePush'
import type { TailscaleStatus } from './tailscaleStatus'
import { handlePhoneApi, type PhoneApiDeps } from './phoneApi'
import { handleChatSocket, handleTerminalSocket, type PhoneSocketDeps } from './phoneSockets'
import { handlePhoneFeedback, isPhoneFeedbackPath, type PhoneFeedbackDeps } from './phoneFeedback'

/**
 * The phone connection: a second HTTP server in main, apart from the Control API.
 *
 * Safety (the person's worry was "the Mac becomes a server"):
 *   - off until Settings › Phone turns it on; off closes the server and every phone socket
 *   - 127.0.0.1 only, its own port; `/v1` and `/mcp` do not exist here — only the routes
 *     below, which read sessions and work in existing ones (no create, delete, rename, resize)
 *   - reached through `tailscale serve`, which the person runs (the app shows the command);
 *     Funnel (the public internet) is refused
 *   - who: this Mac's own Tailscale login, or a device paired with a six-digit code
 *   - Host must name this Mac (loopback, *.ts.net, a tailnet address) and a browser request
 *     that changes something must come from the page's own origin
 */

const HOST = '127.0.0.1'
const COOKIE = 'climanager_phone'
const COOKIE_MAX_AGE = 400 * 24 * 60 * 60
/** a phone that fetched within this long counts as connected */
const CONNECTED_WINDOW_MS = 60_000

const TYPES: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.woff2': 'font/woff2',
    '.woff': 'font/woff',
    '.ttf': 'font/ttf'
}

const CSP = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "worker-src 'self'",
    "manifest-src 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'"
].join('; ')

export interface PhoneServerDeps extends Omit<PhoneApiDeps, 'access' | 'owner' | 'devices' | 'push' | 'stillAllowed'>, PhoneSocketDeps {
    devices: PhoneDevices
    push: PhonePush
    tailscale: TailscaleStatus
    /** out/renderer — phone.html, its assets (from Vite's manifest) and phone/ public files */
    staticDir: string
    /** Settings, the sidebar badge: the state changed */
    onStateChange(): void
    /** a status poller for alerts, started and stopped with the server */
    statusPoller: { start(): void; stop(): void }
    /**
     * A paired device lost access (`null`: every device) — Disconnect, Disconnect all, or pushed out by the
     * 51st pairing. Its sockets are already closing; work it left behind (a Chat queue it filled) should go too.
     */
    onDeviceRevoked?(deviceId: string | null): void
    /** the feedback widget on the phone (phoneFeedback.ts); absent, the page never shows it */
    feedback?: PhoneFeedbackDeps
    /** the Mac's chat quick replies (Settings › Terminal › Chat view), for the phone's own switch (847da0aa) */
    quickReplies?(): string[]
}

export interface PhoneRequestAccess {
    access: PhoneAccess
    /** who owns alerts this request turns on */
    owner: string | null
}

export class PhoneServer {
    private server: http.Server | null = null
    private wss: WebSocketServer | null = null
    private boundPort: number | null = null
    private lastError: string | undefined
    private enabled = false
    private allowedAssets: Set<string> | null = null
    /** who fetched lately or has a socket open, for "n connected" and Settings' list */
    private readonly connections = new PhoneConnections(CONNECTED_WINDOW_MS)
    private readonly sockets = new Set<{ ws: WebSocket; who: string; deviceId?: string }>()

    constructor(private readonly deps: PhoneServerDeps) {
        deps.devices.onRevoke((deviceId) => {
            // close() only starts the handshake: frames the phone sends until it answers still arrive.
            // The terminal socket asks `stillAllowed` before every input (ovis connections.ts:164,247).
            for (const socket of [...this.sockets]) {
                if (deviceId === null ? socket.deviceId !== undefined : socket.deviceId === deviceId) socket.ws.close(4401, 'revoked')
            }
            deps.push.forgetOwner(deviceId === null ? null : `device:${deviceId}`)
            this.connections.forget((key) => (deviceId === null ? key.startsWith('device:') : key === `device:${deviceId}`))
            deps.onDeviceRevoked?.(deviceId)
        })
        deps.devices.onChange(() => deps.onStateChange())
    }

    // ------------------------------------------------------------------
    // Lifecycle
    // ------------------------------------------------------------------

    /** Brings the server in line with `settings`. Never throws: a failure lands in `state().error`. */
    async apply(settings: PhoneSettings): Promise<PhoneState> {
        const next = { ...DEFAULT_PHONE, ...settings }
        await this.stop()
        this.lastError = undefined
        this.allowedAssets = null
        this.enabled = next.enabled
        if (!next.enabled) {
            this.deps.onStateChange()
            return this.state()
        }
        try {
            await this.listen(next.port)
            this.deps.statusPoller.start()
            // who the owner is: read now so the first phone does not wait for it
            void this.deps.tailscale.read(true).then(() => this.deps.onStateChange())
        } catch (error) {
            this.lastError = error instanceof Error ? error.message : String(error)
            this.enabled = false
            await this.stop()
        }
        this.deps.onStateChange()
        return this.state()
    }

    /** Closes the server and every phone connection. */
    async stop(): Promise<void> {
        this.enabled = false
        this.deps.statusPoller.stop()
        for (const socket of this.sockets) socket.ws.terminate()
        this.sockets.clear()
        this.connections.clear()
        this.wss?.close()
        this.wss = null
        const server = this.server
        this.server = null
        this.boundPort = null
        if (!server) return
        await new Promise<void>((resolve) => {
            server.close(() => resolve())
            server.closeAllConnections()
        })
    }

    state(): PhoneState {
        const ts = this.deps.tailscale.peek()
        const port = this.boundPort
        const dnsName = ts?.dnsName ?? null
        const target = `http://127.0.0.1:${port ?? this.configuredPortHint()}`
        return {
            running: this.server !== null,
            port,
            localUrl: port ? `http://127.0.0.1:${port}/` : null,
            ...(this.lastError ? { error: this.lastError } : {}),
            tailscale: { found: ts?.found ?? false, owner: ts?.owner ?? null, dnsName },
            phoneUrl: dnsName ? `https://${dnsName}/` : null,
            serveCommand: `tailscale serve --bg --https=443 ${target}`,
            serveOffCommand: 'tailscale serve --https=443 off',
            devices: this.deps.devices.list(),
            pairing: this.deps.devices.activePairing(),
            connected: this.connections.count(),
            connections: this.connections.list(),
            pushDevices: this.deps.push.count(),
            ...(() => {
                const pushError = this.deps.push.keysProblem()
                return pushError ? { pushError } : {}
            })()
        }
    }

    /** Re-read Tailscale (Settings opening), then the state. */
    async refresh(): Promise<PhoneState> {
        if (this.server) await this.deps.tailscale.read(true)
        return this.state()
    }

    /** Screen status from the poller: alerts. The question is screen text — masked first. */
    statusChanged(changes: SessionScreenStatus[]): void {
        if (!this.server) return
        this.deps.push.onStatus(changes.map((c) => (c.question ? { ...c, question: this.deps.maskLine(c.question) } : c)))
    }

    /**
     * Access judged when a request's headers (or a socket's upgrade) arrived, asked again right before
     * it types: the phone may have been switched off or the device revoked in between.
     */
    stillAllowed(access: Extract<PhoneAccess, { level: 'full' }>): boolean {
        if (!this.enabled || this.server === null) return false
        return access.via !== 'device' || (access.deviceId !== undefined && this.deps.devices.has(access.deviceId))
    }

    private configuredPortHint(): number {
        return DEFAULT_PHONE.port
    }

    private listen(port: number): Promise<void> {
        const server = http.createServer((req, res) => {
            void this.handle(req, res).catch((error) => {
                console.error('[phone] request failed:', error instanceof Error ? error.message : error)
                if (!res.headersSent) send(res, 500, { error: 'internal' })
                else res.end()
            })
        })
        // a slow or idle client cannot hold sockets forever
        server.headersTimeout = 15_000
        server.requestTimeout = 120_000
        const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: false })
        server.on('upgrade', (req, socket, head) => {
            void this.upgrade(req, socket as Socket, head, wss).catch(() => socket.destroy())
        })
        return new Promise((resolve, reject) => {
            server.once('error', reject)
            server.listen(port, HOST, () => {
                server.off('error', reject)
                server.on('error', (error) => console.error('[phone] server error:', error.message))
                this.server = server
                this.wss = wss
                this.boundPort = (server.address() as AddressInfo).port
                resolve()
            })
        })
    }

    // ------------------------------------------------------------------
    // Requests
    // ------------------------------------------------------------------

    /** Access for this request: the rules in phoneAccess.ts with what serve and the cookie say. */
    async accessFor(req: http.IncomingMessage): Promise<PhoneRequestAccess> {
        const header = (name: string): string | null => {
            const value = req.headers[name]
            return (Array.isArray(value) ? value[0] : value) ?? null
        }
        const ts = await this.deps.tailscale.read()
        const device = this.deps.devices.match(readCookie(req.headers.cookie, COOKIE))
        const access = decidePhoneAccess({
            enabled: this.enabled && this.server !== null,
            loopback: isLoopbackAddress(req.socket.remoteAddress),
            funnel: header('tailscale-funnel-request') !== null,
            tailscaleLogin: header('tailscale-user-login'),
            forwardedFor: header('x-forwarded-for'),
            owner: ts.owner,
            device
        })
        const owner = access.level !== 'full' ? null : access.via === 'device' ? `device:${access.deviceId}` : `tailscale:${access.login}`
        if (owner && access.level === 'full') {
            const first = this.connections.seen(owner, {
                label: access.via === 'device' ? access.deviceLabel ?? 'Paired device' : access.login ?? 'Tailscale',
                kind: access.via === 'device' ? 'device' : 'owner',
                // `tailscale serve` forwards with X-Forwarded-For; without it the request came straight to 127.0.0.1
                route: header('x-forwarded-for') !== null ? 'tailscale' : 'local',
                browser: describeBrowser(header('user-agent')),
                role: access.role
            })
            if (first) this.deps.onStateChange()
        }
        return { access, owner }
    }

    private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        res.setHeader('X-Content-Type-Options', 'nosniff')
        res.setHeader('Referrer-Policy', 'no-referrer')
        if (!hostAllowed(req.headers.host)) {
            send(res, 421, { error: 'bad_host' })
            return
        }
        const url = new URL(req.url ?? '/', 'http://phone.local')
        const path = url.pathname

        if (path.startsWith('/api/')) {
            if (req.method !== 'GET' && req.method !== 'HEAD' && !sameOrigin(header(req, 'origin'), req.headers.host)) {
                send(res, 403, { error: 'bad_origin' })
                return
            }
            const who = await this.accessFor(req)
            if (path === PHONE_API.me) {
                send(res, 200, this.me(who.access))
                return
            }
            if (path === PHONE_API.pair && req.method === 'POST') {
                await this.pair(req, res)
                return
            }
            if (who.access.level !== 'full') {
                send(res, who.access.reason === 'pairing_required' ? 401 : 403, { error: who.access.reason })
                return
            }
            const access = who.access
            if (isPhoneFeedbackPath(path)) {
                await handlePhoneFeedback(req, res, url, this.deps.feedback, {
                    access,
                    stillAllowed: () => this.stillAllowed(access),
                    sessionExists: (id) => this.deps.sessionExists(id)
                })
                return
            }
            await handlePhoneApi(req, res, url, { ...this.deps, access, owner: who.owner!, stillAllowed: () => this.stillAllowed(access) })
            return
        }

        if (req.method !== 'GET' && req.method !== 'HEAD') {
            send(res, 405, { error: 'method' })
            return
        }
        this.serveStatic(path, res)
    }

    private me(access: PhoneAccess): PhoneMe {
        if (access.level !== 'full') return { access: 'none', reason: access.reason }
        return {
            access: 'full',
            role: access.role,
            via: access.via,
            ...(access.login ? { login: access.login } : {}),
            ...(access.deviceLabel ? { deviceLabel: access.deviceLabel } : {}),
            ...this.pushInfo(),
            // the widget only for a device that may send — what a view-only device could report it cannot send
            ...(access.role === 'drive' && this.deps.feedback?.enabled() ? { feedback: { appVersion: this.deps.feedback.appVersion() } } : {}),
            // a view-only device has no box to put them in
            ...(access.role === 'drive' && this.deps.quickReplies ? { quickReplies: this.deps.quickReplies() } : {})
        }
    }

    /** The key a page subscribes with; none when the key file is malformed (Settings › Phone says why). */
    private pushInfo(): { push?: { publicKey: string } } {
        try {
            return { push: { publicKey: this.deps.push.publicKey() } }
        } catch {
            return {}
        }
    }

    private async pair(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!this.enabled) {
            send(res, 403, { status: 'rejected', reason: 'disabled' })
            return
        }
        // a code is only worth guessing from where serve or this Mac sends it
        if (!isLoopbackAddress(req.socket.remoteAddress) || req.headers['tailscale-funnel-request'] !== undefined) {
            send(res, 403, { status: 'rejected', reason: 'disabled' })
            return
        }
        const body = await readJson(req)
        const result = this.deps.devices.pair(body?.code, body?.label)
        if ('error' in result) {
            send(res, 400, { status: 'rejected', reason: result.error })
            return
        }
        const secure = header(req, 'x-forwarded-proto') === 'https'
        res.setHeader('Set-Cookie', `${COOKIE}=${result.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE}${secure ? '; Secure' : ''}`)
        send(res, 200, { status: 'paired', role: result.device.role })
    }

    private async upgrade(req: http.IncomingMessage, socket: Socket, head: Buffer, wss: WebSocketServer): Promise<void> {
        const refuse = (status: number, text: string): void => {
            socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
        }
        if (!hostAllowed(req.headers.host)) return refuse(421, 'Misdirected Request')
        // a page on another origin cannot ride the cookie into a socket
        if (!sameOrigin(header(req, 'origin'), req.headers.host)) return refuse(403, 'Forbidden')
        const url = new URL(req.url ?? '/', 'http://phone.local')
        const who = await this.accessFor(req)
        if (who.access.level !== 'full') return refuse(401, 'Unauthorized')
        const access = who.access
        const role: PhoneRole = access.role
        const sessionId = url.searchParams.get('session') ?? ''
        const isTerminal = url.pathname === PHONE_API.terminal
        const chatMatch = /^\/api\/phone\/chat\/([^/]+)\/events$/.exec(url.pathname)
        if (!isTerminal && !chatMatch) return refuse(404, 'Not Found')
        const targetId = isTerminal ? sessionId : decodeURIComponent(chatMatch![1])
        if (!this.deps.sessionExists(targetId)) return refuse(404, 'Not Found')

        wss.handleUpgrade(req, socket, head, (ws) => {
            const entry = { ws, who: who.owner!, ...(access.via === 'device' ? { deviceId: access.deviceId } : {}) }
            this.sockets.add(entry)
            this.connections.opened(entry.who)
            this.deps.onStateChange()
            ws.on('close', () => {
                this.sockets.delete(entry)
                this.connections.closed(entry.who)
                this.deps.onStateChange()
            })
            if (isTerminal) handleTerminalSocket(ws, targetId, role, this.deps, () => this.stillAllowed(access))
            else handleChatSocket(ws, targetId, this.deps)
        })
    }

    // ------------------------------------------------------------------
    // Static files: phone.html and only the assets it loads
    // ------------------------------------------------------------------

    private serveStatic(path: string, res: http.ServerResponse): void {
        const dir = this.deps.staticDir
        let file: string | null = null
        if (path === '/' || path === '/index.html' || path === '/phone.html') file = 'phone.html'
        else if (path === '/sw.js') file = 'phone/sw.js'
        else if (path === '/manifest.webmanifest' || path === '/phone/manifest.webmanifest') file = 'phone/manifest.webmanifest'
        else if (/^\/phone\/[a-z0-9-]+\.png$/.test(path)) file = path.slice(1)
        else if (path.startsWith('/assets/')) {
            const relative = normalize(path.slice(1))
            if (this.assets().has(relative)) file = relative
        }
        if (!file) {
            send(res, 404, { error: 'not_found' })
            return
        }
        const full = join(dir, file)
        if (!full.startsWith(dir) || !existsSync(full)) {
            send(res, file === 'phone.html' ? 503 : 404, { error: file === 'phone.html' ? 'The phone page is not built. Run pnpm build.' : 'not_found' })
            return
        }
        const body = readFileSync(full)
        res.statusCode = 200
        res.setHeader('Content-Type', TYPES[extname(full)] ?? 'application/octet-stream')
        if (file === 'phone.html') res.setHeader('Content-Security-Policy', CSP)
        // hashed assets never change; the page, the worker and the manifest must not stick
        res.setHeader('Cache-Control', file.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache')
        if (file === 'phone/sw.js') res.setHeader('Service-Worker-Allowed', '/')
        res.end(body)
    }

    /**
     * The files phone.html loads, from Vite's manifest: its entry chunk, the chunks it
     * imports (Chat view's included), their CSS and assets — not the desktop app's.
     */
    private assets(): Set<string> {
        if (this.allowedAssets) return this.allowedAssets
        const allowed = new Set<string>()
        try {
            const manifest = JSON.parse(readFileSync(join(this.deps.staticDir, '.vite', 'manifest.json'), 'utf8')) as Record<string, ManifestChunk>
            const visit = (key: string, seen: Set<string>): void => {
                if (seen.has(key)) return
                seen.add(key)
                const chunk = manifest[key]
                if (!chunk) return
                allowed.add(normalize(chunk.file))
                for (const css of chunk.css ?? []) allowed.add(normalize(css))
                for (const asset of chunk.assets ?? []) allowed.add(normalize(asset))
                for (const child of [...(chunk.imports ?? []), ...(chunk.dynamicImports ?? [])]) visit(child, seen)
            }
            const entry = Object.keys(manifest).find((key) => key.endsWith('phone.html'))
            if (entry) visit(entry, new Set())
        } catch {
            // not built: every asset is a 404 and phone.html a 503
        }
        this.allowedAssets = allowed
        return allowed
    }
}

interface ManifestChunk {
    file: string
    css?: string[]
    assets?: string[]
    imports?: string[]
    dynamicImports?: string[]
}

function header(req: http.IncomingMessage, name: string): string | null {
    const value = req.headers[name]
    return (Array.isArray(value) ? value[0] : value) ?? null
}

export function send(res: http.ServerResponse, status: number, body: unknown): void {
    res.statusCode = status
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    res.end(JSON.stringify(body))
}

export function readCookie(cookieHeader: string | undefined, name: string): string | null {
    for (const part of (cookieHeader ?? '').split(';')) {
        const [key, ...rest] = part.trim().split('=')
        if (key === name) return rest.join('=')
    }
    return null
}

const MAX_JSON_BYTES = 256 * 1024

export async function readJson(req: http.IncomingMessage, limit = MAX_JSON_BYTES): Promise<Record<string, unknown> | null> {
    const body = await readBody(req, limit)
    if (body === null) return null
    try {
        const parsed = JSON.parse(body.toString('utf8'))
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
    } catch {
        return null
    }
}

export function readBody(req: http.IncomingMessage, limit: number): Promise<Buffer | null> {
    return new Promise((resolve) => {
        const chunks: Buffer[] = []
        let size = 0
        let done = false
        req.on('data', (chunk: Buffer) => {
            if (done) return
            size += chunk.length
            if (size > limit) {
                done = true
                resolve(null)
                req.resume()
                return
            }
            chunks.push(chunk)
        })
        req.on('end', () => {
            if (!done) resolve(Buffer.concat(chunks))
        })
        req.on('error', () => {
            if (!done) resolve(null)
        })
    })
}
