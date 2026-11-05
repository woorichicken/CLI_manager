#!/usr/bin/env node
/**
 * An inline TUI that resizes the way Claude Code 2.1.309 does (T87).
 *
 * It prints its lines once, then an input box (rule, prompt, rule, footer) and
 * one blank row, with the cursor in the prompt. On SIGWINCH it goes to the top
 * of the screen, clears every row, and redraws the tail of its lines plus the
 * box — leaving the scrollback alone, as the recorded Claude sessions do.
 *
 *   node inline-tui.cjs [lineCount]
 */
const total = Number(process.argv[2] || 120)
const lines = Array.from({ length: total }, (_, i) => `tui line ${i + 1}`)
const RULE = '─'.repeat(40)
const BOX = [RULE, '❯ ', RULE, '  footer: ready']
const out = (s) => process.stdout.write(s)

process.stdin.setRawMode?.(true)
process.stdin.resume()
process.stdin.on('data', (d) => { if (d.includes(3)) process.exit(0) })

out([...lines, ...BOX].join('\r\n') + '\r\n')
// Back onto the prompt row: up from the blank row past the footer and the lower rule.
out('\x1b[3A\r\x1b[2C')

process.on('SIGWINCH', () => {
    const rows = process.stdout.rows
    const tail = lines.slice(Math.max(0, lines.length - (rows - BOX.length - 1)))
    let frame = '\x1b[H'
    for (let row = 0; row < rows; row++) frame += '\x1b[2K' + (row < rows - 1 ? '\r\n' : '')
    frame += '\x1b[H' + [...tail, ...BOX].join('\r\n')
    frame += `\x1b[${tail.length + 2};3H`
    out(frame)
})
