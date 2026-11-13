import React from 'react'
import { SPLIT_DIVIDER_PX } from '../utils/splitLayout'

/**
 * The lines between split panes. Panes have no gap and no frame of their own (report a81cd0ce),
 * so these lines are the only thing that tells one pane from the next. They sit in the
 * `SPLIT_DIVIDER_PX` strip App.tsx leaves free between the terminals, centred on 50%.
 */
const CENTER = `calc(50% - ${SPLIT_DIVIDER_PX / 2}px)`
const LINE = 'absolute bg-white/10 pointer-events-none'

export function SplitDividers({ count }: { count: number }) {
    if (count < 2) return null
    // 2 panes: side by side. 3: two on top, one full width below. 4: 2x2.
    const vertical: React.CSSProperties = count === 3
        ? { left: CENTER, width: SPLIT_DIVIDER_PX, top: 0, height: CENTER }
        : { left: CENTER, width: SPLIT_DIVIDER_PX, top: 0, bottom: 0 }
    return (
        <>
            <div data-split-divider="vertical" className={LINE} style={vertical} />
            {count >= 3 && (
                <div
                    data-split-divider="horizontal"
                    className={LINE}
                    style={{ top: CENTER, height: SPLIT_DIVIDER_PX, left: 0, right: 0 }}
                />
            )}
        </>
    )
}
