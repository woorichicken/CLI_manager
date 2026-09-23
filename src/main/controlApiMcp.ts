import { ApiOutput, ApiWaitResult, ControlApiError, ControlApiService, NAMED_KEYS } from './ControlApiService'

/**
 * Model Context Protocol over Streamable HTTP, stateless, JSON responses only.
 *
 * Hand-rolled on purpose: the server needs four methods (initialize, ping,
 * tools/list, tools/call), and the official SDK would pull an Express stack
 * into the app bundle for them. The spec allows a server that answers every
 * POST with `application/json` and rejects GET with 405, which is all this does.
 */

const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0]

const JSONRPC_PARSE_ERROR = -32700
const JSONRPC_INVALID_REQUEST = -32600
const JSONRPC_METHOD_NOT_FOUND = -32601
const JSONRPC_INVALID_PARAMS = -32602

/** MCP clients commonly cap a tool call at a few minutes; stay under that by default. */
const DEFAULT_WAIT_SECONDS = 120
const MAX_WAIT_SECONDS = 600

const INSTRUCTIONS = `CLI Manager runs terminal sessions the user watches live. These tools let you open a session in a folder, type into it, wait for it to finish, and read its screen — so work you delegate to a CLI agent (for example Claude Code launched from one of the user's templates) happens where the user can see and step in.

Typical flow:
1. list_templates (and list_workspaces if you need a folder the user already uses).
2. open_session with path + template, and optionally prompt to send once the program has started.
3. wait_for_idle, then read_output. Or pass wait_seconds to send_input to do both in one call.
4. Repeat send_input / wait_for_idle as needed. close_session when done, or release_session to hand it to the user.

Rules: you can only access sessions you opened. The user sees them highlighted in green and may type into them or disconnect them at any time — re-read the screen before acting, and stop if a call says the session is not under AI control. If a screen shows a question (awaitingInput: true) — a permission prompt, or Claude Code asking whether to trust a new folder — read the options and answer with send_input keys (e.g. ["down","enter"], ["1"]); text is refused until the question is gone. Trusting a folder or approving an action is the user's call: only accept when the user's request clearly covers it.`

interface JsonRpcRequest {
    jsonrpc?: string
    id?: string | number | null
    method?: string
    params?: Record<string, unknown>
}

interface ToolDefinition {
    name: string
    description: string
    inputSchema: Record<string, unknown>
}

const sessionIdProperty = {
    session_id: { type: 'string', description: 'Session id returned by open_session or list_sessions.' }
}

const TOOLS: ToolDefinition[] = [
    {
        name: 'list_workspaces',
        description: 'List folders registered in CLI Manager (the user has many — use query to filter by name or path).',
        inputSchema: {
            type: 'object',
            properties: { query: { type: 'string', description: 'Case-insensitive substring of the name or path.' } }
        }
    },
    {
        name: 'list_templates',
        description: "List the user's terminal templates (name + command). Pass a template name to open_session to start that program.",
        inputSchema: { type: 'object', properties: {} }
    },
    {
        name: 'list_sessions',
        description: 'List the sessions under your control with their state (starting, busy, idle, exited).',
        inputSchema: { type: 'object', properties: {} }
    },
    {
        name: 'open_session',
        description:
            'Open a new terminal session in a folder, visible in CLI Manager and highlighted as AI-controlled. The folder is registered as a workspace if it is not one yet. Optionally run a template or command, and send a first prompt once the program has started.',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Absolute folder path. Use this or workspace_id.' },
                workspace_id: { type: 'string', description: 'Id from list_workspaces. Use this or path.' },
                template: { type: 'string', description: 'Template name or id to run (see list_templates).' },
                command: { type: 'string', description: 'Shell command to run instead of a template.' },
                name: { type: 'string', description: 'Session name shown in the sidebar.' },
                prompt: {
                    type: 'string',
                    description: 'Text to submit after the program has started and gone quiet (e.g. the task for Claude Code).'
                },
                focus: { type: 'boolean', description: 'Also switch the app to this session. Default false.' }
            }
        }
    },
    {
        name: 'send_input',
        description:
            'Type into a session. text is submitted with Enter unless submit is false; multi-line text is sent as one paste. keys are pressed after the text. Set wait_seconds to wait for the session to settle and get its screen back in the same call. Text is refused while the screen shows a question or menu (Enter would pick the highlighted option) — answer those with keys.',
        inputSchema: {
            type: 'object',
            properties: {
                ...sessionIdProperty,
                text: { type: 'string', description: 'Text to type.' },
                submit: { type: 'boolean', description: 'Press Enter after text. Default true.' },
                keys: {
                    type: 'array',
                    items: { type: 'string' },
                    description: `Keys to press in order: a single character or one of ${Object.keys(NAMED_KEYS).join(', ')}.`
                },
                force: {
                    type: 'boolean',
                    description: 'Type text even though the screen shows a question (e.g. a free-text answer). Default false.'
                },
                wait_seconds: {
                    type: 'number',
                    description: `Wait up to this many seconds for the session to settle, then return the screen. 0 (default) returns immediately. Max ${MAX_WAIT_SECONDS}.`
                }
            },
            required: ['session_id']
        }
    },
    {
        name: 'wait_for_idle',
        description:
            'Wait until a session settles — no output for a moment and no "esc to interrupt" on screen — then return its screen. Returns the screen with timedOut: true if it is still busy at the deadline; call again to keep waiting.',
        inputSchema: {
            type: 'object',
            properties: {
                ...sessionIdProperty,
                timeout_seconds: { type: 'number', description: `Default ${DEFAULT_WAIT_SECONDS}, max ${MAX_WAIT_SECONDS}.` },
                quiet_ms: { type: 'number', description: 'Output silence that counts as settled. Default 1500.' },
                lines: { type: 'number', description: 'Screen lines to return. Default 60.' }
            },
            required: ['session_id']
        }
    },
    {
        name: 'read_output',
        description: 'Read what a session shows. mode "screen" (default) is the visible screen; "tail" includes scrollback.',
        inputSchema: {
            type: 'object',
            properties: {
                ...sessionIdProperty,
                mode: { type: 'string', enum: ['screen', 'tail'] },
                lines: { type: 'number', description: 'How many lines, from the bottom. Default 60, max 2000.' }
            },
            required: ['session_id']
        }
    },
    {
        name: 'focus_session',
        description: 'Switch CLI Manager to show this session, so the user can watch it.',
        inputSchema: { type: 'object', properties: { ...sessionIdProperty }, required: ['session_id'] }
    },
    {
        name: 'release_session',
        description: 'Hand a session to the user: it keeps running, but you lose access to it.',
        inputSchema: { type: 'object', properties: { ...sessionIdProperty }, required: ['session_id'] }
    },
    {
        name: 'close_session',
        description: 'Stop a session you opened and remove it from CLI Manager.',
        inputSchema: { type: 'object', properties: { ...sessionIdProperty }, required: ['session_id'] }
    }
]

