import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'fs'
import path from 'path'
import { TerminalManager } from './TerminalManager'
import { TerminalMirror } from './TerminalMirror'

/**
 * Writes each terminal's history to disk so a force-quit does not take it
 * along. The mirror (main process) is the source; the renderer may already be
 * gone when it matters.
 *
 * Only terminals that printed something since the last save are written.
 * Measured 2026-10-13: a full 2000-line mirror at 200 columns serializes in
 * ~14ms to ~370KB, and the write takes ~0.4ms — so a busy session costs about
 * 0.05% CPU at this interval. A force-quit loses at most this much output.
 */
const SAVE_INTERVAL_MS = 30_000

const FILE_SUFFIX = '.ans'

/** Terminal ids are UUIDs; anything else must never become a file name. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/

export interface SavedHistory {
    data: string
    savedAt: number
}

export class ScrollbackStore {
    private readonly dirty = new Set<string>()
    private timer: NodeJS.Timeout | null = null
    private saving: Promise<void> | null = null

    /**
     * @param keptIds ids whose history is worth keeping — the sessions in the
     *   sidebar. Loop and other transient terminals are skipped.
     */
    constructor(
        private readonly dir: string,
        terminals: TerminalManager,
        private readonly mirror: TerminalMirror,
        private readonly keptIds: () => Set<string>,
        private readonly intervalMs: number = SAVE_INTERVAL_MS
    ) {
        terminals.events.on('output', (id) => this.dirty.add(id))
    }

    start(): void {
        if (this.timer) return
        this.timer = setInterval(() => void this.saveDirty(), this.intervalMs)
        this.timer.unref?.()
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer)
        this.timer = null
    }

    /** The terminal's history changed without printing (Cmd+K). */
    markDirty(id: string): void {
        this.dirty.add(id)
    }

    /** Saves every terminal that printed since the last save. Concurrent calls share one run. */
    saveDirty(): Promise<void> {
        if (!this.saving) {
            this.saving = this.run().finally(() => {
                this.saving = null
            })
        }
        return this.saving
    }

    load(id: string): SavedHistory | null {
        const file = this.fileFor(id)
        if (!file || !existsSync(file)) return null
        try {
            return { data: readFileSync(file, 'utf8'), savedAt: statSync(file).mtimeMs }
        } catch (e) {
            console.warn(`[ScrollbackStore] could not read ${id}:`, e)
            return null
        }
    }

    /** The session is gone; its history must not outlive it. */
    forget(id: string): void {
        this.dirty.delete(id)
        const file = this.fileFor(id)
        if (!file) return
        try {
            unlinkSync(file)
        } catch {
            // never saved
        }
    }

    /** Removes histories of sessions that no longer exist (deleted while the app was closed, say). */
    prune(): void {
        if (!existsSync(this.dir)) return
        const kept = this.keptIds()
        for (const name of readdirSync(this.dir)) {
            if (!name.endsWith(FILE_SUFFIX)) continue
            if (kept.has(name.slice(0, -FILE_SUFFIX.length))) continue
            try {
                unlinkSync(path.join(this.dir, name))
            } catch {
                // already gone
            }
        }
    }

    private async run(): Promise<void> {
        const ids = [...this.dirty]
        this.dirty.clear()
        if (ids.length === 0) return

        const kept = this.keptIds()
        mkdirSync(this.dir, { recursive: true })
        for (const id of ids) {
            const file = this.fileFor(id)
            if (!file || !kept.has(id)) continue
            const data = await this.mirror.snapshot(id, { forDisk: true })
            if (data === null) continue
            try {
                // Write-then-rename: a force-quit mid-write leaves the previous file intact.
                writeFileSync(file + '.tmp', data)
                renameSync(file + '.tmp', file)
            } catch (e) {
                console.warn(`[ScrollbackStore] could not save ${id}:`, e)
                this.dirty.add(id)
            }
            // Serializing blocks the main process; let terminal output through between sessions.
            await new Promise((resolve) => setImmediate(resolve))
        }
    }

    private fileFor(id: string): string | null {
        return SAFE_ID.test(id) ? path.join(this.dir, id + FILE_SUFFIX) : null
    }
}
