import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomBytes } from 'crypto'
import type { AttachResult } from '../shared/conversation'
import { MAX_ATTACH_BYTES } from '../shared/conversation'

/**
 * Stores a file the chat attached that has no path of its own (a picture pasted from the
 * clipboard), so the message can name it as `@path` for the agent to read.
 *
 * The stored name is ASCII: macOS hands a Korean name in NFD (decomposed jamo), and an agent's
 * `@path` mention ends at a space — `<time>-<random>.<ext>` survives both. The original name is
 * only for the person, who sees it on the tile; it is not needed to read the file.
 */
const SAFE_EXTENSION = /^[a-z0-9]{1,8}$/

export function saveChatAttachment(root: string, name: string, bytes: unknown): AttachResult {
    const view = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : ArrayBuffer.isView(bytes) ? bytes : null
    const data = view ? new Uint8Array(view.buffer, view.byteOffset, view.byteLength) : null
    if (!data) return { status: 'rejected', reason: 'unreadable', message: 'The file could not be read.' }
    if (data.byteLength > MAX_ATTACH_BYTES) {
        return { status: 'rejected', reason: 'too_large', message: `Files are limited to ${MAX_ATTACH_BYTES / 1024 / 1024} MB.` }
    }
    const extension = name.normalize('NFC').split('.').pop()?.toLowerCase() ?? ''
    const day = new Date().toISOString().slice(0, 10)
    const folder = join(root, day)
    const file = join(folder, `${Date.now()}-${randomBytes(4).toString('hex')}${SAFE_EXTENSION.test(extension) && extension !== name.toLowerCase() ? `.${extension}` : ''}`)
    try {
        mkdirSync(folder, { recursive: true })
        writeFileSync(file, data)
    } catch (error) {
        return { status: 'rejected', reason: 'unreadable', message: `Could not store the file: ${error instanceof Error ? error.message : String(error)}` }
    }
    return { status: 'attached', path: file }
}
