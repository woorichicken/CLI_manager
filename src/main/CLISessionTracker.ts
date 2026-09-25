import { v4 as uuidv4 } from 'uuid'

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
    private cliTools: CLIToolConfig[]
    /** Shell alias -> what it expands to, so `cldy` can be recognised as claude. */
    private aliases: Map<string, string> = new Map()
    public onSessionDetected?: (info: CLISessionInfo) => void

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
            if (!result) return false

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
