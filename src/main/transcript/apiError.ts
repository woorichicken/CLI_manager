import { closeSync, fstatSync, openSync, readSync } from 'fs'

/**
 * Whether a Claude conversation's last turn ended on an API error (fb-1123 3239a243: the Wi-Fi dropped and the
 * turn ended «API Error: Connection dropped (ECONNRESET). …»). Claude Code 2.1.330 records that as an assistant
 * record of its own — `isApiErrorMessage: true`, `model: "<synthetic>"`, `apiError` (`connection_failed`,
 * `stream_idle_timeout`, `computer_slept`, …) and the words it printed as its one text block (read from real
 * transcripts on this Mac, 2026-11-23). The next prompt is a `user` record after it, so the error is over then.
 *
 * Read from the transcript, not the screen: the screen also shows the conversation's own words, and a session
 * talking about this very message would read as failed.
 */

/** Enough of the file's end for the last records (an error record is about 1KB; a long answer can be larger). */
const TAIL_BYTES = 256 * 1024
/** The words shown in a tooltip, at most. */
const MESSAGE_MAX = 300

/** The error the last turn ended on, from the tail of a transcript, or null when its last turn did not fail. */
export function lastTurnApiError(tail: string): string | null {
    const lines = tail.split('\n')
    for (let index = lines.length - 1; index >= 0; index--) {
        const line = lines[index].trim()
        if (!line.startsWith('{')) continue
        let record: { type?: unknown; isApiErrorMessage?: unknown; isSidechain?: unknown; message?: { content?: unknown } }
        try {
            record = JSON.parse(line)
        } catch {
            // the first line of the tail is usually cut, or a write is half done
            continue
        }
        if (record.isSidechain === true) continue
        if (record.type === 'user') return null
        if (record.type !== 'assistant') continue
        if (record.isApiErrorMessage !== true) return null
        const content = record.message?.content
        const text = Array.isArray(content)
            ? content.map((part: { type?: unknown; text?: unknown }) => (part?.type === 'text' && typeof part.text === 'string' ? part.text : '')).join(' ')
            : typeof content === 'string'
              ? content
              : ''
        const words = text.replace(/\s+/g, ' ').trim() || 'API Error'
        return words.length > MESSAGE_MAX ? `${words.slice(0, MESSAGE_MAX - 1)}…` : words
    }
    return null
}

/**
 * `lastTurnApiError` per transcript file, read again only when the file grew or changed: the sidebar asks every
 * second for every idle Claude session, and a stat is all an unchanged one costs.
 */
export class ApiErrorTails {
    private readonly known = new Map<string, { size: number; mtimeMs: number; error: string | null }>()

    read(file: string): string | null {
        let fd: number | null = null
        try {
            fd = openSync(file, 'r')
            const { size, mtimeMs } = fstatSync(fd)
            const seen = this.known.get(file)
            if (seen && seen.size === size && seen.mtimeMs === mtimeMs) return seen.error
            const length = Math.min(size, TAIL_BYTES)
            const buffer = Buffer.alloc(length)
            readSync(fd, buffer, 0, length, size - length)
            const error = lastTurnApiError(buffer.toString('utf8'))
            this.known.set(file, { size, mtimeMs, error })
            return error
        } catch {
            this.known.delete(file)
            return null
        } finally {
            if (fd !== null) closeSync(fd)
        }
    }

    forget(file: string): void {
        this.known.delete(file)
    }
}
