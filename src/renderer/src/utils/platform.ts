export const isMac = navigator.platform.toUpperCase().includes('MAC')

/**
 * Whether the platform's app-shortcut modifier is held: Cmd on macOS, Ctrl elsewhere.
 *
 * On macOS Ctrl is never ours. Ctrl+W, Ctrl+R, Ctrl+J, Ctrl+K and Ctrl+[ (Escape)
 * are terminal keys — treating Ctrl as Cmd closed tabs and opened the memo while
 * the user was editing a shell line.
 */
export function hasPrimaryModifier(e: KeyboardEvent): boolean {
    return isMac ? e.metaKey : e.ctrlKey
}

/** Ctrl on macOS — a key meant for the terminal, never an app shortcut. */
export function hasTerminalOnlyModifier(e: KeyboardEvent): boolean {
    return isMac && e.ctrlKey
}
