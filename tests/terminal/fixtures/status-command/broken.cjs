#!/usr/bin/env node
// T157 fixture — a status command that prints no JSON and fails.
process.stderr.write('queues: cannot reach the control API\n')
process.exit(1)
