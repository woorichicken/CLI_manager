#!/usr/bin/env node
/**
 * A stand-in for native/dictation (climanager-dictation) in T106/T107: the same stdout lines,
 * no microphone, no macOS permission prompt. Point CLIMANAGER_DICTATION_HELPER at this file.
 *
 *   FAKE_DICTATION_MODE  ok (default) · unsupported · mic_denied · abort · crash
 *   FAKE_DICTATION_LOG   a file; each run appends "status", "listen", "stop", "end" lines
 *   FAKE_DICTATION_WORDS the phrase it "hears", grown word by word (default: 안녕하세요 받아쓰기 시험입니다)
 */
const fs = require('fs')

const mode = process.env.FAKE_DICTATION_MODE || 'ok'
const words = (process.env.FAKE_DICTATION_WORDS || '안녕하세요 받아쓰기 시험입니다').split(' ')
const log = (line) => {
    if (process.env.FAKE_DICTATION_LOG) fs.appendFileSync(process.env.FAKE_DICTATION_LOG, `${line}\n`)
}
const emit = (object) => process.stdout.write(`${JSON.stringify(object)}\n`)
const command = process.argv[2] || 'status'
log(command)

if (command === 'status') {
    emit({ type: 'status', supported: true, onDevice: mode !== 'unsupported', locale: 'ko_KR', speech: 'authorized', mic: 'authorized' })
    process.exit(0)
}

if (mode === 'mic_denied') {
    emit({ type: 'error', code: 'mic_denied', message: 'The microphone is off for CLI Manager. Turn it on in System Settings › Privacy & Security › Microphone.' })
    process.exit(2)
}
if (mode === 'abort') process.kill(process.pid, 'SIGABRT')
if (mode === 'crash') process.exit(9)

emit({ type: 'listening', locale: 'ko_KR' })
let heard = 0
const timer = setInterval(() => {
    if (heard < words.length) {
        heard += 1
        emit({ type: 'partial', text: words.slice(0, heard).join(' ') })
    }
}, 150)

let ended = false
const end = () => {
    if (ended) return
    ended = true
    clearInterval(timer)
    log('end')
    emit({ type: 'final', text: `${words.slice(0, heard).join(' ')}${heard > 0 ? '.' : ''}` })
    process.exit(0)
}
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
    input += chunk
    if (input.split('\n').some((line) => line.trim() === 'stop')) {
        log('stop')
        end()
    }
})
process.stdin.on('end', end)
process.on('SIGTERM', () => {
    log('killed')
    process.exit(143)
})
