---
version: 1
slug: "site-index-html"
primary_target: "site/index.html"
related_targets: ["site/styles.css","site/main.js"]
---

## Scope

Home page of the trenchscope site, `site/index.html` (static HTML/CSS/JS). Mode: Persuade.

## Audience and job

Solana memecoin traders who live in a terminal, and newcomers. They must see the real app working, believe it is local, keyless and non-custodial, and copy the install command.

## Constraints

- Brief-pinned direction (owner, 2026-10-18): black and white to match the CLI's `mono` theme; a high-end animated visual of the CLI going through its sections, after Trial's DeviceStage (`Projects/tape/components/docs/demos/device-stage.tsx`). No concept roll: the owner pinned the direction.
- The stage draws frames rendered by the app itself (`packages/cli/tools/site-frames.mjs` writes `site/tour.json` and `site/tour-narrow.json`). Regenerate them when the CLI look changes; never redraw the CLI by hand.
- Install names `trenchscope` on npm and Homebrew are not published yet (open decision in PRODUCT.md).
- Borrowed: Osmo scaling system, Osmo easings (osmo, energy, punch, smooth), Osmo 3D perspective hover (ported to plain rAF), the base kit's graphite dark tokens, React Bits Terminal Dark guidance (real output as hero, mono only for machine text, one frame language, hairline rules, a real table).

## Direction contract

THESIS: the page is the product running. The first viewport is trenchscope itself on a lit screen, cycling Launch, Screener, Token, New pairs, Analyst and Watchlist, drawn cell for cell by the app; it refuses the man-page costume and the dev-tool hero with invented code.

OWN-WORLD: ground #0a0a0a, the app's own background; ink #ededed and three greys; the only hues are the app's muted up/down and warning amber. Geist for prose, JetBrains Mono only for what you type or the machine prints. Reverse-video keycaps and chips, hairline rules, one frame language (outer 14 to 16, inner 10 to 12), a graphite bezel under a soft white spotlight.

STORY: see the real screens work, read one two-tone claim, copy the install, learn the analyst reads the same tool results, learn the keys, believe the safety rules, see every data source, install again.

FIRST VIEWPORT: two-tone headline left at about 4.6rem, install block with npm/brew/release tabs and copy at right on the same baseline, the stage's top edge rising into the lower third, tilted back 9 to 16 degrees.

FORM: brief-pinned device stage after Trial's DeviceStage; signature interaction: the tour plays real frames with a keystroke HUD and a chapter rail with progress, the screen straightens as it scrolls in (scroll-driven), leans slightly toward the pointer, pauses on hover, offscreen and by hand. seed: none (unavailable)

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
