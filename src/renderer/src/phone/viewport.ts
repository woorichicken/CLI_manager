// Adapted from ovis src/lib/viewport.ts (https://github.com/devswha/ovis, 3e51902)
// — MIT License, Copyright (c) 2026 devswha. See THIRD_PARTY_NOTICES.md.

/*
 * Sizes the page to the VISUAL viewport while the soft keyboard is up. iOS Safari
 * shrinks window.visualViewport when the keyboard opens but leaves the layout viewport
 * (and 100dvh) at full height, then scrolls the page to show the focused field — which
 * pushes the header off the top and the key bar under the keyboard. Publishing the
 * visual height as --app-height (read by .phone-app in phone.css) and pinning the page at
 * (0, 0) keeps the header, the terminal or chat, and the input in view. Chrome resizes the
 * layout viewport itself (interactive-widget=resizes-content in phone.html), so there the
 * same value changes nothing.
 *
 * ovis's version also measures the standalone status-bar gap, a remembered unobstructed
 * height per width and a virtual-keyboard API; this keeps the core rule only: a touch
 * device, a focused text field, and a visual viewport at least 20% shorter than the window.
 */

const KEYBOARD_SHARE = 0.2

function isTypingField(element: Element | null): boolean {
    if (!element) return false
    if (element instanceof HTMLTextAreaElement) return true
    if (element instanceof HTMLInputElement) return !['button', 'checkbox', 'radio', 'submit', 'file'].includes(element.type)
    return (element as HTMLElement).isContentEditable === true
}

export function installViewportFix(): void {
    const viewport = window.visualViewport
    const root = document.documentElement
    const touch = window.matchMedia('(pointer: coarse)')
    const sync = (): void => {
        const height = viewport?.height ?? window.innerHeight
        const keyboard = touch.matches && isTypingField(document.activeElement) && window.innerHeight - height > window.innerHeight * KEYBOARD_SHARE
        root.toggleAttribute('data-keyboard', keyboard)
        if (keyboard) root.style.setProperty('--app-height', `${Math.round(height)}px`)
        else root.style.removeProperty('--app-height')
        if (keyboard) window.scrollTo(0, 0)
    }
    viewport?.addEventListener('resize', sync)
    viewport?.addEventListener('scroll', sync)
    window.addEventListener('resize', sync)
    window.addEventListener('orientationchange', sync)
    document.addEventListener('focusin', sync)
    // focus moving from one field to the next blurs first: read where it landed
    document.addEventListener('focusout', () => window.setTimeout(sync, 0))
    sync()
}
