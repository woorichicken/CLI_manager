import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, copyFileSync, readdirSync, statSync, unlinkSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { HookInstallState, HookTargetState, HookIntegrationSettings } from '../shared/types'
import { CLAUDE_HOOK_SCRIPT, CLAUDE_STATUSLINE_SCRIPT, CODEX_NOTIFY_SCRIPT, HOOK_MARKER, withDelegate } from './hookScripts'

/**
 * Installs and removes the official CLI hook bridges.
 *
 * The hard requirement here is that we are editing configuration files the user
 * owns and that other tools also write to. Every operation therefore:
 *   - backs the file up before the first modification,
 *   - preserves entries we did not create,
 *   - captures any command we displace so it still runs (and can be restored),
 *   - reports failure per target instead of throwing, so one broken
 *     integration never disables the others or blocks app startup.
 */

/** Claude Code lifecycle events we subscribe to. */
const CLAUDE_HOOK_EVENTS = [
    'SessionStart',
    'UserPromptSubmit',
    'Stop',
    'PermissionRequest',
    'Notification',
    'SessionEnd'
] as const

/** Hook scripts finish in microseconds; a short timeout bounds any pathology. */
const HOOK_TIMEOUT_SECONDS = 5

interface PersistedState {
    /** statusLine command that existed before we wrapped it. */
    claudeStatusLineOriginal?: string
    /** notify command that existed before we wrapped it. */
    codexNotifyOriginal?: string[]
}

export class HookInstaller {
    // CLIMANAGER_HOME lets the automated tests point the whole integration at a
    // temp directory, so a test run can never write to the real ~/.climanager.
    private readonly root = process.env.CLIMANAGER_HOME || join(homedir(), '.climanager')
    private readonly hooksDir = join(this.root, 'hooks')
    private readonly backupsDir = join(this.root, 'backups')
    private readonly statePath = join(this.root, 'hook-state.json')

    readonly spoolDir = join(this.root, 'events')

    private readonly claudeSettingsPath = join(homedir(), '.claude', 'settings.json')
    private readonly codexConfigPath = join(homedir(), '.codex', 'config.toml')

    get claudeHookScriptPath(): string {
        return join(this.hooksDir, 'claude-hook.sh')
    }

    get claudeStatusLineScriptPath(): string {
        return join(this.hooksDir, 'claude-statusline.sh')
    }

    get codexNotifyScriptPath(): string {
        return join(this.hooksDir, 'codex-notify.sh')
    }

    // ------------------------------------------------------------------
    // Persisted state
    // ------------------------------------------------------------------

    private readState(): PersistedState {
        try {
            if (!existsSync(this.statePath)) return {}
            return JSON.parse(readFileSync(this.statePath, 'utf-8')) as PersistedState
        } catch {
            return {}
        }
    }

    private writeState(state: PersistedState): void {
        try {
            mkdirSync(this.root, { recursive: true })
            writeFileSync(this.statePath, JSON.stringify(state, null, 2), 'utf-8')
        } catch (error) {
            console.error('[HookInstaller] Failed to persist state:', error)
        }
    }

    /**
     * Copies a config file aside before the first time we touch it. Keeping only
     * the pre-CLI-Manager version means a later restore cannot resurrect a
     * half-written state from one of our own runs.
     */
    private backupOnce(filePath: string, label: string): void {
        try {
            if (!existsSync(filePath)) return
            mkdirSync(this.backupsDir, { recursive: true })
            const target = join(this.backupsDir, `${label}.original`)
            if (existsSync(target)) return
            copyFileSync(filePath, target)
        } catch (error) {
            console.error(`[HookInstaller] Backup failed for ${label}:`, error)
        }
    }

    // ------------------------------------------------------------------
    // Script materialization
    // ------------------------------------------------------------------

    /**
     * Writes the bridge scripts to disk. They are rendered rather than shipped
     * as assets because the delegate command is baked in, and because scripts
     * inside an asar archive cannot be executed by an external process.
     */
    private writeScripts(state: PersistedState): void {
        mkdirSync(this.hooksDir, { recursive: true })
        mkdirSync(this.spoolDir, { recursive: true })

        const files: Array<[string, string]> = [
            [this.claudeHookScriptPath, CLAUDE_HOOK_SCRIPT],
            [
                this.claudeStatusLineScriptPath,
                withDelegate(CLAUDE_STATUSLINE_SCRIPT, state.claudeStatusLineOriginal, 'stdin', true)
            ],
            [
                this.codexNotifyScriptPath,
                withDelegate(CODEX_NOTIFY_SCRIPT, this.formatCodexDelegate(state.codexNotifyOriginal), 'argv')
            ]
        ]

        for (const [path, content] of files) {
            writeFileSync(path, content, 'utf-8')
            chmodSync(path, 0o755)
        }
    }

