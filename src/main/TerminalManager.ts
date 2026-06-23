import { ipcMain, BrowserWindow } from 'electron'
import os from 'os'
import { execSync } from 'child_process'
import { existsSync } from 'fs'
import { CLISessionTracker } from './CLISessionTracker'
const pty = require('node-pty')

// Default shell based on platform
const DEFAULT_SHELL = os.platform() === 'win32' ? 'powershell.exe' : 'zsh'

// Standard shell paths to try as fallback
const FALLBACK_SHELLS = os.platform() === 'win32'
    ? ['powershell.exe', 'cmd.exe']
    : ['/bin/zsh', '/bin/bash', '/bin/sh']

// ANSI escape sequence regex for stripping colors/formatting
// Covers: CSI sequences, OSC sequences, DCS/PM/APC sequences, single-char escapes, carriage returns
// Also handles terminal mode sequences like ?2026l, ?2026h
const ANSI_REGEX = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[PX^_].*?\x1b\\|\x1b\(B|\x1b[=>]|\x1b.|\r|\x07/g

// Output batching: coalesce rapid pty chunks before sending over IPC.
// CLI TUIs emit many tiny chunks per frame; with several terminals running,
// per-chunk IPC sends flood the renderer event loop. 4ms is imperceptible
// for interactive echo but merges a whole TUI frame into one message.
const OUTPUT_FLUSH_MS = 4
const OUTPUT_FLUSH_BYTES = 256 * 1024

interface PendingOutput {
    chunks: string[]
    bytes: number
    timer: NodeJS.Timeout | null
}

export class TerminalManager {
    private terminals: Map<string, any> = new Map()
    // Output buffer for terminal preview (stores last N lines per terminal)
    private outputBuffers: Map<string, string[]> = new Map()
    private readonly PREVIEW_BUFFER_LINES = 10
    private cliTracker: CLISessionTracker | null = null
    private pendingOutput: Map<string, PendingOutput> = new Map()

    /**
     * Optional hook called for every raw PTY output chunk, after buffering and
     * batching logic. Used by LoopManager to detect loop iterations without
     * altering existing terminal rendering behavior. No-op when undefined.
     */
    public onOutput?: (id: string, data: string) => void

    constructor(cliTracker?: CLISessionTracker) {
        this.cliTracker = cliTracker ?? null
        this.setupIpc()
    }

    /**
     * Strip ANSI escape sequences from text
     */
    private stripAnsi(text: string): string {
        return text.replace(ANSI_REGEX, '')
    }

    /**
     * Clean line by removing trailing separators
     */
    private cleanLine(line: string): string {
        // Remove trailing box drawing characters and separators
        return line.replace(/[─━─—_=]+\s*$/, '').trim()
    }

    /**
     * Check if a line is meaningful content (not just decorators/separators)
     */
    private isMeaningfulLine(line: string): boolean {
        const trimmed = line.trim()
        if (!trimmed) return false

        // Skip lines that are just separators (underscores, dashes, equals, dots)
        if (/^[_\-=─━·.•─—]+$/.test(trimmed)) return false

        // Skip lines containing mostly separators (more than 5 consecutive)
        if (/[─━_\-=]{5,}/.test(trimmed)) return false

        // Skip lines that are just whitespace or box drawing characters
        if (/^[\s│┃|├┤└┘┌┐╭╮╯╰▮█▯░▒▓]+$/.test(trimmed)) return false

        // Skip terminal mode artifacts
        if (/^\?[\d]+[lh]$/.test(trimmed)) return false

        // Skip prompt-only lines (>, $, %, #, etc.)
        if (/^[>$%#›»❯➜→]\s*$/.test(trimmed)) return false

        // Skip Claude Code / AI tool status bar messages (anywhere in line)
        if (/bypass\s*permissions/i.test(trimmed)) return false
        if (/shift\+tab\s*(to\s*)?cycle/i.test(trimmed)) return false
        if (/MCP\s*server/i.test(trimmed)) return false
        if (/\/mcp\s+(for\s+)?info/i.test(trimmed)) return false
        if (/\/chrome\s+(for\s+)?info/i.test(trimmed)) return false
        if (/enabled\s*·\s*\//i.test(trimmed)) return false
        if (/for\s+info\s*$/i.test(trimmed)) return false

        // Skip Claude Code splash/header info
        if (/Claude\s*Code\s*v[\d.]+/i.test(trimmed)) return false
        if (/Opus\s*[\d.]+\s*·/i.test(trimmed)) return false
        if (/Sonnet\s*[\d.]+\s*·/i.test(trimmed)) return false
        if (/Claude\s*(Max|Pro|Free)/i.test(trimmed)) return false
        if (/^\*\s*[▮█▯░▒▓\s]+\*/.test(trimmed)) return false

        // Skip fragment lines (likely partial UI elements)
        if (/^cycle\)?$/i.test(trimmed)) return false
        if (/^\d+\s*$/.test(trimmed)) return false  // Just numbers

        // Skip very short lines (likely UI artifacts)
        if (trimmed.length < 4) return false

        return true
    }

    /**
     * Append data to terminal's preview buffer
     * Maintains a rolling buffer of the last N lines
     */
    private appendToBuffer(id: string, data: string): void {
        let buffer = this.outputBuffers.get(id) || []

        // Strip ANSI codes and split by newlines
        const cleanData = this.stripAnsi(data)
        const lines = cleanData.split('\n')

        // Append new lines to buffer
        for (let i = 0; i < lines.length; i++) {
            let line = lines[i]

            // If first segment and buffer has content, append to last line
            if (i === 0 && buffer.length > 0 && !data.startsWith('\n')) {
                buffer[buffer.length - 1] += line
            } else if (this.isMeaningfulLine(line)) {
                // Clean the line (remove trailing separators)
                const cleanedLine = this.cleanLine(line)
                if (!cleanedLine || cleanedLine.length < 4) continue

                // Skip duplicate lines (check against recent lines, not just last)
                const isDuplicate = buffer.slice(-5).some(
                    existing => existing === cleanedLine ||
                    existing.includes(cleanedLine) ||
                    cleanedLine.includes(existing)
                )
                if (!isDuplicate) {
                    buffer.push(cleanedLine)
                }
            }
        }

        // Keep only last N lines
        if (buffer.length > this.PREVIEW_BUFFER_LINES) {
            buffer = buffer.slice(-this.PREVIEW_BUFFER_LINES)
        }

        this.outputBuffers.set(id, buffer)
    }

    /**
     * Get preview lines for a terminal
     */
    getPreview(id: string, lineCount: number = 5): string[] {
        const buffer = this.outputBuffers.get(id) || []
        return buffer.slice(-lineCount)
    }

    /**
     * Clear buffer when terminal is killed
     */
    private clearBuffer(id: string): void {
        this.outputBuffers.delete(id)
    }

    /**
     * Resolve and validate shell path
     * - If absolute path: check file exists
     * - If relative: use which command to find
     * - Fallback to default shells if not found
     */
    private resolveShell(requestedShell?: string): string {
        // If no shell requested, use default
        if (!requestedShell) {
            return DEFAULT_SHELL
        }

        // Absolute path - check if exists
        if (requestedShell.startsWith('/')) {
            if (existsSync(requestedShell)) {
                return requestedShell
            }
            console.warn(`Shell not found at ${requestedShell}, trying fallbacks...`)
        } else {
            // Relative path - try to resolve with which
            try {
                const resolvedPath = execSync(`which ${requestedShell}`, { encoding: 'utf-8' }).trim()
                if (resolvedPath && existsSync(resolvedPath)) {
                    return resolvedPath
                }
            } catch {
                console.warn(`Shell '${requestedShell}' not found in PATH, trying fallbacks...`)
            }
        }

        // Try fallback shells
        for (const fallback of FALLBACK_SHELLS) {
            if (fallback.startsWith('/')) {
                if (existsSync(fallback)) {
                    console.log(`Using fallback shell: ${fallback}`)
                    return fallback
                }
            } else {
                try {
                    const resolved = execSync(`which ${fallback}`, { encoding: 'utf-8' }).trim()
                    if (resolved && existsSync(resolved)) {
                        console.log(`Using fallback shell: ${resolved}`)
                        return resolved
                    }
                } catch {
                    // Continue to next fallback
                }
            }
        }

        // Last resort: return default
        console.warn(`No valid shell found, using default: ${DEFAULT_SHELL}`)
        return DEFAULT_SHELL
    }

    private setupIpc() {
        ipcMain.handle('terminal-create', (_, id: string, cwd: string, cols: number, rows: number, shell?: string) => {
            this.createTerminal(id, cwd, cols, rows, shell)
            return true
        })

        ipcMain.on('terminal-input', (_, id: string, data: string) => {
            const ptyProcess = this.terminals.get(id)
            if (!ptyProcess) return

            // Route through CLI session tracker for interception
            if (this.cliTracker) {
                const intercepted = this.cliTracker.processInput(
                    id,
                    data,
                    (d) => ptyProcess.write(d)
                )
                if (intercepted) return
            }

            ptyProcess.write(data)
        })

        ipcMain.handle('terminal-resize', (_, id: string, cols: number, rows: number) => {
            const ptyProcess = this.terminals.get(id)
            if (ptyProcess) {
                ptyProcess.resize(cols, rows)
            }
        })

        ipcMain.handle('terminal-kill', (_, id: string) => {
            const ptyProcess = this.terminals.get(id)
            if (ptyProcess) {
                ptyProcess.kill()
                this.terminals.delete(id)
                this.clearBuffer(id)
                this.clearPendingOutput(id)
                this.cliTracker?.cleanup(id)
            }
        })

        // Check if terminal has running child processes
        ipcMain.handle('terminal-has-running-process', (_, id: string): boolean => {
            return this.hasRunningProcess(id)
        })

        // Get terminal preview (last N lines)
        ipcMain.handle('terminal-get-preview', (_, id: string, lineCount: number = 5): string[] => {
            return this.getPreview(id, lineCount)
        })

        // Clear terminal buffer (Cmd+K) - broadcasts clear event to all windows
        ipcMain.on('terminal-clear', (_, id: string) => {
            // Broadcast clear event to all windows (renderer will call xterm.clear())
            const channel = `terminal-clear-${id}`
            BrowserWindow.getAllWindows().forEach(win => {
                win.webContents.send(channel)
            })
        })
    }

    /**
     * Check if a specific terminal has running child processes
     */
    private hasRunningProcess(id: string): boolean {
        const ptyProcess = this.terminals.get(id)
        if (!ptyProcess) return false

        try {
            const pid = ptyProcess.pid
            // Use pgrep to check for child processes (macOS/Linux)
            // Returns non-empty if there are child processes
            const result = execSync(`pgrep -P ${pid}`, { encoding: 'utf-8' }).trim()
            return result.length > 0
        } catch {
            // pgrep returns exit code 1 if no processes found
            return false
        }
    }

    /**
     * Check if any terminal has running child processes
     */
    hasAnyRunningProcesses(): boolean {
        for (const [id] of this.terminals) {
            if (this.hasRunningProcess(id)) {
                return true
            }
        }
        return false
    }

    /**
     * Get count of terminals with running child processes
     */
    getRunningProcessCount(): number {
        let count = 0
        for (const [id] of this.terminals) {
            if (this.hasRunningProcess(id)) {
                count++
            }
        }
        return count
    }

    /**
     * Get count of active terminals
     */
    getTerminalCount(): number {
        return this.terminals.size
    }

    /**
     * Write data directly to a terminal's PTY process.
     * Used by LoopManager to send restart commands (e.g. 'claude\r') without
     * going through the renderer IPC path. Safe to call with a dead PTY —
     * any error is silently swallowed so it does not propagate to callers.
     *
     * @param id   - terminal id
     * @param data - raw data to write (use '\r' as line terminator, not '\n')
     */
    public writeToTerminal(id: string, data: string): void {
        try {
            const ptyProcess = this.terminals.get(id)
            if (ptyProcess) {
                ptyProcess.write(data)
            }
        } catch (e) {
            console.warn(`[TerminalManager] writeToTerminal(${id}) failed:`, e)
        }
    }

    /**
     * Kill all terminal processes
     */
    killAll(): void {
        for (const [id, ptyProcess] of this.terminals) {
            try {
                ptyProcess.kill()
                console.log(`Killed terminal: ${id}`)
            } catch (e) {
                console.error(`Failed to kill terminal ${id}:`, e)
            }
        }
        for (const id of [...this.pendingOutput.keys()]) {
            this.clearPendingOutput(id)
        }
        this.terminals.clear()
        this.outputBuffers.clear()
    }

    private createTerminal(id: string, cwd: string, cols: number = 80, rows: number = 30, requestedShell?: string) {
        // 이미 존재하는 터미널이면 생성 건너뛰기
        if (this.terminals.has(id)) {
            console.log(`Terminal ${id} already exists, skipping creation`)
            return
        }

        // Resolve shell with validation and fallback
        const shell = this.resolveShell(requestedShell)
        console.log(`Creating terminal with shell: ${shell}`)

        // Use login shell on Unix-like systems to load full PATH from .zprofile/.bash_profile
        // This fixes "command not found" errors for brew, claude, direnv, etc.
        // when app is launched from Finder/Spotlight (which doesn't inherit shell PATH)
        // Windows shells (PowerShell, cmd) don't use --login flag
        const shellArgs = os.platform() === 'win32' ? [] : ['--login']

        const ptyProcess = pty.spawn(shell, shellArgs, {
            name: 'xterm-256color',
            cols,
            rows,
            cwd,
            encoding: 'utf8',  // Enable UTF-8 for Korean/CJK input
            env: {
                ...process.env,
                TERM_PROGRAM: 'CLImanger',
                // Disable zsh's partial line indicator (the % that appears when no newline at end)
                PROMPT_EOL_MARK: '',
                // Ensure UTF-8 locale for proper Korean input
                LANG: process.env.LANG || 'en_US.UTF-8',
                LC_ALL: process.env.LC_ALL || 'en_US.UTF-8'
            } as any
        })

        ptyProcess.onData((data: string) => {
            // Store in preview buffer
            this.appendToBuffer(id, data)
            this.enqueueOutput(id, data)
            // Additive hook: notify LoopManager (or any observer) of raw output.
            // No-op when unset; does not affect existing rendering behavior.
            this.onOutput?.(id, data)
        })

        this.terminals.set(id, ptyProcess)
    }

    /**
     * Queue a pty chunk for batched delivery to the renderer(s).
     * Flushes after OUTPUT_FLUSH_MS, or immediately past OUTPUT_FLUSH_BYTES.
     */
    private enqueueOutput(id: string, data: string): void {
        let pending = this.pendingOutput.get(id)
        if (!pending) {
            pending = { chunks: [], bytes: 0, timer: null }
            this.pendingOutput.set(id, pending)
        }
        pending.chunks.push(data)
        pending.bytes += data.length

        if (pending.bytes >= OUTPUT_FLUSH_BYTES) {
            this.flushOutput(id)
            return
        }
        if (!pending.timer) {
            pending.timer = setTimeout(() => this.flushOutput(id), OUTPUT_FLUSH_MS)
        }
    }

    private flushOutput(id: string): void {
        const pending = this.pendingOutput.get(id)
        if (!pending) return
        if (pending.timer) {
            clearTimeout(pending.timer)
            pending.timer = null
        }
        if (pending.chunks.length === 0) return

        const data = pending.chunks.join('')
        pending.chunks = []
        pending.bytes = 0

        const windows = BrowserWindow.getAllWindows()
        windows.forEach(win => {
            if (!win.isDestroyed()) {
                win.webContents.send(`terminal-output-${id}`, data)
            }
        })
    }

    private clearPendingOutput(id: string): void {
        const pending = this.pendingOutput.get(id)
        if (pending?.timer) {
            clearTimeout(pending.timer)
        }
        this.pendingOutput.delete(id)
    }
}
