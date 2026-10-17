import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { MENU_Z_INDEX } from '../../constants/styles'
import {
    FEEDBACK_TOGGLE_EVENT, isCorrectPassword, isDevFeedbackHost, isFeedbackConfigured,
    readUnlocked, writeUnlocked
} from '../../utils/feedbackGate'

// Imported only after the gate opens: a locked app never downloads the widget chunk.
const FeedbackWidget = lazy(() => import('./FeedbackWidget'))

/**
 * Mounts the feedback widget when this build and machine may show it (see utils/feedbackGate).
 * Settings > Feedback dispatches FEEDBACK_TOGGLE_EVENT; this component owns the password prompt.
 */
export function FeedbackGate() {
    const devHost = isDevFeedbackHost(window.location.hostname)
    const [unlocked, setUnlocked] = useState(() => readUnlocked())
    const [promptOpen, setPromptOpen] = useState(false)
    const [error, setError] = useState('')
    const inputRef = useRef<HTMLInputElement>(null)

    useEffect(() => {
        if (devHost) return
        const onToggle = () => {
            if (readUnlocked()) {
                writeUnlocked(false)
                setUnlocked(false)
            } else {
                setError('')
                setPromptOpen(true)
            }
        }
        document.addEventListener(FEEDBACK_TOGGLE_EVENT, onToggle)
        return () => document.removeEventListener(FEEDBACK_TOGGLE_EVENT, onToggle)
    }, [devHost])

    useEffect(() => {
        if (promptOpen) inputRef.current?.focus()
    }, [promptOpen])

    if (!isFeedbackConfigured()) return null

    const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
        e.preventDefault()
        if (await isCorrectPassword(inputRef.current?.value ?? '')) {
            writeUnlocked(true)
            setUnlocked(true)
            setPromptOpen(false)
        } else {
            setError('Wrong password.')
            inputRef.current?.select()
        }
    }

    return (
        <>
            {(devHost || unlocked) && (
                <Suspense fallback={null}>
                    <FeedbackWidget />
                </Suspense>
            )}
            {promptOpen && createPortal(
                <div
                    className={`fixed inset-0 z-[${MENU_Z_INDEX}] flex items-center justify-center bg-black/50 backdrop-blur-sm`}
                    onClick={e => e.target === e.currentTarget && setPromptOpen(false)}
                >
                    <form
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="feedback-gate-title"
                        className="bg-[#1e1e20] border border-white/10 rounded-lg p-4 w-96 shadow-2xl"
                        onSubmit={handleSubmit}
                        onKeyDown={e => e.key === 'Escape' && setPromptOpen(false)}
                    >
                        <h3 id="feedback-gate-title" className="text-sm font-medium text-white mb-1">Feedback mode</h3>
                        <p className="text-xs text-gray-400 mb-3">
                            Enter the password to show the feedback button on this Mac.
                        </p>
                        <input
                            ref={inputRef}
                            type="password"
                            autoComplete="current-password"
                            placeholder="Password"
                            aria-invalid={Boolean(error)}
                            data-feedback-password
                            className={`w-full bg-black/30 border rounded px-2 py-1.5 text-sm text-white focus:outline-none ${error ? 'border-red-500' : 'border-white/10 focus:border-blue-500'}`}
                        />
                        {error && <p role="alert" className="text-xs text-red-400 mt-2">{error}</p>}
                        <div className="flex justify-end gap-2 mt-4">
                            <button
                                type="button"
                                onClick={() => setPromptOpen(false)}
                                className="px-3 py-1 text-xs text-gray-400 hover:text-white"
                            >
                                Cancel
                            </button>
                            <button
                                type="submit"
                                data-testid="feedback-gate-submit"
                                className="px-3 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-500"
                            >
                                Unlock
                            </button>
                        </div>
                    </form>
                </div>,
                document.body
            )}
        </>
    )
}
