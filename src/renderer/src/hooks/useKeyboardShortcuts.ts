import { useEffect, useCallback, useRef } from 'react'
import {
    Workspace,
    TerminalSession,
    UserSettings,
    SplitTerminalLayout,
    KeyBinding,
    KeyboardShortcutMap,
    ShortcutAction,
    DEFAULT_SHORTCUTS,
    TerminalTemplate,
} from '../../../shared/types'

interface UseKeyboardShortcutsConfig {
    settings: UserSettings
    activeWorkspace: Workspace | null
    activeSession: TerminalSession | null
    /** Every workspace, top to bottom as the sidebar draws it. */
    workspacesInSidebarOrder: Workspace[]
    splitLayout: SplitTerminalLayout | null
    activeSplitIndex: number
    settingsOpen: boolean
    fileSearchOpen: boolean
    templates: TerminalTemplate[]  // Custom templates for chord shortcuts
    onSelectSession: (workspace: Workspace, session: TerminalSession) => void
    onSetActiveSplitIndex: (index: number) => void
    onSetFileSearchOpen: (open: boolean) => void
    onSetFileSearchMode: (mode: 'files' | 'content') => void
    onToggleSidebar: () => void
    onToggleSettings: () => void
    onAddSession: (workspaceId: string, template?: TerminalTemplate) => void
    onCloseSession: (workspaceId: string, sessionId: string) => void
    onClearSession: (sessionId: string) => void
    onRenameSession: (sessionId: string) => void
    onToggleMemo: () => void
}

function getShortcuts(settings: UserSettings): KeyboardShortcutMap {
    return { ...DEFAULT_SHORTCUTS, ...settings.keyboard?.shortcuts }
}

// Unshifted character for the physical keys bindings use. `e.key` reports what
// the key types — '}' for Shift+], 'ㅅ' for T under a Korean input source — so a
// binding stored as ']' or 't' would never match those presses on its own.
const PUNCTUATION_BY_CODE: Record<string, string> = {
    BracketLeft: '[', BracketRight: ']', Backquote: '`', Comma: ',', Period: '.',
    Slash: '/', Backslash: '\\', Semicolon: ';', Quote: "'", Minus: '-', Equal: '=',
}

function keyFromCode(code: string): string | null {
    const letter = /^Key([A-Z])$/.exec(code)
    if (letter) return letter[1].toLowerCase()
    const digit = /^Digit([0-9])$/.exec(code)
    if (digit) return digit[1]
    return PUNCTUATION_BY_CODE[code] ?? null
}

function matchShortcut(e: KeyboardEvent, binding: KeyBinding): boolean {
    const wanted = binding.code.toLowerCase()
    // e.key first: it is what custom bindings were recorded from.
    const keyMatches = e.key.toLowerCase() === wanted || keyFromCode(e.code) === wanted
    if (!keyMatches) return false

    const needsMod = binding.modifiers.includes('mod')
    const needsShift = binding.modifiers.includes('shift')
    const needsAlt = binding.modifiers.includes('alt')

    const hasMod = e.metaKey || e.ctrlKey
    const hasShift = e.shiftKey
    const hasAlt = e.altKey

    if (needsMod !== hasMod) return false
    if (needsShift !== hasShift) return false
    if (needsAlt !== hasAlt) return false

    return true
}

/**
 * Centralized keyboard shortcut handler for the application.
 * Uses capture phase to intercept events before xterm.js consumes them.
 */
// Chord mode timeout in milliseconds
const CHORD_TIMEOUT_MS = 500

