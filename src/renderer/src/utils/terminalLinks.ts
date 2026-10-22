/**
 * Which links a terminal may hand to the OS.
 *
 * Terminal output is untrusted: anything the agent prints — including the
 * contents of a file it read — can carry a link with an arbitrary scheme. So
 * only the built-in schemes below pass by default, and every other app scheme
 * (`obsidian`, `things`, …) passes only after the user adds it in
 * Settings > Terminal. A link only asks the OS to open something; nothing in it
 * is ever typed into a shell.
 */

/**
 * Always allowed. Editor schemes are here because Codex emits them for file
 * citations (`file_opener` defaults to "vscode").
 */
export const BUILTIN_LINK_PROTOCOLS: ReadonlySet<string> = new Set([
    'http:',
    'https:',
    'file:',
    'vscode:',
    'vscode-insiders:',
    'cursor:',
    'windsurf:'
])

/**
 * Never user-allowable. These either run code inside this window or belong to
 * the app itself (`climanager:` session links are resolved in-app, never by the OS).
 */
const RESERVED_SCHEMES: ReadonlySet<string> = new Set([
    'javascript',
    'data',
    'vbscript',
    'blob',
    'about',
    'climanager'
])

// RFC 3986 scheme syntax, lowercased.
const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*$/
const MAX_SCHEME_LENGTH = 32

export type SchemeCheck = { scheme: string; error?: undefined } | { scheme?: undefined; error: string }

/**
 * Turns what the user typed (`Obsidian`, `obsidian:`, `obsidian://`) into a bare
 * lowercase scheme, or explains why it cannot be added.
 */
export function normalizeLinkScheme(input: string, existing: readonly string[] = []): SchemeCheck {
    const scheme = input.trim().toLowerCase().replace(/:(\/\/)?$/, '')
    if (!scheme) return { error: 'Enter a scheme, e.g. obsidian' }
    if (scheme.length > MAX_SCHEME_LENGTH || !SCHEME_PATTERN.test(scheme)) {
        return { error: 'Use letters, digits, "+", "." or "-" (e.g. obsidian)' }
    }
    if (RESERVED_SCHEMES.has(scheme)) return { error: `"${scheme}:" links can't be opened from the terminal` }
    if (BUILTIN_LINK_PROTOCOLS.has(`${scheme}:`)) return { error: `"${scheme}:" links are always allowed` }
    if (existing.includes(scheme)) return { error: `"${scheme}:" is already in the list` }
    return { scheme }
}

/** Drops anything a hand-edited config could slip in that the settings screen would refuse. */
export function sanitizeLinkSchemes(schemes: readonly string[] | undefined): string[] {
    const result: string[] = []
    for (const raw of schemes ?? []) {
        if (typeof raw !== 'string') continue
        const check = normalizeLinkScheme(raw, result)
        if (check.scheme) result.push(check.scheme)
    }
    return result
}

/** Whether a link with this URI may be passed to the OS. */
export function isLinkAllowed(uri: string, extraSchemes: readonly string[]): boolean {
    let protocol: string
    try {
        protocol = new URL(uri).protocol
    } catch {
        return false
    }
    if (BUILTIN_LINK_PROTOCOLS.has(protocol)) return true
    return sanitizeLinkSchemes(extraSchemes).includes(protocol.slice(0, -1))
}

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Plain-text detector for the user's extra schemes, for WebLinksAddon.
 *
 * The body mirrors the addon's own http(s) pattern so wrapping and trailing
 * punctuation behave like web links. Non-ASCII stays in, so an agent can print
 * `obsidian://open?path=/vault/리뷰.md` without percent-encoding — encoding turns
 * each Hangul syllable into nine characters, and long words are what Claude Code
 * breaks onto an indented next line where no detector can rejoin them.
 * `://` is required so a word like `note:` in prose never becomes a link.
 */
export function buildLinkSchemeRegex(extraSchemes: readonly string[]): RegExp | null {
    const schemes = sanitizeLinkSchemes(extraSchemes)
    if (schemes.length === 0) return null
    const alternatives = schemes.map(escapeRegExp).join('|')
    return new RegExp(
        `(?<![a-z0-9+.-])(?:${alternatives}):\\/\\/[^\\s"'!*(){}|\\\\^<>\`]*[^\\s"':,.!?{}|\\\\^~\\[\\]\`()<>]`,
        'i'
    )
}
