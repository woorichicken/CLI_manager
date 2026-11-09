import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { ChatPreferences } from '../../../shared/conversation'
import { DICTATION_LOG_AUDIO_DAYS, DICTATION_LOG_TEXT_DAYS } from '../../../shared/dictation'

/** How long "Delete all" waits for the second click before it forgets the first. */
const CONFIRM_MS = 4000

interface Props {
    logOn: boolean
    audioOn: boolean
    update(patch: Partial<ChatPreferences>): void
    toggle(on: boolean, onClick: () => void, testId: string, disabled?: boolean): ReactNode
}

/**
 * Settings › Terminal › Chat view › Keep dictation log (decision 0012, default off): what dictation heard
 * next to what was sent, on this Mac only, to make dictation better later. The folder and Delete all act
 * at once — they do not wait for Save. Main: src/main/DictationLog.ts.
 */
export function DictationLogSettings({ logOn, audioOn, update, toggle }: Props) {
    const [confirming, setConfirming] = useState(false)
    const [note, setNote] = useState<string | null>(null)
    const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
    useEffect(() => () => {
        if (confirmTimer.current) clearTimeout(confirmTimer.current)
    }, [])

    const openFolder = async (): Promise<void> => {
        const result = await window.api.openDictationLogFolder()
        setNote(result === 'opened' ? null : result === 'missing' ? 'Nothing kept yet.' : `Could not open the folder: ${result}`)
    }

    const deleteAll = async (): Promise<void> => {
        if (!confirming) {
            setConfirming(true)
            setNote(null)
            confirmTimer.current = setTimeout(() => setConfirming(false), CONFIRM_MS)
            return
        }
        if (confirmTimer.current) clearTimeout(confirmTimer.current)
        setConfirming(false)
        await window.api.deleteDictationLog()
        setNote('Deleted the dictation log.')
    }

    return (
        <div className="p-4 bg-black/20 border border-white/10 rounded-lg space-y-3" data-testid="chat-dictation-log-settings">
            <div className="flex items-center justify-between gap-3">
                <div>
                    <p className="text-sm text-white">Keep dictation log</p>
                    <p className="text-xs text-gray-400 mt-0.5">
                        Keeps what dictation heard next to the message you sent, to make dictation better later. On this Mac only — never in a
                        feedback report, on a phone or through the Control API. Kept {DICTATION_LOG_TEXT_DAYS} days.
                    </p>
                </div>
                {/* turning the log off turns the sound off too: on again starts without it */}
                {toggle(logOn, () => update(logOn ? { dictationLog: false, dictationLogAudio: false } : { dictationLog: true }), 'chat-setting-dictation-log')}
            </div>
            <div className={`flex items-center justify-between gap-3 ${logOn ? '' : 'opacity-60'}`}>
                <div>
                    <p className="text-sm text-white">Also keep audio</p>
                    <p className="text-xs text-gray-400 mt-0.5">The sound of each dictation as a WAV file. Kept {DICTATION_LOG_AUDIO_DAYS} days. Needs the log on.</p>
                </div>
                {toggle(audioOn, () => update({ dictationLogAudio: !audioOn }), 'chat-setting-dictation-audio', !logOn)}
            </div>
            <div className="flex items-center gap-2">
                <button
                    type="button"
                    data-testid="chat-setting-dictation-open"
                    onClick={() => void openFolder()}
                    className="px-3 py-1.5 text-xs text-white bg-white/10 hover:bg-white/15 rounded"
                >
                    Open log folder
                </button>
                <button
                    type="button"
                    data-testid="chat-setting-dictation-delete"
                    data-state={confirming ? 'confirm' : 'idle'}
                    onClick={() => void deleteAll()}
                    className={`px-3 py-1.5 text-xs rounded ${confirming ? 'text-white bg-red-600 hover:bg-red-500' : 'text-red-300 bg-white/10 hover:bg-white/15'}`}
                >
                    {confirming ? 'Click again to delete all' : 'Delete all'}
                </button>
                {note && (
                    <span className="text-xs text-gray-400" data-testid="chat-setting-dictation-note">
                        {note}
                    </span>
                )}
            </div>
        </div>
    )
}
