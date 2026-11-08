import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChatDictation, DictationEvent } from '../../../../shared/dictation'
import { dictationAnchor, placeDictation, type DictationAnchor } from './dictationText'

/**
 * The Chat view's mic: speech to text into the message box (Orca-style dictation — it types, the
 * person sends). Only where the transport has `dictation` and main says this Mac can do it on the
 * device; anywhere else `available` is false and the button is not drawn.
 *
 * While listening the box is read-only: the words replace themselves as the recognizer hears more,
 * and a keystroke in between would land in the middle of them.
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
}

interface Options {
    dictation: ChatDictation | undefined
    sessionId: string
    /** the box's text and selection when listening starts */
    readBox(): { text: string; start: number; end: number }
    /** puts the box's text and moves the cursor */
    write(text: string, caret: number): void
    /** a run ended without words for a reason the person should read */
    onError(message: string): void
}

export function useDictation({ dictation, sessionId, readBox, write, onError }: Options): DictationControls {
    const [available, setAvailable] = useState(false)
    const [state, setState] = useState<DictationState>('idle')
    const run = useRef<{ id: number | null; anchor: DictationAnchor } | null>(null)
    // the latest callbacks without re-subscribing on every render
    const callbacks = useRef({ write, onError })
    callbacks.current = { write, onError }

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
            if (dictation && current?.id != null) void dictation.cancel(current.id)
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
            result = await dictation.start()
        } catch (error) {
            result = { status: 'rejected' as const, code: 'helper_failed' as const, message: error instanceof Error ? error.message : String(error) }
        }
        if (run.current !== current) {
            // the session changed while main started it: end it unseen
            if (result.status === 'started') void dictation.cancel(result.id)
            return
        }
        if (result.status === 'rejected') {
            run.current = null
            setState('idle')
            callbacks.current.onError(result.message)
            return
        }
        current.id = result.id
    }, [dictation, readBox])

    const stop = useCallback((): void => {
        const current = run.current
        if (!dictation || !current || current.id === null) return
        setState('finishing')
        void dictation.stop(current.id)
    }, [dictation])

    const toggle = useCallback((): void => {
        if (state === 'idle') void start()
        else if (state === 'listening') stop()
    }, [state, start, stop])

    return { available: available && dictation !== undefined, state, active: state !== 'idle', toggle, stop }
}
