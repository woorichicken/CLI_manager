// Key list, labels and sequences adapted from ovis src/lib/keyBar.ts and src/lib/keys.ts, hold-repeat
// from src/lib/keyRepeat.ts (https://github.com/devswha/ovis, 3e51902) — MIT License, Copyright (c) 2026 devswha.
// See THIRD_PARTY_NOTICES.md.

/**
 * The phone terminal's key bar: the keys a phone keyboard does not have, in ovis's
 * default order. Ctrl stays held until tapped again (or used once) and combines with
 * the next key — an arrow here, or a letter typed in the input line.
 */

export type KeyBarKey = 'Escape' | 'Tab' | 'BackTab' | 'Enter' | 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight' | 'ctrl-c'

export type KeyBarItem = { type: 'key'; key: KeyBarKey } | { type: 'modifier'; modifier: 'ctrl' }

export const KEY_BAR_ITEMS: KeyBarItem[] = [
    { type: 'key', key: 'Escape' },
    { type: 'key', key: 'Tab' },
    // Shift+Tab: Claude Code cycles its modes with it («shift+tab to cycle») — ovis reaches it with a held Shift
    { type: 'key', key: 'BackTab' },
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
    BackTab: '⇧Tab',
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
        case 'BackTab':
            return '\x1b[Z'
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

// ---- hold to repeat (ovis keyRepeat.ts; checked there by scripts/key-bar-hold-repeat-regression.ts) ----

export const KEY_REPEAT_DELAY_MS = 400
export const KEY_REPEAT_INTERVAL_MS = 50
/** a finger that moves this far before repeating starts was scrolling the bar, not holding a key */
export const KEY_REPEAT_MOVE_SLOP_PX = 10

/**
 * Keys that move, which a held hardware key repeats too — walking a long Claude menu or a
 * shell history. Esc, Tab, Enter and ^C stay single: repeated, they act many times on what
 * one press meant.
 */
export function isRepeatable(item: KeyBarItem): boolean {
    return item.type === 'key' && (item.key === 'ArrowUp' || item.key === 'ArrowDown' || item.key === 'ArrowLeft' || item.key === 'ArrowRight')
}

export interface KeyRepeatClock {
    setTimeout: (callback: () => void, delay: number) => unknown
    clearTimeout: (timer: unknown) => void
}

export interface KeyRepeat {
    press(x: number, y: number): void
    /** true when moving cancelled a hold that had not started repeating */
    move(x: number, y: number): boolean
    release(): void
    cancel(): void
    /** the click after a hold that repeated is not one more key — false once for it */
    takeClick(): boolean
}

const realClock: KeyRepeatClock = {
    setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
    clearTimeout: (timer) => globalThis.clearTimeout(timer as number)
}

/** A hold sends only from timers; a tap stays on the ordinary click. */
export function createKeyRepeat(send: () => void, clock: KeyRepeatClock = realClock): KeyRepeat {
    let timer: unknown = null
    let generation = 0
    let active = false
    let repeating = false
    let suppressClick = false
    let startX = 0
    let startY = 0
    const stop = (): void => {
        generation++
        active = false
        repeating = false
        if (timer !== null) clock.clearTimeout(timer)
        timer = null
    }
    return {
        press(x, y) {
            stop()
            suppressClick = false
            active = true
            startX = x
            startY = y
            const pressed = generation
            const repeat = (): void => {
                if (!active || generation !== pressed) return
                timer = null
                repeating = true
                send()
                if (active && generation === pressed) timer = clock.setTimeout(repeat, KEY_REPEAT_INTERVAL_MS)
            }
            timer = clock.setTimeout(repeat, KEY_REPEAT_DELAY_MS)
        },
        move(x, y) {
            if (!active || repeating) return false
            const dx = x - startX
            const dy = y - startY
            if (dx * dx + dy * dy <= KEY_REPEAT_MOVE_SLOP_PX * KEY_REPEAT_MOVE_SLOP_PX) return false
            stop()
            return true
        },
        release() {
            if (repeating) suppressClick = true
            stop()
        },
        cancel() {
            stop()
            suppressClick = false
        },
        takeClick() {
            const allowed = !suppressClick
            suppressClick = false
            return allowed
        }
    }
}
