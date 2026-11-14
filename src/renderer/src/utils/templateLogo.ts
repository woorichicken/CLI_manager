/**
 * Turns a picked PNG/SVG into the small logo a template keeps (report 8062e68c).
 *
 * The result is a 32×32 PNG data URL: twice the 14–16px it is drawn at, so it stays sharp on a
 * Retina screen, and only a few KB in config.json. Everything that could stall the window is
 * refused before decoding: oversized files, and PNGs whose header promises a huge canvas (a
 * 30000×30000 PNG compresses to a few KB but decodes to gigabytes).
 */

/** Stored size, in pixels — 2x of the sidebar slot. */
export const TEMPLATE_LOGO_SIZE = 32
/** Larger files are refused outright; a logo never needs this much. */
export const MAX_LOGO_FILE_BYTES = 2 * 1024 * 1024
/** Refuse PNGs wider or taller than this before decoding them. */
export const MAX_LOGO_SOURCE_PIXELS = 4096
/** A decode that takes longer than this is treated as a broken file. */
const DECODE_TIMEOUT_MS = 5000

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
/** Signature (8) + IHDR length (4) + "IHDR" (4) + width (4) + height (4). */
const PNG_HEADER_BYTES = 24

export type TemplateLogoResult = { ok: true; dataUrl: string } | { ok: false; error: string }

type LogoKind = 'png' | 'svg'

export function logoKindOf(file: { name: string; type: string }): LogoKind | null {
    const name = file.name.toLowerCase()
    if (file.type === 'image/png' || name.endsWith('.png')) return 'png'
    if (file.type === 'image/svg+xml' || name.endsWith('.svg')) return 'svg'
    return null
}

/**
 * Width and height from a PNG's IHDR, or null when the bytes are not a PNG. Reading the header is
 * cheap and needs no decode, so a decompression bomb never reaches the image decoder.
 */
export function pngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
    if (bytes.length < PNG_HEADER_BYTES) return null
    for (let i = 0; i < PNG_SIGNATURE.length; i++) {
        if (bytes[i] !== PNG_SIGNATURE[i]) return null
    }
    const tag = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15])
    if (tag !== 'IHDR') return null
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    return { width: view.getUint32(16), height: view.getUint32(20) }
}

function readAsDataUrl(file: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result))
        reader.onerror = () => reject(reader.error ?? new Error('read failed'))
        reader.readAsDataURL(file)
    })
}

/** Data URLs, not blob: — the app's CSP does not allow blob: images. */
function loadImage(src: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const img = new Image()
        const timer = setTimeout(() => reject(new Error('timeout')), DECODE_TIMEOUT_MS)
        img.onload = () => {
            clearTimeout(timer)
            resolve(img)
        }
        img.onerror = () => {
            clearTimeout(timer)
            reject(new Error('decode failed'))
        }
        img.src = src
    })
}

/**
 * Draws the image centred into a square, keeping its proportions. Big sources are halved step by
 * step first: a single jump from 1000px to 32px skips most pixels and comes out jagged.
 */
function shrinkToSquare(img: HTMLImageElement, size: number): string {
    // An SVG with only a viewBox can report 0×0; any square box fits it, so draw it at full size.
    let width = img.naturalWidth || size
    let height = img.naturalHeight || size
    let source: CanvasImageSource = img

    while (width > size * 2 && height > size * 2) {
        const half = document.createElement('canvas')
        half.width = Math.max(1, Math.round(width / 2))
        half.height = Math.max(1, Math.round(height / 2))
        const ctx = half.getContext('2d')
        if (!ctx) break
        ctx.imageSmoothingQuality = 'high'
        ctx.drawImage(source, 0, 0, half.width, half.height)
        source = half
        width = half.width
        height = half.height
    }

    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('no canvas')
    ctx.imageSmoothingQuality = 'high'
    const scale = Math.min(size / width, size / height)
    const drawWidth = width * scale
    const drawHeight = height * scale
    ctx.drawImage(source, (size - drawWidth) / 2, (size - drawHeight) / 2, drawWidth, drawHeight)
    return canvas.toDataURL('image/png')
}

export async function readTemplateLogo(file: File): Promise<TemplateLogoResult> {
    const kind = logoKindOf(file)
    if (!kind) return { ok: false, error: 'Choose a PNG or SVG image.' }
    if (file.size > MAX_LOGO_FILE_BYTES) {
        return { ok: false, error: `This file is too big (${Math.ceil(file.size / 1024)} KB). Use one under ${MAX_LOGO_FILE_BYTES / 1024 / 1024} MB.` }
    }

    if (kind === 'png') {
        const head = new Uint8Array(await file.slice(0, PNG_HEADER_BYTES).arrayBuffer())
        const dims = pngDimensions(head)
        if (!dims) return { ok: false, error: 'This image could not be read. Choose another PNG or SVG.' }
        if (dims.width > MAX_LOGO_SOURCE_PIXELS || dims.height > MAX_LOGO_SOURCE_PIXELS) {
            return { ok: false, error: `This image is too large (${dims.width}×${dims.height}). Use one up to ${MAX_LOGO_SOURCE_PIXELS}px on each side.` }
        }
    }

    try {
        const source = await readAsDataUrl(kind === 'svg' ? new Blob([file], { type: 'image/svg+xml' }) : file)
        const img = await loadImage(source)
        return { ok: true, dataUrl: shrinkToSquare(img, TEMPLATE_LOGO_SIZE) }
    } catch {
        return { ok: false, error: 'This image could not be read. Choose another PNG or SVG.' }
    }
}
