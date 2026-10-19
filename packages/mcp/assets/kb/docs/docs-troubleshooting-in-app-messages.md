---
id: docs-troubleshooting-in-app-messages
title: Troubleshooting › In-app messages
kind: docs
page: troubleshooting
page_title: Troubleshooting
heading: In-app messages
anchor: in-app-messages
url: https://dexterm.xyz/docs/troubleshooting#in-app-messages
tags:
  - docs
  - troubleshooting
  - in-app
  - messages
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/troubleshooting.md
date: 2026-10-16
---

| message | meaning |
|---|---|
| `connecting to the live feed…` | the first DexScreener list has not landed yet; skeleton rows show in the meantime |
| `offline — can't reach the data feed` | no source answered; run `dexterm doctor`. `r` retries. |
| `rate-limited — backing off` | a source returned 429; the limiter pauses it (30 s, doubling to 10 min) and other sources keep going |
| `unavailable: <reason>` / `needs key` in a panel | that panel's source is down or needs a key; nothing is fabricated |
| `cached Nm old · refreshing` | the screener painted its last snapshot while fresh rows load |
| `claude is not logged in` in the analyst panel | run `claude login` and retry |
| `analyst busy; Esc to interrupt before vetting` | one run per conversation at a time; `esc` interrupts it |
| `open links needs live mode` / `paper trading needs live mode` | fixtures and one-shot frames have no real links or quotes |
| `AI scan needs live data (or --replay FILE)` | the scan has nothing real to watch on fixtures |
| `AI scan blocked analyst action "…" · observe-only` | the model tried an action during a scan and the app refused it; this is the safety layer working |
| `rate limited by Jupiter — retrying…` on a ticket | the keyless quote bucket is paused; the confirm retries for up to 8 s, then lets you retry or cancel |
| `chart opened in browser (<reason>)` | the native shell is not built or has no display; the page says why too |
| `voice-in unavailable — type your question instead` | no speech-to-text engine on this Mac (no `swiftc`, or no whisper-cli + model + sox/ffmpeg); replies are still spoken. `dexterm doctor` prints the 2-minute fix |
| `mic/STT could not start: …` | the Apple Speech helper could not be spawned or macOS denied Microphone / Speech permission; voice stays idle and the keyboard works. Allow the permissions in System Settings › Privacy & Security, or set `DEXTERM_VOICE_STT=whisper` |
| `mic timed out — press v to talk again` | the mic was live for 15 s with no second `v`; it closed itself |
| `I don't see a token called X` / `I see 2 tokens called X` | voice never guesses a coin: open the exact token first, then say buy or sell |
