/**
 * Chat dictation — speech to text into the Chat view's message box (macOS, on the device).
 * main runs the helper (`src/main/Dictation.ts`), the renderer shows the mic button
 * (`components/ChatView/useDictation.ts`). Nothing is ever sent by dictation: the words land
 * in the box and the person sends them, as with typing.
 */

/** Why the mic button is hidden (`available: false`), or `null` when it is shown. */
export type DictationUnavailableReason =
    | 'not_mac' // Windows / Linux
    | 'no_helper' // the helper is not built (`pnpm build:dictation`) or not packaged
    | 'unsupported' // this Mac cannot recognize its language on the device
    | 'helper_failed' // the helper did not answer

export interface DictationStatus {
    available: boolean
    reason: DictationUnavailableReason | null
    /** the language it listens for, e.g. "ko_KR" */
    locale: string
    /** macOS's answers so far — `notDetermined` means the first use will ask */
    speech: 'authorized' | 'denied' | 'restricted' | 'notDetermined' | 'unknown'
    mic: 'authorized' | 'denied' | 'restricted' | 'notDetermined' | 'unknown'
}

/** Why a listening run ended without words. */
export type DictationErrorCode =
    | 'speech_denied'
    | 'mic_denied'
    | 'no_microphone'
    | 'audio_failed'
    | 'recognition_failed'
    | 'unsupported'
    /** macOS killed the helper when it asked: the app lacks a usage description (a dev build run from a terminal) */
    | 'permission_setup'
    | 'busy' // another window is already listening
    | 'helper_failed'

export type DictationEvent =
    | { id: number; type: 'listening' }
    | { id: number; type: 'partial'; text: string }
    | { id: number; type: 'final'; text: string }
    | { id: number; type: 'error'; code: DictationErrorCode; message: string }
    /** the run is over (after `final` or `error`) */
    | { id: number; type: 'ended' }

export type DictationStartResult = { status: 'started'; id: number } | { status: 'rejected'; code: DictationErrorCode; message: string }

/** Which agent the words were for — the dictation log keeps it (`src/main/DictationLog.ts`). */
export type DictationAgent = 'claude' | 'codex'

export interface DictationStartContext {
    agent?: DictationAgent
}

/**
 * Why a run is cancelled: the person pressed Esc (`cancelled`), or the box it typed into went away —
 * another session, a closed view (`discarded`). Only the dictation log tells them apart.
 */
export type DictationCancelReason = 'cancelled' | 'discarded'

/**
 * What became of a run's words, as the Chat view saw it — the dictation log's `sentText`.
 *  - `sent`: the message box was sent; `text` is the whole box as sent (edits included)
 *  - `edited-away`: the box was emptied without sending
 */
export type DictationOutcome = { type: 'sent'; text: string } | { type: 'edited-away' }

/** What a Chat view needs; absent on a transport that has no dictation (the phone uses its keyboard's mic). */
export interface ChatDictation {
    status(): Promise<DictationStatus>
    start(context?: DictationStartContext): Promise<DictationStartResult>
    /** ends listening; the last words still arrive as `final` */
    stop(id: number): Promise<void>
    /** ends listening and drops what was not final yet */
    cancel(id: number, reason?: DictationCancelReason): Promise<void>
    /** what became of a finished run's words — only the dictation log reads it (Settings › Chat view) */
    report?(id: number, outcome: DictationOutcome): Promise<void>
    onEvent(listener: (event: DictationEvent) => void): () => void
}

/** Settings › Chat view › Keep dictation log: where and how long (people's decision 11-09, decision 0012). */
export const DICTATION_LOG_TEXT_DAYS = 30
export const DICTATION_LOG_AUDIO_DAYS = 7

/** One run is cut after this long by the helper; main kills it a little later if it did not stop. */
export const DICTATION_MAX_SECONDS = 300
