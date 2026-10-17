import { useEffect, useState } from 'react'
import {
    FEEDBACK_CHANGED_EVENT, FEEDBACK_TOGGLE_EVENT, isDevFeedbackHost, isFeedbackConfigured, readUnlocked
} from '../../utils/feedbackGate'

/** Settings > Feedback row that turns the feedback widget on or off for this machine. */
export function FeedbackModeSetting() {
    const devHost = isDevFeedbackHost(window.location.hostname)
    const configured = isFeedbackConfigured()
    const [unlocked, setUnlocked] = useState(() => readUnlocked())

    useEffect(() => {
        const onChanged = () => setUnlocked(readUnlocked())
        document.addEventListener(FEEDBACK_CHANGED_EVENT, onChanged)
        return () => document.removeEventListener(FEEDBACK_CHANGED_EVENT, onChanged)
    }, [])

    // Said out loud: a build without the values otherwise looks exactly like a locked one.
    const status = !configured
        ? 'Not available in this build'
        : devHost
            ? 'Always on in development builds'
            : unlocked
                ? 'On — the feedback button is shown on this Mac'
                : 'Off — requires a password'

    return (
        <div className="flex items-center justify-between mt-4">
            <div>
                <p className="text-sm text-gray-300">Feedback Mode</p>
                <p className="text-xs text-gray-500 mt-1" data-testid="feedback-mode-status">{status}</p>
            </div>
            {configured && !devHost && (
                <button
                    data-testid="feedback-mode-toggle"
                    onClick={() => document.dispatchEvent(new CustomEvent(FEEDBACK_TOGGLE_EVENT))}
                    className="px-3 py-1.5 text-xs text-gray-300 hover:text-white bg-white/5 hover:bg-white/10 border border-white/10 rounded transition-colors"
                >
                    {unlocked ? 'Turn Off' : 'Turn On…'}
                </button>
            )}
        </div>
    )
}
