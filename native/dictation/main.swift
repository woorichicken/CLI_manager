// climanager-dictation — on-device speech to text for the Chat view's mic button (macOS only).
//
// The app's main process runs this as a child and reads one JSON object per line from stdout:
//
//   climanager-dictation status            → {"type":"status", "supported", "onDevice", "locale", "speech", "mic"}
//   climanager-dictation listen            → {"type":"listening"} · {"type":"partial","text"} · {"type":"final","text"}
//                                             or {"type":"error","code","message"}; "stop" on stdin (or EOF) ends it
//
// Why a separate program: Electron has no speech recognizer of its own (Chromium's Web Speech API
// calls Google's servers with keys Electron does not ship). Apple's SFSpeechRecognizer is native-only.
//
// Audio never leaves the Mac: `requiresOnDeviceRecognition` is set, and a Mac that cannot recognize
// the language on the device reports `onDevice: false` — the app then hides the button instead of
// falling back to Apple's servers.
//
// Permissions belong to the app that launched this (macOS's "responsible process"): the app's
// Info.plist carries NSSpeechRecognitionUsageDescription and NSMicrophoneUsageDescription. Without
// them macOS kills this process (SIGABRT) the moment it asks — main reports that as `permission_setup`.

import AVFoundation
import Foundation
import Speech

setvbuf(stdout, nil, _IOLBF, 0)

/** One listening run is cut off after this long, so a forgotten mic does not stay open. */
let maxListenSeconds: Double = 300
/** After "stop", how long to wait for the recognizer's last result before giving what it has. */
let finalWaitSeconds: Double = 4

func emit(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object),
          let line = String(data: data, encoding: .utf8) else { return }
    print(line)
    fflush(stdout)
}

func fail(_ code: String, _ message: String) -> Never {
    emit(["type": "error", "code": code, "message": message])
    exit(2)
}

func speechStatus() -> String {
    switch SFSpeechRecognizer.authorizationStatus() {
    case .authorized: return "authorized"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .notDetermined: return "notDetermined"
    @unknown default: return "notDetermined"
    }
}

func micStatus() -> String {
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized: return "authorized"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .notDetermined: return "notDetermined"
    @unknown default: return "notDetermined"
    }
}

// The language the Mac is set to. A locale flag is accepted for tests and a later language setting.
var localeId: String? = nil
let arguments = CommandLine.arguments
if let index = arguments.firstIndex(of: "--locale"), index + 1 < arguments.count { localeId = arguments[index + 1] }
let recognizer: SFSpeechRecognizer? = localeId.map { SFSpeechRecognizer(locale: Locale(identifier: $0)) } ?? SFSpeechRecognizer()
let command = arguments.count > 1 ? arguments[1] : "status"

if command == "status" {
    emit([
        "type": "status",
        "supported": recognizer != nil,
        "onDevice": recognizer?.supportsOnDeviceRecognition ?? false,
        "locale": recognizer?.locale.identifier ?? "",
        "speech": speechStatus(),
        "mic": micStatus()
    ])
    exit(0)
}

guard command == "listen" else { fail("usage", "Unknown command: \(command)") }
guard let recognizer, recognizer.supportsOnDeviceRecognition else {
    fail("unsupported", "This Mac cannot recognize speech on the device for its language.")
}

// ---- permissions (each asks once; the answer is remembered by macOS) ---------------------------
if SFSpeechRecognizer.authorizationStatus() == .notDetermined {
    let asked = DispatchSemaphore(value: 0)
    SFSpeechRecognizer.requestAuthorization { _ in asked.signal() }
    asked.wait()
}
guard SFSpeechRecognizer.authorizationStatus() == .authorized else {
    fail("speech_denied", "Speech Recognition is off for CLI Manager. Turn it on in System Settings › Privacy & Security › Speech Recognition.")
}
if AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined {
    let asked = DispatchSemaphore(value: 0)
    AVCaptureDevice.requestAccess(for: .audio) { _ in asked.signal() }
    asked.wait()
}
guard AVCaptureDevice.authorizationStatus(for: .audio) == .authorized else {
    fail("mic_denied", "The microphone is off for CLI Manager. Turn it on in System Settings › Privacy & Security › Microphone.")
}

// ---- listening ---------------------------------------------------------------------------------
let engine = AVAudioEngine()
let request = SFSpeechAudioBufferRecognitionRequest()
request.requiresOnDeviceRecognition = true
request.shouldReportPartialResults = true
if #available(macOS 13, *) { request.addsPunctuation = true }

let input = engine.inputNode
let format = input.outputFormat(forBus: 0)
guard format.sampleRate > 0, format.channelCount > 0 else { fail("no_microphone", "No microphone is connected.") }
input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in request.append(buffer) }
engine.prepare()
do { try engine.start() } catch { fail("audio_failed", "Could not start the microphone: \(error.localizedDescription)") }

var lastText = ""
var stopping = false
var finished = false

/** Ends the run once: the last words as `final`, then exit. */
func finish(_ code: Int32) -> Never {
    if !finished {
        finished = true
        emit(["type": "final", "text": lastText])
    }
    exit(code)
}

func stopListening() {
    if stopping { return }
    stopping = true
    engine.stop()
    input.removeTap(onBus: 0)
    request.endAudio()
    // The recognizer usually answers within a second; never leave main waiting on it.
    DispatchQueue.main.asyncAfter(deadline: .now() + finalWaitSeconds) { finish(0) }
}

let task = recognizer.recognitionTask(with: request) { result, error in
    if let result {
        lastText = result.bestTranscription.formattedString
        if result.isFinal { finish(0) }
        emit(["type": "partial", "text": lastText])
    }
    if let error {
        // Stopping with nothing said ends in "no speech detected": that is an empty result, not a failure.
        if stopping { finish(0) }
        emit(["type": "error", "code": "recognition_failed", "message": error.localizedDescription])
        exit(3)
    }
}
_ = task

emit(["type": "listening", "locale": recognizer.locale.identifier])

// "stop" (or main closing stdin, or main going away) ends the run.
Thread.detachNewThread {
    while let line = readLine() {
        if line.trimmingCharacters(in: .whitespaces) == "stop" { break }
    }
    DispatchQueue.main.async { stopListening() }
}
DispatchQueue.main.asyncAfter(deadline: .now() + maxListenSeconds) { stopListening() }

RunLoop.main.run()
