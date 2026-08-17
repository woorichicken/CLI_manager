#!/usr/bin/env node
/**
 * Post-release distribution: R2 upload, website links, changelog.
 *
 * These three steps ran by hand until now, in an order that matters and with
 * failure modes that are invisible from the outside. The website can advertise
 * a download URL that 404s, and nobody finds out until a user clicks it.
 *
 * So each step verifies the thing it just changed, from the outside:
 *   - after uploading, the public R2 URL must actually serve the file
 *   - the website links are only rewritten once those URLs are live
 *   - after committing, no stale version string may remain in the site
 *   - after inserting, the changelog row must be readable back
 *
 * Usage:
 *   DATABASE_URL=... node scripts/post-release.cjs --version 1.7.0 --check
 *   DATABASE_URL=... node scripts/post-release.cjs --version 1.7.0 --notes notes.json
 *   node scripts/post-release.cjs --version 1.7.0 --skip-changelog
 *
 * `--notes` is a JSON file: { title, description, improvements[], fixes[] }.
 * DATABASE_URL is read from the environment on purpose — a connection string in
 * this repository would be a committed credential.
 */

const { spawnSync } = require('child_process')
const { existsSync, readFileSync, writeFileSync, statSync } = require('fs')
const { join } = require('path')

const ROOT = join(__dirname, '..')
const RELEASE_DIR = join(ROOT, 'release')
const SITE_DIR = join(process.env.HOME, 'Downloads', 'solhun-web-page')
const R2_PUBLIC_BASE = 'https://pub-dc249db286af4c1991fedf690157891d.r2.dev'
const UPLOAD_SCRIPT = join(ROOT, '.claude', 'skills', 'upload-to-r2', 'scripts', 'upload-to-r2.js')

/** Gitignored credential file: distribution secrets live here, never in the repo. */
const ENV_FILE = join(ROOT, '.env.release')

/**
 * Loads `.env.release` into the environment if present.
 *
 * The upload script reads its credentials from the environment so the code can
 * be shared publicly. Keeping the values in one gitignored file means the
 * maintainer never has to export anything by hand, and a fresh clone simply
 * gets a script that asks for credentials it does not have — which is the
 * correct behaviour for someone else's bucket.
 */
function loadReleaseEnv() {
    if (!existsSync(ENV_FILE)) return false
    for (const line of readFileSync(ENV_FILE, 'utf-8').split('\n')) {
        const match = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/.exec(line)
        if (match && !process.env[match[1]]) process.env[match[1]] = match[2]
    }
    return true
}

/** Files on the site that carry download URLs. Verified, not assumed. */
const SITE_LINK_FILES = ['app/page.tsx', 'components/site-header.tsx', 'components/cta-section.tsx']

let failed = false

const log = (m) => console.log(m)
const pass = (n, d) => log(`  PASS  ${n}${d ? ` — ${d}` : ''}`)
const warn = (n, d) => log(`  WARN  ${n}${d ? ` — ${d}` : ''}`)
const section = (t) => log(`\n${t}`)

function fail(name, detail, fix) {
    failed = true
    log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
    if (fix) log(`        → ${fix}`)
}

/** Combined stdout+stderr; many CLIs report on stderr even when they succeed. */
function run(cmd, args, options = {}) {
    const r = spawnSync(cmd, args, { encoding: 'utf-8', ...options })
    return { ok: r.status === 0 && !r.error, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, status: r.status }
}

const dmgNames = (version) => [`cli-manager-${version}-arm64.dmg`, `cli-manager-${version}-x64.dmg`]

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

