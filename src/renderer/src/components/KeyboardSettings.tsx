import React, { useState, useEffect, useCallback } from 'react'
import {
    UserSettings,
    KeyBinding,
    KeyboardShortcutMap,
    ShortcutAction,
    ShortcutGroup,
    DEFAULT_SHORTCUTS,
    SHORTCUT_LABELS,
    SHORTCUT_GROUP_NAMES,
} from '../../../shared/types'
import { RotateCcw } from 'lucide-react'
import { isMac, hasPrimaryModifier, hasTerminalOnlyModifier } from '../utils/platform'

interface KeyboardSettingsProps {
    settings: UserSettings
    setSettings: React.Dispatch<React.SetStateAction<UserSettings>>
}


function formatModifier(mod: string): string {
    if (mod === 'mod') return isMac ? '⌘' : 'Ctrl'
    if (mod === 'shift') return isMac ? '⇧' : 'Shift'
    if (mod === 'alt') return isMac ? '⌥' : 'Alt'
    return mod
}

function formatBinding(binding: KeyBinding): string {
    const mods = binding.modifiers.map(formatModifier)
    const key = binding.key === '`' ? '`' : binding.key
    if (isMac) {
        return [...mods, key].join('')
    }
    return [...mods, key].join('+')
}

function bindingsEqual(a: KeyBinding, b: KeyBinding): boolean {
    if (a.code.toLowerCase() !== b.code.toLowerCase()) return false
    if (a.modifiers.length !== b.modifiers.length) return false
    const sortedA = [...a.modifiers].sort()
    const sortedB = [...b.modifiers].sort()
    return sortedA.every((m, i) => m === sortedB[i])
}

function getShortcuts(settings: UserSettings): KeyboardShortcutMap {
    return { ...DEFAULT_SHORTCUTS, ...settings.keyboard?.shortcuts }
}

const GROUP_ORDER: ShortcutGroup[] = ['navigation', 'splitView', 'search', 'ui', 'actions']

function ShortcutRow({
    action,
    binding,
    isRecording,
    conflict,
    onStartRecording,
    onCancelRecording,
}: {
    action: ShortcutAction
    binding: KeyBinding
    isRecording: boolean
    conflict: string | null
    onStartRecording: () => void
    onCancelRecording: () => void
}) {
    const info = SHORTCUT_LABELS[action]

    return (
        <div className="flex items-center justify-between py-2">
            <div className="flex-1 min-w-0 mr-3">
                <p className="text-sm text-white">{info.label}</p>
                <p className="text-xs text-gray-500">{info.description}</p>
            </div>
            <button
                onClick={isRecording ? onCancelRecording : onStartRecording}
                className={`px-3 py-1.5 rounded text-xs font-mono min-w-[100px] text-center transition-colors ${
                    isRecording
                        ? 'bg-blue-600 text-white animate-pulse'
                        : 'bg-white/10 text-gray-300 hover:bg-white/15'
                }`}
            >
                {isRecording ? 'Press keys...' : formatBinding(binding)}
            </button>
            {conflict && (
                <p className="text-xs text-red-400 ml-2">{conflict}</p>
            )}
        </div>
    )
}

