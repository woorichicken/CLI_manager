import { useEffect, useRef, useState } from 'react'
import { Settings2 } from 'lucide-react'
import { setPhoneChatSetting, usePhoneChatSettings } from './phoneChatSettings'

/**
 * Settings for this phone only (b6b1b6b6): what the chat box does with Return (69340cc2) and the
 * one-tap phrases over it (847da0aa). The phrases themselves are the Mac's list.
 */
export function PhoneSettingsMenu({ quickReplies }: { quickReplies: string[] }) {
    const [open, setOpen] = useState(false)
    const settings = usePhoneChatSettings()
    const root = useRef<HTMLDivElement>(null)

    useEffect(() => {
        if (!open) return
        const close = (event: PointerEvent): void => {
            if (!root.current?.contains(event.target as Node)) setOpen(false)
        }
        document.addEventListener('pointerdown', close)
        return () => document.removeEventListener('pointerdown', close)
    }, [open])

    return (
        <div className="phone-alerts" ref={root}>
            <button type="button" className="phone-icon-button" aria-label="Phone settings" title="Settings for this phone" data-testid="phone-settings-button" onClick={() => setOpen((v) => !v)}>
                <Settings2 size={17} />
            </button>
            {open && (
                <div className="phone-menu" role="menu" data-testid="phone-settings-menu">
                    <div className="phone-menu-title">This phone</div>
                    <label className="phone-menu-switch">
                        <input
                            type="checkbox"
                            data-testid="phone-setting-return-sends"
                            checked={settings.returnSends}
                            onChange={(event) => setPhoneChatSetting('returnSends', event.target.checked)}
                        />
                        <span>Return sends the message</span>
                    </label>
                    <p className="phone-menu-note">Off: Return starts a new line and the arrow sends.</p>
                    <label className="phone-menu-switch">
                        <input
                            type="checkbox"
                            data-testid="phone-setting-quick-replies"
                            checked={settings.quickReplies}
                            onChange={(event) => setPhoneChatSetting('quickReplies', event.target.checked)}
                        />
                        <span>Quick replies over the chat box</span>
                    </label>
                    <p className="phone-menu-note">
                        {quickReplies.length > 0 ? quickReplies.join(' · ') : 'None set'} — edit them on the Mac: Settings › Terminal › Chat view.
                    </p>
                </div>
            )}
        </div>
    )
}
