/** Placeholder — replaced by the bottom-anchored resize. */
export interface ResizableTerminal {
    readonly cols: number
    readonly rows: number
    resize(cols: number, rows: number): void
}

export function resizeKeepingBottom(term: ResizableTerminal, cols: number, rows: number): void {
    term.resize(cols, rows)
}
