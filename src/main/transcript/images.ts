// From ovis (https://github.com/devswha/ovis, 3e51902) — MIT, Copyright (c) 2026 devswha. Modified.
// Source: server/codex-images.ts — only the inline-picture type check the parsers call. The chat names
// pictures and shows a placeholder; reading their bytes (and Codex's local image files) is not ported.

const RASTER_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
/** The largest picture a transcript may name inline. */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024

/** How many bytes a base64 string decodes to, its padding left out. */
export function base64Size(data: string): number {
    return Math.floor((data.length * 3) / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0)
}

function hasBytes(bytes: Buffer, offset: number, signature: string): boolean {
    return bytes.subarray(offset, offset + signature.length).equals(Buffer.from(signature, 'latin1'))
}

/** The raster type its leading bytes announce: a signature check, not a decode. */
export function imageType(bytes: Buffer): string | null {
    if (hasBytes(bytes, 0, '\x89PNG\r\n\x1a\n')) return 'image/png'
    if (hasBytes(bytes, 0, '\xff\xd8\xff')) return 'image/jpeg'
    if (hasBytes(bytes, 0, 'GIF87a') || hasBytes(bytes, 0, 'GIF89a')) return 'image/gif'
    if (hasBytes(bytes, 0, 'RIFF') && hasBytes(bytes, 8, 'WEBP')) return 'image/webp'
    return null
}

/**
 * The type of a picture a transcript holds inline as base64, by its leading bytes: a raster
 * declared as one, within MAX_IMAGE_BYTES. Null for anything else.
 */
export function inlineImageType(declared: unknown, data: unknown): string | null {
    if (typeof data !== 'string' || typeof declared !== 'string' || !RASTER_TYPES.has(declared)) return null
    if (base64Size(data) > MAX_IMAGE_BYTES) return null
    return imageType(Buffer.from(data.slice(0, 16), 'base64'))
}
