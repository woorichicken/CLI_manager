/**
 * T80 — ovis's own unit tests, run against the modules we ported from it. Without Electron.
 *
 * ovis (https://github.com/devswha/ovis, 3e51902 — MIT, Copyright (c) 2026 devswha) keeps a bun
 * test next to each module. The cases (inputs, expected values, fixtures) are copied here as they
 * are and only the calls are pointed at our API, one file per group under ./ovis-port/. Fixtures
 * live in tests/fixtures/ovis/<group>/ with a SOURCE.md naming where each came from.
 *
 * - `test.fixme(true, …)`: we changed that behavior on purpose; the reason names the comment or doc.
 * - `test.fail(true, 'ovis-port bug: …')`: our port differs from ovis with no recorded reason —
 *   a defect left for a separate fix (the test starts failing once it is fixed, as a reminder).
 */
import './ovis-port/chatlib'
import './ovis-port/claude'
import './ovis-port/codex'
import './ovis-port/commands'
import './ovis-port/phone-server'
import './ovis-port/phone-ui'
import './ovis-port/prompt'