    /** Codex stores notify as an argv array; rebuild a quoted shell command. */
    private formatCodexDelegate(original?: string[]): string | undefined {
        if (!original || original.length === 0) return undefined
        return original.map((part) => `'${part.replace(/'/g, `'\\''`)}'`).join(' ')
    }

    // ------------------------------------------------------------------
    // Claude Code: ~/.claude/settings.json
    // ------------------------------------------------------------------

    private readClaudeSettings(): Record<string, any> {
        if (!existsSync(this.claudeSettingsPath)) return {}
        const raw = readFileSync(this.claudeSettingsPath, 'utf-8').trim()
        if (!raw) return {}
        return JSON.parse(raw) as Record<string, any>
    }

    private writeClaudeSettings(settings: Record<string, any>): void {
        mkdirSync(join(homedir(), '.claude'), { recursive: true })
        writeFileSync(this.claudeSettingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8')
    }

    private isOurCommand(command: unknown): boolean {
        return typeof command === 'string' && command.includes(HOOK_MARKER)
    }

    /** True when the command string points at one of the scripts we installed. */
    private isOurScriptPath(command: unknown): boolean {
        if (typeof command !== 'string') return false
        return (
            command.includes(this.claudeHookScriptPath) ||
            command.includes(this.claudeStatusLineScriptPath) ||
            command.includes(this.codexNotifyScriptPath)
        )
    }

    private installClaudeHooks(): HookTargetState {
        try {
            this.backupOnce(this.claudeSettingsPath, 'claude-settings.json')
            const settings = this.readClaudeSettings()
            const hooks: Record<string, any[]> = settings.hooks ?? {}

            const command = `"${this.claudeHookScriptPath}"`

            for (const event of CLAUDE_HOOK_EVENTS) {
                const existing: any[] = Array.isArray(hooks[event]) ? hooks[event] : []

                // Drop any previous entry of ours, then re-add. This makes the
                // install idempotent and picks up path changes after an app move.
                const preserved = existing
                    .map((group) => {
                        if (!group || !Array.isArray(group.hooks)) return group
                        const kept = group.hooks.filter((h: any) => !this.isOurScriptPath(h?.command))
                        return { ...group, hooks: kept }
                    })
                    .filter((group) => !Array.isArray(group?.hooks) || group.hooks.length > 0)

                preserved.push({
                    matcher: '*',
                    hooks: [{ type: 'command', command, timeout: HOOK_TIMEOUT_SECONDS }]
                })

                hooks[event] = preserved
            }

            settings.hooks = hooks
            this.writeClaudeSettings(settings)
            return { installed: true }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            console.error('[HookInstaller] Claude hooks install failed:', message)
            return { installed: false, error: message }
        }
    }

    private installClaudeStatusLine(): HookTargetState {
        try {
            this.backupOnce(this.claudeSettingsPath, 'claude-settings.json')
            const settings = this.readClaudeSettings()
            const state = this.readState()

            const current = settings.statusLine
            const currentCommand: string | undefined =
                current && current.type === 'command' && typeof current.command === 'string'
                    ? current.command
                    : undefined

            // Only capture a delegate the first time. Re-reading our own wrapper
            // on a second install would make the script invoke itself forever.
            if (currentCommand && !this.isOurScriptPath(currentCommand) && !this.isOurCommand(currentCommand)) {
                state.claudeStatusLineOriginal = currentCommand
                this.writeState(state)
            }

            // Render the script now that we know what to delegate to.
            this.writeScripts(state)

            settings.statusLine = {
                type: 'command',
                command: `"${this.claudeStatusLineScriptPath}"`
            }
            this.writeClaudeSettings(settings)

            return { installed: true, wrapped: state.claudeStatusLineOriginal }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            console.error('[HookInstaller] Claude statusLine install failed:', message)
            return { installed: false, error: message }
        }
    }

    // ------------------------------------------------------------------
    // Codex: ~/.codex/config.toml
    // ------------------------------------------------------------------

    /**
     * Rewrites the root-level `notify` key.
     *
     * A full TOML parser is deliberately avoided: this file holds the user's
     * entire Codex configuration and a lossy round-trip would destroy comments
     * and formatting. We only touch the single line we own, and refuse to act
     * at all when the existing value spans multiple lines.
     */
    private setCodexNotify(lines: string[], value: string[] | null): { lines: string[]; previous?: string[] } {
        const serialized = value ? `notify = [${value.map((v) => JSON.stringify(v)).join(', ')}]` : null

        // Root keys must precede the first table header in TOML.
        let boundary = lines.findIndex((line) => /^\s*\[/.test(line))
        if (boundary === -1) boundary = lines.length

        const existingIndex = lines.findIndex((line, i) => i < boundary && /^\s*notify\s*=/.test(line))

        if (existingIndex === -1) {
            if (!serialized) return { lines }
            // Insert after any leading comment block so the file still reads well.
            let insertAt = 0
            while (insertAt < boundary && /^\s*(#|$)/.test(lines[insertAt])) insertAt++
            const next = [...lines]
            next.splice(insertAt, 0, serialized)
            return { lines: next }
        }

        const existingLine = lines[existingIndex]
        const opens = (existingLine.match(/\[/g) ?? []).length
        const closes = (existingLine.match(/\]/g) ?? []).length
        if (opens !== closes) {
            throw new Error('notify spans multiple lines; refusing to edit config.toml automatically')
        }

        let previous: string[] | undefined
        try {
            const rhs = existingLine.slice(existingLine.indexOf('=') + 1).trim()
            const parsed = JSON.parse(rhs)
            if (Array.isArray(parsed)) previous = parsed.map(String)
        } catch {
            // Unparseable value: keep going, but do not claim we captured it.
        }

        const next = [...lines]
        if (serialized) {
            next[existingIndex] = serialized
        } else {
            next.splice(existingIndex, 1)
        }
        return { lines: next, previous }
    }

    private installCodexNotify(): HookTargetState {
        try {
            if (!existsSync(this.codexConfigPath)) {
                return { installed: false, error: 'Codex is not configured on this machine (~/.codex/config.toml not found)' }
            }

            this.backupOnce(this.codexConfigPath, 'codex-config.toml')
            const state = this.readState()
            const raw = readFileSync(this.codexConfigPath, 'utf-8')
            const lines = raw.split('\n')

            const ourValue = ['/bin/sh', this.codexNotifyScriptPath]
            const { lines: nextLines, previous } = this.setCodexNotify(lines, ourValue)

            // Same self-chaining guard as the status line.
            if (previous && !previous.some((part) => part.includes(HOOK_MARKER) || part === this.codexNotifyScriptPath)) {
                state.codexNotifyOriginal = previous
                this.writeState(state)
            }

            this.writeScripts(state)
            writeFileSync(this.codexConfigPath, nextLines.join('\n'), 'utf-8')

            const wrapped = state.codexNotifyOriginal?.join(' ')
            return { installed: true, wrapped }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            console.error('[HookInstaller] Codex notify install failed:', message)
            return { installed: false, error: message }
        }
    }

    // ------------------------------------------------------------------
    // Public API
    // ------------------------------------------------------------------

    /**
     * Brings the on-disk configuration in line with `settings`. Safe to call on
     * every app start: each step is idempotent and repairs stale script paths.
     */
    install(settings: HookIntegrationSettings): HookInstallState {
        const state: HookInstallState = {
            claudeHooks: { installed: false },
            claudeStatusLine: { installed: false },
            codexNotify: { installed: false }
        }

        if (!settings.enabled) {
            return state
        }

        this.writeScripts(this.readState())

        if (settings.claudeHooks) state.claudeHooks = this.installClaudeHooks()
        if (settings.claudeStatusLine) state.claudeStatusLine = this.installClaudeStatusLine()
        if (settings.codexNotify) state.codexNotify = this.installCodexNotify()

        return state
    }

    /** Removes our entries and restores anything we displaced. */
    uninstall(): HookInstallState {
        const result: HookInstallState = {
            claudeHooks: { installed: false },
            claudeStatusLine: { installed: false },
            codexNotify: { installed: false }
        }
        const state = this.readState()

        // Claude hooks + statusLine
        try {
            if (existsSync(this.claudeSettingsPath)) {
                const settings = this.readClaudeSettings()

                if (settings.hooks) {
                    for (const event of Object.keys(settings.hooks)) {
                        const groups: any[] = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : []
                        const cleaned = groups
                            .map((group) => {
                                if (!group || !Array.isArray(group.hooks)) return group
                                return { ...group, hooks: group.hooks.filter((h: any) => !this.isOurScriptPath(h?.command)) }
                            })
                            .filter((group) => !Array.isArray(group?.hooks) || group.hooks.length > 0)

                        if (cleaned.length > 0) settings.hooks[event] = cleaned
                        else delete settings.hooks[event]
                    }
                    if (Object.keys(settings.hooks).length === 0) delete settings.hooks
                }

                if (settings.statusLine && this.isOurScriptPath(settings.statusLine.command)) {
                    if (state.claudeStatusLineOriginal) {
                        settings.statusLine = { type: 'command', command: state.claudeStatusLineOriginal }
                    } else {
                        delete settings.statusLine
                    }
                }

                this.writeClaudeSettings(settings)
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            result.claudeHooks = { installed: false, error: message }
            result.claudeStatusLine = { installed: false, error: message }
        }

        // Codex notify
        try {
            if (existsSync(this.codexConfigPath)) {
                const lines = readFileSync(this.codexConfigPath, 'utf-8').split('\n')
                const restore = state.codexNotifyOriginal ?? null
                const { lines: nextLines } = this.setCodexNotify(lines, restore)
                writeFileSync(this.codexConfigPath, nextLines.join('\n'), 'utf-8')
            }
        } catch (error) {
            result.codexNotify = { installed: false, error: error instanceof Error ? error.message : String(error) }
        }

        // Forget captured delegates so a future install re-captures the truth.
        this.writeState({})
        return result
    }

    /**
     * Reports what is actually present on disk rather than what we believe we
     * wrote. Another tool (or the user) may have rewritten these files since.
     */
    verify(): HookInstallState {
        const result: HookInstallState = {
            claudeHooks: { installed: false },
            claudeStatusLine: { installed: false },
            codexNotify: { installed: false }
        }
        const state = this.readState()

        try {
            const settings = this.readClaudeSettings()
            const hooks = settings.hooks ?? {}
            const registered = CLAUDE_HOOK_EVENTS.filter((event) => {
                const groups: any[] = Array.isArray(hooks[event]) ? hooks[event] : []
                return groups.some((g) => Array.isArray(g?.hooks) && g.hooks.some((h: any) => this.isOurScriptPath(h?.command)))
            })
            result.claudeHooks = {
                installed: registered.length === CLAUDE_HOOK_EVENTS.length,
                error:
                    registered.length > 0 && registered.length < CLAUDE_HOOK_EVENTS.length
                        ? `Only ${registered.length}/${CLAUDE_HOOK_EVENTS.length} events registered`
                        : undefined
            }
            result.claudeStatusLine = {
                installed: this.isOurScriptPath(settings.statusLine?.command),
                wrapped: state.claudeStatusLineOriginal
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            result.claudeHooks = { installed: false, error: message }
            result.claudeStatusLine = { installed: false, error: message }
        }

        try {
            if (existsSync(this.codexConfigPath)) {
                const raw = readFileSync(this.codexConfigPath, 'utf-8')
                result.codexNotify = {
                    installed: raw.includes(this.codexNotifyScriptPath),
                    wrapped: state.codexNotifyOriginal?.join(' ')
                }
            } else {
                result.codexNotify = { installed: false, error: 'Codex is not configured on this machine' }
            }
        } catch (error) {
            result.codexNotify = { installed: false, error: error instanceof Error ? error.message : String(error) }
        }

        return result
    }

    /**
     * Drops spool files left behind while the app was closed. Without this the
     * directory would grow without bound and startup would replay stale events.
     */
    pruneSpool(maxAgeMs = 10 * 60 * 1000): void {
        try {
            if (!existsSync(this.spoolDir)) return
            const cutoff = Date.now() - maxAgeMs
            for (const name of readdirSync(this.spoolDir)) {
                const path = join(this.spoolDir, name)
                try {
                    if (statSync(path).mtimeMs < cutoff) unlinkSync(path)
                } catch {
                    // Racing with a hook write; the next prune will catch it.
                }
            }
        } catch (error) {
            console.error('[HookInstaller] Spool prune failed:', error)
        }
    }
}

/**
 * Suppresses installation during automated tests so a test run can never
 * rewrite the developer's real ~/.claude or ~/.codex configuration.
 *
 * Kept free of any electron import so HookInstaller stays a plain filesystem
 * module that can be exercised directly.
 */
export function hookIntegrationAllowed(): boolean {
    return !process.env.CLIMANGER_TEST_USERDATA && !process.env.CLIMANGER_TEST_HEADLESS
}
