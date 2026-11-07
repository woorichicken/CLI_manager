import { v4 as uuidv4 } from 'uuid'
import { isInteractiveCodex, parseCodexResumePosition } from './CodexSessionLocator'

export interface CLIToolConfig {
    name: string
    commands: string[]
    sessionFlag: string
    resumeFlag: string
    skipIfFlags: string[]
    nonInteractiveSubcommands: string[]
}

export interface CLISessionInfo {
    terminalId: string
    cliToolName: string
    cliSessionId: string
    /**
     * The command as the user wrote it, without the injected flag — `cldy`, not
     * `claude`. Resuming has to repeat it: `claude --resume <id>` would drop
     * whatever the alias carried (bypass mode, a model choice, an env switch).
     */
    baseCommand: string
}

interface ProtocolInput {
    mode: 'escape' | 'csi' | 'osc' | 'dcs'
    sequence: string
    count: number
    escaping: boolean
}

const DEFAULT_CLI_TOOLS: CLIToolConfig[] = [
    {
        name: 'claude',
        commands: ['claude'],
        sessionFlag: '--session-id',
        resumeFlag: '--resume',
        // Only flags that make a session id meaningless belong here. Measured
        // 2026-09-25: `claude --dangerously-skip-permissions --session-id <uuid>`
        // starts fine and `--resume <uuid>` brings the conversation back, so
        // keeping that flag on this list only cost users their history.
        skipIfFlags: [
            '--session-id',
            '--resume',
            '-r',
            '--continue',
            '-c',
            '-p',
            '--print',
            '-h',
            '--help',
            '--version'
        ],
        nonInteractiveSubcommands: [
            'install',
            'uninstall',
            'update',
            'config',
            'mcp',
            'doctor',
            'api-key'
        ]
    }
]

export class CLISessionTracker {
    private lineBuffers: Map<string, string> = new Map()
    private resumeBuffers = new Map<string, string>()
    private pendingInput = new Map<string, { text: string; uncertain: boolean }>()
    private protocolInput = new Map<string, ProtocolInput>()
    private cliTools: CLIToolConfig[]
    /** Shell alias -> what it expands to, so `cldy` can be recognised as claude. */
    private aliases: Map<string, string> = new Map()
    public onSessionDetected?: (info: CLISessionInfo) => void
    /**
     * A typed command starts a Codex conversation. Codex takes no session id
     * from us, so the caller has to find the one Codex picked (CodexSessionLocator).
     */
    public onCodexStarted?: (terminalId: string, baseCommand: string) => void

    /** A typed or pasted candidate only; main must verify the actual process, file and ownership. */
    public onCodexResumed?: (terminalId: string, id: string, baseCommand: string) => void

    constructor(cliTools?: CLIToolConfig[]) {
        this.cliTools = cliTools ?? DEFAULT_CLI_TOOLS
    }

    /**
     * Teaches the tracker the user's shell aliases.
     *
     * Most people start an agent through one (`cldy`), and an alias is invisible
     * to us otherwise: the command never matches a known tool, no session id is
     * injected, and the session cannot be resumed after a restart. Appending the
     * flag to the alias works because the shell expands it in place —
     * `cldy --session-id X` becomes `claude … --session-id X`.
     */
    setAliases(aliases: Record<string, string>): void {
        this.aliases = new Map(Object.entries(aliases))
    }

    resolveAlias(name: string): string | undefined {
        return this.aliases.get(name)
    }

    getPendingInput(terminalId: string): { text: string; uncertain: boolean } {
        const pending = this.pendingInput.get(terminalId) ?? { text: '', uncertain: false }
        return { ...pending, uncertain: pending.uncertain || this.protocolInput.has(terminalId) }
    }

