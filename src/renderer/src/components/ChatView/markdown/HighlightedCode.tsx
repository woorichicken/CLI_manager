// From ovis (https://github.com/devswha/ovis, 3e51902) — MIT, Copyright (c) 2026 devswha. Modified.
// Source: src/components/HighlightedCode.tsx — CodeLines kept; highlighting runs on the page only, up to
// SYNC_LIMIT characters (ovis hands longer code to a worker). File-path links in code are not ported.
import { Fragment, memo, useMemo } from 'react'
import { canHighlight, countLines, highlightNow, LINE_ELEMENT_LIMIT, normalizeCode, plainLines, type Lines } from './highlight'

/**
 * Highlighted on the page up to this many characters. TanStack Highlight is
 * linear on ordinary code but quadratic on a few shapes (ovis measured <5 ms at
 * 2 KB for the worst); longer code shows plain rather than hold the page.
 */
const SYNC_LIMIT = 8 * 1024

function useLines(code: string, language: string | null): { lines: Lines; tooLong: boolean } {
    return useMemo(() => {
        const source = normalizeCode(code)
        const tooLong = canHighlight(language) && (source.length > SYNC_LIMIT || countLines(source) > LINE_ELEMENT_LIMIT)
        if (!canHighlight(language) || tooLong) return { lines: plainLines(source), tooLong }
        return { lines: highlightNow(source, language), tooLong: false }
    }, [code, language])
}

/**
 * Code colored by role, one `.hl-line` per source line, joined by literal "\n"
 * text nodes so a copied selection keeps every blank line.
 */
const CodeLines = memo(function CodeLines({ lines }: { lines: Lines }) {
    const plain = lines.length > LINE_ELEMENT_LIMIT
    const elements = useMemo(
        () =>
            plain
                ? lines.map((tokens) => tokens.map((token) => token.text).join('')).join('\n')
                : lines.map((tokens, index) => (
                      <Fragment key={index}>
                          {index > 0 && '\n'}
                          <span className="hl-line">
                              {tokens.map((token, n) =>
                                  token.role === null ? (
                                      <Fragment key={n}>{token.text}</Fragment>
                                  ) : (
                                      <span className={`hl-${token.role}`} key={n}>
                                          {token.text}
                                      </span>
                                  )
                              )}
                          </span>
                      </Fragment>
                  )),
        [lines, plain]
    )
    return (
        <pre className="hl-code">
            <code>{elements}</code>
        </pre>
    )
})

export const HighlightedCode = memo(function HighlightedCode({ code, language }: { code: string; language: string | null }) {
    const { lines, tooLong } = useLines(code, language)
    return (
        <>
            <CodeLines lines={lines} />
            {tooLong && <p className="hl-note">Too long to highlight</p>}
        </>
    )
})
