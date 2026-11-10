// The running text of one dictation run, across pauses (BRIEF-add1, 11-09: a pause wiped the words before it).
//
// SFSpeechRecognizer sends each result as the whole phrase so far — until the speaker pauses. Then the
// next result holds only the new words and starts over. Taking each result as "the text" wiped
// everything said before the pause.
//
// A result that does not continue the current one starts a new segment; the current one is kept.
// It continues when it extends it ("hello" → "hello world"), or is a revision: a prefix of it, longer
// than it, or beginning with the same word ("hello world" → "hello word"). Only a shorter result with
// another first word is a pause ("hello world" → "next"). After an utterance end the recognizer
// reports itself (macOS 14+ metadata) anything that does not extend it is new.
//
// Keep this the same as src/shared/dictationTranscript.ts: T106 runs both over
// tests/terminal/fixtures/dictation-transcript-cases.json (this one through `climanager-dictation accumulate`).

import Foundation

struct Transcript {
    private(set) var committed: [String] = []
    private(set) var segment = ""
    private(set) var sealed = false

    mutating func add(_ text: String, utteranceEnd: Bool = false) {
        // an empty result says nothing new; it must not wipe what was heard
        if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            if utteranceEnd { sealed = true }
            return
        }
        if startsNewSegment(text) {
            committed.append(segment.trimmingCharacters(in: .whitespacesAndNewlines))
        }
        segment = text
        sealed = utteranceEnd
    }

    var text: String {
        (committed + [segment.trimmingCharacters(in: .whitespacesAndNewlines)]).filter { !$0.isEmpty }.joined(separator: " ")
    }

    private func startsNewSegment(_ next: String) -> Bool {
        if segment.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return false }
        if next.hasPrefix(segment) { return false }
        if sealed { return true }
        // Swift counts characters, TypeScript UTF-16 units: the same for the scripts dictation types
        if segment.hasPrefix(next) || next.count >= segment.count { return false }
        return Transcript.firstWord(next) != Transcript.firstWord(segment)
    }

    /** The first word without punctuation or case, to tell a revision from new words. */
    static func firstWord(_ text: String) -> String {
        let word = text.split(whereSeparator: { $0.isWhitespace }).first.map(String.init) ?? ""
        let kept = word.unicodeScalars.filter { !CharacterSet.punctuationCharacters.contains($0) && !CharacterSet.symbols.contains($0) }
        return String(String.UnicodeScalarView(kept)).lowercased()
    }
}
