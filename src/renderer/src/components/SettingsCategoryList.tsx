import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Search, X } from 'lucide-react'
import { searchSettings, type SettingsCategory, type SettingsEntry } from './settingsIndex'

export interface SettingsCategoryGroup {
    label: string
    items: { id: SettingsCategory; label: string; icon: ReactNode }[]
}

/** How long a found setting stays lit after the search scrolls to it. */
const HIGHLIGHT_MS = 1600

/**
 * Scrolls `container` to the setting titled `title` and lights it for a moment. The title is matched as the
 * whole text of a heading or label, so «Show Session Tree» does not land on a description that mentions it.
 */
export function revealSetting(container: HTMLElement | null, title: string): boolean {
    if (!container) return false
    const found = Array.from(container.querySelectorAll<HTMLElement>('h3, h4, p, label, span')).find((node) => node.textContent?.trim() === title)
    if (!found) return false
    // the setting's row (title, description and its control), else the title itself
    const near = found.closest<HTMLElement>('.flex.items-center.justify-between')
    const row = near && container.contains(near) ? near : found
    row.scrollIntoView({ block: 'center' })
    row.setAttribute('data-settings-found', 'true')
    row.classList.add('settings-found')
    window.setTimeout(() => {
        row.removeAttribute('data-settings-found')
        row.classList.remove('settings-found')
    }, HIGHLIGHT_MS)
    return true
}

/**
 * The left column of Settings: a search box over the grouped tabs (74c893e6). Typing keeps only the tabs with
 * a setting that holds every word, each with one or two of those settings in faint text under it; Enter or a
 * click opens that tab at the setting. ⌘F focuses the box; Esc empties it (and only then leaves the box).
 */
export function SettingsCategoryList({
    groups,
    activeCategory,
    onOpen
}: {
    groups: SettingsCategoryGroup[]
    activeCategory: SettingsCategory
    onOpen: (category: SettingsCategory, entry?: SettingsEntry) => void
}) {
    const [query, setQuery] = useState('')
    const input = useRef<HTMLInputElement>(null)
    const order = groups.flatMap((group) => group.items)
    const results = searchSettings(query, order)

    // ⌘F (Ctrl+F elsewhere) while Settings is open: the search box, not the app's own find
    useEffect(() => {
        const onKey = (event: KeyboardEvent): void => {
            if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'f') {
                event.preventDefault()
                event.stopPropagation()
                input.current?.focus()
                input.current?.select()
            }
        }
        window.addEventListener('keydown', onKey, true)
        return () => window.removeEventListener('keydown', onKey, true)
    }, [])

    const button = (category: { id: SettingsCategory; label: string; icon: ReactNode }, matches?: SettingsEntry[]) => (
        <div key={category.id}>
            <button
                data-testid={`settings-category-${category.id}`}
                onClick={() => onOpen(category.id, matches?.[0])}
                className={`w-full flex items-center gap-2 px-3 py-2 rounded text-sm transition-colors ${activeCategory === category.id
                        ? 'bg-blue-600/20 text-blue-300 border border-blue-500/30'
                        : 'text-gray-400 hover:bg-white/5 hover:text-white'
                    }`}
            >
                {category.icon}
                <span>{category.label}</span>
            </button>
            {matches && (
                <div className="pl-9 pr-2 pb-1" data-testid="settings-search-matches">
                    {matches.slice(0, 2).map((entry) => (
                        <button
                            key={entry.title}
                            type="button"
                            data-testid="settings-search-match"
                            data-category={category.id}
                            onClick={() => onOpen(category.id, entry)}
                            className="block w-full text-left truncate text-[11px] leading-4 text-gray-500 hover:text-gray-300"
                            title={entry.title}
                        >
                            {entry.title}
                        </button>
                    ))}
                    {matches.length > 2 && <span className="block text-[10px] text-gray-600">+{matches.length - 2} more</span>}
                </div>
            )}
        </div>
    )

    return (
        <>
            <div className="p-2 pb-0">
                <div className="relative">
                    <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none" aria-hidden="true" />
                    <input
                        ref={input}
                        type="text"
                        value={query}
                        data-testid="settings-search"
                        placeholder="Search"
                        aria-label="Search settings"
                        spellCheck={false}
                        onChange={(event) => setQuery(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === 'Escape' && query) {
                                event.preventDefault()
                                event.stopPropagation()
                                setQuery('')
                            } else if (event.key === 'Enter' && results && results.length > 0) {
                                event.preventDefault()
                                onOpen(results[0].category, results[0].matches[0])
                            }
                        }}
                        className="w-full bg-black/30 border border-white/10 rounded pl-6 pr-6 py-1.5 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
                    />
                    {query && (
                        <button type="button" aria-label="Clear search" data-testid="settings-search-clear" onClick={() => (setQuery(''), input.current?.focus())} className="absolute right-1.5 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300">
                            <X size={12} />
                        </button>
                    )}
                </div>
            </div>
            <div className="flex-1 overflow-y-auto p-2">
                {results === null ? (
                    groups.map((group) => (
                        <div key={group.label} data-settings-group={group.label} className="mb-2 last:mb-0">
                            <div className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-gray-500 select-none">{group.label}</div>
                            {group.items.map((category) => button(category))}
                        </div>
                    ))
                ) : results.length === 0 ? (
                    <p className="px-3 py-4 text-xs text-gray-500" data-testid="settings-search-empty">
                        No settings match
                    </p>
                ) : (
                    <div data-testid="settings-search-results">
                        {results.map((result) => button(order.find((item) => item.id === result.category)!, result.matches))}
                    </div>
                )}
            </div>
        </>
    )
}
