import { HEADER_BUTTONS, headerButtonShown, withHeaderButton, type UserSettings } from '../../../shared/types'

/**
 * Settings › Sidebar › Header buttons (d5efaf86): a switch for each button on the right of the main header.
 * All on by default. Settings itself has no switch — it is the way back here. A hidden button that has a
 * shortcut still works by it (Loop, Review Diff, System Monitor and Parent session have none). Source Control keeps its old test id (T36 · T158 click it).
 */
export function HeaderButtonsSetting({ settings, onChange }: { settings: UserSettings; onChange: (update: (prev: UserSettings) => UserSettings) => void }) {
    return (
        <div data-testid="settings-header-buttons">
            <p className="text-sm text-gray-300">Header buttons</p>
            <p className="text-xs text-gray-500 mt-1 mb-3">
                The buttons on the right of the header. Off only hides a button: one with a shortcut (Related ⌘⇧L, Checklists ⌘⇧J, Search Files, Terminal / Chat ⌘⇧M) still opens with it. Settings always stays.
            </p>
            <div className="space-y-2">
                {HEADER_BUTTONS.map((button) => {
                    const shown = headerButtonShown(settings, button.id)
                    return (
                        <div key={button.id} className="flex items-center justify-between">
                            <span className="text-sm text-gray-300">
                                {button.label}
                                {button.id === 'sourceControl' && <span className="text-xs text-gray-500"> — also the split panes' Git button</span>}
                            </span>
                            <button
                                type="button"
                                role="switch"
                                aria-checked={shown}
                                aria-pressed={shown}
                                aria-label={`Show ${button.label}`}
                                data-testid={button.id === 'sourceControl' ? 'settings-show-source-control' : 'settings-header-button'}
                                data-header-button={button.id}
                                onClick={() => onChange((prev) => withHeaderButton(prev, button.id, !headerButtonShown(prev, button.id)))}
                                className={`relative w-11 h-6 rounded-full transition-colors shrink-0 ml-4 ${shown ? 'bg-emerald-600' : 'bg-white/20'}`}
                            >
                                <div className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-transform ${shown ? 'translate-x-6' : 'translate-x-1'}`} />
                            </button>
                        </div>
                    )
                })}
            </div>
        </div>
    )
}
