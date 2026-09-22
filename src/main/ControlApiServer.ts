import http from 'http'
import { AddressInfo } from 'net'
import { randomBytes, timingSafeEqual } from 'crypto'
import { chmodSync, mkdirSync, unlinkSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { ControlApiSettings, ControlApiState, DEFAULT_CONTROL_API } from '../shared/types'
import { ControlApiError, ControlApiService } from './ControlApiService'
import { handleMcpBody } from './controlApiMcp'

/**
 * Local HTTP server for the Control API: REST under /v1 and MCP at /mcp.
 *
 * Safety model — the API can type commands into a shell, so every layer is closed by default:
 *   - off until the user turns it on in Settings > Agents
 *   - bound to 127.0.0.1 only
 *   - every request needs `Authorization: Bearer <token>`
 *   - Host must be 127.0.0.1/localhost (defeats DNS rebinding) and a browser
 *     Origin other than our own is rejected (a web page cannot drive it)
 *   - the service only touches sessions the API itself opened
 */

const HOST = '127.0.0.1'
const MAX_BODY_BYTES = 1024 * 1024
const TOKEN_BYTES = 24
const TOKEN_STORE_KEY = 'controlApiToken'
const DISCOVERY_FILE = 'control-api.json'

type JsonHandler = (ctx: RequestContext) => Promise<unknown> | unknown

interface RequestContext {
    body: Record<string, unknown>
    query: URLSearchParams
    params: Record<string, string>
    client: string
    signal: AbortSignal
}

interface Route {
    method: string
    pattern: RegExp
    keys: string[]
    handler: JsonHandler
}

function route(method: string, template: string, handler: JsonHandler): Route {
    const keys: string[] = []
    const pattern = new RegExp(
        '^' + template.replace(/:([a-zA-Z]+)/g, (_m, key: string) => {
            keys.push(key)
            return '([^/]+)'
        }) + '$'
    )
    return { method, pattern, keys, handler }
}

function sanitizeClient(value: string | string[] | undefined, fallback: string): string {
    const raw = Array.isArray(value) ? value[0] : value
    const cleaned = (raw ?? '').replace(/[^\w .@-]/g, '').trim().slice(0, 40)
    return cleaned || fallback
}

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
    const value = body[key]
    if (value === undefined || value === null) return undefined
    if (typeof value !== 'string') throw new ControlApiError(400, 'bad_request', `${key} must be a string`)
    return value
}

function optionalNumber(value: unknown, key: string): number | undefined {
    if (value === undefined || value === null || value === '') return undefined
    const n = typeof value === 'string' ? Number(value) : value
    if (typeof n !== 'number' || !Number.isFinite(n)) throw new ControlApiError(400, 'bad_request', `${key} must be a number`)
    return n
}

function optionalBoolean(body: Record<string, unknown>, key: string): boolean | undefined {
    const value = body[key]
    if (value === undefined || value === null) return undefined
    if (typeof value !== 'boolean') throw new ControlApiError(400, 'bad_request', `${key} must be a boolean`)
    return value
}

export interface ControlApiServerOptions {
    service: ControlApiService
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store: any
    appVersion: string
    /** Directory for the discovery file. CLIMANAGER_HOME in tests. */
    homeDir?: string
}

export class ControlApiServer {
    private server: http.Server | null = null
    private boundPort: number | null = null
    private lastError: string | undefined
    private readonly routes: Route[]
    private readonly discoveryPath: string

    constructor(private readonly options: ControlApiServerOptions) {
        const home = options.homeDir ?? process.env.CLIMANAGER_HOME ?? join(homedir(), '.climanager')
        this.discoveryPath = join(home, DISCOVERY_FILE)
        this.routes = this.buildRoutes()
    }

    // ------------------------------------------------------------------
    // Lifecycle
    // ------------------------------------------------------------------

    /** Brings the server in line with `settings`. Never throws: failures land in `state().error`. */
    async apply(settings: ControlApiSettings): Promise<ControlApiState> {
        const next = { ...DEFAULT_CONTROL_API, ...settings }
        await this.stop()
        this.lastError = undefined

        if (!next.enabled) return this.state()

        // Tests run the real app. Without an isolated CLIMANAGER_HOME a test
        // would overwrite the user's discovery file (and token) in ~/.climanager.
        if (process.env.CLIMANGER_TEST_USERDATA && !process.env.CLIMANAGER_HOME) {
            this.lastError = 'Disabled in test mode without CLIMANAGER_HOME'
            return this.state()
        }

        try {
            await this.listen(next.port)
            this.writeDiscovery()
        } catch (error) {
            const code = (error as NodeJS.ErrnoException)?.code
            this.lastError = code === 'EADDRINUSE'
                ? `Port ${next.port} is already in use. Pick another port.`
                : `Could not start: ${(error as Error)?.message ?? error}`
            await this.stop()
        }
        return this.state()
    }

