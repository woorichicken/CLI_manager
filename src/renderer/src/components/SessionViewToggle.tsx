import { MessageSquareText, SquareTerminal } from 'lucide-react'
import { useSessionViewMode } from '../hooks/useSessionViewMode'
import { switchSessionView } from '../utils/sessionViewSwitch'
import { useShortcutHint } from '../utils/shortcutHints'

/**
 * "Terminal | Chat" in a session header (single view and split panes). The
 * terminal keeps running either way; Chat only draws the same session from the
 * agent's transcript. Shown for Claude Code and Codex sessions. The main header has
 * the icons alone (d5efaf86 — the words took room the other buttons need); a wide
 * split pane keeps its words (`labels`). The name and the shortcut are always in the
 * tooltip and the aria-label.
 */
export function SessionViewToggle({ sessionId, compact = false, labels = false }: { sessionId: string; compact?: boolean; labels?: boolean }) {
    const mode = useSessionViewMode(sessionId)
    const hint = useShortcutHint()
    const button = (value: 'terminal' | 'chat', label: string, Icon: typeof SquareTerminal) => {
        const active = mode === value
        return (
            <button
                type="button"
                data-testid={`view-toggle-${value}`}
                aria-pressed={active}
                aria-label={label}
                title={hint(label, 'toggleChatView', false)}
                onClick={(event) => {
                    event.stopPropagation()
                    switchSessionView(sessionId, value)
                }}
                className={`flex items-center gap-1 rounded ${compact ? 'px-1 py-0.5' : 'px-1.5 py-0.5'} transition-colors ${
                    active ? 'bg-white/15 text-gray-100' : 'text-gray-400 hover:text-gray-200 hover:bg-white/5'
                }`}
            >
                <Icon size={compact ? 12 : 13} aria-hidden="true" />
                {labels && !compact && <span className="hidden md:inline text-[11px] leading-none">{label}</span>}
            </button>
        )
    }
    return (
        <div
            className="flex items-center shrink-0 gap-0.5 rounded-md border border-white/10 p-0.5 no-drag"
            role="group"
            aria-label="Session view"
            data-testid="view-toggle"
            data-mode={mode}
        >
            {button('terminal', 'Terminal', SquareTerminal)}
            {button('chat', 'Chat', MessageSquareText)}
        </div>
    )
}
