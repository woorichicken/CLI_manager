import type { ConversationAgent } from './conversation'

export type AliasResolver = (name: string) => string | undefined
export interface AgentCommandDecision {
    /** Unknown syntax and options remain exactly as the person saved them. */
    storedCommand: string
    /** Only this command may be typed before a new resume target. */
    inputCommand: string
    recognized: boolean
    confident: boolean
    stripped: boolean
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ONE_VALUE: Record<ConversationAgent, Set<string>> = {
    codex: new Set(['-c', '--config', '-m', '--model', '-p', '--profile', '-C', '--cd', '-s', '--sandbox', '-a', '--ask-for-approval', '-i', '--image', '--enable', '--disable', '--add-dir', '--remote', '--remote-auth-token-env', '--local-provider']),
    claude: new Set(['--plugin-dir', '--model', '--fallback-model', '-n', '--name', '--max-budget-usd', '--output-format', '--input-format', '--permission-mode', '--effort', '--agent', '--agents', '--settings', '--setting-sources', '--append-system-prompt', '--append-system-prompt-file', '--system-prompt', '--system-prompt-file'])
}
const MANY_VALUES: Record<ConversationAgent, Set<string>> = {
    codex: new Set(),
    claude: new Set(['--tools', '--file', '--add-dir', '--mcp-config', '--allowedTools', '--allowed-tools', '--disallowedTools', '--disallowed-tools', '--betas'])
}
const BOOLEAN: Record<ConversationAgent, Set<string>> = {
    codex: new Set(['--dangerously-bypass-approvals-and-sandbox', '--yolo', '--full-auto', '--oss', '--search', '--no-alt-screen']),
    claude: new Set(['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--verbose', '--chrome', '--no-chrome', '--ide', '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands', '--include-partial-messages'])
}
const NONINTERACTIVE: Record<ConversationAgent, Set<string>> = {
    codex: new Set(['exec', 'e', 'login', 'logout', 'mcp', 'mcp-server', 'app-server', 'completion', 'sandbox', 'debug', 'apply', 'a', 'cloud', 'features', 'fork', 'help']),
    claude: new Set(['install', 'uninstall', 'update', 'config', 'mcp', 'doctor', 'api-key'])
}

interface Token {
    text: string
    raw: string
    start: number
    end: number
    kind: 'word' | 'separator' | 'control'
    dynamic: boolean
}
interface Lexed { tokens: Token[]; complete: boolean }
const nameOf = (word: string): string => word.split('/').pop() ?? ''
function executableAgent(word: string): ConversationAgent | null {
    const name = nameOf(word)
    if (name === 'claude') return 'claude'
    return /^codex(?:\.js|-(?:aarch64|x86_64|arm64)-[A-Za-z0-9_-]+)?$/.test(name) ? 'codex' : null
}

/** Skips a shell substitution without interpreting it; only preparation words may retain one. */
function groupEnd(command: string, start: number, depth = 0): number {
    if (depth > 16) return -1
    let level = 1
    for (let i = start + 2; i < command.length; i++) {
        const c = command[i]
        if (c === '\\') { i++; continue }
        if (c === '"' || c === "'" || c === '`') {
            const end = quotedEnd(command, i, c, depth + 1)
            if (end < 0) return -1
            i = end; continue
        }
        if (c === '(') level++
        if (c === ')' && --level === 0) return i
    }
    return -1
}
function quotedEnd(command: string, start: number, quote: string, depth = 0): number {
    if (depth > 16) return -1
    for (let i = start + 1; i < command.length; i++) {
        if (command[i] === '\\' && quote !== "'") { i++; continue }
        if (command[i] === quote) return i
        if (quote !== "'" && command[i] === '$' && command[i + 1] === '(') {
            i = groupEnd(command, i, depth + 1)
            if (i < 0) return -1
        }
    }
    return -1
}

/** Keeps source spans so accepted options and the preparation prefix retain their original quoting. */
function lex(command: string): Lexed {
    const tokens: Token[] = []
    if (/[\x00-\x08\x0a-\x1f]/.test(command)) return { tokens, complete: false }
    let i = 0
    while (i < command.length) {
        if (/\s/.test(command[i])) { i++; continue }
        const start = i
        if (command[i] === ';' || command.slice(i, i + 2) === '&&') {
            i += command[i] === ';' ? 1 : 2
            tokens.push({ text: command.slice(start, i), raw: command.slice(start, i), start, end: i, kind: 'separator', dynamic: false })
            continue
        }
        if (/[|&<>]/.test(command[i])) {
            i++
            tokens.push({ text: command.slice(start, i), raw: command.slice(start, i), start, end: i, kind: 'control', dynamic: false })
            continue
        }
        let text = ''
        let dynamic = false
        while (i < command.length && !/\s/.test(command[i]) && !/[;&|<>]/.test(command[i])) {
            const c = command[i]
            if (c === '\\') {
                if (++i >= command.length) return { tokens, complete: false }
                text += command[i++]; continue
            }
            if (c === '"' || c === "'" || c === '`') {
                const end = quotedEnd(command, i, c)
                if (end < 0) return { tokens, complete: false }
                const value = command.slice(i + 1, end)
                dynamic ||= c === '`' || c === '"' && /[$`]/.test(value)
                text += c === "'" ? value : value.replace(/\\([\\"$`])/g, '$1')
                i = end + 1; continue
            }
            if (c === '$' && command[i + 1] === '(') {
                const end = groupEnd(command, i)
                if (end < 0) return { tokens, complete: false }
                dynamic = true; text += command.slice(i, end + 1); i = end + 1; continue
            }
            dynamic ||= c === '$'
            text += c; i++
        }
        tokens.push({ text, raw: command.slice(start, i), start, end: i, kind: 'word', dynamic })
    }
    return { tokens, complete: true }
}

