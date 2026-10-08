import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, X } from 'lucide-react'

const NOTICE_VISIBLE_MS = 1800

interface Notice {
    ok: boolean
    label: string
    value: string
}

/**
 * Copy text from a sidebar menu and confirm it on screen.
 *
 * Menus close on click, so without a notice the user cannot tell whether the copy
 * happened or what exactly is on the clipboard before pasting it to an agent.
 */
export function useCopyWithNotice() {
    const [notice, setNotice] = useState<Notice | null>(null)
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

    useEffect(() => () => {
        if (timerRef.current) clearTimeout(timerRef.current)
    }, [])

    const copy = useCallback(async (text: string, label: string) => {
        let ok = true
        try {
            await navigator.clipboard.writeText(text)
        } catch (err) {
            ok = false
            console.error(`Failed to copy ${label}:`, err)
        }
        setNotice({ ok, label, value: text })
        if (timerRef.current) clearTimeout(timerRef.current)
        timerRef.current = setTimeout(() => setNotice(null), NOTICE_VISIBLE_MS)
    }, [])

    return { notice, copy }
}

export function CopyNotice({ notice }: { notice: Notice | null }) {
    if (!notice) return null
    return (
        <div
            data-testid="sidebar-copy-notice"
            className="absolute left-2 right-2 bottom-2 z-40 flex items-center gap-1.5 px-2 py-1.5 rounded border border-white/10 bg-[#1e1e20] shadow-xl text-xs pointer-events-none"
        >
            {notice.ok
                ? <Check size={12} className="text-emerald-400 shrink-0" />
                : <X size={12} className="text-red-400 shrink-0" />}
            <span className={notice.ok ? 'text-gray-300 shrink-0' : 'text-red-300 shrink-0'}>
                {notice.ok ? `Copied ${notice.label}` : `Could not copy ${notice.label}`}
            </span>
            {notice.ok && (
                <span className="text-gray-500 font-mono truncate min-w-0">{notice.value}</span>
            )}
        </div>
    )
}
