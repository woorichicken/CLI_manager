/**
 * Shell scripts installed into the user's home directory as bridges between
 * the AI CLIs and CLI Manager.
 *
 * Why POSIX sh and not Node:
 *   These run on every agent turn, inside the CLI's own process tree. They must
 *   start instantly, must not depend on a `node` binary being on PATH (the app
 *   may be launched from Finder without the login shell PATH), and must never
 *   fail in a way that surfaces to the user's agent session. A few lines of sh
 *   satisfy all three.
 *
 * Why a spool directory and not HTTP:
 *   An HTTP hook would block the CLI for the whole connect timeout whenever
 *   CLI Manager is closed — on every single turn. Writing a file always
 *   succeeds in microseconds regardless of whether the app is running, which is
 *   also the approach Orca settled on.
 *
 * Every script ends with `exit 0`. A broken bridge must never break the agent.
 */

/** Marks our own entries so re-installs never chain a script to itself. */
export const HOOK_MARKER = 'climanager-bridge'

/** Placeholder replaced at install time with the pre-existing command, if any. */
const DELEGATE_TOKEN = '#__CLIMANAGER_DELEGATE__'

const SPOOL_PREAMBLE = `
spool="\${CLIMANAGER_SPOOL:-$HOME/.climanager/events}"
mkdir -p "$spool" 2>/dev/null || exit 0
`.trim()

/**
 * Claude Code lifecycle hooks. Receives the event payload on stdin and records
 * it verbatim; classification happens in the app, so the script never needs to
 * understand JSON.
 */
export const CLAUDE_HOOK_SCRIPT = `#!/bin/sh
# ${HOOK_MARKER}: Claude Code lifecycle events -> CLI Manager
# Records the hook payload and exits 0 unconditionally.
${SPOOL_PREAMBLE}

f=$(mktemp "$spool/ev-XXXXXXXX" 2>/dev/null) || exit 0
{
  printf '{"climanager":{"source":"claude-hook"},"payload":'
  cat
  printf '}'
} > "$f" 2>/dev/null

exit 0
`

/**
 * Claude Code statusLine bridge. This is the only place the official
 * `rate_limits` payload is exposed, so we capture it here and then hand stdin
 * to whatever statusLine command was configured before us — the user's own
 * status line keeps rendering exactly as it did.
 */
export const CLAUDE_STATUSLINE_SCRIPT = `#!/bin/sh
# ${HOOK_MARKER}: Claude Code statusLine -> CLI Manager (usage capture)
# Captures official rate_limits, then delegates to the previous statusLine.
input=$(cat)
${SPOOL_PREAMBLE}

f=$(mktemp "$spool/ev-XXXXXXXX" 2>/dev/null)
if [ -n "$f" ]; then
  printf '{"climanager":{"source":"claude-statusline"},"payload":%s}' "$input" > "$f" 2>/dev/null
fi

${DELEGATE_TOKEN}

exit 0
`

/**
 * Fallback status line used only when the user had no statusLine before.
 * Claude Code hides its footer hints once any statusLine is configured, so
 * printing something useful is friendlier than printing nothing.
 * Extraction is best-effort: an empty result simply prints an empty line.
 */
const STATUSLINE_DEFAULT_OUTPUT = `model=$(printf '%s' "$input" | sed -n 's/.*"display_name"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' | head -1)
printf '%s' "\${model:-claude}"`

/**
 * Codex notify bridge. Codex passes its JSON as argv[1] rather than on stdin,
 * and only fires for `agent-turn-complete`.
 */
export const CODEX_NOTIFY_SCRIPT = `#!/bin/sh
# ${HOOK_MARKER}: Codex notify -> CLI Manager
# Records the turn-complete payload, then delegates to the previous notify.
${SPOOL_PREAMBLE}

f=$(mktemp "$spool/ev-XXXXXXXX" 2>/dev/null)
if [ -n "$f" ]; then
  printf '{"climanager":{"source":"codex-notify"},"payload":%s}' "$1" > "$f" 2>/dev/null
fi

${DELEGATE_TOKEN}

exit 0
`

/**
 * Substitutes the delegate placeholder with a call to the command we replaced.
 *
 * @param script            One of the templates above.
 * @param delegate          Original command, or undefined when there was none.
 * @param mode              'stdin'  - pipe the captured stdin to the delegate
 *                          'argv'   - pass our own arguments straight through
 * @param fallbackToDefault Emit a minimal status line when nothing was replaced.
 */
export function withDelegate(
    script: string,
    delegate: string | undefined,
    mode: 'stdin' | 'argv',
    fallbackToDefault = false
): string {
    let replacement: string

    if (delegate && delegate.trim()) {
        // Delegate failures are swallowed: a broken third-party status line
        // must not take our capture (or the agent) down with it.
        replacement =
            mode === 'stdin'
                ? `printf '%s' "$input" | ${delegate} 2>/dev/null || true`
                : `${delegate} "$@" 2>/dev/null || true`
    } else if (fallbackToDefault) {
        replacement = STATUSLINE_DEFAULT_OUTPUT
    } else {
        replacement = ': # nothing to delegate to'
    }

    return script.replace(DELEGATE_TOKEN, replacement)
}
