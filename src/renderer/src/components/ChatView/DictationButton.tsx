import type { ReactElement } from 'react'
import { Loader2, Mic } from 'lucide-react'
import { useShortcutHint } from '../../utils/shortcutHints'
import type { DictationControls } from './useDictation'

/** The mic chip beside ＋ in the box's lower row. Not drawn where dictation is unavailable. */
export function DictationButton({ controls }: { controls: DictationControls }): ReactElement | null {
    const hint = useShortcutHint()
    if (!controls.available) return null
    const listening = controls.state === 'listening'
    const busy = controls.state === 'starting' || controls.state === 'finishing'
    const label = listening ? 'Stop dictation' : busy ? (controls.state === 'starting' ? 'Starting dictation…' : 'Finishing…') : 'Dictate'
    return (
        <button
            type="button"
            className={`chat-meta-chip is-icon chat-dictation${listening ? ' is-listening' : ''}`}
            data-testid="chat-dictation"
            data-state={controls.state}
            aria-pressed={controls.active}
            aria-label={label}
            title={hint(listening ? 'Stop dictation — the words stay (Esc discards them)' : 'Dictate — speech becomes text here, you send it', 'toggleDictation')}
            disabled={busy}
            // keep the box's selection: listening starts where the cursor is
            onPointerDown={(event) => event.preventDefault()}
            onClick={controls.toggle}
        >
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Mic size={13} />}
            {listening && <span className="chat-dictation-label">Listening…</span>}
        </button>
    )
}
