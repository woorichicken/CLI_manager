/**
 * What the Settings search finds (74c893e6 — «like Apple's System Settings»): one row per setting, in the tab
 * that draws it, with its title exactly as that tab draws it (the search scrolls to that text) and a few more
 * words a person might type. T208 opens every tab and checks each title is on screen — so a renamed setting
 * fails a test instead of drifting out of the search. Only settings that are always drawn are listed (a row
 * that shows only while another switch is on would not be found to scroll to).
 */

export type SettingsCategory =
    | 'general'
    | 'sidebar'
    | 'editor'
    | 'terminal'
    | 'chat'
    | 'keyboard'
    | 'agents'
    | 'phone'
    | 'port-monitoring'
    | 'templates'
    | 'git'
    | 'github'
    | 'loop'
    | 'developer'

export interface SettingsEntry {
    category: SettingsCategory
    /** the setting's own title, as the tab draws it */
    title: string
    /** more words to find it by */
    keywords?: string
}

export const SETTINGS_INDEX: SettingsEntry[] = [
    { category: 'general', title: 'Appearance', keywords: 'theme light dark colour color' },
    { category: 'general', title: 'Feedback Mode', keywords: 'feedback report widget bug' },
    { category: 'general', title: 'Show Welcome Screen', keywords: 'onboarding welcome tutorial getting started' },
    { category: 'general', title: 'Status Command', keywords: 'status queues queue command monitor' },
    { category: 'keyboard', title: 'Keyboard Shortcuts', keywords: 'shortcut shortcuts key keys binding bindings hotkey' },
    { category: 'sidebar', title: 'Sidebar Font Size', keywords: 'font size text' },
    { category: 'sidebar', title: 'Show Session Count', keywords: 'count number' },
    { category: 'sidebar', title: 'Show Worktrees', keywords: 'worktree git branch' },
    { category: 'sidebar', title: 'Show Home Workspace', keywords: 'home folder directory' },
    { category: 'sidebar', title: 'Show Playground', keywords: 'playground' },
    { category: 'sidebar', title: 'Show Session Tabs', keywords: 'tabs tab row' },
    { category: 'sidebar', title: 'Open Sessions as Preview Tabs', keywords: 'preview italic tab' },
    { category: 'sidebar', title: 'Show Session Tree', keywords: 'tree layout parent child' },
    { category: 'sidebar', title: 'Header buttons', keywords: 'header toolbar icons related checklist checklists loop monitor search diff source control git terminal chat hide' },
    { category: 'sidebar', title: 'Show Session Status', keywords: 'status dot working waiting' },
    { category: 'editor', title: 'Default Editor', keywords: 'editor vscode cursor code open ide' },
    { category: 'terminal', title: 'Terminal Configuration', keywords: 'font shell scrollback cursor' },
    { category: 'terminal', title: 'Show Preview on Hover', keywords: 'preview hover' },
    { category: 'terminal', title: 'File Links in Terminal', keywords: 'file link links path click' },
    { category: 'terminal', title: 'App Links in Terminal', keywords: 'app link links scheme url obsidian' },
    { category: 'chat', title: 'Chat view', keywords: 'chat' },
    { category: 'chat', title: 'Enter sends', keywords: 'enter send return key newline' },
    { category: 'chat', title: 'Collapse work', keywords: 'collapse fold tools work' },
    { category: 'chat', title: 'Keep my last message on top', keywords: 'pin last message top' },
    { category: 'chat', title: 'Open files in the app', keywords: 'file files preview open' },
    { category: 'chat', title: 'Quick replies', keywords: 'quick reply replies chip chips phrase colour color' },
    { category: 'chat', title: 'Keep dictation log', keywords: 'dictation voice microphone mic speech log' },
    { category: 'chat', title: 'Also keep audio', keywords: 'dictation audio wav sound' },
    { category: 'templates', title: 'Terminal Templates', keywords: 'template templates command agent logo' },
    { category: 'agents', title: 'AI Control API', keywords: 'api mcp token port control ai' },
    { category: 'agents', title: 'Official Agent Hooks', keywords: 'hooks integration claude codex' },
    { category: 'agents', title: 'Usage Alerts', keywords: 'usage limit alert alerts rate notification' },
    { category: 'agents', title: 'Session Monitoring', keywords: 'monitoring status badge' },
    { category: 'phone', title: 'Phone', keywords: 'phone mobile tailscale pair device qr remote' },
    { category: 'git', title: 'Git Worktree Settings', keywords: 'worktree branch' },
    { category: 'git', title: 'Worktree Deletion Options', keywords: 'delete remove worktree' },
    { category: 'github', title: 'GitHub Configuration', keywords: 'github gh pull request pr auth' },
    { category: 'port-monitoring', title: 'Port Monitoring', keywords: 'port ports lsof localhost server' },
    { category: 'port-monitoring', title: 'Port Filter', keywords: 'filter' },
    { category: 'port-monitoring', title: 'Ignored Items', keywords: 'ignore ignored' },
    { category: 'port-monitoring', title: 'Action Logs', keywords: 'log logs kill' },
    { category: 'loop', title: 'Loop Detection', keywords: 'loop repeat autocron' }
]

/** Lower-case words (letters and digits); a query word matches the start of one of them. */
const wordsOf = (text: string): string[] => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)

/**
 * The tabs with settings that hold every word of `query` (any case, each at the start of a word — «tree» is
 * Show Session Tree, not Worktrees), in `order`, each with its matching settings in the index's order.
 * Empty `query`: null (the plain list).
 */
export function searchSettings(
    query: string,
    order: { id: SettingsCategory; label: string }[],
    index: SettingsEntry[] = SETTINGS_INDEX
): { category: SettingsCategory; matches: SettingsEntry[] }[] | null {
    const wanted = wordsOf(query)
    if (wanted.length === 0) return null
    const label = new Map(order.map((item) => [item.id, item.label]))
    const hits = index.filter((entry) => {
        const words = wordsOf(`${entry.title} ${entry.keywords ?? ''} ${label.get(entry.category) ?? ''}`)
        return wanted.every((part) => words.some((word) => word.startsWith(part)))
    })
    return order
        .map((item) => ({ category: item.id, matches: hits.filter((entry) => entry.category === item.id) }))
        .filter((group) => group.matches.length > 0)
}