class InvalidParams extends Error {}

function str(args: Record<string, unknown>, key: string, required = false): string | undefined {
    const value = args[key]
    if (value === undefined || value === null) {
        if (required) throw new InvalidParams(`${key} is required`)
        return undefined
    }
    if (typeof value !== 'string') throw new InvalidParams(`${key} must be a string`)
    return value
}

function num(args: Record<string, unknown>, key: string): number | undefined {
    const value = args[key]
    if (value === undefined || value === null) return undefined
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new InvalidParams(`${key} must be a number`)
    return value
}

function bool(args: Record<string, unknown>, key: string): boolean | undefined {
    const value = args[key]
    if (value === undefined || value === null) return undefined
    if (typeof value !== 'boolean') throw new InvalidParams(`${key} must be a boolean`)
    return value
}

function strList(args: Record<string, unknown>, key: string): string[] | undefined {
    const value = args[key]
    if (value === undefined || value === null) return undefined
    if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
        throw new InvalidParams(`${key} must be an array of strings`)
    }
    return value as string[]
}

function seconds(value: number | undefined, fallback: number): number {
    return Math.min(Math.max(value ?? fallback, 0), MAX_WAIT_SECONDS) * 1000
}

/** Screens read better as text than as a JSON-escaped string. */
function formatScreen(output: ApiOutput | ApiWaitResult): string {
    const s = output.session
    const header = [
        `session ${s.id} (${s.name}) · state: ${s.state} · awaitingInput: ${s.awaitingInput}`,
        'timedOut' in output ? `waited ${Math.round(output.waitedMs / 100) / 10}s${output.timedOut ? ' · TIMED OUT (still busy)' : ''}` : null,
        `--- ${output.mode} (${output.lines.length} lines${output.cols ? `, ${output.cols}x${output.rows}` : ''}) ---`
    ].filter(Boolean)
    return [...header, ...output.lines].join('\n')
}

