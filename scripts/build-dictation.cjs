#!/usr/bin/env node
/**
 * Builds the Chat view's dictation helper (native/dictation/main.swift + Transcript.swift) into
 * native/dictation/bin/climanager-dictation — one universal binary (arm64 + x86_64),
 * because the mac release ships both architectures and electron-builder copies the
 * same extraResources file into each.
 *
 * macOS only. Elsewhere it prints a note and exits 0: the app hides the mic button
 * when the helper is missing, so Windows/Linux builds need nothing from here.
 *
 * Run by `pnpm build:mac` / `publish:mac` before electron-builder; `pnpm build:dictation` alone for dev.
 */
const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
// main.swift is the program; Transcript.swift its running text across pauses (tested alone through `accumulate`)
const SOURCES = ['main.swift', 'Transcript.swift'].map((name) => path.join(ROOT, 'native/dictation', name))
const OUT_DIR = path.join(ROOT, 'native/dictation/bin')
const OUT = path.join(OUT_DIR, 'climanager-dictation')
// SFSpeechRecognizer's on-device mode needs 10.15; Electron itself needs 11.
const MIN_MACOS = '11.0'
const ARCHES = ['arm64', 'x86_64']

function run(cmd, args) {
    const result = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf-8' })
    if (result.status !== 0) {
        process.stderr.write(result.stdout || '')
        process.stderr.write(result.stderr || '')
        throw new Error(`${cmd} ${args.join(' ')} failed (exit ${result.status})`)
    }
    return result.stdout
}

function main() {
    if (process.platform !== 'darwin') {
        console.log('[build-dictation] Not macOS — skipped (the mic button is macOS only).')
        return
    }
    fs.mkdirSync(OUT_DIR, { recursive: true })
    const parts = ARCHES.map((arch) => {
        const part = path.join(OUT_DIR, `climanager-dictation-${arch}`)
        run('xcrun', ['swiftc', '-O', '-target', `${arch}-apple-macos${MIN_MACOS}`, ...SOURCES, '-o', part])
        return part
    })
    run('xcrun', ['lipo', '-create', ...parts, '-output', OUT])
    for (const part of parts) fs.rmSync(part, { force: true })
    fs.chmodSync(OUT, 0o755)
    console.log(`[build-dictation] ${path.relative(ROOT, OUT)} (${run('xcrun', ['lipo', '-archs', OUT]).trim()})`)
}

try {
    main()
} catch (error) {
    console.error(`[build-dictation] ${error.message}`)
    process.exit(1)
}
