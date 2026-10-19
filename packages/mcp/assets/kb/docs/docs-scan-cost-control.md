---
id: docs-scan-cost-control
title: AI scan mode › Cost control
kind: docs
page: scan
page_title: AI scan mode
heading: Cost control
anchor: cost-control
url: https://dexterm.xyz/docs/scan#cost-control
tags:
  - docs
  - scan
  - cost
  - control
  - mode
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/scan.md
date: 2026-10-16
---

Every analyst turn the scan starts counts against two caps: (generated from the app: see https://dexterm.xyz/docs/scan#cost-control; app-help has the exact keys and commands) per rolling hour and (generated from the app: see https://dexterm.xyz/docs/scan#cost-control; app-help has the exact keys and commands) per coin per hour; a lock needs budget for one turn. A refresh of the locked coin happens only when ≥ (generated from the app: see https://dexterm.xyz/docs/scan#cost-control; app-help has the exact keys and commands) s have passed since the last read, the analyst is idle, **and** the data materially moved (price ≥ (generated from the app: see https://dexterm.xyz/docs/scan#cost-control; app-help has the exact keys and commands)%, 5m buy share ≥ 10 points, 5m volume up or down 1.5×, or a new trigger). After a lock ends the same coin is barred for (generated from the app: see https://dexterm.xyz/docs/scan#cost-control; app-help has the exact keys and commands) min and no new lock happens for (generated from the app: see https://dexterm.xyz/docs/scan#cost-control; app-help has the exact keys and commands) s. The header meter shows `ai used/cap per h · coin n/4`.

In calm mode the scan adds no draws; measured idle CPU with the scan on was the same 2% median as off.
