import type { ReactElement } from 'react'

/**
 * Claude's dim next-prompt suggestion, drawn in the empty Chat box where the placeholder would be
 * (ba2ae0cb). A keyboard takes it with Tab; a touch screen has no Tab, so a `Use` pill sits at the
 * right of the box instead. Either way it only fills the box — sending stays the person's Enter.
 */
export function ComposerSuggestion({ text, touch, onUse }: { text: string; touch: boolean; onUse(): void }): ReactElement {
    return (
        <>
            <div className="chat-composer-suggestion notranslate" translate="no" aria-hidden="true" data-testid="chat-suggestion" title={text}>
                {text}
            </div>
            <button
                type="button"
                className={`chat-suggestion-use${touch ? ' is-touch' : ''}`}
                data-testid="chat-suggestion-use"
                // keep focus where it is: on a Mac the box keeps its caret, on a phone the keyboard stays down
                onPointerDown={(event) => event.preventDefault()}
                onClick={onUse}
                title={`Use the suggestion: ${text}`}
                aria-label={`Use the suggestion: ${text}`}
            >
                {touch ? (
                    'Use'
                ) : (
                    <>
                        <kbd>Tab</kbd> to use
                    </>
                )}
            </button>
        </>
    )
}
