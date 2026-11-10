#!/usr/bin/env node
/**
 * A stand-in for native/dictation (climanager-dictation) in T106/T107: the same stdout lines,
 * no microphone, no macOS permission prompt. Point CLIMANAGER_DICTATION_HELPER at this file.
 *
 *   FAKE_DICTATION_MODE  ok (default) · unsupported · mic_denied · abort · crash
 *                        pause — after the first two words the recognizer "starts over" (a pause in speech):
 *                        the next partials carry only the new words, and so does the final (BRIEF-add1)
 *   --audio-out <path>   writes a short silent WAV there, as the real helper writes the run's sound
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

const audioAt = process.argv.indexOf('--audio-out')
if (audioAt > 0 && process.argv[audioAt + 1]) fs.writeFileSync(process.argv[audioAt + 1], silentWav(), { mode: 0o600 })

/** 0.1 s of 16 kHz mono 16-bit silence — a valid RIFF/WAVE file. */
function silentWav() {
    const samples = 1600
    const data = samples * 2
    const buffer = Buffer.alloc(44 + data)
    buffer.write('RIFF', 0)
    buffer.writeUInt32LE(36 + data, 4)
    buffer.write('WAVE', 8)
    buffer.write('fmt ', 12)
    buffer.writeUInt32LE(16, 16)
    buffer.writeUInt16LE(1, 20) // PCM
    buffer.writeUInt16LE(1, 22) // mono
    buffer.writeUInt32LE(16000, 24)
    buffer.writeUInt32LE(32000, 28)
    buffer.writeUInt16LE(2, 32)
    buffer.writeUInt16LE(16, 34)
    buffer.write('data', 36)
    buffer.writeUInt32LE(data, 40)
    return buffer
}

emit({ type: 'listening', locale: 'ko_KR' })
let heard = 0
/** in `pause` mode the recognizer's result restarts after this many words */
const PAUSE_AFTER = 2
const spoken = () => (mode === 'pause' && heard > PAUSE_AFTER ? words.slice(PAUSE_AFTER, heard) : words.slice(0, heard)).join(' ')
const timer = setInterval(() => {
    if (heard < words.length) {
        heard += 1
        emit({ type: 'partial', text: spoken() })
    }
}, 150)

let ended = false
const end = () => {
    if (ended) return
    ended = true
    clearInterval(timer)
    log('end')
    emit({ type: 'final', text: `${spoken()}${heard > 0 ? '.' : ''}` })
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
