#!/usr/bin/env node
/**
 * T77 — a full Claude Code-shaped screen at the terminal's own size, to measure how big the
 * phone draws it. Not a real conversation (made up for the test): a welcome box, a Korean
 * prompt, tool calls, a diff that runs to the right edge, a Korean answer, the input box and
 * the status line. It draws at the terminal's size, again when that changes, and stays until
 * the session closes.
 */

const ESC = '\x1b['
const dim = (s) => `${ESC}2m${s}${ESC}22m`
const orange = (s) => `${ESC}38;5;209m${s}${ESC}39m`
const green = (s) => `${ESC}32m${s}${ESC}39m`
const red = (s) => `${ESC}31m${s}${ESC}39m`
const bold = (s) => `${ESC}1m${s}${ESC}22m`

/** display width: Hangul and other wide characters take two cells */
const width = (s) => [...s.replace(/\x1b\[[0-9;]*m/g, '')].reduce((n, ch) => n + (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1), 0)
const pad = (s, n) => s + ' '.repeat(Math.max(0, n - width(s)))
const box = (lines, w) => [
    dim('╭' + '─'.repeat(w - 2) + '╮'),
    ...lines.map((line) => dim('│') + ' ' + pad(line, w - 4) + ' ' + dim('│')),
    dim('╰' + '─'.repeat(w - 2) + '╯')
]
const cut = (s, n) => {
    let out = ''
    for (const ch of s) {
        if (width(out + ch) > n) break
        out += ch
    }
    return out
}

function screen(cols) {
    const diff = [
        ['  88  ', '      const entries = orderForAllSessions(', ' '],
        ['  89 +', '          sessionsInSidebarOrder(workspacesInLoadOrder([...all]), folders, settings?.showWorktrees ?? true),', '+'],
        ['  90 +', '          deps.recentSessions()', '+'],
        ['  91  ', '      )', ' '],
        ['  92 -', '      const byWorkspace = new Map<string, PhoneSession[]>()  // grouped by workspace, then by folder', '-'],
        ['  93 +', '      const grouped = groupBySessionFolder(entries, sessionFolders)', '+']
    ]

    const lines = [
        ...box([`${orange('✻')} Welcome to ${bold('Claude Code')}!`, '', dim('  /help for help, /status for your current setup'), '', dim('  cwd: ~/project/phone-app')], 58),
        '',
        `${dim('>')} 폰 세션 목록을 Mac 의 All sessions 순서 그대로 보여 줘. 따로 정렬하지 말고 사이드바와 같은 함수를 써.`,
        '',
        `${orange('●')} 사이드바가 쓰는 정렬 함수부터 찾겠습니다.`,
        '',
        `${green('●')} ${bold('Search')}(pattern: "orderForAllSessions", path: "src")`,
        `  ⎿  Found 4 files ${dim('(ctrl+r to expand)')}`,
        '',
        `${green('●')} ${bold('Read')}(src/renderer/src/utils/sessionNavigation.ts)`,
        `  ⎿  Read 132 lines ${dim('(ctrl+r to expand)')}`,
        '',
        `${green('●')} ${bold('Update')}(src/main/phone/phoneSetup.ts)`,
        `  ⎿  Updated src/main/phone/phoneSetup.ts with ${bold('18')} additions and ${bold('6')} removals`,
        ...diff.map(([gutter, code, mark]) => {
            const text = cut(`${gutter}  ${code}`, cols - 6)
            return '      ' + (mark === '+' ? green(text) : mark === '-' ? red(text) : dim(text))
        }),
        '',
        `${green('●')} ${bold('Bash')}(pnpm typecheck && npx playwright test tests/terminal/t75-phone-unit.spec.ts --workers=1)`,
        '  ⎿  > tsc --noEmit',
        `     ${green('30 passed')} (607ms)`,
        '',
        `${orange('●')} 바꾼 것: 폰 목록은 이제 Mac 사이드바 All sessions 와 같은 순서입니다. 세션 폴더가 먼저, 그 안에서는`,
        '  고정 → 최근 본 순 → 사이드바 순. 순서는 main 이 사이드바와 같은 함수로 만들고, 폰은 그리기만 합니다.',
        '',
        '  남은 것: T76 목록 단언을 데스크톱 DOM 순서와 직접 비교하게 바꿉니다. 글씨 크기는 세 모드로 잽니다.',
        '',
        ...box(['> '], cols),
        `  ${dim('⏵⏵ accept edits on (shift+tab to cycle)')}` + ' '.repeat(Math.max(1, cols - 62)) + dim('◯ IDE disconnected')
    ]

    return lines
}

function draw() {
    const lines = screen(process.stdout.columns || 103)
    process.stdout.write(`${ESC}2J${ESC}3J${ESC}H${ESC}?25l`)
    process.stdout.write(lines.join('\r\n'))
    // leave the cursor in the input box, as Claude Code does
    process.stdout.write(`${ESC}${lines.length - 2};5H${ESC}?25h`)
}

draw()
process.stdout.on('resize', draw)
setInterval(() => {}, 1 << 30)
