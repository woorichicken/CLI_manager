/**
 * What kind of file a name says it is: the Mac's previews (FilePreview, ChatFilePreview) and the phone's
 * file route (phone/phoneFiles.ts) decide from one list, so a file cannot open one way here and another there.
 */

/** Drawn as a picture. */
export const IMAGE_EXTENSIONS: readonly string[] = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp']

/** Not shown in the app: the Mac opens them in its own app, the phone's browser downloads them. */
export const SYSTEM_TYPES: ReadonlySet<string> = new Set([
    'pdf', 'mp4', 'mov', 'm4v', 'webm', 'avi', 'mkv', 'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg',
    'zip', 'gz', 'tgz', 'dmg', 'pkg', 'docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt', 'key', 'pages', 'numbers', 'hwp', 'hwpx', 'psd', 'ai', 'sketch', 'fig'
])

/** The extension of a path's last name, lower case, without the dot ('' when it has none). */
export function fileExtension(path: string): string {
    const name = path.slice(path.lastIndexOf('/') + 1)
    const dot = name.lastIndexOf('.')
    return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}
