import { Terminal, ILinkProvider, ILink, IBufferCell, IDisposable } from '@xterm/xterm'

/**
 * File Path Link Provider for xterm.js
 * Based on WebLinksAddon implementation for proper Unicode/emoji handling
 */

// File extensions to recognize (longer extensions first to avoid partial matches)
const FILE_EXTENSIONS = 'tsx|jsx|cjs|mjs|cts|mts|ts|js|json|mdx|md|scss|sass|less|css|html|vue|svelte|py|rb|go|rs|java|kt|swift|cpp|hpp|cs|c|h|bash|zsh|sh|fish|yaml|yml|toml|ini|env|sql|graphql|prisma|php'

// Guards shared by both patterns.
//
// LEADING: a path may not start right after `:` `/` or a word character. This is
// what keeps URLs out — in `https://github.com/o/r/pull/1` the `//github.c` slice
// would otherwise match, because `c` is a valid extension and `.com` contains it.
//
// TRAILING: the extension may not be followed by another word character, so
// `.com` no longer matches `c` and `.tsx:411` still does.
const PATH_START_GUARD = '(?<![:/\\w])'
const EXTENSION_END_GUARD = '(?![\\w])'

// Regex for file paths
// Group 1: path, Group 2: line, Group 3: column
const FILE_PATH_REGEX = new RegExp(
    PATH_START_GUARD +
    '(' +
    // Relative path starting with known dirs (supports [id], [slug], etc.)
    `(?:\\./|(?:src|app|lib|pages|components|utils|hooks|types|styles|tests?|spec|__tests__|public|assets|api|services|models|packages|modules|features|core|common|shared|apps)/)` +
    `[\\w\\-./\\[\\]]+\\.(?:${FILE_EXTENSIONS})` +
    ')' +
    EXTENSION_END_GUARD +
    // Optional line number
    `(?::(\\d+))?` +
    // Optional column number
    `(?::(\\d+))?`,
    'g'
)

// Separate regex for absolute paths or project-root paths
// Matches /path/to/file.ext (will be resolved by main process)
const ABSOLUTE_PATH_REGEX = new RegExp(
    PATH_START_GUARD +
    '(' +
    `/[\\w\\-./\\[\\]]+\\.(?:${FILE_EXTENSIONS})` +
    ')' +
    EXTENSION_END_GUARD +
    `(?::(\\d+))?` +
    `(?::(\\d+))?`,
    'g'
)

/**
 * Link provider using WebLinksAddon-style coordinate mapping
 */
class FilePathLinkProvider implements ILinkProvider {
    constructor(
        private _terminal: Terminal,
        private _handler: (path: string, line?: number, column?: number) => void
    ) {}

    provideLinks(lineNumber: number, callback: (links: ILink[] | undefined) => void): void {
        const links = this._computeLinks(lineNumber)
        callback(links.length > 0 ? links : undefined)
    }

    private _computeLinks(y: number): ILink[] {
        const links: ILink[] = []

        // Get windowed line strings (handle wrapped lines)
        const [lines, startLineIndex] = this._getWindowedLineStrings(y - 1)
        const lineStr = lines.join('')

        if (!lineStr.trim()) return links

        // Use both regexes
        const regexes = [
            new RegExp(FILE_PATH_REGEX.source, 'g'),
            new RegExp(ABSOLUTE_PATH_REGEX.source, 'g')
        ]

        // Track matched ranges to avoid overlapping matches
        const matchedRanges: { start: number; end: number }[] = []

        for (const regex of regexes) {
            let match: RegExpExecArray | null
            while ((match = regex.exec(lineStr)) !== null) {
                const matchStart = match.index
                const matchEnd = match.index + match[0].length

                // Skip if this range overlaps with an already matched range
                const overlaps = matchedRanges.some(r =>
                    (matchStart >= r.start && matchStart < r.end) ||
                    (matchEnd > r.start && matchEnd <= r.end) ||
                    (matchStart <= r.start && matchEnd >= r.end)
                )
                if (overlaps) continue

                const filePath = match[1]
                const line = match[2] ? parseInt(match[2], 10) : undefined
                const column = match[3] ? parseInt(match[3], 10) : undefined
                const text = match[0]

                // Map string index to terminal coordinates
                const [startY, startX] = this._mapStrIdx(startLineIndex, 0, matchStart)
                const [endY, endX] = this._mapStrIdx(startLineIndex, 0, matchEnd)

                if (startY === -1 || startX === -1 || endY === -1 || endX === -1) {
                    continue
                }

                matchedRanges.push({ start: matchStart, end: matchEnd })

                links.push({
                    range: {
                        start: { x: startX + 1, y: startY + 1 },
                        end: { x: endX, y: endY + 1 }
                    },
                    text,
                    activate: (event: MouseEvent) => {
                        // xterm activates links on a plain click. Opening an editor from
                        // that steals window focus, so a bare click — placing the cursor,
                        // starting a selection — must not launch anything. Require the
                        // same modifier VS Code and iTerm use.
                        if (!event.metaKey && !event.ctrlKey) return
                        this._handler(filePath, line, column)
                    }
                })
            }
        }

        return links
    }