export function useKeyboardShortcuts(config: UseKeyboardShortcutsConfig): void {
    const {
        settings,
        activeWorkspace,
        activeSession,
        workspacesInSidebarOrder,
        splitLayout,
        activeSplitIndex,
        settingsOpen,
        fileSearchOpen,
        templates,
        onSelectSession,
        onSetActiveSplitIndex,
        onSetFileSearchOpen,
        onSetFileSearchMode,
        onToggleSidebar,
        onToggleSettings,
        onAddSession,
        onCloseSession,
        onClearSession,
        onRenameSession,
        onToggleMemo,
    } = config

    // Chord mode state (for Cmd+T → number sequences)
    const chordModeRef = useRef<{
        active: boolean
        workspaceId: string | null
        timer: NodeJS.Timeout | null
    }>({ active: false, workspaceId: null, timer: null })

    const navigateSplitPane = useCallback((direction: 1 | -1) => {
        if (!splitLayout || splitLayout.sessionIds.length === 0) return
        const count = splitLayout.sessionIds.length
        const nextIndex = (activeSplitIndex + direction + count) % count
        console.log(`[Shortcuts] navigateSplitPane: ${activeSplitIndex} → ${nextIndex}`)
        onSetActiveSplitIndex(nextIndex)
        // The highlight alone would leave the caret in the old pane, so the next
        // keystrokes would go to a terminal the user just moved away from.
        const textarea = document.querySelector<HTMLTextAreaElement>(
            `[data-session-id="${splitLayout.sessionIds[nextIndex]}"] .xterm-helper-textarea`
        )
        textarea?.focus()
    }, [splitLayout, activeSplitIndex, onSetActiveSplitIndex])

    const navigateSession = useCallback((direction: 1 | -1) => {
        if (!activeWorkspace || activeWorkspace.sessions.length === 0) {
            console.log('[Shortcuts] navigateTab: no active workspace or no sessions')
            return
        }

        // In split view, delegate to split pane navigation
        if (splitLayout && splitLayout.sessionIds.length > 0) {
            navigateSplitPane(direction)
            return
        }

        const sessions = activeWorkspace.sessions
        const currentIndex = activeSession
            ? sessions.findIndex(s => s.id === activeSession.id)
            : -1
        const nextIndex = currentIndex < 0
            ? 0
            : (currentIndex + direction + sessions.length) % sessions.length
        console.log(`[Shortcuts] navigateTab: ${currentIndex} → ${nextIndex} (${sessions[nextIndex]?.name})`)
        onSelectSession(activeWorkspace, sessions[nextIndex])
    }, [activeWorkspace, activeSession, splitLayout, onSelectSession, navigateSplitPane])

    const navigateWorkspace = useCallback((direction: 1 | -1) => {
        const workspacesWithSessions = workspacesInSidebarOrder.filter(w => w.sessions.length > 0)
        if (workspacesWithSessions.length === 0) {
            console.log('[Shortcuts] navigateWorkspace: no workspaces with sessions')
            return
        }

        const currentIndex = activeWorkspace
            ? workspacesWithSessions.findIndex(w => w.id === activeWorkspace.id)
            : -1
        const nextIndex = currentIndex < 0
            ? 0
            : (currentIndex + direction + workspacesWithSessions.length) % workspacesWithSessions.length
        const targetWorkspace = workspacesWithSessions[nextIndex]
        console.log(`[Shortcuts] navigateWorkspace: ${currentIndex} → ${nextIndex} (${targetWorkspace.name})`)
        onSelectSession(targetWorkspace, targetWorkspace.sessions[0])
    }, [workspacesInSidebarOrder, activeWorkspace, onSelectSession])

    // Helper to cancel chord mode
    const cancelChordMode = useCallback(() => {
        if (chordModeRef.current.timer) {
            clearTimeout(chordModeRef.current.timer)
        }
        chordModeRef.current = { active: false, workspaceId: null, timer: null }
    }, [])

    // Helper to create session with template by index
    const createSessionWithTemplateIndex = useCallback((workspaceId: string, index: number) => {
        if (index === 0) {
            // 0 = Plain Terminal
            onAddSession(workspaceId, undefined)
        } else if (index <= templates.length) {
            // 1~9 = Template by index (1-based)
            const template = templates[index - 1]
            onAddSession(workspaceId, template)
        } else {
            // No template at this index, create plain terminal
            onAddSession(workspaceId, undefined)
        }
    }, [templates, onAddSession])

    useEffect(() => {
        const shortcuts = getShortcuts(settings)
        console.log('[Shortcuts] Effect mounted, registering capture listener')

        const handleKeyDown = (e: KeyboardEvent) => {
            // Handle chord mode: waiting for number key after Cmd+T
            if (chordModeRef.current.active) {
                const workspaceId = chordModeRef.current.workspaceId
                if (!workspaceId) {
                    cancelChordMode()
                    return
                }

                // Check if it's a number key (0-9)
                const numMatch = e.key.match(/^[0-9]$/)
                if (numMatch) {
                    e.preventDefault()
                    e.stopPropagation()
                    const index = parseInt(e.key, 10)
                    console.log(`[Shortcuts] Chord: Cmd+T → ${index} (template index)`)
                    cancelChordMode()
                    createSessionWithTemplateIndex(workspaceId, index)
                    return
                }

                // Any other key cancels chord mode and creates plain terminal
                console.log(`[Shortcuts] Chord cancelled by key: ${e.key}`)
                cancelChordMode()
                onAddSession(workspaceId, undefined)
                // Don't prevent default - let the key through
                return
            }

            // Only process events with at least one modifier (when not in chord mode)
            if (!e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) return

            // Allow toggleSettings even when modals are open
            if (matchShortcut(e, shortcuts.toggleSettings)) {
                console.log('[Shortcuts] matched: toggleSettings')
                e.preventDefault()
                e.stopPropagation()
                onToggleSettings()
                return
            }

            // Allow toggleMemo even when typing in textarea (memo itself)
            if (matchShortcut(e, shortcuts.toggleMemo)) {
                console.log('[Shortcuts] matched: toggleMemo')
                e.preventDefault()
                e.stopPropagation()
                onToggleMemo()
                return
            }

            // Skip when typing in real input fields, but NOT xterm's hidden textarea
            const el = document.activeElement as HTMLElement | null
            if (el) {
                const tag = el.tagName.toLowerCase()
                if (tag === 'input') return
                if (tag === 'textarea' && !el.closest('.xterm')) return
            }

            // Skip when modals are open (except toggleSettings handled above)
            if (settingsOpen || fileSearchOpen) return

            // Special handling for newSession: enter chord mode instead of immediate action
            if (matchShortcut(e, shortcuts.newSession)) {
                if (activeWorkspace) {
                    e.preventDefault()
                    e.stopPropagation()
                    console.log('[Shortcuts] Cmd+T pressed, entering chord mode')

                    // Enter chord mode
                    chordModeRef.current = {
                        active: true,
                        workspaceId: activeWorkspace.id,
                        timer: setTimeout(() => {
                            // Timeout: create plain terminal
                            console.log('[Shortcuts] Chord timeout, creating plain terminal')
                            const wsId = chordModeRef.current.workspaceId
                            cancelChordMode()
                            if (wsId) {
                                onAddSession(wsId, undefined)
                            }
                        }, CHORD_TIMEOUT_MS)
                    }
                }
                return
            }

            const actionHandlers: Partial<Record<ShortcutAction, () => void>> = {
                nextSession: () => navigateSession(1),
                prevSession: () => navigateSession(-1),
                nextWorkspace: () => navigateWorkspace(1),
                prevWorkspace: () => navigateWorkspace(-1),
                nextSplitPane: () => navigateSplitPane(1),
                prevSplitPane: () => navigateSplitPane(-1),
                toggleSidebar: () => onToggleSidebar(),
                fileSearch: () => {
                    if (activeWorkspace) {
                        onSetFileSearchMode('files')
                        onSetFileSearchOpen(true)
                    }
                },
                contentSearch: () => {
                    if (activeWorkspace) {
                        onSetFileSearchMode('content')
                        onSetFileSearchOpen(true)
                    }
                },
                closeSession: () => {
                    // Close the currently active session and go to previous.
                    // Split view has no active session — the active pane is the target.
                    if (splitLayout && splitLayout.sessionIds.length > 0) {
                        const sessionId = splitLayout.sessionIds[activeSplitIndex]
                        const owner = workspacesInSidebarOrder.find(w => w.sessions.some(s => s.id === sessionId))
                        if (owner && sessionId) {
                            onCloseSession(owner.id, sessionId)
                        }
                    } else if (activeWorkspace && activeSession) {
                        onCloseSession(activeWorkspace.id, activeSession.id)
                    }
                },
                clearSession: () => {
                    // Clear the currently active session
                    if (splitLayout && splitLayout.sessionIds.length > 0) {
                        // In split view, clear the active pane's session
                        const sessionId = splitLayout.sessionIds[activeSplitIndex]
                        if (sessionId) {
                            onClearSession(sessionId)
                        }
                    } else if (activeSession) {
                        onClearSession(activeSession.id)
                    }
                },
                renameSession: () => {
                    // Rename the currently active session
                    if (splitLayout && splitLayout.sessionIds.length > 0) {
                        const sessionId = splitLayout.sessionIds[activeSplitIndex]
                        if (sessionId) {
                            onRenameSession(sessionId)
                        }
                    } else if (activeSession) {
                        onRenameSession(activeSession.id)
                    }
                },
            }

            for (const [action, handler] of Object.entries(actionHandlers)) {
                const binding = shortcuts[action as ShortcutAction]
                if (binding && matchShortcut(e, binding)) {
                    console.log(`[Shortcuts] matched: ${action} (key=${e.key}, meta=${e.metaKey}, ctrl=${e.ctrlKey}, shift=${e.shiftKey})`)
                    e.preventDefault()
                    e.stopPropagation()
                    handler()
                    return
                }
            }
        }

        // Use capture phase so we intercept before xterm.js handles the event
        window.addEventListener('keydown', handleKeyDown, true)
        return () => {
            window.removeEventListener('keydown', handleKeyDown, true)
            // Cleanup chord mode timer on unmount
            if (chordModeRef.current.timer) {
                clearTimeout(chordModeRef.current.timer)
            }
        }
    }, [
        settings,
        settingsOpen,
        fileSearchOpen,
        activeWorkspace,
        activeSession,
        splitLayout,
        activeSplitIndex,
        workspacesInSidebarOrder,
        templates,
        navigateSession,
        navigateWorkspace,
        navigateSplitPane,
        onToggleSidebar,
        onToggleSettings,
        onSetFileSearchOpen,
        onSetFileSearchMode,
        onAddSession,
        onCloseSession,
        onClearSession,
        onRenameSession,
        onToggleMemo,
        cancelChordMode,
        createSessionWithTemplateIndex,
    ])
}
