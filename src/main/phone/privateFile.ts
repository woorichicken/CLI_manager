import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'

/**
 * JSON files only this account may read (0600 in a 0700 folder): the phone's device
 * list and push keys live in the app data folder, never in config.json (0644) and never
 * in a log. Written whole through a temp file, so a crash leaves the old file.
 */

export function readPrivateJson<T>(file: string): T | null {
    try {
        return JSON.parse(readFileSync(file, 'utf8')) as T
    } catch {
        return null
    }
}

export function writePrivateJson(file: string, value: unknown): void {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    const temp = `${file}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 })
    // an existing temp file keeps its mode: set it again
    chmodSync(temp, 0o600)
    renameSync(temp, file)
}