    /**
     * Get line strings including wrapped lines
     */
    private _getWindowedLineStrings(lineIndex: number): [string[], number] {
        const buffer = this._terminal.buffer.active
        const lines: string[] = []
        let startIndex = lineIndex

        // Get current line
        let line = buffer.getLine(lineIndex)
        if (!line) return [[], lineIndex]

        const currentLineStr = line.translateToString(true)

        // Check previous wrapped lines
        let checkIndex = lineIndex
        let totalLen = 0
        while (checkIndex > 0 && totalLen < 2048) {
            const prevLine = buffer.getLine(checkIndex - 1)
            if (!prevLine) break

            const nextLine = buffer.getLine(checkIndex)
            if (!nextLine?.isWrapped) break

            checkIndex--
            startIndex = checkIndex
            const str = prevLine.translateToString(true)
            lines.unshift(str)
            totalLen += str.length
        }

        lines.push(currentLineStr)

        // Check next wrapped lines
        let nextIndex = lineIndex + 1
        totalLen = 0
        while (totalLen < 2048) {
            const nextLine = buffer.getLine(nextIndex)
            if (!nextLine?.isWrapped) break

            const str = nextLine.translateToString(true)
            lines.push(str)
            totalLen += str.length
            nextIndex++
        }

        return [lines, startIndex]
    }

    /**
     * Map string index to terminal cell coordinates
     * Handles wide characters (emoji, CJK) properly
     */
    private _mapStrIdx(startY: number, startX: number, offset: number): [number, number] {
        const buffer = this._terminal.buffer.active
        const nullCell = this._terminal.buffer.active.getNullCell()
        let y = startY
        let x = startX
        let remaining = offset

        while (remaining > 0) {
            const line = buffer.getLine(y)
            if (!line) return [-1, -1]

            for (let i = x; i < line.length && remaining > 0; i++) {
                line.getCell(i, nullCell)
                const chars = nullCell.getChars()
                const width = nullCell.getWidth()

                if (width > 0) {
                    remaining -= chars.length || 1
                }

                if (remaining <= 0) {
                    return [y, i + 1]
                }
            }

            // Move to next line
            const nextLine = buffer.getLine(y + 1)
            if (!nextLine?.isWrapped) {
                // Not a wrapped line, return end of current line
                return [y, line.length]
            }

            y++
            x = 0
        }

        return [y, x]
    }
}

/**
 * Register file path link provider to a terminal.
 * Returns the disposable so callers can turn the feature off without
 * rebuilding the terminal.
 */
export function registerFilePathLinks(term: Terminal, cwd: string): IDisposable {
    const handler = (path: string, line?: number, column?: number) => {
        window.api.openFileInEditor(path, cwd, line, column)
            .then(result => {
                if (!result.success) {
                    console.warn('[FilePathLink] Failed to open file:', result.error)
                }
            })
            .catch(err => {
                console.error('[FilePathLink] Error:', err)
            })
    }

    return term.registerLinkProvider(new FilePathLinkProvider(term, handler))
}
