// Key list, labels and sequences adapted from ovis src/lib/keyBar.ts and src/lib/keys.ts
// (https://github.com/devswha/ovis, 3e51902) — MIT License, Copyright (c) 2026 devswha.
// See THIRD_PARTY_NOTICES.md.

/**
 * The phone terminal's key bar: the keys a phone keyboard does not have, in ovis's
 * default order. Ctrl stays held until tapped again (or used once) and combines with
 * the next key — an arrow here, or a letter typed in the input line.
 */

export type KeyBarKey = 'Escape' | 'Tab' | 'Enter' | 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight' | 'ctrl-c'

export type KeyBarItem = { type: 'key'; key: KeyBarKey } | { type: 'modifier'; modifier: 'ctrl' }

export const KEY_BAR_ITEMS: KeyBarItem[] = [
    { type: 'key', key: 'Escape' },
    { type: 'key', key: 'Tab' },
    { type: 'modifier', modifier: 'ctrl' },
    { type: 'key', key: 'ArrowUp' },
    { type: 'key', key: 'ArrowDown' },
    { type: 'key', key: 'ArrowLeft' },
    { type: 'key', key: 'ArrowRight' },
    { type: 'key', key: 'ctrl-c' },
    { type: 'key', key: 'Enter' }
]

const CAPS: Record<KeyBarKey | 'ctrl', string> = {
    Escape: 'Esc',
    Tab: 'Tab',
    Enter: '⏎',
    ArrowUp: '↑',
    ArrowDown: '↓',
    ArrowLeft: '←',
    ArrowRight: '→',
    'ctrl-c': '^C',
    ctrl: 'Ctrl'
}

export function keyBarLabel(item: KeyBarItem): string {
    return item.type === 'modifier' ? CAPS.ctrl : CAPS[item.key]
}

/** What the terminal would send for this key; arrows follow the program's cursor-key mode. */
export function keySequence(key: KeyBarKey, applicationCursorKeys: boolean, ctrl: boolean): string {
    const arrow = { ArrowUp: 'A', ArrowDown: 'B', ArrowRight: 'C', ArrowLeft: 'D' } as const
    if (key in arrow) {
        const final = arrow[key as keyof typeof arrow]
        // xterm: Ctrl+arrow is CSI 1;5 X whatever the cursor mode
        if (ctrl) return `\x1b[1;5${final}`
        return applicationCursorKeys ? `\x1bO${final}` : `\x1b[${final}`
    }
    switch (key) {
        case 'Escape':
            return '\x1b'
        case 'Tab':
            return '\t'
        case 'Enter':
            return '\r'
        case 'ctrl-c':
            return '\x03'
    }
    return ''
}

/** Ctrl + one typed character: the control code a terminal sends (Ctrl+A = 0x01 … Ctrl+Z = 0x1a). */
export function controlCharacter(text: string): string | null {
    if (text.length !== 1) return null
    const upper = text.toUpperCase()
    const code = upper.charCodeAt(0)
    if (code >= 0x40 && code <= 0x5f) return String.fromCharCode(code - 0x40)
    if (text === ' ') return '\x00'
    if (text === '?') return '\x7f'
    return null
}
