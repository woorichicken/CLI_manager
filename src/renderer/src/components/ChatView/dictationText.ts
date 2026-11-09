/**
 * Where dictated words go in the message box: at the cursor (or over the selection), with a space
 * between them and the text around when that text does not already have one. Pure, for the tests.
 *
 * The anchor is taken once, when listening starts. Each `partial` replaces the words of the last
 * one — the recognizer rewrites the whole phrase as it hears more — so the box shows
 * `before + words + after` every time, never a pile of drafts.
 */

export interface DictationAnchor {
    before: string
    after: string
}

export function dictationAnchor(text: string, selectionStart: number, selectionEnd: number): DictationAnchor {
    const start = Math.max(0, Math.min(selectionStart, text.length))
    const end = Math.max(start, Math.min(selectionEnd, text.length))
    return { before: text.slice(0, start), after: text.slice(end) }
}

/** The box with the words in place, and where the cursor goes (right after the words). */
export function placeDictation(anchor: DictationAnchor, words: string): { text: string; caret: number } {
    const spoken = words.trim()
    if (!spoken) return { text: anchor.before + anchor.after, caret: anchor.before.length }
    const lead = anchor.before && !/\s$/.test(anchor.before) ? ' ' : ''
    const trail = anchor.after && !/^\s/.test(anchor.after) ? ' ' : ''
    const head = anchor.before + lead + spoken
    return { text: head + trail + anchor.after, caret: head.length }
}
