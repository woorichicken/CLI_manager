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

/**
 * Window x where header content may start on macOS: the main window's traffic lights (x 15, three
 * ~13px buttons ~23px apart, so they end near x 75) plus a gap. The lights are drawn over the content,
 * so the header row that sits under them — the sidebar's, or the main header's when the sidebar is
 * closed — keeps just this spot free (91fce7bf r2). 0 elsewhere: no lights to clear.
 */
export const TRAFFIC_LIGHTS_CLEAR_X = isMac ? 84 : 0