async function callTool(
    service: ControlApiService,
    name: string,
    args: Record<string, unknown>,
    client: string,
    signal: AbortSignal
): Promise<string> {
    switch (name) {
        case 'list_workspaces':
            return JSON.stringify(service.listWorkspaces(str(args, 'query')), null, 1)
        case 'list_templates':
            return JSON.stringify(service.listTemplates(), null, 1)
        case 'list_sessions':
            return JSON.stringify(service.listSessions(), null, 1)
        case 'open_session': {
            const result = await service.openSession({
                path: str(args, 'path'),
                workspaceId: str(args, 'workspace_id'),
                template: str(args, 'template'),
                command: str(args, 'command'),
                name: str(args, 'name'),
                prompt: str(args, 'prompt'),
                focus: bool(args, 'focus'),
                client
            })
            return JSON.stringify(result, null, 1)
        }
        case 'send_input': {
            const sessionId = str(args, 'session_id', true)!
            const session = await service.sendInput(sessionId, {
                text: str(args, 'text'),
                submit: bool(args, 'submit'),
                keys: strList(args, 'keys'),
                force: bool(args, 'force')
            })
            const waitMs = seconds(num(args, 'wait_seconds'), 0)
            if (waitMs === 0) return JSON.stringify({ sent: true, session }, null, 1)
            return formatScreen(await service.waitForIdle(sessionId, { timeoutMs: waitMs, signal }))
        }
        case 'wait_for_idle':
            return formatScreen(
                await service.waitForIdle(str(args, 'session_id', true)!, {
                    timeoutMs: seconds(num(args, 'timeout_seconds'), DEFAULT_WAIT_SECONDS),
                    quietMs: num(args, 'quiet_ms'),
                    lines: num(args, 'lines'),
                    signal
                })
            )
        case 'read_output': {
            const mode = str(args, 'mode')
            if (mode !== undefined && mode !== 'screen' && mode !== 'tail') throw new InvalidParams('mode must be "screen" or "tail"')
            return formatScreen(
                await service.readOutput(str(args, 'session_id', true)!, { mode, lines: num(args, 'lines') })
            )
        }
        case 'focus_session':
            return JSON.stringify(service.focusSession(str(args, 'session_id', true)!), null, 1)
        case 'release_session':
            service.releaseSession(str(args, 'session_id', true)!)
            return 'Released. The session keeps running for the user; you no longer have access to it.'
        case 'close_session':
            service.closeSession(str(args, 'session_id', true)!)
            return 'Closed.'
        default:
            throw new InvalidParams(`Unknown tool: ${name}`)
    }
}

function rpcError(id: JsonRpcRequest['id'], code: number, message: string): Record<string, unknown> {
    return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }
}

async function handleOne(
    service: ControlApiService,
    request: JsonRpcRequest,
    appVersion: string,
    client: string,
    signal: AbortSignal
): Promise<Record<string, unknown> | null> {
    if (!request || typeof request !== 'object' || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
        return rpcError(request?.id, JSONRPC_INVALID_REQUEST, 'Invalid JSON-RPC request')
    }

    const isNotification = request.id === undefined
    if (isNotification) return null  // notifications/initialized, cancelled, … need no answer

    const { id, method } = request
    const params = request.params ?? {}

    switch (method) {
        case 'initialize': {
            const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : LATEST_PROTOCOL_VERSION
            return {
                jsonrpc: '2.0',
                id,
                result: {
                    protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION,
                    capabilities: { tools: { listChanged: false } },
                    serverInfo: { name: 'cli-manager', title: 'CLI Manager', version: appVersion },
                    instructions: INSTRUCTIONS
                }
            }
        }
        case 'ping':
            return { jsonrpc: '2.0', id, result: {} }
        case 'tools/list':
            return { jsonrpc: '2.0', id, result: { tools: TOOLS } }
        case 'tools/call': {
            const name = params.name
            const args = (params.arguments ?? {}) as Record<string, unknown>
            if (typeof name !== 'string' || typeof args !== 'object' || Array.isArray(args)) {
                return rpcError(id, JSONRPC_INVALID_PARAMS, 'tools/call needs name and an arguments object')
            }
            try {
                const text = await callTool(service, name, args, client, signal)
                return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } }
            } catch (error) {
                if (error instanceof InvalidParams) return rpcError(id, JSONRPC_INVALID_PARAMS, error.message)
                // Domain failures are tool results, not protocol errors, so the
                // model sees the message and can correct course.
                const message = error instanceof ControlApiError ? `${error.code}: ${error.message}` : String((error as Error)?.message ?? error)
                return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: message }], isError: true } }
            }
        }
        default:
            return rpcError(id, JSONRPC_METHOD_NOT_FOUND, `Method not found: ${method}`)
    }
}

/**
 * Handles one POST body. Returns the JSON to send, or null for "202 Accepted,
 * no body" (the body held only notifications or responses).
 */
export async function handleMcpBody(
    service: ControlApiService,
    rawBody: string,
    appVersion: string,
    client: string,
    signal: AbortSignal
): Promise<unknown | null> {
    let parsed: unknown
    try {
        parsed = JSON.parse(rawBody)
    } catch {
        return rpcError(null, JSONRPC_PARSE_ERROR, 'Parse error')
    }

    // Batches were removed in 2025-06-18 but older clients may still send them.
    if (Array.isArray(parsed)) {
        const responses = (
            await Promise.all(parsed.map((r) => handleOne(service, r as JsonRpcRequest, appVersion, client, signal)))
        ).filter((r) => r !== null)
        return responses.length > 0 ? responses : null
    }

    return handleOne(service, parsed as JsonRpcRequest, appVersion, client, signal)
}

export const MCP_TOOL_NAMES = TOOLS.map((t) => t.name)
