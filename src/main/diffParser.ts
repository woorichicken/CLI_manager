import { DiffFileStatus, DiffFileSummary, DiffHunk, DiffLine, FileDiff } from '../shared/types'

/**
 * Parsers for git's plumbing output.
 *
 * Kept as pure functions with no git invocation of their own so they can be
 * exercised directly against captured fixtures.
 */

/** Beyond this a single file's diff is truncated; the UI says so explicitly. */
const MAX_LINES_PER_FILE = 4000

function statusFromCode(code: string): DiffFileStatus {
    switch (code[0]) {
        case 'A':
            return 'added'
        case 'D':
            return 'deleted'
        case 'R':
            return 'renamed'
        default:
            return 'modified'
    }
}

/**
 * Merges `git diff --numstat` with `git diff --name-status`.
 *
 * Two commands are needed because numstat carries the line counts but not the
 * change kind, while name-status carries the kind but not the counts.
 *
 * Both are read in NUL-delimited (`-z`) form so that paths containing spaces,
 * quotes or non-ASCII characters survive intact — git would otherwise escape
 * and quote them, which silently breaks the follow-up `git diff -- <path>`.
 */
export function parseDiffSummary(numstatZ: string, nameStatusZ: string): DiffFileSummary[] {
    const statuses = new Map<string, { status: DiffFileStatus; oldPath?: string }>()

    const nameFields = nameStatusZ.split('\0').filter((f) => f.length > 0)
    for (let i = 0; i < nameFields.length; ) {
        const code = nameFields[i]
        // Rename and copy records carry two paths; everything else carries one.
        if (/^[RC]/.test(code)) {
            const oldPath = nameFields[i + 1]
            const newPath = nameFields[i + 2]
            if (newPath) statuses.set(newPath, { status: 'renamed', oldPath })
            i += 3
        } else {
            const path = nameFields[i + 1]
            if (path) statuses.set(path, { status: statusFromCode(code) })
            i += 2
        }
    }

    const files: DiffFileSummary[] = []
    const numFields = numstatZ.split('\0').filter((f) => f.length > 0)

    for (let i = 0; i < numFields.length; ) {
        const record = numFields[i]
        const parts = record.split('\t')
        if (parts.length < 3) {
            i += 1
            continue
        }

        const [addedRaw, deletedRaw] = parts
        // With -z, a rename emits the counts record then old and new paths as
        // two additional NUL-terminated fields.
        const inlinePath = parts.slice(2).join('\t')
        let path = inlinePath
        let oldPath: string | undefined

        if (inlinePath === '') {
            oldPath = numFields[i + 1]
            path = numFields[i + 2]
            i += 3
        } else {
            i += 1
        }

        if (!path) continue

        const binary = addedRaw === '-' || deletedRaw === '-'
        const known = statuses.get(path)

        files.push({
            path,
            oldPath: known?.oldPath ?? oldPath,
            status: known?.status ?? 'modified',
            additions: binary ? 0 : Number.parseInt(addedRaw, 10) || 0,
            deletions: binary ? 0 : Number.parseInt(deletedRaw, 10) || 0,
            binary
        })
    }

    // Deletions of empty files, and other cases numstat omits, still deserve a row.
    for (const [path, info] of statuses) {
        if (!files.some((f) => f.path === path)) {
            files.push({ path, oldPath: info.oldPath, status: info.status, additions: 0, deletions: 0, binary: false })
        }
    }

    return files.sort((a, b) => a.path.localeCompare(b.path))
}

/**
 * Parses a single file's unified diff into hunks with resolved line numbers.
 *
 * Line numbers are tracked per side so a comment can cite the number the reader
 * actually sees, which is the whole point of sending a selection to an agent.
 */
export function parseFileDiff(raw: string, path: string, status: DiffFileStatus, oldPath?: string): FileDiff {
    const result: FileDiff = { path, oldPath, status, hunks: [], binary: false, truncated: false }

    if (!raw.trim()) return result
    if (/^Binary files .* differ$/m.test(raw)) {
        result.binary = true
        return result
    }

    const lines = raw.split('\n')
    let current: DiffHunk | null = null
    let oldNumber = 0
    let newNumber = 0
    let emitted = 0

    for (const line of lines) {
        const hunkMatch = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line)
        if (hunkMatch) {
            current = { header: line, lines: [] }
            result.hunks.push(current)
            oldNumber = Number.parseInt(hunkMatch[1], 10)
            newNumber = Number.parseInt(hunkMatch[3], 10)
            continue
        }

        // Everything before the first @@ is the file header (index/---/+++).
        if (!current) continue

        if (emitted >= MAX_LINES_PER_FILE) {
            result.truncated = true
            break
        }

        const marker = line[0]
        let entry: DiffLine | null = null

        if (marker === '+') {
            entry = { type: 'add', oldNumber: null, newNumber, content: line.slice(1) }
            newNumber++
        } else if (marker === '-') {
            entry = { type: 'del', oldNumber, newNumber: null, content: line.slice(1) }
            oldNumber++
        } else if (marker === ' ') {
            entry = { type: 'context', oldNumber, newNumber, content: line.slice(1) }
            oldNumber++
            newNumber++
        } else if (marker === '\\') {
            // "\ No newline at end of file" — metadata, not content.
            continue
        } else if (line === '') {
            // Trailing newline produced by the split; not part of the hunk.
            continue
        } else {
            // A new file header inside a multi-file diff: stop, this parser
            // handles one file at a time.
            if (line.startsWith('diff --git')) break
            continue
        }

        current.lines.push(entry)
        emitted++
    }

    return result
}

// The review prompt is assembled in the renderer (utils/reviewPrompt.ts),
// where the line selection lives. Keeping a second copy here would let the two
// drift apart silently.