function preflight(version, { skipChangelog }) {
    section('Preflight')

    if (!/^\d+\.\d+\.\d+$/.test(version)) {
        fail('malformed version', version)
        return
    }

    for (const name of dmgNames(version)) {
        const path = join(RELEASE_DIR, name)
        if (existsSync(path)) pass(name, `${(statSync(path).size / 1024 / 1024).toFixed(0)}MB`)
        else fail(`missing ${name}`, '', 'run scripts/release.cjs --build first')
    }

    if (existsSync(UPLOAD_SCRIPT)) pass('upload script present')
    else fail('upload script missing', UPLOAD_SCRIPT)

    const missingR2 = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME']
        .filter((name) => !process.env[name])
    if (missingR2.length === 0) pass('R2 credentials loaded', existsSync(ENV_FILE) ? '.env.release' : 'environment')
    else fail('R2 credentials missing', missingR2.join(', '), `set them in ${ENV_FILE} or the environment`)

    if (existsSync(SITE_DIR)) {
        const dirty = run('git', ['status', '--porcelain'], { cwd: SITE_DIR })
            .out.split('\n').filter(Boolean).filter((l) => !l.startsWith('??'))
        if (dirty.length === 0) pass('website repo clean')
        else fail('website repo has uncommitted changes', dirty.join(', '), 'commit or stash there first')

        const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: SITE_DIR }).out.trim()
        if (branch === 'main') pass('website on main')
        else fail('website not on main', branch)
    } else {
        fail('website repo not found', SITE_DIR)
    }

    if (skipChangelog) {
        warn('changelog skipped')
        return
    }

    if (!process.env.DATABASE_URL) {
        fail('DATABASE_URL not set', '', 'export it, or pass --skip-changelog')
        return
    }
    const db = run('psql', [process.env.DATABASE_URL, '-t', '-A', '-c', 'select 1'])
    if (db.ok) pass('changelog database reachable')
    else fail('cannot reach changelog database', db.out.split('\n')[0])
}

// ---------------------------------------------------------------------------
// Step 1 — R2
// ---------------------------------------------------------------------------

function uploadToR2(version) {
    section('R2 upload')

    const result = run('node', [UPLOAD_SCRIPT, version], { cwd: ROOT, stdio: 'pipe' })
    if (!result.ok) {
        fail('upload failed', result.out.split('\n').slice(-3).join(' ').trim())
        return
    }
    pass('uploaded', dmgNames(version).join(', '))
}

/**
 * Asks the public CDN whether the files are really there.
 *
 * A successful upload API call is not the same fact as a working download URL,
 * and the website is about to point users at these exact addresses.
 */
function verifyR2(version) {
    section('R2 verification')

    for (const name of dmgNames(version)) {
        const url = `${R2_PUBLIC_BASE}/${name}`
        const head = run('curl', ['-sI', '-o', '/dev/null', '-w', '%{http_code} %{size_download}', '-L', url])
        const status = head.out.trim().split(' ')[0]

        if (status !== '200') {
            fail(`${name} not reachable`, `HTTP ${status}`, 'do not update the website until this serves')
            continue
        }

        // Compare the advertised length against the local artifact: a truncated
        // upload also answers 200.
        const lengthProbe = run('curl', ['-sI', '-L', url])
        const remote = Number(/content-length:\s*(\d+)/i.exec(lengthProbe.out)?.[1] ?? 0)
        const local = statSync(join(RELEASE_DIR, name)).size

        if (remote === local) pass(name, `200, ${(remote / 1024 / 1024).toFixed(0)}MB matches local`)
        else fail(`${name} size mismatch`, `remote ${remote} vs local ${local}`, 're-upload')
    }
}

// ---------------------------------------------------------------------------
// Step 2 — website
// ---------------------------------------------------------------------------

function currentSiteVersion() {
    const sample = readFileSync(join(SITE_DIR, SITE_LINK_FILES[0]), 'utf-8')
    return /cli-manager-(\d+\.\d+\.\d+)-/.exec(sample)?.[1] ?? null
}

function updateWebsite(version) {
    section('Website links')

    const previous = currentSiteVersion()
    if (!previous) {
        fail('could not read current version from the site', SITE_LINK_FILES[0])
        return
    }
    if (previous === version) {
        pass('already at this version', version)
        return
    }
    pass('current site version', previous)

    let changed = 0
    for (const rel of SITE_LINK_FILES) {
        const path = join(SITE_DIR, rel)
        if (!existsSync(path)) {
            fail(`missing ${rel}`)
            continue
        }
        const before = readFileSync(path, 'utf-8')
        const after = before.split(`cli-manager-${previous}-`).join(`cli-manager-${version}-`)
        if (after !== before) {
            writeFileSync(path, after)
            changed++
            pass(rel, 'updated')
        } else {
            warn(rel, 'no download URL found')
        }
    }

    if (changed === 0) {
        fail('no files were updated')
        return
    }

    // A file outside the known list would leave the old build linked somewhere.
    const stale = run('grep', ['-rn', `cli-manager-${previous}-`, '--include=*.tsx', '--include=*.ts', '.'], { cwd: SITE_DIR })
        .out.split('\n').filter((l) => l && !l.includes('node_modules'))
    if (stale.length === 0) pass('no stale version references remain')
    else fail('stale references still present', stale.slice(0, 3).join(' | '), 'add those files to SITE_LINK_FILES')
}

