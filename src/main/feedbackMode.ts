/**
 * Whether this Mac shows the feedback widget, as the renderer last said.
 *
 * The answer lives in the renderer: the build's ingest values are inlined there, and the
 * password unlock is in its localStorage (utils/feedbackGate.ts). The phone page cannot judge
 * for itself — behind `adb reverse` its host is localhost, which the desktop reads as a
 * development build — so main keeps the renderer's answer and the phone server passes it on.
 *
 * Off until the renderer reports (at startup and whenever feedback mode changes). Every window
 * reads the same localStorage, so the latest report is the truth.
 */
export class FeedbackModeState {
    private on = false

    /** Anything but `true` from IPC is off. */
    report(value: unknown): void {
        this.on = value === true
    }

    enabled(): boolean {
        return this.on
    }
}
