import type { IDisposable, Terminal } from '@xterm/xterm'

/** the two xterm 6.0.0 internals this reaches; both optional so a future xterm without them is a no-op */
interface XtermInternals {
    _core?: {
        _renderService?: { onDimensionsChange?: (listener: () => void) => IDisposable }
        _viewport?: { queueSync?: () => void }
    }
}

/**
 * Keep xterm's scroll area sized to the cells it draws.
 *
 * xterm 6.0.0's Viewport measures its scroll area (row height × lines) only when the buffer
 * resizes or scrolls — not when the renderer's cell size changes. The phone opens its terminal
 * with the fallback font and switches to the bundled one when it arrives (G3); when that lands
 * after the snapshot, the scroll area keeps the old 15px rows while the grid draws 13px ones, and
 * `scrollLines` asks for a row past the bottom — clamped, nothing moves: a drag up through the
 * history did nothing until the shell printed again (fb-1114 session C, T131 «font after the
 * snapshot»). Re-measure whenever the renderer's dimensions change.
 *
 * Private API: there is no public hook (6.0.0 is the newest stable, 2026-11-14). When an xterm
 * upgrade drops either internal this does nothing and T131 fails — that is the alarm.
 */
export function keepViewportInSync(term: Terminal): IDisposable {
    const core = (term as unknown as XtermInternals)._core
    const subscribe = core?._renderService?.onDimensionsChange
    if (!core || !subscribe) return { dispose: () => undefined }
    return subscribe.call(core._renderService, () => core._viewport?.queueSync?.())
}
