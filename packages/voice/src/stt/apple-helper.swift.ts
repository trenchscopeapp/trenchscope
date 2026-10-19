// The Swift source for the Apple Speech helper, kept as a string so the package ships no build step.
// AppleStt writes it to a cache dir and compiles it with `swiftc` on first use (SPEC: an Apple Speech
// helper compiled on the fly with swiftc if present). It uses on-device recognition (no key, no
// network) and streams NDJSON to stdout: {"type":"partial","text":...} … {"type":"final","text":...}.
//
// Protocol: it listens until it reads a line on stdin (the app writes "stop\n") or gets SIGINT, then
// prints the final line and exits 0. On authorization/denial it prints {"type":"error",...} and exits 1.

export const APPLE_HELPER_SWIFT = String.raw`
import Foundation
import AVFoundation
import Speech

// Line-buffered stdout so Node sees partials immediately.
setvbuf(stdout, nil, _IOLBF, 0)

func emit(_ obj: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: obj),
       let s = String(data: data, encoding: .utf8) {
        print(s)
    }
}

let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
guard let recognizer = recognizer, recognizer.isAvailable else {
    emit(["type": "error", "message": "no speech recognizer available"]); exit(1)
}

let sem = DispatchSemaphore(value: 0)
var authorized = false
SFSpeechRecognizer.requestAuthorization { status in
    authorized = (status == .authorized)
    sem.signal()
}
sem.wait()
guard authorized else { emit(["type": "error", "message": "speech recognition not authorized"]); exit(1) }

let audioEngine = AVAudioEngine()
let request = SFSpeechAudioBufferRecognitionRequest()
request.shouldReportPartialResults = true
if #available(macOS 10.15, *) { request.requiresOnDeviceRecognition = true }

var finalText = ""
var finalConfidence = 1.0
var lastError = ""
let doneSem = DispatchSemaphore(value: 0)
var gotFinal = false
let task = recognizer.recognitionTask(with: request) { result, error in
    if let result = result {
        let text = result.bestTranscription.formattedString
        finalText = text
        let segs = result.bestTranscription.segments
        if !segs.isEmpty { finalConfidence = Double(segs.map { $0.confidence }.reduce(0, +)) / Double(segs.count) }
        emit(["type": "partial", "text": text])
        if result.isFinal && !gotFinal { gotFinal = true; doneSem.signal() }
    }
    if let e = error {
        // "No speech detected" (1110) and "cancelled" (216/301) are an empty result, not a failure.
        let ns = e as NSError
        if ![1110, 216, 301].contains(ns.code) { lastError = "\(e)" }
        if !gotFinal { gotFinal = true; doneSem.signal() }
    }
}

let input = audioEngine.inputNode
let format = input.outputFormat(forBus: 0)
input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in request.append(buffer) }
audioEngine.prepare()
do { try audioEngine.start() } catch {
    emit(["type": "error", "message": "could not start audio engine: \(error)"]); exit(1)
}
emit(["type": "ready"])

var finishing = false
let finishLock = NSLock()
func finish() {
    finishLock.lock()
    if finishing { finishLock.unlock(); return }
    finishing = true
    finishLock.unlock()
    audioEngine.stop()
    input.removeTap(onBus: 0)
    request.endAudio()
    // The last words of an utterance arrive with the FINAL result, not the last partial: wait for it
    // (bounded) instead of a fixed sleep, so a short phrase is not lost.
    _ = doneSem.wait(timeout: .now() + 2.0)
    task.finish()
    if finalText.isEmpty && !lastError.isEmpty { emit(["type": "error", "message": lastError]) }
    emit(["type": "final", "text": finalText, "confidence": finalConfidence])
    exit(0)
}

signal(SIGINT) { _ in finish() }

// Stop when the parent writes a line to our stdin.
DispatchQueue.global().async {
    while let line = readLine(strippingNewline: true) {
        if line == "stop" { finish() }
    }
    finish() // stdin closed -> stop
}

RunLoop.main.run()
`;
