---
name: trenchscope
description: A terminal for the trenches. The page is the product running: a real CLI on a tilted graphite device, on green-tinted near-black, with one green accent.
colors:
  page: "#080a09"
  surface: "#101411"
  card: "#0e1310"
  well: "#090c0a"
  selected: "#19211c"
  border: "#29352e"
  hairline: "#1a221d"
  ink: "#edf2ee"
  ink-body: "#a5b0a8"
  ink-quiet: "#7c887f"
  ink-faint: "#4a564e"
  ink-bright: "#ffffff"
  pop-up: "#4ade80"
  pop-down: "#f2877e"
  pop-warn: "#f5c451"
  warn: "#d9b46a"
  up: "#7cc794"
  down: "#e8847c"
  bezel-top: "#2b302d"
  bezel-mid: "#161917"
  bezel-low: "#0b0d0c"
  bezel-edge: "#39403b"
  rail-track: "#070908"
typography:
  headline:
    fontFamily: "Spline Sans Mono, ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "4.5rem"
    fontWeight: 700
    lineHeight: 0.98
    letterSpacing: "-0.045em"
  display:
    fontFamily: "Spline Sans Mono, ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "4rem"
    fontWeight: 600
    lineHeight: 0.98
    letterSpacing: "-0.04em"
  title:
    fontFamily: "Spline Sans Mono, ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "2.125rem"
    fontWeight: 600
    lineHeight: 1.1
    letterSpacing: "-0.035em"
  lede:
    fontFamily: "Spline Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 400
    lineHeight: "1.75rem"
  sub:
    fontFamily: "Spline Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.0625rem"
    fontWeight: 400
    lineHeight: 1.6
  body:
    fontFamily: "Spline Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.65
  card-title:
    fontFamily: "Spline Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 600
    letterSpacing: "-0.01em"
  label:
    fontFamily: "Spline Sans Mono, ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "0.8125rem"
    fontWeight: 500
    lineHeight: 1.6
    fontFeature: "\"liga\" 0"
  command:
    fontFamily: "Spline Sans Mono, ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: 1
    fontFeature: "\"liga\" 0"
  cell:
    fontFamily: "JetBrains Mono, ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: "18px"
rounded:
  chip: "4px"
  key-inline: "5px"
  button: "8px"
  segment: "10px"
  callout: "12px"
  card: "16px"
  screen: "0.75rem"
  bezel: "1.375rem"
  bezel-narrow: "1rem"
spacing:
  gutter: "2.5rem"
  gutter-narrow: "1rem"
  section: "6.5rem"
  section-narrow: "4.25rem"
  bar: "3.75rem"
  bar-narrow: "3.5rem"
  wrap-max: "80rem"
  card-pad: "0.875rem"
  stage-max: "76rem"
components:
  button-ink:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.page}"
    rounded: "{rounded.button}"
    padding: "0 1rem"
    height: "2.5rem"
  button-ink-hover:
    backgroundColor: "{colors.ink-bright}"
  copy-button:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.page}"
    typography: "{typography.card-title}"
    rounded: "{rounded.button}"
    padding: "0 0.875rem"
    height: "2.375rem"
  copy-button-done:
    backgroundColor: "{colors.pop-up}"
    textColor: "#04210e"
  installer:
    backgroundColor: "{colors.card}"
    rounded: "{rounded.card}"
    padding: "{spacing.card-pad}"
  segment:
    backgroundColor: "#0a0d0b"
    rounded: "{rounded.segment}"
    padding: "3px"
  segment-thumb:
    backgroundColor: "{colors.selected}"
    rounded: "7px"
  segment-item:
    textColor: "{colors.ink-quiet}"
    typography: "{typography.label}"
    height: "1.875rem"
    padding: "0 0.6875rem"
  segment-item-selected:
    textColor: "{colors.ink}"
  command-band:
    backgroundColor: "{colors.well}"
    textColor: "{colors.ink}"
    typography: "{typography.command}"
    height: "3.25rem"
    padding: "0 0.5rem 0 1.375rem"
  bezel:
    backgroundColor: "{colors.bezel-mid}"
    rounded: "{rounded.bezel}"
    padding: "0.625rem"
  screen:
    backgroundColor: "{colors.page}"
    textColor: "{colors.ink}"
    rounded: "{rounded.screen}"
  chapter-tab:
    textColor: "{colors.ink-quiet}"
    typography: "{typography.label}"
    rounded: "{rounded.button}"
    height: "2.25rem"
  chapter-tab-current:
    textColor: "{colors.ink}"
  chapter-pill:
    backgroundColor: "#1a231e"
    rounded: "{rounded.button}"
  key-badge-current:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.page}"
    rounded: "{rounded.chip}"
    size: "18px"
  rule-card:
    backgroundColor: "{colors.card}"
    textColor: "{colors.ink-body}"
    padding: "1.125rem 1.25rem 1.25rem"
  rule-icon:
    backgroundColor: "{colors.selected}"
    textColor: "{colors.pop-up}"
    rounded: "7px"
    size: "1.75rem"
  keycap:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.page}"
    rounded: "7px"
    size: "2.25rem"
  event-kind:
    backgroundColor: "#151b17"
    textColor: "{colors.ink-body}"
    rounded: "{rounded.chip}"
  callout-warn:
    textColor: "{colors.ink-body}"
    rounded: "{rounded.callout}"
    padding: "0.875rem 1.125rem"
