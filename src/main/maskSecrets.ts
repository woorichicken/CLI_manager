/**
 * Masks credentials in terminal text before it leaves the app in a feedback report.
 *
 * Terminals are where people paste tokens, print env files and log in. A report
 * carries the last lines of one terminal, so anything shaped like a credential
 * is replaced first. The patterns lean towards masking too much: a hidden
 * harmless value costs a line of context, a leaked key costs a rotation.
 * The screenshot is not covered — it shows the screen as it is.
 */

export const MASK = '[REDACTED]'

/** Prefixed vendor tokens. The prefix makes them safe to match anywhere in a line. */
const VENDOR_TOKENS: RegExp[] = [
    /\bsk-[A-Za-z0-9_-]{16,}/g, // OpenAI, Anthropic (sk-ant-…)
    /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, // GitHub
    /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
    /\bglpat-[A-Za-z0-9_-]{20,}/g, // GitLab
    /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack
    /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
    /\bAIza[0-9A-Za-z_-]{35}/g, // Google API key
    /\b[rs]k_live_[0-9A-Za-z]{16,}/g, // Stripe
    /\bnpm_[A-Za-z0-9]{30,}/g,
    /\blin_api_[A-Za-z0-9]{20,}/g, // Linear
    /\bsbp_[A-Za-z0-9]{20,}/g, // Supabase personal token
    /\bdp_[a-z]+_[A-Za-z0-9_-]{8,}/g, // Lasso Run keys (dp_ingest_…)
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g // JWT
]

/**
 * `NAME=value`, `name: value`, `"name": "value"` where the name says it is secret.
 * Group 1 is the name, 2 the separator (quotes included), 3 the value.
 */
const SECRET_ASSIGNMENT =
    /\b([A-Za-z0-9_.-]*(?:password|passwd|passphrase|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential)s?[A-Za-z0-9_.-]*)(["']?\s*[:=]\s*["']?)([^\s"',;]{4,})/gi

/** `Authorization: Bearer …` and the like. Case-sensitive so prose ("basic usage") is left alone. */
const AUTH_SCHEME = /\b(Bearer|Basic)(\s+)[A-Za-z0-9._~+/=-]{12,}/g

/** `scheme://user:password@host` */
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)([^\s@/]+)@/gi

const PRIVATE_KEY_BEGIN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/
const PRIVATE_KEY_END = /-----END [A-Z0-9 ]*PRIVATE KEY-----/

/**
 * Characters of a token (a key, a path, a URL). A row cut between two of them may have split a
 * secret. Not `%` or `~`: a zsh prompt starts with them, and a prompt row is never a continuation.
 */
const TOKEN_CHAR = /^[A-Za-z0-9_\-+/=.:@]$/

/** Shorter user names are ordinary words; replacing them would garble the text. */
const MIN_USERNAME_LENGTH = 3

export interface MaskOptions {
    /** Replaced with `~`, so reports do not carry the account's folder. */
    homeDir?: string
    /** Replaced where it reads as an account (`name@host`, the shell prompt). */
    username?: string
}

export interface MaskResult {
    lines: string[]
    /** How many values were masked. */
    masked: number
}

export function maskSecretLines(lines: string[], options: MaskOptions = {}): MaskResult {
    let masked = 0
    let inPrivateKey = false
    const out = joinSplitSecrets(lines, options).map((line) => {
        if (inPrivateKey || PRIVATE_KEY_BEGIN.test(line)) {
            inPrivateKey = !PRIVATE_KEY_END.test(line)
            masked++
            return MASK
        }
        const result = maskLine(line, options)
        masked += result.masked
        return result.text
    })
    return { lines: out, masked }
}

/**
 * Terminal rows are cut at the right edge, and a secret cut in two matches no
 * pattern on either row. The terminal's own wraps are already joined
 * (TerminalMirror.logicalTail), but zsh breaks a long typed command itself, and
 * a resize leaves such cuts where they were — so no width test can find them.
 * Two rows touching mid-word are joined when masking them together hides more
 * of the original text than masking them apart: only then, so ordinary rows
 * keep their shape — and a join that would hide less (it can: an account name
 * glued to the row before) is never made.
 */
function joinSplitSecrets(lines: string[], options: MaskOptions): string[] {
    const out: string[] = []
    for (const line of lines) {
        const last = out.length - 1
        // Whether a row was cut or simply ended there cannot be told from the text. Joining
        // costs at most a merged row and a masked word; not joining can leak half a key.
        if (last >= 0 && cutsToken(out[last], line)) {
            const joined = out[last] + line
            if (visibleLength(maskLine(joined, options).text) < visibleLength(maskLine(out[last], options).text) + visibleLength(maskLine(line, options).text)) {
                out[last] = joined
                continue
            }
        }
        out.push(line)
    }
    return out
}

/** Characters of the original still shown — the mask itself does not count. */
function visibleLength(text: string): number {
    return text.split(MASK).join('').length
}

function cutsToken(before: string, after: string): boolean {
    return TOKEN_CHAR.test(before.charAt(before.length - 1)) && TOKEN_CHAR.test(after.charAt(0))
}

/** One line on its own; private key blocks span lines and are handled by the caller. */
function maskLine(line: string, options: MaskOptions): { text: string; masked: number } {
    let masked = 0
    let text = line
    for (const pattern of VENDOR_TOKENS) {
        text = text.replace(pattern, () => {
            masked++
            return MASK
        })
    }
    text = text.replace(SECRET_ASSIGNMENT, (match, name: string, separator: string, value: string) => {
        if (value === MASK) return match
        masked++
        return `${name}${separator}${MASK}`
    })
    text = text.replace(AUTH_SCHEME, (_match, scheme: string, space: string) => {
        masked++
        return `${scheme}${space}${MASK}`
    })
    text = text.replace(URL_CREDENTIALS, (_match, prefix: string) => {
        masked++
        return `${prefix}${MASK}@`
    })
    return { text: maskAccount(text, options), masked }
}

function maskAccount(text: string, { homeDir, username }: MaskOptions): string {
    let result = text
    if (homeDir && homeDir.length > 1) result = result.split(homeDir).join('~')
    if (username && username.length >= MIN_USERNAME_LENGTH) {
        // No word boundary: a row joined to the one before glues the name to other text.
        result = result.split(`${username}@`).join('user@')
    }
    return result
}
