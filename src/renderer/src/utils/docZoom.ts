/** A browser's zoom levels (Chrome's), for ⌘+ / ⌘- on a document (5c6ddf8f). */
export const DOC_ZOOM_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3]

/** The zoom after `key` (`=`/`+` in, `-` out, `0` back to 100%) from `zoom`; null for any other key. */
export function nextDocZoom(zoom: number, key: string): number | null {
    if (key === '0') return 1
    const step = key === '=' || key === '+' ? 1 : key === '-' ? -1 : 0
    if (step === 0) return null
    // the next level past the current one, so a zoom between levels lands on one; the ends hold
    const EPSILON = 0.001
    const next = step > 0 ? DOC_ZOOM_STEPS.find((level) => level > zoom + EPSILON) : [...DOC_ZOOM_STEPS].reverse().find((level) => level < zoom - EPSILON)
    return next ?? zoom
}
