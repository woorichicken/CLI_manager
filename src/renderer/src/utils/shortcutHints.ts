import { useCallback, useSyncExternalStore } from 'react'
import { DEFAULT_SHORTCUTS, effectiveShortcuts, KeyBinding, KeyboardShortcutMap, SHORTCUT_LABELS, ShortcutAction } from '../../../shared/types'
import { isMac } from './platform'

// Keys a binding stores by name (`KeyboardEvent.key`), shown as their key-cap symbol.
const KEY_SYMBOLS: Record<string, string> = {
    ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓',
    Backspace: isMac ? '⌫' : 'Backspace', Delete: isMac ? '⌦' : 'Delete', Enter: isMac ? '↩' : 'Enter',
    PageUp: 'PgUp', PageDown: 'PgDn',
}

function formatModifier(mod: string): string {
    if (mod === 'mod') return isMac ? '⌘' : 'Ctrl'
    if (mod === 'shift') return isMac ? '⇧' : 'Shift'
    if (mod === 'alt') return isMac ? '⌥' : 'Alt'
    return mod
}

/** A binding as its key caps, in the order it is stored — as Settings › Keyboard shows it: ⌘⌥N on macOS, Ctrl+Alt+N elsewhere. */
export function formatBinding(binding: KeyBinding): string {
    const mods = binding.modifiers.map(formatModifier)
    const key = KEY_SYMBOLS[binding.key] ?? binding.key
    if (isMac) {
        return [...mods, key].join('')
    }
    return [...mods, key].join('+')
}

/**
 * "New page" + ⌘⌥N → "New page (⌘⌥N)", and with a description a second line saying what it does:
 * "New page (⌘⌥N)\nAdd a page to the memo (opens it if closed)" (report 78a79526). The first line is
 * always the label first, so `title^="New page"` keeps matching.
 */
export function withShortcut(label: string, binding: KeyBinding | undefined, description?: string): string {
    const first = binding?.code ? `${label} (${formatBinding(binding)})` : label
    return description ? `${first}\n${description}` : first
}

/** What an action does, in one line — the text Settings › Keyboard shows beside it. */
export function shortcutDescription(action: ShortcutAction): string {
    return SHORTCUT_LABELS[action]?.description ?? ''
}

/*
 * The bindings in effect, for tooltips (report 386b0c76: a button that has a shortcut says so
 * on hover). App feeds it Settings › Keyboard, so a remapped key never shows the old one.
 * A module store rather than props: the buttons sit in the header, the memo and the sidebar.
 */
let activeShortcuts: KeyboardShortcutMap = DEFAULT_SHORTCUTS
let activeKey = JSON.stringify(DEFAULT_SHORTCUTS)
const listeners = new Set<() => void>()

export function setActiveShortcuts(overrides: Partial<KeyboardShortcutMap> | undefined): void {
    const next = effectiveShortcuts(overrides)
    const nextKey = JSON.stringify(next)
    // Settings are replaced on every change; only a different binding should re-render the buttons.
    if (nextKey === activeKey) return
    activeShortcuts = next
    activeKey = nextKey
    listeners.forEach(listener => listener())
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
}

/**
 * `hint('Settings', 'toggleSettings')` → "Settings (⌘,)\nOpen or close settings": the keys, then the
 * action's description. `description: false` keeps one line — for a label that already says what the
 * button does (Related, Dictate) — and a string replaces the description.
 */
export function useShortcutHint(): (label: string, action: ShortcutAction, description?: string | false) => string {
    const shortcuts = useSyncExternalStore(subscribe, () => activeShortcuts)
    return useCallback(
        (label: string, action: ShortcutAction, description?: string | false) =>
            withShortcut(label, shortcuts[action], description === false ? undefined : description ?? shortcutDescription(action)),
        [shortcuts]
    )
}
