#!/usr/bin/env node
// T157 fixture — prints a StatusReport v1 the way `queues status --json` does, then exits 3 when a row
// is blocked (the real command does too). Prints junk first, like a login shell's motd can.
// Writes one line to STATUS_FIXTURE_LOG per run so the spec can count runs (on open only, no polling).
const fs = require('fs')
if (process.env.STATUS_FIXTURE_LOG) fs.appendFileSync(process.env.STATUS_FIXTURE_LOG, 'run\n')
const report = {
    version: 1,
    generatedAt: new Date().toISOString(),
    counts: { ok: 99, busy: 0, attention: 0, blocked: 0, error: 0 },
    sources: [
        { id: 'heavy', name: 'Heavy lane', what: 'heavy commands', state: 'blocked', summary: 'used 2 · waiting 1',
          items: [{ text: 'waiting pid 4242 for 21 min :: pnpm e2e', state: 'blocked' }], see: 'heavy-run status' },
        { id: 'browser', name: 'Browser lock', state: 'ok', summary: 'free · waiting 0', items: [] },
        { id: 'list', name: 'Checklists', state: 'attention', summary: 'open 6 · overdue 3',
          items: [{ text: 'contest-1106 10/12', state: 'attention' }] },
        { id: 'remote', name: 'Remote jobs', state: 'no-such-state', summary: 'ssh failed', items: [] }
    ]
}
process.stdout.write('motd line before the report\n')
process.stdout.write(JSON.stringify(report))
process.exit(3)
