#!/usr/bin/env node
// T158 fixture — a report where one queue can be managed and one is read only, the way `queues status --json`
// marks Ludyte (cancel while waiting) next to heavy-run (read only). A row cancelled by act.cjs is gone on the
// next run, like the real queue. STATUS_FIXTURE_STATE is the folder both fixtures share.
const fs = require('fs')
const path = require('path')
const cancelledFile = path.join(process.env.STATUS_FIXTURE_STATE || '/nonexistent', 'cancelled')
const cancelled = fs.existsSync(cancelledFile) ? fs.readFileSync(cancelledFile, 'utf8').split('\n') : []
const jobs = [
    { id: 'q1', text: 'waiting q1 — render cut 1', state: 'busy', actions: ['cancel'] },
    { id: 'fail', text: 'waiting fail — the action command will fail', state: 'busy', actions: ['cancel'] },
    { id: 'r1', text: 'running r1 — no cancel while running', state: 'busy', actions: [] },
    { id: 'bad id!', text: 'an id that is not a plain name', state: 'busy', actions: ['cancel'] }
].filter(j => !cancelled.includes(j.id))
process.stdout.write(JSON.stringify({
    version: 1,
    generatedAt: new Date().toISOString(),
    sources: [
        { id: 'jobs', name: 'Render jobs', state: 'busy', summary: `waiting ${jobs.length}`,
          actions: [{ id: 'cancel', label: 'Cancel' }, { id: 'rm -rf', label: 'Not a plain id' }], items: jobs },
        { id: 'heavy', name: 'Heavy lane', state: 'busy', summary: 'used 1',
          items: [{ id: 'h1', text: 'pnpm e2e', state: 'busy', actions: ['cancel'] }] }
    ]
}))
