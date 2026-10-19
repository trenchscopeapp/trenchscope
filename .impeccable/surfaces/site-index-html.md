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

- Brief-pinned direction (owner, 2026-10-18): a high-end animated visual of the CLI going through its sections, after Trial's DeviceStage (`Projects/tape/components/docs/demos/device-stage.tsx`). No concept roll: the owner pinned the direction. Superseded in part on 2026-10-19: the black and white mono palette and the Spline Sans Mono pin were replaced by the green-tinted palette and the Spline Sans pairing (see the dated section below).
- The stage draws frames rendered by the app itself (`packages/cli/tools/site-frames.mjs` writes `site/tour.json`, `site/tour-narrow.json` and `site/tour-analyst.json`). Regenerate them when the CLI look changes; never redraw the CLI by hand. The screen content keeps the CLI `mono` theme; only the page chrome is green-tinted.
- Install names `trenchscope` on npm and Homebrew are not published yet (open decision in PRODUCT.md).
- Borrowed: Osmo scaling system, Osmo easings (osmo, energy, punch, smooth), Osmo Typewriter and Button 069, Osmo 3D perspective hover (ported to plain rAF), React Bits Spotlight Card and Rubber Segment, React Bits Terminal Dark guidance (real output as hero, one frame language, a real table), Trial's DeviceStage.

## Direction contract

THESIS: the page is the product running. The first viewport is trenchscope itself on a lit device, cycling Launch, Screener, Token, New pairs, Analyst and Watchlist, drawn cell for cell by the app; it refuses the man-page costume and the dev-tool hero with invented code.

OWN-WORLD: page #080a09 with card surface #0e1310, selected #19211c, border #29352e, hairline #1a221d; text #edf2ee, #a5b0a8, #7c887f (#4a564e for non-text only); one green accent #4ade80, with coral #f2877e and amber #d9b46a for state. Spline Sans for prose (lede 18px on 28px); Spline Sans Mono for headlines (bold, tight tracking), labels, commands and technical text; JetBrains Mono only for terminal cells and the trench. The terminal screen keeps the CLI's own mono theme frames. One control language: spotlight card, rubber segment, command band, white Copy button. Graphite bezel with a green under-glow.

STORY: see the real screens work (with the events they show), read one claim, copy the install, learn the analyst reads the same tool results and hook up an agent, learn the keys, believe the safety rules, see every data source, install again.

FIRST VIEWPORT: headline left in Spline Sans Mono bold at 4.5rem with a Spline Sans lede, the installer card at right on the same baseline, the stage device rising into the lower third, tilted back 7deg.

FORM: device stage after Trial's DeviceStage; signature interaction: the real tour plays in a bezel tilted back 7deg that flattens on hover or focus (flat on phones and reduced motion), with the chapter rail inside the bezel (six tabs, sliding pill, per-chapter caption, Pause), progress as a lit line on the screen's top edge, the keystroke HUD, and an events row under the stage that changes with the chapter. The analyst panel is a second, smaller leaning device. Cards carry a soft shadow. seed: none (unavailable)

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Layout refinement, owner 2026-10-19 (earlier that day; still in force)

Keep the original visual direction (the visual direction itself was later changed, see the next section). The owner rejected the Evidence Sheet redesign and asked for a slightly tighter layout because the original felt too big and zoomed in. Cap the responsive root scale at 1rem, use a narrower content measure, and reduce large headings and section gaps. Preserve the fonts, colors, ASCII trench, bezel, app frames, content and interactions.

The owner also requested removal of decorative blinking carets site-wide. Keep the animated ASCII background aligned above the demo as the layout compacts; do not replace its established look.

Background correction, owner screenshot 2026-10-19: the live shader and old far-ridge raster overlapped at different glyph scales. In live mode, hide every raster layer. The original plates belong only to the fallback renderer. Verify both states and fractional display scaling before claiming the overlap resolved.

## Green redesign, owner 2026-10-19 (approved, merged, live on https://www.trenchscope.dev)

Superseded by this section:
- The 2026-10-18 pin to black and white matching the CLI mono theme, for page chrome. The screen content still renders the mono theme; `packages/tui/src/theme.ts` did not change.
- The 2026-10-18 pin of Spline Sans Mono for everything: prose now uses Spline Sans and headlines and technical text keep Spline Sans Mono, the role split the redesign brief asked for. The brief's Spline Sans suggestion was tried and dropped because the design detector lists it as an overused font. JetBrains Mono still sets cells and the trench.
- "Stage v2" (flat screen, chapter pill above the screen, no tilt). The stage now tilts back 7deg and the rail lives inside the bezel.
- The DESIGN.md "Flat Content Rule" (no shadows on content) and "One Lit Object Rule" (only the stage leans). Cards now carry a soft shadow and two devices lean (stage and analyst panel). Owner-directed.
- The earlier install well, vertical agent rail and the frame component for the analyst panel.

Changes:
- Palette: surface roles from the owner's brief (page #080a09, surface #101411, cards #0e1310, selected #19211c, border #29352e, hairline #1a221d, text #edf2ee, #a5b0a8, #7c887f, faint #4a564e non-text). One accent green `--pop-up` #4ade80, `--pop-down` #f2877e, warn #d9b46a, `--pop-warn` #f5c451.
- Stage: graphite bezel tilted back 7deg (rotateX, origin bottom), flat on hover or focus, phones and reduced motion. Rail inside the bezel; progress on the screen's top edge; HUD kept; green under-glow; caption with the live dot and 160x46 size. Hover pauses only on the screen.
- Events row replaced a scrolling ticker on purpose (a marquee hides half its content): five real events per chapter from the sample frames, 45ms stagger, three on phones.
- Installer (hero and closing section, same component): Spotlight Card, Rubber Segment with Apple, Windows and npm logos, full-bleed command band with a short command typed by an Osmo Typewriter port and a green block caret, a white Copy button (Osmo Button 069 shuffle, turns green "Copied"), meta line with doctor and a source link. Copy takes the full commands.
- Agent hookup: same parts; cli or config segment, agent icon switch with names (icons only under 560px), command band with Copy (and Open for Cursor); config held at eight lines.
- Analyst panel: small bezel device turned toward the copy (rotateY -8deg) until hover, with a device bar, cropped to 21 rows, resting on the last clean frame.
- Cards: analyst and safety rules are tiled cards with a 28px green-tinted icon square; keylist, sources table and setup FAQ share the card surface; known issues is an amber callout.
- Terminal glyphs under 1.4:1 contrast on their background (the app's decrypt fade) render as empty cells.
- Unchanged: `og.png` is the media-studio keycap banner matching the X banner (job 20261019-164232-trenchscope-og-5d80, wordmark still in Spline Sans Mono); `og.html` is a legacy card. Easings osmo, energy, punch, smooth, plus `--ease-out` on the stage. No arrows on buttons.
