import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChatDictation, DictationAgent, DictationEvent } from '../../../../shared/dictation'
import { dictationAnchor, placeDictation, type DictationAnchor } from './dictationText'

/**
 * The Chat view's mic: speech to text into the message box (Orca-style dictation — it types, the
 * person sends). Only where the transport has `dictation` and main says this Mac can do it on the
 * device; anywhere else `available` is false and the button is not drawn.
 *
 * While listening the box is read-only: the words replace themselves as the recognizer hears more,
 * and a keystroke in between would land in the middle of them. The words show as they are heard and
 * stay unless the person presses Esc (people's decision 11-09: 「ESC 로 취소 안하면 그대로 적히게」).
 */

export type DictationState = 'idle' | 'starting' | 'listening' | 'finishing'

export interface DictationControls {
    available: boolean
    state: DictationState
    /** listening or about to — the box is read-only and Enter stops instead of sending */
    active: boolean
    /** starts, or stops when already listening (the words stay) */
    toggle(): void
    /** stops and keeps the words heard so far */
    stop(): void
    /** stops and takes this run's words back out of the box (Esc) — the text from before stays */
    cancel(): void
    /**
     * The box is about to be sent: takes the finished runs whose words are in it (for the dictation log).
     * Give them to `sent` once it went, or back to `restore` when the send was refused and the text returned.
     */
    takeForSend(): number[]
    sent(runs: number[], text: string): void
    restore(runs: number[]): void
    /** the box is empty: words dictated into it were not sent (edited-away) */
    boxEmptied(): void
}

interface Options {
    dictation: ChatDictation | undefined
    sessionId: string
    /** which agent the words are for — the dictation log keeps it */
    agent?: DictationAgent
    /** the box's text and selection when listening starts */
    readBox(): { text: string; start: number; end: number }
    /** puts the box's text and moves the cursor */
    write(text: string, caret: number): void
    /** a run ended without words for a reason the person should read */
    onError(message: string): void
}

/**
 * Finished runs whose words sit in a session's box, waiting to be sent — per session, outside the
 * component, because the box's draft outlives the view (draftStore). Only the dictation log reads
 * what becomes of them (main ignores the reports when the log is off); one that is never reported
 * counts as discarded there after half an hour.
 */
const awaitingSend = new Map<string, number[]>()

export function useDictation({ dictation, sessionId, agent, readBox, write, onError }: Options): DictationControls {
    const [available, setAvailable] = useState(false)
    const [state, setState] = useState<DictationState>('idle')
    const run = useRef<{ id: number | null; anchor: DictationAnchor } | null>(null)
    // the latest callbacks without re-subscribing on every render
    const callbacks = useRef({ write, onError, sessionId })
    callbacks.current = { write, onError, sessionId }

    useEffect(() => {
        if (!dictation) return
        let alive = true
        dictation
            .status()
            .then((status) => {
                if (alive) setAvailable(status.available)
            })
            .catch(() => undefined)
        return () => {
            alive = false
        }
    }, [dictation])

    useEffect(() => {
        if (!dictation) return
        return dictation.onEvent((event: DictationEvent) => {
            const current = run.current
            if (!current || current.id !== event.id) return
            if (event.type === 'listening') setState((now) => (now === 'starting' ? 'listening' : now))
            else if (event.type === 'partial' || event.type === 'final') {
                const placed = placeDictation(current.anchor, event.text)
                callbacks.current.write(placed.text, placed.caret)
                if (event.type === 'final' && event.text.trim()) {
                    const session = callbacks.current.sessionId
                    awaitingSend.set(session, [...(awaitingSend.get(session) ?? []), event.id])
                }
            } else if (event.type === 'error') callbacks.current.onError(event.message)
            else if (event.type === 'ended') {
                run.current = null
                setState('idle')
            }
        })
    }, [dictation])

    // Another session's box (or no box): that run's words must not land in it.
    useEffect(
        () => () => {
            const current = run.current
            run.current = null
            setState('idle')
            if (dictation && current?.id != null) void dictation.cancel(current.id, 'discarded')
        },
        [dictation, sessionId]
    )

    const start = useCallback(async (): Promise<void> => {
        if (!dictation || run.current) return
        const box = readBox()
        const current = { id: null as number | null, anchor: dictationAnchor(box.text, box.start, box.end) }
        run.current = current
        setState('starting')
        let result
        try {
            result = await dictation.start({ agent })
        } catch (error) {
            result = { status: 'rejected' as const, code: 'helper_failed' as const, message: error instanceof Error ? error.message : String(error) }
        }
        if (run.current !== current) {
            // the session changed while main started it: end it unseen
            if (result.status === 'started') void dictation.cancel(result.id, 'discarded')
            return
        }
        if (result.status === 'rejected') {
            run.current = null
            setState('idle')
            callbacks.current.onError(result.message)
            return
        }
        current.id = result.id
    }, [dictation, readBox, agent])

    const stop = useCallback((): void => {
        const current = run.current
        if (!dictation || !current || current.id === null) return
        setState('finishing')
        void dictation.stop(current.id)
    }, [dictation])

    const cancel = useCallback((): void => {
        const current = run.current
        if (!dictation || !current) return
        run.current = null
        setState('idle')
        const restored = placeDictation(current.anchor, '')
        callbacks.current.write(restored.text, restored.caret)
        // still starting (no id yet): start() sees the run is gone and ends it unseen
        if (current.id !== null) void dictation.cancel(current.id, 'cancelled')
    }, [dictation])

    const takeForSend = useCallback((): number[] => {
        const runs = awaitingSend.get(sessionId) ?? []
        awaitingSend.delete(sessionId)
        return runs
    }, [sessionId])

    const sent = useCallback(
        (runs: number[], text: string): void => {
            for (const id of runs) void dictation?.report?.(id, { type: 'sent', text })
        },
        [dictation]
    )

    const restore = useCallback(
        (runs: number[]): void => {
            if (runs.length > 0) awaitingSend.set(sessionId, [...runs, ...(awaitingSend.get(sessionId) ?? [])])
        },
        [sessionId]
    )

    const boxEmptied = useCallback((): void => {
        const runs = awaitingSend.get(sessionId)
        if (!runs) return
        awaitingSend.delete(sessionId)
        for (const id of runs) void dictation?.report?.(id, { type: 'edited-away' })
    }, [dictation, sessionId])

    const toggle = useCallback((): void => {
        if (state === 'idle') void start()
        else if (state === 'listening') stop()
    }, [state, start, stop])

    return { available: available && dictation !== undefined, state, active: state !== 'idle', toggle, stop, cancel, takeForSend, sent, restore, boxEmptied }
}
