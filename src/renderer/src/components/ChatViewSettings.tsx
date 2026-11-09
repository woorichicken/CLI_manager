import { useEffect, useState } from 'react'
import type { UserSettings } from '../../../shared/types'
import { DEFAULT_QUICK_REPLIES } from '../../../shared/conversation'
import { DictationLogSettings } from './DictationLogSettings'

/**
 * Settings › Terminal › Chat view: how the chat's message box sends, and one-tap replies over the
 * empty box (ovis Settings → Chat → Composer). Kept with the app's settings, not per device.
 */
export function ChatViewSettings({ settings, setSettings }: { settings: UserSettings; setSettings: React.Dispatch<React.SetStateAction<UserSettings>> }) {
    const chat = settings.chat ?? {}
    const enterSends = chat.enterSends !== false
    const showQuick = chat.showQuickReplies === true
    const pinLast = chat.pinLastMessage === true
    const openInApp = chat.openFilesInApp !== false
    const replies = chat.quickReplies ?? DEFAULT_QUICK_REPLIES
    const [repliesText, setRepliesText] = useState(replies.join('\n'))
    useEffect(() => setRepliesText((chat.quickReplies ?? DEFAULT_QUICK_REPLIES).join('\n')), [chat.quickReplies])

    const update = (patch: Partial<NonNullable<UserSettings['chat']>>): void => setSettings((prev) => ({ ...prev, chat: { ...prev.chat, ...patch } }))

    const toggle = (on: boolean, onClick: () => void, testId: string, disabled = false) => (
        <button
            type="button"
            data-testid={testId}
            aria-pressed={on}
            disabled={disabled}
            onClick={onClick}
            className={`relative w-11 h-6 rounded-full transition-colors shrink-0 ${on ? 'bg-blue-600' : 'bg-gray-600'} ${disabled ? 'opacity-40 cursor-not-allowed' : ''}`}
        >
            <div className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-transform ${on ? 'translate-x-6' : 'translate-x-1'}`} />
        </button>
    )

    return (
        <div className="mt-6 pt-6 border-t border-white/10" data-testid="chat-view-settings">
            <h3 className="text-sm font-semibold text-white mb-1">Chat view</h3>
            <p className="text-xs text-gray-400 mb-3">The Terminal / Chat switch in a Claude Code or Codex session&apos;s header.</p>
            <div className="space-y-3">
                <div className="p-4 bg-black/20 border border-white/10 rounded-lg flex items-center justify-between gap-3">
                    <div>
                        <p className="text-sm text-white">Enter sends</p>
                        <p className="text-xs text-gray-400 mt-0.5">On: Enter sends, Shift+Enter starts a new line. Off: Enter starts a new line and ⌘Enter sends.</p>
                    </div>
                    {toggle(enterSends, () => update({ enterSends: !enterSends }), 'chat-setting-enter-sends')}
                </div>
                <div className="p-4 bg-black/20 border border-white/10 rounded-lg flex items-center justify-between gap-3">
                    <div>
                        <p className="text-sm text-white">Keep my last message on top</p>
                        <p className="text-xs text-gray-400 mt-0.5">Once it has scrolled out of view, your last message stays over the chat. Click it to go back there. A phone follows this until you set it on the phone.</p>
                    </div>
                    {toggle(pinLast, () => update({ pinLastMessage: !pinLast }), 'chat-setting-pin-last')}
                </div>
                <div className="p-4 bg-black/20 border border-white/10 rounded-lg flex items-center justify-between gap-3">
                    <div>
                        <p className="text-sm text-white">Open files in the app</p>
                        <p className="text-xs text-gray-400 mt-0.5">On: a file path in the chat opens in the app&apos;s preview. Off: it opens in the Mac&apos;s default app for that file.</p>
                    </div>
                    {toggle(openInApp, () => update({ openFilesInApp: !openInApp }), 'chat-setting-open-in-app')}
                </div>
                <div className="p-4 bg-black/20 border border-white/10 rounded-lg space-y-3">
                    <div className="flex items-center justify-between gap-3">
                        <div>
                            <p className="text-sm text-white">Quick replies</p>
                            <p className="text-xs text-gray-400 mt-0.5">One-tap replies over the empty message box. Each sends at once; while the agent works, it waits for the turn to end.</p>
                        </div>
                        {toggle(showQuick, () => update({ showQuickReplies: !showQuick }), 'chat-setting-quick-replies')}
                    </div>
                    {showQuick && (
                        <div>
                            <label className="block text-xs text-gray-400 mb-1">Replies, one per line</label>
                            <textarea
                                value={repliesText}
                                rows={4}
                                data-testid="chat-setting-quick-list"
                                onChange={(event) => setRepliesText(event.target.value)}
                                onBlur={() =>
                                    update({
                                        quickReplies: repliesText
                                            .split('\n')
                                            .map((line) => line.trim())
                                            .filter(Boolean)
                                            .slice(0, 8)
                                    })
                                }
                                className="w-full bg-black/30 border border-white/10 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
                            />
                        </div>
                    )}
                </div>
                <DictationLogSettings
                    logOn={chat.dictationLog === true}
                    audioOn={chat.dictationLog === true && chat.dictationLogAudio === true}
                    update={update}
                    toggle={toggle}
                />
            </div>
        </div>
    )
}
