/**
 * Which template logos the phone's session list may carry (59886f9c). The store holds whatever was
 * saved there; the phone puts the value straight into an <img src>. Only a base64 PNG data URL — what
 * the template editor stores (renderer utils/templateLogo.ts, a 32×32 PNG) — and no longer than a
 * logo that size can be: the list is polled every few seconds.
 */

/** 32×32 PNGs the editor makes are a few KB; anything this long is not one of them */
export const MAX_PHONE_LOGO_CHARS = 20_000
const PNG_DATA_URL = /^data:image\/png;base64,[A-Za-z0-9+/=]+$/

/** The value, if it may go to the phone; otherwise undefined (the row keeps its plain icon). */
export function phoneTemplateLogo(value: unknown): string | undefined {
    if (typeof value !== 'string' || value.length > MAX_PHONE_LOGO_CHARS) return undefined
    return PNG_DATA_URL.test(value) ? value : undefined
}