function commitWebsite(version) {
    section('Website publish')

    const dirty = run('git', ['status', '--porcelain'], { cwd: SITE_DIR })
        .out.split('\n').filter(Boolean).filter((l) => !l.startsWith('??'))
    if (dirty.length === 0) {
        pass('nothing to commit')
        return
    }

    for (const rel of SITE_LINK_FILES) run('git', ['add', rel], { cwd: SITE_DIR })
    const commit = run('git', ['commit', '-m', `chore: v${version} 다운로드 링크 갱신`], { cwd: SITE_DIR })
    if (!commit.ok) {
        fail('commit failed', commit.out.split('\n')[0])
        return
    }

    const push = run('git', ['push', 'origin', 'main'], { cwd: SITE_DIR })
    if (push.ok) pass('pushed', 'origin/main')
    else fail('push failed', push.out.split('\n').slice(-2).join(' '))
}

// ---------------------------------------------------------------------------
// Step 3 — changelog
// ---------------------------------------------------------------------------

function insertChangelog(version, notesPath) {
    section('Changelog')

    if (!existsSync(notesPath)) {
        fail('notes file not found', notesPath)
        return
    }
    const notes = JSON.parse(readFileSync(notesPath, 'utf-8'))

    const existing = run('psql', [
        process.env.DATABASE_URL, '-t', '-A',
        '-c', `select count(*) from changelogs where version = 'v${version}'`
    ])
    if (existing.out.trim() !== '0') {
        pass('changelog entry already exists', `v${version}`)
        return
    }

    const date = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    const jsonList = (items) => JSON.stringify((items ?? []).map((text) => ({ text })))

    // Values go through psql variables so quotes in the text cannot break the
    // statement or inject SQL. The SQL must arrive on **stdin**: psql does not
    // interpolate :'var' in a -c command string, it forwards it to the server
    // verbatim and the server rejects it as a syntax error.
    const sql = `
        INSERT INTO changelogs (version, date, title, description, improvements, fixes, is_featured)
        VALUES (:'v', :'d', :'t', :'desc', :'imp'::jsonb, :'fix'::jsonb, true);
    `
    const result = run('psql', [
        process.env.DATABASE_URL,
        '-v', 'ON_ERROR_STOP=1',
        '-v', `v=v${version}`,
        '-v', `d=${date}`,
        '-v', `t=${notes.title}`,
        '-v', `desc=${notes.description}`,
        '-v', `imp=${jsonList(notes.improvements)}`,
        '-v', `fix=${jsonList(notes.fixes)}`
    ], { input: sql })

    if (!result.ok) {
        fail('insert failed', result.out.split('\n').filter(Boolean).slice(-2).join(' '))
        return
    }

    const readBack = run('psql', [
        process.env.DATABASE_URL, '-t', '-A', '-F', '|',
        '-c', `select version, date, title from changelogs where version = 'v${version}'`
    ])
    if (readBack.out.trim()) pass('changelog inserted', readBack.out.trim())
    else fail('inserted but not readable back', 'check the table manually')
}

// ---------------------------------------------------------------------------

function main() {
    const args = process.argv.slice(2)
    const checkOnly = args.includes('--check')
    const skipChangelog = args.includes('--skip-changelog')
    const vi = args.indexOf('--version')
    const version = vi === -1 ? null : args[vi + 1]
    const ni = args.indexOf('--notes')
    const notesPath = ni === -1 ? null : args[ni + 1]

    if (!version) {
        console.error('Usage: node scripts/post-release.cjs --version X.Y.Z [--notes notes.json] [--check] [--skip-changelog]')
        return 1
    }

    log(`CLI Manager post-release${checkOnly ? ' preflight' : ''} — v${version}`)
    loadReleaseEnv()
    preflight(version, { skipChangelog })

    if (failed) {
        log('\nPREFLIGHT FAILED — nothing was uploaded or published.')
        return 1
    }
    if (checkOnly) {
        log('\nPreflight passed.')
        return 0
    }

    uploadToR2(version)
    verifyR2(version)
    if (failed) {
        log('\nR2 STEP FAILED — website not touched, so it still points at the previous release.')
        return 1
    }

    updateWebsite(version)
    if (failed) {
        log('\nWEBSITE UPDATE FAILED — nothing committed.')
        return 1
    }
    commitWebsite(version)

    if (!skipChangelog) {
        if (!notesPath) warn('changelog skipped', 'no --notes given')
        else insertChangelog(version, notesPath)
    }

    log(`\n${failed ? 'COMPLETED WITH FAILURES' : 'DONE'} — v${version} distributed.`)
    return failed ? 1 : 0
}

process.exit(main())
