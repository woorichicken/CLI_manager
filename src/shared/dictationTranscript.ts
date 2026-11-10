/**
 * Dictation's running text across pauses (BRIEF-add1, 11-09: 「보이스에 약간이라도 공백이 있으면 내용이 사라진다」).
 *
 * Apple's on-device recognizer sends each result as the whole phrase so far — until the speaker
 * pauses. Then the next result holds only the new words and starts over. Taking each result as
 * "the text" (as the helper did) wiped everything said before the pause.
 *
 * The rule: a result that does not continue the current one starts a new segment, and the current
 * one is kept (committed). The text is the committed segments and the current one, joined by spaces.
 *
 * A result continues the current one when it extends it (`hello` → `hello world`), or when it is a
 * revision: a prefix of it (`hello world` → `hello`), longer than it, or beginning with the same word
 * (`hello world` → `hello word`). Only a shorter result with another first word is a pause
 * (`hello world` → `next`). An utterance end the recognizer reports itself (macOS 14+ result metadata)
 * makes anything that does not extend it a new segment.
 *
 * The helper does this itself (native/dictation/Transcript.swift — keep the two the same, the T106
 * cases file checks both); main runs it again over the helper's lines (Dictation.ts), which changes
 * nothing for text that already accumulates and keeps the words from an older helper.
 */

export interface DictationTranscript {
    /** segments that ended (a pause), oldest first */
    committed: string[]
    /** the recognizer's current result */
    segment: string
    /** the recognizer said the current utterance ended */
    sealed: boolean
}

export function emptyDictationTranscript(): DictationTranscript {
    return { committed: [], segment: '', sealed: false }
}

/** The first word without punctuation or case, to tell a revision from new words. */
function firstWord(text: string): string {
    const word = text.trim().split(/\s+/)[0] ?? ''
    return word.replace(/[\p{P}\p{S}]/gu, '').toLowerCase()
}

function startsNewSegment(current: string, next: string, sealed: boolean): boolean {
    if (!current.trim()) return false
    if (next.startsWith(current)) return false
    if (sealed) return true
    if (current.startsWith(next) || next.length >= current.length) return false
    return firstWord(next) !== firstWord(current)
}

/** One recognizer result (partial or final). `utteranceEnd`: the recognizer marked this result as an utterance's end. */
export function addDictationResult(state: DictationTranscript, text: string, utteranceEnd = false): DictationTranscript {
    // an empty result says nothing new; it must not wipe what was heard
    if (!text.trim()) return utteranceEnd ? { ...state, sealed: true } : state
    if (startsNewSegment(state.segment, text, state.sealed)) {
        return { committed: [...state.committed, state.segment.trim()], segment: text, sealed: utteranceEnd }
    }
    return { committed: state.committed, segment: text, sealed: utteranceEnd }
}

export function dictationTranscriptText(state: DictationTranscript): string {
    return [...state.committed, state.segment.trim()].filter(Boolean).join(' ')
}