export function KeyboardSettings({ settings, setSettings }: KeyboardSettingsProps) {
    const [recordingAction, setRecordingAction] = useState<ShortcutAction | null>(null)
    const [conflict, setConflict] = useState<string | null>(null)

    const shortcuts = getShortcuts(settings)

    const saveShortcuts = useCallback((newShortcuts: KeyboardShortcutMap) => {
        setSettings(prev => ({
            ...prev,
            keyboard: {
                scrollShortcuts: prev.keyboard?.scrollShortcuts ?? true,
                showScrollButtons: prev.keyboard?.showScrollButtons ?? true,
                shortcuts: newShortcuts,
            }
        }))
    }, [setSettings])

    const findConflict = useCallback((binding: KeyBinding, excludeAction: ShortcutAction): string | null => {
        for (const [action, existingBinding] of Object.entries(shortcuts)) {
            if (action === excludeAction) continue
            if (bindingsEqual(binding, existingBinding)) {
                return SHORTCUT_LABELS[action as ShortcutAction].label
            }
        }
        return null
    }, [shortcuts])

    useEffect(() => {
        if (!recordingAction) return

        const handleKeyDown = (e: KeyboardEvent) => {
            e.preventDefault()
            e.stopPropagation()

            // Escape cancels recording
            if (e.key === 'Escape') {
                setRecordingAction(null)
                setConflict(null)
                return
            }

            // Ignore bare modifier presses
            if (['Meta', 'Control', 'Shift', 'Alt'].includes(e.key)) return

            // Ctrl on macOS belongs to the terminal; recording it would recreate the conflict
            if (hasTerminalOnlyModifier(e)) return

            // Require at least one modifier
            const hasMod = hasPrimaryModifier(e)
            const hasShift = e.shiftKey
            const hasAlt = e.altKey
            if (!hasMod && !hasShift && !hasAlt) return

            const modifiers: ('mod' | 'shift' | 'alt')[] = []
            if (hasMod) modifiers.push('mod')
            if (hasShift) modifiers.push('shift')
            if (hasAlt) modifiers.push('alt')

            // Determine display key
            let displayKey = e.key
            if (displayKey.length === 1) {
                displayKey = displayKey.toUpperCase()
            }

            const newBinding: KeyBinding = {
                key: displayKey,
                modifiers,
                code: e.key,
            }

            // Check for conflicts
            const conflictName = findConflict(newBinding, recordingAction)
            if (conflictName) {
                setConflict(`Already used by "${conflictName}"`)
                return
            }

            // Save the new binding
            const newShortcuts = { ...shortcuts, [recordingAction]: newBinding }
            saveShortcuts(newShortcuts)
            setRecordingAction(null)
            setConflict(null)
        }

        window.addEventListener('keydown', handleKeyDown, true)
        return () => window.removeEventListener('keydown', handleKeyDown, true)
    }, [recordingAction, shortcuts, findConflict, saveShortcuts])

    const handleResetAll = () => {
        saveShortcuts({ ...DEFAULT_SHORTCUTS })
    }

    // Group actions by category
    const groupedActions = GROUP_ORDER.map(group => ({
        group,
        label: SHORTCUT_GROUP_NAMES[group],
        actions: (Object.keys(SHORTCUT_LABELS) as ShortcutAction[]).filter(
            action => SHORTCUT_LABELS[action].group === group
        ),
    })).filter(g => g.actions.length > 0)

    return (
        <div>
            <h3 className="text-sm font-semibold text-white mb-1">Keyboard Shortcuts</h3>
            <p className="text-xs text-gray-400 mb-4">
                Configure keyboard shortcuts for terminal control
            </p>

            <div className="space-y-4">
                {/* Scroll Shortcuts Toggle */}
                <div className="p-4 bg-black/20 border border-white/10 rounded-lg">
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                            <div className="flex-1">
                                <div className="flex items-center gap-2">
                                    <p className="text-sm text-white">Scroll Shortcuts</p>
                                    <kbd className="px-1.5 py-0.5 bg-white/10 rounded text-[10px] text-gray-400">⌘↑</kbd>
                                    <kbd className="px-1.5 py-0.5 bg-white/10 rounded text-[10px] text-gray-400">⌘↓</kbd>
                                </div>
                            </div>
                        </div>
                        <button
                            onClick={() => setSettings(prev => ({
                                ...prev,
                                keyboard: {
                                    scrollShortcuts: !(prev.keyboard?.scrollShortcuts ?? true),
                                    showScrollButtons: prev.keyboard?.showScrollButtons ?? true,
                                    shortcuts: prev.keyboard?.shortcuts,
                                }
                            }))}
                            className={`relative w-11 h-6 rounded-full transition-colors ${
                                (settings.keyboard?.scrollShortcuts ?? true)
                                    ? 'bg-blue-600'
                                    : 'bg-white/20'
                            }`}
                        >
                            <div className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-transform ${
                                (settings.keyboard?.scrollShortcuts ?? true)
                                    ? 'translate-x-6'
                                    : 'translate-x-1'
                            }`} />
                        </button>
                    </div>
                </div>

                {/* Floating Scroll Buttons Toggle */}
                <div className="p-4 bg-black/20 border border-white/10 rounded-lg">
                    <div className="flex items-center justify-between">
                        <div className="flex-1">
                            <p className="text-sm text-white">Floating Scroll Buttons</p>
                        </div>
                        <button
                            onClick={() => setSettings(prev => ({
                                ...prev,
                                keyboard: {
                                    scrollShortcuts: prev.keyboard?.scrollShortcuts ?? true,
                                    showScrollButtons: !(prev.keyboard?.showScrollButtons ?? true),
                                    shortcuts: prev.keyboard?.shortcuts,
                                }
                            }))}
                            className={`relative w-11 h-6 rounded-full transition-colors ${
                                (settings.keyboard?.showScrollButtons ?? true)
                                    ? 'bg-blue-600'
                                    : 'bg-white/20'
                            }`}
                        >
                            <div className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-transform ${
                                (settings.keyboard?.showScrollButtons ?? true)
                                    ? 'translate-x-6'
                                    : 'translate-x-1'
                            }`} />
                        </button>
                    </div>
                </div>

                {/* Configurable Shortcuts */}
                <div className="mt-6 pt-4 border-t border-white/10">
                    <div className="flex items-center justify-between mb-1">
                        <h4 className="text-sm font-medium text-white">Shortcut Bindings</h4>
                        <button
                            onClick={handleResetAll}
                            className="flex items-center gap-1.5 px-2 py-1 text-xs text-gray-400 hover:text-white hover:bg-white/10 rounded transition-colors"
                        >
                            <RotateCcw size={12} />
                            Reset all
                        </button>
                    </div>
                    <p className="text-xs text-gray-500 mb-3">
                        Click a shortcut to re-assign it. All shortcuts require at least one modifier key (⌘, ⇧, ⌥).
                    </p>

                    <div className="space-y-4">
                        {groupedActions.map(({ group, label, actions }) => (
                            <div key={group} className="p-4 bg-black/20 border border-white/10 rounded-lg">
                                <p className="text-xs font-medium text-gray-400 uppercase tracking-wider mb-2">{label}</p>
                                <div className="divide-y divide-white/5">
                                    {actions.map(action => (
                                        <ShortcutRow
                                            key={action}
                                            action={action}
                                            binding={shortcuts[action]}
                                            isRecording={recordingAction === action}
                                            conflict={recordingAction === action ? conflict : null}
                                            onStartRecording={() => {
                                                setRecordingAction(action)
                                                setConflict(null)
                                            }}
                                            onCancelRecording={() => {
                                                setRecordingAction(null)
                                                setConflict(null)
                                            }}
                                        />
                                    ))}
                                </div>
                            </div>
                        ))}
                    </div>
                </div>

                {/* Footer */}
                <div className="mt-4 pt-4 border-t border-white/10">
                    <p className="text-xs text-gray-500">
                        <kbd className="px-1 py-0.5 bg-white/10 rounded text-[10px]">⌘+/-/0</kbd> Font size · <kbd className="px-1 py-0.5 bg-white/10 rounded text-[10px]">⌘↑/↓</kbd> Scroll
                    </p>
                </div>

                {/* Tip box */}
                <div className="p-3 bg-blue-500/10 border border-blue-500/20 rounded">
                    <p className="text-xs text-blue-200">
                        <strong>Tip:</strong> Click any shortcut to re-assign it. Press Escape to cancel.
                    </p>
                </div>
            </div>
        </div>
    )
}
