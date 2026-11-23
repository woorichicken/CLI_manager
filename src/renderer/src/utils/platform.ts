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
 * Top margin of the two panels (sidebar card, main card). On macOS the window's traffic lights
 * (trafficLightPosition {15, 10} in main) sit over the content; the panels start below them so the
 * lights get a strip of their own instead of covering the sidebar title (report 91fce7bf). The
 * header row has no width to spare for them at the default sidebar width, so the strip takes height.
 */
export const PANEL_TOP_MARGIN = isMac ? 'mt-8' : 'mt-2'
