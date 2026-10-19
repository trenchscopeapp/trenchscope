---
id: docs-voice-the-voice-neural-by-default
title: Jarvis voice mode › The voice: neural by default
kind: docs
page: voice
page_title: Jarvis voice mode
heading: The voice: neural by default
anchor: the-voice-neural-by-default
url: https://dexterm.xyz/docs/voice#the-voice-neural-by-default
tags:
  - docs
  - voice
  - neural
  - default
  - jarvis
  - mode
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/voice.md
date: 2026-10-16
---

dexterm speaks with a **neural British voice** (Piper, `en_GB-alan-medium`) — the one chosen as the default. It is free, local and keyless, and sounds markedly more natural than the built-in system voices. It is the default speaking voice everywhere it is installed, on macOS as well as Linux, with the system `say` voice as the fallback.

On macOS, run `dexterm voice setup` once to install it. The prebuilt macOS Piper binary from upstream is broken (it needs a system library it does not bundle), so dexterm instead builds its own private Python environment under `~/.dexterm/piper/` and installs Piper into it, then downloads the ~61 MB voice from the official source and checks it against a pinned checksum. It asks before it does any of this, needs Python 3.9+ (the doctor prints the exact install line if it is missing), runs fully offline afterwards, and ships no key. `dexterm voice uninstall` removes the runtime and keeps the downloaded voice model (add `--purge-model` to delete that too); the fallback `say` voice takes over again. Off macOS, install the prebuilt Piper binary and run `dexterm voice download piper-voice`.

```sh
$ dexterm voice setup                    # macOS: private runtime + checksum-verified voice (asks first)
$ dexterm voice status                   # which engines and models this machine has
$ dexterm voice uninstall                # remove the runtime (add --purge-model to drop the voice too)
```

Once Piper is installed it is used automatically — no config change. The model is kept pre-warmed while voice is on, so the first word of a reply starts in about a fifth of a second. `voice.rate` still maps to its speaking speed; a `voice.pitch` setting does not apply to Piper (its pitch is fixed by the model) and is ignored.

**The fallback chain.** dexterm picks the first engine that can speak on this machine, and never a novelty voice or the machine's own system voice:

| platform | 1st | 2nd | then |
| --- | --- | --- | --- |
| macOS | Piper `en_GB-alan-medium` (after `dexterm voice setup`) | `say` with a deep British male voice (Eddy, then Daniel, then the next installed one on that list) | text only: the analyst still answers on screen |
| Linux (beta) | Piper (prebuilt binary + `dexterm voice download piper-voice`) | `espeak-ng` with a British male voice | text only |

Set `DEXTERM_VOICE_TTS` to `piper`, `say`, `espeak` or `none` to pin one engine. An explicit `say` never switches to Piper.

**Speed and delivery.** `<` slows the spoken reply and `>` speeds it up, 15 words a minute per press between 120 and 320 (the default is 205). The new rate is saved to `voice.rate` in `config.json`. Numbers are read the way a trader says them: a sub-cent price is spoken as the coin's market cap when the line includes one, and otherwise as "a tiny price". Years and SOL amounts are read as written. On the screener, "this one", "this coin" or "it" means the highlighted row.