    /** Terminal replies can span onData chunks. Keep partial replies out of shell text tracking. */
    private filterProtocolInput(terminalId: string, data: string): string {
        let state = this.protocolInput.get(terminalId)
        let clean = ''
        const begin = (mode: ProtocolInput['mode']): void => { state = { mode, sequence: mode === 'csi' ? '\x1b[' : '', count: 0, escaping: false } }
        for (const char of data) {
            if (!state) {
                if (char === '\x1b') begin('escape')
                else if (char === '\x9d') begin('osc')
                else if (char === '\x90') begin('dcs')
                else if (char === '\x9b') begin('csi')
                else clean += char
                continue
            }
            if (char === '\x03' || char === '\r' || char === '\n') {
                state = undefined
                clean += char
                continue
            }
            if (state.mode === 'escape') {
                if (char === ']') begin('osc')
                else if (char === 'P') begin('dcs')
                else if (char === '[') begin('csi')
                else { clean += '\x1b' + char; state = undefined }
                continue
            }
            state.count++
            if (state.mode === 'csi') {
                state.sequence += char
                if (char >= '@' && char <= '~') {
                    if (!/^\x1b\[(?:[IO]|\??\d+;\d+R|[?>]?\d+(?:;\d+)*c|\??\d+n)$/.test(state.sequence)) clean += state.sequence
                    state = undefined
                } else if (state.count > 256) { clean += state.sequence; state = undefined }
                continue
            }
            if ((state.escaping && char === '\\') || char === '\x9c' || (state.mode === 'osc' && char === '\x07')) {
                state = undefined
            } else if (state.count > 16_384) {
                // An unterminated or excessive reply must block sending rather than hide a draft.
                clean += '\x1b'
                state = undefined
            } else state.escaping = char === '\x1b'
        }
        if (state) this.protocolInput.set(terminalId, state)
        else this.protocolInput.delete(terminalId)
        return clean
    }

    /** Observe paste for resume candidates without enabling Claude command rewriting on paste. */
    private observeInput(terminalId: string, data: string): void {
        const clean = data.replace(/\x1b\[(?:200|201)~/g, '')
        if (clean.includes('\x1b')) {
            const pending = this.pendingInput.get(terminalId) ?? { text: '', uncertain: false }
            this.pendingInput.set(terminalId, { ...pending, uncertain: true })
            this.resumeBuffers.delete(terminalId)
            return
        }
        for (const char of clean) {
            if (char === '\r' || char === '\n') {
                const resume = this.codexResume(this.resumeBuffers.get(terminalId) ?? '')
                this.resumeBuffers.delete(terminalId)
                this.pendingInput.delete(terminalId)
                if (resume) this.onCodexResumed?.(terminalId, resume.id, resume.baseCommand)
                continue
            }
            if (char === '\x03') {
                this.resumeBuffers.delete(terminalId)
                this.pendingInput.delete(terminalId)
                continue
            }
            const pending = this.pendingInput.get(terminalId) ?? { text: '', uncertain: false }
            if (char === '\x15') {
                // Ctrl+U need not erase text to the right of the cursor. Only submit/interrupt resets this.
                this.pendingInput.set(terminalId, { text: '', uncertain: true })
                this.resumeBuffers.delete(terminalId)
            } else if (char === '\x7f') {
                this.pendingInput.set(terminalId, { ...pending, text: pending.text.slice(0, -1) })
                this.resumeBuffers.set(terminalId, (this.resumeBuffers.get(terminalId) ?? '').slice(0, -1))
            } else if (char >= ' ') {
                const text = pending.text + char
                this.pendingInput.set(terminalId, { text: text.slice(-16_384), uncertain: pending.uncertain || text.length > 16_384 })
                if (!pending.uncertain && text.length <= 16_384) this.resumeBuffers.set(terminalId, (this.resumeBuffers.get(terminalId) ?? '') + char)
            } else {
                this.pendingInput.set(terminalId, { ...pending, uncertain: true })
                this.resumeBuffers.delete(terminalId)
            }
        }
    }

    /**
     * Process terminal input data. Buffers printable characters and intercepts
     * CLI tool commands on Enter, injecting --session-id.
     * Returns true if the input was intercepted (caller should NOT forward to PTY).
     * Returns false if input should be forwarded normally.
     */
    processInput(
        terminalId: string,
        data: string,
        writeFn: (data: string) => void
    ): boolean {
        data = this.filterProtocolInput(terminalId, data)
        if (!data) return false
        this.observeInput(terminalId, data)
        // Only handle single-character or Enter key inputs from manual typing
        // Multi-byte data (paste, escape sequences) pass through
        if (data.length > 1 && data !== '\r' && data !== '\n') {
            // Could be paste or escape sequence - clear buffer as it's unreliable
            this.lineBuffers.delete(terminalId)
            return false
        }

        const char = data

        // Ctrl+C or Ctrl+D - clear buffer
        if (char === '\x03' || char === '\x04') {
            this.lineBuffers.delete(terminalId)
            return false
        }

        // Ctrl+U - clear line buffer
        if (char === '\x15') {
            this.lineBuffers.set(terminalId, '')
            return false
        }

        // Backspace
        if (char === '\x7f') {
            const buf = this.lineBuffers.get(terminalId) || ''
            if (buf.length > 0) {
                this.lineBuffers.set(terminalId, buf.slice(0, -1))
            }
            return false
        }

        // Enter
        if (char === '\r' || char === '\n') {
            const buffer = (this.lineBuffers.get(terminalId) || '').trim()
            this.lineBuffers.delete(terminalId)

            if (!buffer) return false

            const result = this.shouldIntercept(buffer)
            if (!result) {
                if (this.isCodexStart(buffer)) this.onCodexStarted?.(terminalId, buffer)
                return false
            }

            const sessionId = uuidv4()
            const rewritten = `${buffer} ${result.config.sessionFlag} ${sessionId}`

            // Clear the current line (Ctrl+U) then send rewritten command
            writeFn('\x15')
            writeFn(rewritten + '\r')

            this.onSessionDetected?.({
                terminalId,
                cliToolName: result.config.name,
                cliSessionId: sessionId,
                baseCommand: buffer
            })

            return true
        }

        // Printable characters - buffer them
        if (char >= ' ' && char <= '~') {
            const buf = this.lineBuffers.get(terminalId) || ''
            this.lineBuffers.set(terminalId, buf + char)
        }

        return false
    }

    /**
     * Rewrite an initialCommand/template command to include --session-id if applicable.
     * Returns { command, cliSessionId, cliToolName } if rewritten, or null if no rewrite needed.
     */
    rewriteCommand(command: string): {
        command: string
        cliSessionId: string
        cliToolName: string
        baseCommand: string
    } | null {
        const trimmed = command.trim()
        if (!trimmed) return null

        const result = this.shouldIntercept(trimmed)
        if (!result) return null

        const sessionId = uuidv4()
        return {
            command: `${trimmed} ${result.config.sessionFlag} ${sessionId}`,
            cliSessionId: sessionId,
            cliToolName: result.config.name,
            baseCommand: trimmed
        }
    }

    /** True when the command line (aliases resolved) starts an interactive Codex conversation. */
    isCodexStart(commandLine: string): boolean {
        const lastSegment = commandLine.split(/&&|;/).pop()?.trim() ?? commandLine
        const tokens = lastSegment.split(/\s+/).filter(Boolean)
        if (tokens.length === 0) return false
        const name = tokens[0].split('/').pop() || tokens[0]
        const expansion = this.aliases.get(name)
        const effective = expansion ? `${expansion} ${tokens.slice(1).join(' ')}`.trim().split(/\s+/) : tokens
        return isInteractiveCodex(effective)
    }

    /** Recognise explicit UUID resumes, retaining the alias and preceding setup commands. */
    codexResume(commandLine: string): { id: string; baseCommand: string } | null {
        const lastSegment = commandLine.split(/&&|;/).pop()?.trim() ?? commandLine
        const tokens = lastSegment.split(/\s+/).filter(Boolean)
        if (!tokens.length) return null
        const name = tokens[0].split('/').pop() || tokens[0]
        const expansion = this.aliases.get(name)
        const effective = expansion ? `${expansion} ${tokens.slice(1).join(' ')}`.trim().split(/\s+/) : tokens
        const result = parseCodexResumePosition(effective)
        if (!result) return null
        const expansionLength = expansion?.trim().split(/\s+/).length ?? 1
        const resumeIndex = result.resumeIndex - (expansionLength - 1)
        if (resumeIndex < 0) return null
        const baseSegment = [...tokens.slice(0, resumeIndex), ...tokens.slice(resumeIndex + 2)].join(' ')
        const prefix = commandLine.slice(0, commandLine.lastIndexOf(lastSegment))
        return { id: result.id, baseCommand: prefix + baseSegment }
    }

    /**
     * Generate a resume command for a previously tracked CLI session.
     */
    getResumeCommand(cliToolName: string, cliSessionId: string): string | null {
        const config = this.cliTools.find((t) => t.name === cliToolName)
        if (!config) return null
        return `${config.commands[0]} ${config.resumeFlag} ${cliSessionId}`
    }

    /**
     * Clear the line buffer for a terminal (e.g., on terminal kill).
     */
    cleanup(terminalId: string): void {
        this.lineBuffers.delete(terminalId)
        this.resumeBuffers.delete(terminalId)
        this.pendingInput.delete(terminalId)
        this.protocolInput.delete(terminalId)
    }

    /**
     * Check if a command line should be intercepted.
     * Returns the matching config if yes, null if the command should pass through.
     */
    private shouldIntercept(
        commandLine: string
    ): { config: CLIToolConfig } | null {
        // Templates chain setup before the agent (`glm-on && cldy`). The flag is
        // appended to the whole line, so it lands on the last command — which is
        // also the one that has to be recognised.
        const lastSegment = commandLine.split(/&&|;/).pop()?.trim() ?? commandLine
        const tokens = lastSegment.split(/\s+/)
        if (tokens.length === 0) return null

        const baseCommand = tokens[0]

        // Find matching CLI tool by command name
        // Handle both bare command and full path (e.g., /usr/local/bin/claude)
        // An alias is resolved first: `cldy` is claude wearing a hat.
        const commandName = baseCommand.split('/').pop() || baseCommand
        const expansion = this.aliases.get(commandName)
        const effectiveTokens = expansion ? `${expansion} ${tokens.slice(1).join(' ')}`.trim().split(/\s+/) : tokens
        const effectiveName = (effectiveTokens[0] ?? '').split('/').pop() || ''
        const config = this.cliTools.find((t) =>
            t.commands.includes(effectiveName)
        )
        if (!config) return null

        // Check for non-interactive subcommands (second token)
        if (effectiveTokens.length > 1) {
            const subcommand = effectiveTokens[1]
            if (
                config.nonInteractiveSubcommands.includes(subcommand)
            ) {
                return null
            }
        }

        // Check for skip flags anywhere in the command
        for (const token of effectiveTokens) {
            if (config.skipIfFlags.includes(token)) {
                return null
            }
        }

        return { config }
    }
}