---

# Design System: trenchscope

## Overview

**Creative North Star: "The Lit Device"**

The page is the product running. The real CLI, drawn cell for cell by the app itself, plays inside a graphite bezel that is tilted back 7deg like a device on a desk and flattens when you reach for it. Everything else on the page is quiet enough to let it be the brightest thing. Surfaces are near-black tinted green (#080a09 page, #0e1310 cards), text is a soft green-white, and there is exactly one accent: a green (#4ade80) that means live, selected or confirmed.

The page chrome and the terminal screen are now two palettes. The chrome follows the owner's surface-role brief (2026-10-19). The screen still renders the CLI's own `mono` theme frames, which are generated tour data, so the screen content stays black, white and grey with the app's muted up and down. Nothing in `packages/tui/src/theme.ts` changed.

Prose is set in Spline Sans; headlines, labels, commands and anything technical are set in Spline Sans Mono; JetBrains Mono draws only terminal cells and the trench. Controls share one language: a card with an inset 1px border, a segmented switch whose thumb stretches and lands, and a command band with a Copy button. Behind it all runs a full-bleed ASCII trench that steps back past the first screen.

**Key Characteristics:**
- Green-tinted surface roles, one green accent, a white Copy button as the strongest control.
- Two leaning devices: the stage and the analyst panel. Cards carry a soft shadow.
- One component family reused for the installer (hero and closing section) and the agent hookup: spotlight card, rubber segment, command band, Copy.
- Rem-scaled layout (Osmo scaling) so the composition holds its proportions between design frames.
- Four named easings plus `--ease-out` on the stage; reduced motion removes all animation.

## Colors

Green-tinted near-black with a soft green-white text ladder. The frontmatter is normative for every value.

### Primary
- **Signal Green** (`pop-up`, #4ade80): the one accent. Live dot, chapter progress line and pill underline, the `$` prompt, the caret, Copy when copied, rule icons, focus rings on the switches, the period that ends every heading, text selection, hover underlines, events marked up, the newest candle in the trench.

### Secondary (state hues, used sparingly)
- **Coral Down** (`pop-down`, #f2877e): events marked down, click sparks, the trench's red candles.
- **Amber** (`warn`, #d9b46a): the known-issues callout (tinted fill and inset hairline) and warn events. `pop-warn` (#f5c451) colours the bold lead-in of notes.
- **Muted up and down** (`up` #7cc794, `down` #e8847c): the CLI's price colours. They appear inside the rendered screen; the page chrome does not use them.

### Neutral
- **Page** (`page`, #080a09): background, the screen background, and the text on ink fills. **Surface** (`surface`, #101411): supporting surface. **Card** (`card`, #0e1310): installer, agent panel, rule cards, keylist, sources table and FAQ. **Well** (`well`, #090c0a): the command band, which is deeper than the card around it.
- **Selected** (`selected`, #19211c): the selected segment, hover fills and chips.
- **Border** (`border`, #29352e): the inset 1px edge of every card and the Pause control. **Hairline** (`hairline`, #1a221d): rules between rows, the bar border, command band edges.
- **Ink** (`ink`, #edf2ee): primary text and the Copy and Install fills. `ink-bright` (#ffffff) is the hover of those fills only.
- **Ink Body** (`ink-body`, #a5b0a8): supporting text. **Ink Quiet** (`ink-quiet`, #7c887f): captions, inactive tabs, meta. **Ink Faint** (`ink-faint`, #4a564e): non-text only (paused dot, link underlines, separators).
- **Bezel set** (`bezel-top`, `bezel-mid`, `bezel-low`, `bezel-edge`, `rail-track`): the graphite of the device, used by the stage bezel and the analyst device only. Its gradient runs #2b302d, #161917, #0b0d0c, #222724.

### Named Rules
**The Two Palettes Rule.** Page chrome uses the tokens above. The terminal screen renders the CLI's `mono` theme frames (generated by `packages/cli/tools/site-frames.mjs`), so its colours come from the app, not from this file. Do not recolour screen content to match the page, and do not hand-edit frames. Terminal glyphs whose colour is under 1.4:1 contrast on their background (the app's decrypt fade) render as empty cells on the page.

**The One Green Rule.** Green means live, selected or confirmed. No second accent, no gradient fills with hue beyond the soft green under-glow of the devices.

**The Strongest Control Rule.** The Copy button (ink fill, page text) and the Install button are the only solid light fills. It turns green and reads "Copied" on success.

## Typography

**Prose Font:** Spline Sans (400, 500, 600), with ui-sans-serif.
**Headline and Technical Font:** Spline Sans Mono (400 to 700), with ui-monospace, SF Mono, Menlo. Ligatures off.
**Cell Font:** JetBrains Mono (400, 700), for terminal cells and the trench only, for its box-drawing and block coverage.

Spline Sans Mono was the owner pin for everything on 2026-10-18. The 2026-10-19 redesign brief split prose from technical text and suggested Spline Sans as a pairing to test; Spline Sans is on the design detector's overused-font list, so the same split is kept in the site's own family instead: Spline Sans for prose, Spline Sans Mono for headlines and technical text (the face the wordmark and og.png already use). Spline Sans and Spline Sans Mono are self-hosted (latin subset, `site/assets/fonts/`) and preloaded, with metric-matched system fallbacks (Arial and Courier New sized to the same advance, ascent and descent) so text never re-wraps when they arrive; JetBrains Mono loads from Google Fonts without blocking render, since only the terminal cells use it.

**Character:** a quiet sans for reading and a tight bold mono for headlines, labels and commands, so the page reads like a technical product, with the terminal as the only place the cell font appears.

### Hierarchy
- **Headline** (Spline Sans Mono 700, 4.5rem, 0.98, -0.045em): the hero line. 2.375rem to 2.5rem on phones.
- **Display** (Spline Sans Mono 600, 4rem, 0.98, -0.04em): the single safety statement, capped at 10ch. 2.75rem on phones.
- **Title** (Spline Sans Mono 600, 2.125rem, 1.1, -0.035em): section headings, capped at 24ch. 1.75rem on phones.
- **Lede** (Spline Sans 400, 18px on 28px, 34em): hero lede. 16px on 26px on phones. **Sub** (Spline Sans 400, 1.0625rem, 1.6, 46ch): section subtext.
- **Body** (Spline Sans 400, 0.9375rem, 1.65): prose; descriptions cap near 52ch.
- **Card title** (Spline Sans 600, 0.875rem, -0.01em): installer, agent panel and rule card titles.
- **Label** (Spline Sans Mono 500, 0.78125rem to 0.8125rem): chapter tabs, segment items, table heads, footer.
- **Command** (Spline Sans Mono 400, 0.8125rem): the typed command in the band, inline code, events.
- **Cell** (JetBrains Mono 400, 14px on an 18px row): the tour grid, scaled by transform to its box.

### Named Rules
**The Machine Voice Rule.** Mono is for headlines, labels, commands, keys and source names. Sentences are Spline Sans.

**The Tight Display Rule.** Letter-spacing tightens as size grows (-0.035em at title, -0.04em at display, -0.045em at headline); body stays at 1.6 to 1.75.

## Layout

An Osmo scaling system sets the root: `--size-container` is the viewport clamped between a min and max, and `html` font-size is that container divided by (ideal / 16), floored at 0.875rem and capped at 1rem so wide screens do not enlarge the interface. Design frames: 1440 ideal (992 to 1920) on desktop, 834 (768 to 991), 550 (480 to 767), 390 (320 to 479, floor 0.8125rem). Every rem follows that bounded scale between frames; do not mix px for layout.

Content sits in a `.wrap`: full width to an 80rem maximum with a 2.5rem gutter (1rem at 767px and below). Sections are separated by 6.5rem of top padding (4.25rem narrow). The sticky bar is 3.75rem (3.5rem narrow); anchors scroll with that offset plus 1.5rem.

The hero is a two-column grid (copy, then a 33rem installer, aligned to the bottom) that stacks below 1080px. The stage follows, up to 76rem wide and sized so the device still fits under the bar. Below it come the events row, then ruled and carded sections: analyst copy and device (6fr / 5fr), keys heading and keylist (4fr / 8fr), safety statement and rules (4fr / 8fr, so the keys, safety and sources cards share one column edge), sources heading (sticky) and table (4fr / 8fr), close (6fr / 6fr). Those collapse to one column at 991px. The chapter rail is one row of six tabs at desktop and two rows of three at 767px and below. Touch targets for tabs, Copy, ghost controls and the wordmark are at least 2.75rem tall on phones and coarse pointers.

## Elevation & Depth

Depth is now owner-directed and has two layers. Cards carry a soft drop shadow (`inset 0 0 0 1px border, inset 0 1px 0 rgb(255 255 255 / .04), 0 30px 60px -30px rgb(0 0 0 / .9)`). Two devices lean: the stage tilts back 7deg (rotateX, origin bottom, 2400px perspective) and flattens on hover or focus, and the analyst panel turns toward the copy (rotateY -8deg, rotateX 2deg) until hover. Both are flat on phones, on touch devices and under reduced motion. On a fine pointer the stage also leans up to 1.2deg and 0.9deg toward the cursor. A faint green under-glow sits behind the stage and the analyst device.

This supersedes the earlier "Flat Content Rule" (no shadows on content) and "One Lit Object Rule" (only the stage leans). Both were reversed by the owner on 2026-10-19.

### Shadow Vocabulary
- **Card** (`0 30px 60px -30px rgb(0 0 0 / .9)` with inset border and top light): installer, agent panel, rule cards, keylist, table, FAQ.
- **Bezel** (`inset 0 0 0 1px #39403b, inset 0 1px 0 #5a625c, 0 0 0 1px #000, 0 2px 4px rgb(0 0 0 / .4), 0 70px 90px -40px rgb(0 0 0 / .95)`): the device edge.
- **Green glow** (`0 0 10px rgb(74 222 128 / .6 to .7)`): the progress line, pill underline and live dot only.
- **Copied** (`0 0 0 4px rgb(74 222 128 / .18), 0 10px 30px -10px rgb(74 222 128 / .7)`): the Copy button after a copy.
- **Blur surfaces** (`backdrop-filter: blur(14px)` on the bar, `blur(12px)` on the HUD).

### Named Rules
**The Soft Card Rule.** A card is the page's content surface: card fill, inset border, soft shadow. Do not stack a card inside a card; the command band runs full bleed with hairlines instead.

**The Two Leaning Devices Rule.** Only the stage and the analyst panel lean. Any third leaning object needs a new owner decision.

## Shapes

Rounded rectangles in two nesting steps. Cards are 16px; the segmented switch is 10px with a 7px thumb; buttons and tabs are 8px; the callout is 12px; chips and key badges are 4px; rule icons and keycaps are 7px; inline keys are 5px. The bezel is 1.375rem (1rem on phones) around a 0.75rem screen. The command band is the exception: full bleed, square, with hairlines above and below. Status pips and the live dot are circles. There is no decorative blinking caret on headings or the wordmark; the only caret is the green block in the command band, which blinks once the command has finished typing.

## Components

### Buttons
- **Install and Copy:** ink fill, page text, 8px radius. Install is 2.5rem tall with hover to white and active scale 0.97 (punch easing). Copy is 2.375rem tall, Spline Sans 600, with a top highlight, and is the strongest control. On hover its letters shuffle once (Osmo Button 069); after a click it turns green and says "Copied". Open (for Cursor's deep link) is the ghost version: transparent with an inset border.
- **Ghost and Pause:** 1px border, ink-body text, raise to ink on hover.
- **No arrows or chevrons on buttons or calls to action.** Icons are limited to the clipboard, pause and play glyphs, platform and agent marks, and the external-link glyph in meta lines.

### Installer (hero and closing section, one component)
A React Bits Spotlight Card: a green pointer light moves inside and catches the border, settling when idle (fine pointers only). Head: `Install trenchscope` and a React Bits Rubber Segment switch with Apple, Windows and npm logos (the thumb stretches across, then lands with a slight overshoot). Below it a full-bleed command band shows a short form of the command, typed by an Osmo Typewriter port with a humanised delay and a green block caret, with Copy at the right. Copy always copies the full commands (install plus `trenchscope doctor`). Meta line: `Then run trenchscope doctor` and a platform note, plus a link to install.sh, install.ps1 or the npm package. The visitor's OS picks the first segment; without scripts the HTML already shows the macOS and Linux command. Segments are a tablist over one focusable tabpanel with arrow, Home and End keys.

### Agent hookup
Built from the same parts, in the analyst section under the rules. Head: `Connect <agent>` with a one-line step, and a `cli` / `config` Rubber Segment. Below, an agent icon switch with names (Claude, Codex, Cursor, Gemini, VS Code; icons only under 560px), then a command band with Copy and, for Cursor, Open. Config mode opens the band into the file, held at eight lines so switching agents never moves the page (ten at 479px and below). Every entry runs `npx -y trenchscope mcp`; the meta line points at `trenchscope mcp doctor`. Agent marks are monochrome LobeHub icons in `currentColor`.

### Stage (device, rail, screen, HUD)
After Trial's DeviceStage (`Projects/tape/components/docs/demos/device-stage.tsx`). The real tour plays in the bezel described under Elevation. The chapter rail lives inside the bezel above the screen: six tabs with key badges (current one is reverse video), a sliding pill with a green underline (450ms, osmo easing), a per-chapter caption, and the Pause control. Progress is a lit green line along the top edge of the screen. The keystroke HUD stays: a frosted chip at the bottom right whose light keycap rises out of a blur with each key. The screen has no ring of its own: it is the display inside the bezel, and the bezel draws the edge. A caption under the stage carries the live dot, the sample note and the 160x46 size (the size is hidden on phones). On phones the tour opens on the Screener, since the 60-column Launch banner reads as a mosaic at that width. The chapter tabs and the two-line phone caption have their space reserved in CSS, so the screen never shifts down when main.js builds them. Hover pauses only on the screen (mouse only), so the rail stays usable; the tour also pauses when offscreen, hidden or paused by hand, and shows a still frame under reduced motion. Clicking a chapter plays it once and holds on its last frame. If the tour cannot load or scripts are off, the screen says so with the `trenchscope --fixtures` command and the controls step aside.

### Events row
Under the stage: five real events per chapter, read from the sample frames (kind chip, subject, detail), crossfading in with a 45ms stagger when the chapter changes; three on phones. It replaced a scrolling ticker on purpose: a marquee hides half its content.

### Analyst device
A small bezel device turned toward the copy until hover, with a device bar (live dot, `token screen · analyst panel`, `sample render`). It plays `tour-analyst.json` cropped to 21 rows (the verdict and its five reasons, ending on a clean break) and rests on the last clean frame, with no scramble glyphs.

### Cards and tiles
The analyst rules and safety rules are tiled cards: two columns (one under 560px) with a 28px green-tinted icon square per rule. The keylist (keycaps in ink with page text, two columns, one under 640px), the sources table (hairline rows, mono lowercase heads, right-aligned mono last column) and the setup FAQ (native disclosures) sit on the same card surface. The known-issues note is an amber callout: warn tint fill, inset warn hairline, 12px radius.

### ASCII background
Three stacked tile layers (far ridge at .2 opacity, 240s pan; near ridge at .26, 130s; a lit copy revealed by a moving mask band every 11s) under a top fade mask, plus a sparse canvas glyph field. The whole layer fades to .4 on scroll. Under reduced motion the pan, sweep and flicker stop. When WebGL2 is available (`site/fx.js`) one live ASCII shader replaces all of it: the ridge is a candle chart (4 cells per candle) that scrolls one cell every 420ms, glyphs from the ramp ` .·:-=+*x#%@█` picked by brightness, neutral ink at alpha .42 desktop and .34 phone, 9 by 16 px cells (7 by 13 on phones), about 6 fps at rest and 30 fps while the pointer or a key-press ring moves it. The pointer lifts the ridge; each key the tour presses sends a ring through it; the newest candle is green or red. The raster layers are fallback-only and hidden while the live renderer runs. A head script marks `<html class="webgl2">` so WebGL2 browsers never fetch any plate; `fx.js` removes the mark, and the plates return, only if the shader fails. A worker checks the WebGL2 renderer first (OffscreenCanvas, off the main thread): on a software renderer such as SwiftShader or llvmpipe the shader never starts and the page keeps the light canvas glyph field, because drawing on the CPU stalls the page.

The two ridges are `site/assets/trench-far.webp` and `trench-near.webp`: authored plates of periodic sample price data, rendered by ASCII Magic (asciiStudio style, recipe code in each `.webp.json` sidecar), converted to grayscale and resized to 2880 wide. They are tileable and must keep their sidecars.

### Cursors
On fine pointers the cursor is a 1-bit pixel hand at 2x (`site/assets/cursors/hand.svg`, hotspot 9 1), redrawn from the API site's set; over anything clickable it turns green (`hand-pop.svg`). Touch, forced colours and higher-contrast preferences keep the native cursor.

### Motion
- **Headings** wipe in left to right in 820ms on `energy`. **List rows** wipe in with a 55ms stagger capped at 400ms.
- **Mono labels** decrypt in the CLI's own hex and line glyphs (`0-9 A-F ∷ ⋮ ⋯ ╳ ◇ ◆`) with no reflow.
- **Keycaps** press in a 70ms wave as the keys section arrives. **Clicks** throw eight line sparks (React Bits Click Spark). **The Install button** leans toward the pointer (React Bits Magnet). **The screen glass** carries a soft light under the pointer (React Bits Glare Hover).
- **Segments** use Rubber Segment: a 190ms stretch, then a 300ms landing with overshoot.

Four named easings on `:root`: `osmo` cubic-bezier(0.625, 0.05, 0, 1) for reveals, underlines, the pill and device tilt (400ms to 900ms), `energy` cubic-bezier(0.32, 0.72, 0, 1) for wipes and the pointer lean, `punch` cubic-bezier(0.19, 1, 0.22, 1) for press and pop, `smooth` cubic-bezier(0.38, 0.005, 0.215, 1) for colour fades and the light sweep. The stage also uses `--ease-out` cubic-bezier(0.22, 1, 0.36, 1). Reduced motion removes all animation and transition, and every element is visible by default if scripts do not run.

### Link preview and brand mark
`site/og.png` (1200 by 630) is unchanged. It is the media-studio keycap banner that matches the X banner (job 20261019-164232-trenchscope-og-5d80); its wordmark is still set in Spline Sans Mono. `site/og.html` is a legacy card, not the source. `site/assets/brand/trenchscope-mark.svg` is the logo: a keycap with a pixel `t` and halftone bevel in #0a0a0a and #ededed (traced with Recraft vectorize from the owner's render), with its own dark plate. Favicons at 16 and 32 px are hand-drawn pixel versions; larger icons come from the trace and are listed in `site.webmanifest`. The header uses the text wordmark.

### Generated frames
`site/tour.json` (160 by 46), `site/tour-narrow.json` (60 by 44) and `site/tour-analyst.json` (the token chapter cropped to the analyst panel) are rendered by the app through `packages/cli/tools/site-frames.mjs` in the `mono` theme at 12 fps. Chapters: Launch, Screener, Token, New pairs, Analyst, Watchlist. Regenerate them when the CLI look or sample data changes; never hand-edit or redraw.

## Do's and Don'ts

### Do:
- **Do** take page colours from the frontmatter tokens and keep green to live, selected and confirmed states.
- **Do** build new controls from the installer parts: card, rubber segment, command band, Copy.
- **Do** use Spline Sans for sentences and Spline Sans Mono for headlines, labels and commands.
- **Do** use rem for layout so the Osmo scaling holds; render desktop and the 390px frame.
- **Do** keep controls at least 2.75rem tall on touch and keep a visible focus ring.
- **Do** regenerate the tour with `site-frames.mjs` whenever the app's look changes.
- **Do** put provenance (a `.webp.json` sidecar) beside every shipping raster.

### Don't:
- **Don't** add a second accent colour.
- **Don't** use em dashes (U+2014) anywhere in copy, code comments or docs.
- **Don't** put arrows or chevrons on buttons or calls to action.
- **Don't** hand-draw, recolour or screenshot-edit the CLI screen; frames come from the app.
- **Don't** present the npm or Homebrew names as live until they are published.
- **Don't** replace the events row with a scrolling ticker.
- **Don't** nest a card in a card, or lean a third object.
- **Don't** set ink-faint (#4a564e) as text.
