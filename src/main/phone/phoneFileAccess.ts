import path from 'path'

/**
 * Which files a phone may read: the pure half of the judgement (decision 0010). Plain strings in and answers out,
 * so its table can be tested without a disk — phoneFiles.ts does the disk half and the order of the steps.
 *
 * Macs read names without regard to case (`~/.SSH/id_rsa` is `~/.ssh/id_rsa`), so everything here compares in
 * lower case, in the composed form. The list errs towards refusing: a Keynote `.key` that will not open costs a
 * trip to the Mac; a private key shown on a phone costs a rotation.
 */

/** A longer path is not a path (PATH_MAX on the Mac is 1024; Linux 4096). */
export const MAX_PATH_BYTES = 4096

/** Folders and files under the home folder that hold keys, tokens or other people's data. */
const PROTECTED_IN_HOME = [
    // keys and cloud logins
    '.ssh',
    '.gnupg',
    '.aws',
    '.azure',
    '.kube',
    '.1password',
    '.config/gh',
    '.config/gcloud',
    '.config/op',
    // agents and apps
    '.claude.json',
    '.claude/.credentials.json',
    '.codex/auth.json',
    '.docker/config.json',
    '.climanager/control-api.json',
    '.climanager/orch-token',
    // the Mac's stores and history
    'library/keychains',
    'library/cookies',
    'library/group containers',
    'library/application support/google',
    'library/application support/chromium',
    'library/application support/bravesoftware',
    'library/application support/microsoft edge',
    'library/application support/arc',
    'library/application support/firefox',
    'library/application support/1password',
    'library/application support/cli manager',
    '.zsh_history',
    '.bash_history',
    '.netrc',
    '.npmrc',
    '.pypirc',
    '.git-credentials'
]

/** `.env.example` and the like are written to be shared. */
const ENV_FILE = /^\.env(?:\.(?!example$|sample$|template$)[^/]+)?$/
const SECRET_FOLDER = /^\.secrets?$/
const KEY_NAME = /^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)$/
const KEY_EXTENSION = /\.(?:pem|key|p12|pfx|keystore|jks)$/
const CREDENTIALS_NAME = /^credentials(?:\..+)?$/
const SERVICE_ACCOUNT = /^service-account.*\.json$/

const form = (value: string): string => value.normalize('NFC').toLowerCase()

/**
 * The absolute path a request names, normalized (`..` is gone after this), or null when it is not one: empty,
 * relative, too long, or holding a control character. The result keeps the request's own bytes — a name on disk
 * can be decomposed, and opening it by its composed form would fail on a disk that tells them apart.
 */
export function usablePath(raw: string): string | null {
    if (!raw || Buffer.byteLength(raw) > MAX_PATH_BYTES) return null
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(raw)) return null
    if (!path.isAbsolute(raw)) return null
    return path.normalize(raw)
}

/** Whether `candidate` is `root` or inside it. */
function isInside(candidate: string, root: string): boolean {
    const a = form(candidate)
    const b = form(root).replace(/\/+$/, '')
    return a === b || a.startsWith(`${b}/`)
}

/** Whether `real` (symlinks resolved) sits under one of `roots`. An empty root or `/` would admit everything: it counts for nothing. */
export function withinRoots(real: string, roots: readonly string[]): boolean {
    return roots.some((root) => root.replace(/\/+$/, '') !== '' && isInside(real, root))
}

function nameIsProtected(target: string): boolean {
    const segments = form(target).split('/').filter(Boolean)
    const name = segments[segments.length - 1] ?? ''
    if (ENV_FILE.test(name) || KEY_NAME.test(name) || KEY_EXTENSION.test(name) || CREDENTIALS_NAME.test(name) || SERVICE_ACCOUNT.test(name)) return true
    // a folder of secrets protects what is in it, wherever it is
    if (segments.some((segment) => SECRET_FOLDER.test(segment) || segment === '.env')) return true
    return segments.slice(-2).join('/') === '.git/config'
}

/**
 * Whether a path is on the list. `homes` holds the home folder as the app names it and as the disk names it (a
 * home behind a symlink); `extra` adds places of this app (its own data folder holds the paired devices).
 */
export function isProtectedPath(target: string, homes: readonly string[], extra: readonly string[] = []): boolean {
    if (nameIsProtected(target)) return true
    if (extra.some((place) => isInside(target, place))) return true
    return homes.some((home) => PROTECTED_IN_HOME.some((place) => isInside(target, `${home.replace(/\/+$/, '')}/${place}`)))
}