    async stop(): Promise<void> {
        this.removeDiscovery()
        const server = this.server
        this.server = null
        this.boundPort = null
        if (!server) return
        await new Promise<void>((resolve) => {
            server.close(() => resolve())
            // Long-poll waits would otherwise hold close() open for minutes.
            server.closeAllConnections?.()
        })
    }

    regenerateToken(): ControlApiState {
        this.options.store.set(TOKEN_STORE_KEY, randomBytes(TOKEN_BYTES).toString('base64url'))
        if (this.server) this.writeDiscovery()
        return this.state()
    }

    state(): ControlApiState {
        const url = this.boundPort ? `http://${HOST}:${this.boundPort}` : null
        return {
            running: this.server !== null,
            port: this.boundPort,
            url,
            mcpUrl: url ? `${url}/mcp` : null,
            token: this.token(),
            discoveryPath: this.discoveryPath,
            ...(this.lastError ? { error: this.lastError } : {})
        }
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    private token(): string {
        let token = this.options.store.get(TOKEN_STORE_KEY) as string | undefined
        if (!token) {
            token = randomBytes(TOKEN_BYTES).toString('base64url')
            this.options.store.set(TOKEN_STORE_KEY, token)
        }
        return token
    }

    private listen(port: number): Promise<void> {
        return new Promise((resolve, reject) => {
            const server = http.createServer((req, res) => {
                void this.handle(req, res)
            })
            server.once('error', reject)
            server.listen(port, HOST, () => {
                server.off('error', reject)
                server.on('error', (error) => console.error('[control-api] server error:', error))
                this.server = server
                this.boundPort = (server.address() as AddressInfo).port
                console.log(`[control-api] listening on http://${HOST}:${this.boundPort}`)
                resolve()
            })
        })
    }

    /** Lets local tools find the server without the user pasting a token around. Owner-only. */
    private writeDiscovery(): void {
        if (!this.boundPort) return
        try {
            const dir = join(this.discoveryPath, '..')
            mkdirSync(dir, { recursive: true, mode: 0o700 })
            const url = `http://${HOST}:${this.boundPort}`
            writeFileSync(
                this.discoveryPath,
                JSON.stringify({ url, mcpUrl: `${url}/mcp`, token: this.token(), pid: process.pid }, null, 2) + '\n',
                { mode: 0o600 }
            )
            // writeFileSync keeps the mode of an existing file.
            chmodSync(this.discoveryPath, 0o600)
        } catch (error) {
            console.error('[control-api] could not write discovery file:', error)
        }
    }

    private removeDiscovery(): void {
        try {
            unlinkSync(this.discoveryPath)
        } catch {
            // Not there: nothing to clean up.
        }
    }

    private isAllowedHost(host: string | undefined): boolean {
        if (!host || !this.boundPort) return false
        return host === `${HOST}:${this.boundPort}` || host === `localhost:${this.boundPort}`
    }

    private isAllowedOrigin(origin: string | undefined): boolean {
        if (!origin) return true  // CLI clients send none; browsers always do
        return origin === `http://${HOST}:${this.boundPort}` || origin === `http://localhost:${this.boundPort}`
    }

    private isAuthorized(header: string | undefined): boolean {
        const match = /^Bearer\s+(.+)$/i.exec(header ?? '')
        if (!match) return false
        const given = Buffer.from(match[1].trim())
        const expected = Buffer.from(this.token())
        return given.length === expected.length && timingSafeEqual(given, expected)
    }

    private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        const send = (status: number, payload?: unknown, headers: Record<string, string> = {}): void => {
            if (res.headersSent || res.writableEnded) return
            if (payload === undefined) {
                res.writeHead(status, headers)
                res.end()
                return
            }
            const body = JSON.stringify(payload)
            res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers })
            res.end(body)
        }
        const fail = (status: number, code: string, message: string): void => send(status, { error: { code, message } })

        // Abort long waits when the client goes away.
        const abort = new AbortController()
        res.on('close', () => {
            if (!res.writableFinished) abort.abort()
        })

        try {
            if (!this.isAllowedHost(req.headers.host)) return fail(403, 'forbidden_host', 'Host not allowed')
            if (!this.isAllowedOrigin(req.headers.origin)) return fail(403, 'forbidden_origin', 'Origin not allowed')
            if (!this.isAuthorized(req.headers.authorization)) {
                return send(401, { error: { code: 'unauthorized', message: 'Missing or wrong bearer token' } }, { 'WWW-Authenticate': 'Bearer' })
            }

            const url = new URL(req.url ?? '/', `http://${HOST}`)
            const method = req.method ?? 'GET'

            if (url.pathname === '/mcp') {
                if (method !== 'POST') return send(405, undefined, { Allow: 'POST' })
                const raw = await this.readBody(req)
                const client = sanitizeClient(req.headers['x-client-name'], 'mcp')
                const response = await handleMcpBody(this.options.service, raw, this.options.appVersion, client, abort.signal)
                return response === null ? send(202) : send(200, response)
            }

            for (const r of this.routes) {
                if (r.method !== method) continue
                const match = r.pattern.exec(url.pathname)
                if (!match) continue

                const params: Record<string, string> = {}
                r.keys.forEach((key, i) => (params[key] = decodeURIComponent(match[i + 1])))

                let body: Record<string, unknown> = {}
                if (method === 'POST') {
                    const raw = await this.readBody(req)
                    if (raw.trim()) {
                        try {
                            const parsed = JSON.parse(raw)
                            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error()
                            body = parsed
                        } catch {
                            return fail(400, 'bad_json', 'Body must be a JSON object')
                        }
                    }
                }

                const result = await r.handler({
                    body,
                    query: url.searchParams,
                    params,
                    client: sanitizeClient(req.headers['x-client-name'], 'api'),
                    signal: abort.signal
                })
                return send(200, result ?? { ok: true })
            }

            return fail(404, 'no_route', `No route for ${method} ${url.pathname}`)
        } catch (error) {
            if (error instanceof ControlApiError) return fail(error.status, error.code, error.message)
            console.error('[control-api] request failed:', error)
            return fail(500, 'internal', String((error as Error)?.message ?? error))
        }
    }

    private readBody(req: http.IncomingMessage): Promise<string> {
        return new Promise((resolve, reject) => {
            const chunks: Buffer[] = []
            let size = 0
            req.on('data', (chunk: Buffer) => {
                size += chunk.length
                if (size > MAX_BODY_BYTES) {
                    reject(new ControlApiError(413, 'too_large', 'Request body is limited to 1 MB'))
                    req.destroy()
                    return
                }
                chunks.push(chunk)
            })
            req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
            req.on('error', reject)
        })
    }

    private buildRoutes(): Route[] {
        const service = this.options.service
        return [
            route('GET', '/v1/health', () => ({ ok: true, app: 'CLI Manager', version: this.options.appVersion })),
            route('GET', '/v1/workspaces', ({ query }) => service.listWorkspaces(query.get('query') ?? undefined)),
            route('GET', '/v1/templates', () => service.listTemplates()),
            route('GET', '/v1/sessions', () => service.listSessions()),
            route('POST', '/v1/sessions', ({ body, client }) =>
                service.openSession({
                    path: optionalString(body, 'path'),
                    workspaceId: optionalString(body, 'workspaceId'),
                    template: optionalString(body, 'template'),
                    command: optionalString(body, 'command'),
                    name: optionalString(body, 'name'),
                    prompt: optionalString(body, 'prompt'),
                    focus: optionalBoolean(body, 'focus'),
                    client
                })
            ),
            route('GET', '/v1/sessions/:id', ({ params }) => service.getSession(params.id)),
            route('GET', '/v1/sessions/:id/output', ({ params, query }) => {
                const mode = query.get('mode') ?? undefined
                if (mode !== undefined && mode !== 'screen' && mode !== 'tail') {
                    throw new ControlApiError(400, 'bad_request', 'mode must be "screen" or "tail"')
                }
                return service.readOutput(params.id, { mode, lines: optionalNumber(query.get('lines'), 'lines') })
            }),
            route('POST', '/v1/sessions/:id/input', ({ params, body }) => {
                const keys = body.keys
                if (keys !== undefined && (!Array.isArray(keys) || keys.some((k) => typeof k !== 'string'))) {
                    throw new ControlApiError(400, 'bad_request', 'keys must be an array of strings')
                }
                return service.sendInput(params.id, {
                    text: optionalString(body, 'text'),
                    submit: optionalBoolean(body, 'submit'),
                    keys: keys as string[] | undefined,
                    force: optionalBoolean(body, 'force')
                })
            }),
            route('POST', '/v1/sessions/:id/wait', ({ params, body, signal }) =>
                service.waitForIdle(params.id, {
                    timeoutMs: optionalNumber(body.timeoutMs, 'timeoutMs'),
                    quietMs: optionalNumber(body.quietMs, 'quietMs'),
                    lines: optionalNumber(body.lines, 'lines'),
                    signal
                })
            ),
            route('POST', '/v1/sessions/:id/focus', ({ params }) => service.focusSession(params.id)),
            route('POST', '/v1/sessions/:id/release', ({ params }) => {
                service.releaseSession(params.id)
                return { ok: true }
            }),
            route('DELETE', '/v1/sessions/:id', ({ params }) => {
                service.closeSession(params.id)
                return { ok: true }
            })
        ]
    }
}