function commandStart(tokens: Token[]): number {
    let start = 0
    for (let i = 0; i < tokens.length; i++) if (tokens[i].kind === 'separator') start = i + 1
    if (tokens[start]?.text === 'env') start++
    while (tokens[start]?.kind === 'word' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[start].text)) start++
    if (/^(node|nodejs)$/.test(nameOf(tokens[start]?.text ?? ''))) start++
    return start
}

export function commandAgent(command: string | undefined, resolveAlias?: AliasResolver, depth = 0): ConversationAgent | null {
    if (!command || depth > 4) return null
    const { tokens } = lex(command)
    const executable = tokens[commandStart(tokens)]
    if (!executable || executable.kind !== 'word' || executable.dynamic) return null
    return executableAgent(executable.text) ?? commandAgent(resolveAlias?.(executable.text), resolveAlias, depth + 1)
}

/** Read-only policy used for storage, manual connect and the final restart input alike. */
export function decideAgentCommand(command: string | undefined, agent: ConversationAgent, resolveAlias?: AliasResolver, depth = 0): AgentCommandDecision {
    const original = command || agent
    const fallback = (recognized = false): AgentCommandDecision => ({ storedCommand: original, inputCommand: agent, recognized, confident: false, stripped: false })
    if (depth > 4) return fallback()
    const { tokens, complete } = lex(original)
    const start = commandStart(tokens)
    const executable = tokens[start]
    if (!executable || executable.kind !== 'word' || executable.dynamic) return fallback()
    const actual = executableAgent(executable.text)
    if (actual !== agent) {
        if (actual) return fallback()
        const expansion = resolveAlias?.(executable.text)
        if (!expansion) return fallback()
        const alias = decideAgentCommand(expansion, agent, resolveAlias, depth + 1)
        if (!alias.recognized) return fallback()
        // An alias carrying a prompt or resume target would replay it even after its visible text was removed.
        if (!alias.confident || alias.stripped) return fallback(true)
    }
    if (!complete) return fallback(true)
    const kept: Token[] = []
    let stripped = false
    for (let i = start + 1; i < tokens.length; i++) {
        const token = tokens[i]
        if (token.kind !== 'word' || token.dynamic) return fallback(true)
        const equals = token.text.indexOf('=')
        const flag = equals < 0 ? token.text : token.text.slice(0, equals)
        if (agent === 'codex' && token.text === 'resume') {
            if (!UUID.test(tokens[i + 1]?.text ?? '')) return fallback(true)
            i++; stripped = true; continue
        }
        if (['--resume', '-r', '--session-id'].includes(flag)) {
            const value = equals < 0 ? tokens[++i] : undefined
            if (!UUID.test(equals < 0 ? value?.text ?? '' : token.text.slice(equals + 1))) return fallback(true)
            stripped = true; continue
        }
        if (['--help', '-h', '--version', '-V'].includes(flag) || agent === 'claude' && (/^-p/.test(flag) || ['--print', '--continue', '-c', '--fork-session'].includes(flag))) return fallback(true)
        if (token.text === '--' || !token.text.startsWith('-')) {
            if (NONINTERACTIVE[agent].has(token.text)) return fallback(true)
            stripped = true; break
        }
        if (BOOLEAN[agent].has(flag)) {
            if (equals >= 0) return fallback(true)
            kept.push(token); continue
        }
        const many = MANY_VALUES[agent].has(flag)
        if (!many && !ONE_VALUE[agent].has(flag)) return fallback(true)
        kept.push(token)
        if (equals >= 0) {
            if (!token.text.slice(equals + 1)) return fallback(true)
            continue
        }
        let values = 0
        while (i + 1 < tokens.length) {
            const value = tokens[i + 1]
            if (value.kind !== 'word' || value.dynamic || value.text.startsWith('-')) break
            kept.push(value); values++; i++
            if (!many) break
        }
        if (!values) return fallback(true)
    }
    const base = stripped ? original.slice(0, executable.end) + kept.map((token) => ' ' + token.raw).join('') : original
    return { storedCommand: base, inputCommand: base.trim(), recognized: true, confident: true, stripped }
}

/** Compatibility entry point: a command safe to type, never a storage repair. */
export function normalizeAgentCommand(command: string | undefined, agent: ConversationAgent, resolveAlias?: AliasResolver): string {
    return decideAgentCommand(command, agent, resolveAlias).inputCommand
}
