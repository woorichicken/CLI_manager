import { PHONE_DOC_SANDBOX, PHONE_MAX_DOC_BYTES } from './phone'

/**
 * The Mac draws an HTML report in a sandboxed frame (decision 0013), on the same rules the phone uses (0011):
 * an opaque origin, `connect-src 'none'`, nothing from the web.
 *
 * Addresses look like `climanager-doc://doc/<token>/<file>`. The token is in the path because a standard scheme
 * lowercases its host, and the token is case-sensitive.
 */
export const DOC_PREVIEW_SCHEME = 'climanager-doc'
export const DOC_PREVIEW_HOST = 'doc'
export const DOC_PREVIEW_ORIGIN = `${DOC_PREVIEW_SCHEME}://${DOC_PREVIEW_HOST}`

/** The frame's flags: the phone's, never `allow-same-origin`. */
export const DOC_PREVIEW_SANDBOX = PHONE_DOC_SANDBOX

/** The phone's limit. The text preview's 500 KB (`read-file-content`) is for reading words, not for drawing a page. */
export const DOC_PREVIEW_MAX_BYTES = PHONE_MAX_DOC_BYTES

/** What the frame's bridge says to the window holding it (`postMessage`). Anything else is ignored. */
export const DOC_PREVIEW_MESSAGE = 'clim-doc-preview'

export type DocPreviewRefusal = 'not_found' | 'not_html' | 'too_large' | 'not_a_file' | 'bad_encoding'

export type DocPreviewOpenResult =
    | { status: 'ok'; url: string; size: number }
    | { status: 'refused'; reason: DocPreviewRefusal; message: string }
