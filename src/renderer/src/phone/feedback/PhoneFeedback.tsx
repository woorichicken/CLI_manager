import { lazy, Suspense, useRef } from 'react'
import type { PhoneMe } from '../../../../shared/phone'
import { phoneFeedbackAvailable } from '../feedbackGate'

// Imported only when the Mac says feedback mode is on: a locked Mac's phone never downloads the widget.
const PhoneFeedbackWidget = lazy(() => import('./PhoneFeedbackWidget'))

/** What a report says about the screen it came from, read when the report is built. */
export interface PhoneFeedbackView {
    me: PhoneMe | null
    sessionId: string | null
    lens: 'chat' | 'terminal' | null
}

/** The build carries the ingest URL and key (inlined, like the desktop's). */
export function phoneFeedbackConfigured(): boolean {
    return Boolean(import.meta.env.VITE_DP_FEEDBACK_URL && import.meta.env.VITE_DP_FEEDBACK_KEY)
}

/**
 * Mounts the widget when /me says this Mac shows it. Its own floating button is hidden (phone.css):
 * bottom-right is where the Chat send button and the key bar are. The «Feedback» item in the
 * session list's header opens it (openPhoneFeedback).
 */
export function PhoneFeedback({ me, sessionId, lens }: PhoneFeedbackView) {
    const viewRef = useRef<PhoneFeedbackView>({ me, sessionId, lens })
    viewRef.current = { me, sessionId, lens }
    if (!phoneFeedbackAvailable(me, phoneFeedbackConfigured())) return null
    return (
        <Suspense fallback={null}>
            <PhoneFeedbackWidget viewRef={viewRef} />
        </Suspense>
    )
}

/** The kit's floating button, hidden but still the one way into its report. */
const KIT_BUTTON_ID = 'feedback-kit-floating-button'
const OPEN_WAIT_MS = 3000

/**
 * Opens the report the way the kit's own button does (it captures the screen with its UI hidden).
 * Waits a frame first so a closing drawer is not in the screenshot, and for the lazy chunk on a first tap.
 */
export async function openPhoneFeedback(): Promise<boolean> {
    const end = Date.now() + OPEN_WAIT_MS
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    for (;;) {
        const button = document.getElementById(KIT_BUTTON_ID)
        if (button) {
            button.click()
            return true
        }
        if (Date.now() > end) return false
        await new Promise((resolve) => setTimeout(resolve, 50))
    }
}
