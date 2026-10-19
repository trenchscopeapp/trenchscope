---
name: trenchscope
description: A terminal for the trenches. The site is the app running: ink on black, one mono palette shared with the CLI.
colors:
  ground: "#0a0a0a"
  surface: "#0e0e0e"
  raised: "#141414"
  hairline: "#1d1d1d"
  hairline-strong: "#2c2c2c"
  ink: "#ededed"
  ink-body: "#a6a6a6"
  ink-quiet: "#8c8c8c"
  ink-faint: "#4a4a4a"
  ink-bright: "#ffffff"
  up: "#7cc794"
  down: "#e8847c"
  warn: "#d9b46a"
  bezel-top: "#2b2b2b"
  bezel-mid: "#161616"
  bezel-low: "#0b0b0b"
  bezel-edge: "#343434"
  screen-bar: "#0d0d0d"
  frame-fill: "#0c0c0c"
typography:
  display:
    fontFamily: "Spline Sans Mono, ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "5rem"
    fontWeight: 600
    lineHeight: 0.98
    letterSpacing: "-0.04em"
  headline:
    fontFamily: "Spline Sans Mono, ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "4.625rem"
    fontWeight: 600
    lineHeight: 1.02
    letterSpacing: "-0.04em"
  title:
    fontFamily: "Spline Sans Mono, ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "2.375rem"
    fontWeight: 600
    lineHeight: 1.1
    letterSpacing: "-0.035em"
  lede:
    fontFamily: "Spline Sans Mono, ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "1.1875rem"
    fontWeight: 400
    lineHeight: 1.55
  sub:
    fontFamily: "Spline Sans Mono, ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "1.0625rem"
    fontWeight: 400
    lineHeight: 1.6
  body:
    fontFamily: "Spline Sans Mono, ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.65
  label:
    fontFamily: "Spline Sans Mono, ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "0.875rem"
    fontWeight: 500
    lineHeight: 1.6
  machine:
    fontFamily: "Spline Sans Mono, ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: 1.6
    fontFeature: "\"liga\" 0"
  keycap:
    fontFamily: "Spline Sans Mono, ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "0.9375rem"
    fontWeight: 700
    lineHeight: 1
  cell:
    fontFamily: "JetBrains Mono, ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: "18px"
rounded:
  chip: "4px"
  key-inline: "5px"
  skip: "6px"
  key: "7px"
  button: "8px"
  screen: "0.625rem"
  screen-narrow: "0.5625rem"
  hud: "10px"
  frame-inner: "12px"
  install: "14px"
  frame: "16px"
  bezel: "1.375rem"
  bezel-narrow: "1rem"
spacing:
  gutter: "2.5rem"
  gutter-narrow: "1rem"
  section: "9rem"
  section-narrow: "5.5rem"
  bar: "3.75rem"
  bar-narrow: "3.5rem"
  wrap-max: "88rem"
  row: "1rem"
  stack-sm: "0.75rem"
  stack-md: "1.5rem"
  stack-lg: "2.5rem"
  column-gap: "5rem"
components:
  button-ink:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.ground}"
    typography: "{typography.label}"
    rounded: "{rounded.button}"
    padding: "0 1rem"
    height: "2.5rem"
  button-ink-hover:
    backgroundColor: "{colors.ink-bright}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink-body}"
    rounded: "{rounded.button}"
    padding: "0 0.875rem"
    height: "2.75rem"
  button-ghost-hover:
    textColor: "{colors.ink}"
  install-block:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink-body}"
    typography: "{typography.machine}"
    rounded: "{rounded.install}"
    padding: "1rem 1.125rem"
  install-tab:
    textColor: "{colors.ink-quiet}"
    typography: "{typography.machine}"
    height: "2.75rem"
    padding: "0 0.75rem"
  install-tab-selected:
    textColor: "{colors.ink}"
  keycap:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.ground}"
    typography: "{typography.keycap}"
    rounded: "{rounded.key}"
    size: "2.25rem"
    padding: "0 0.625rem"
  chapter-key:
    textColor: "{colors.ink-quiet}"
    typography: "{typography.machine}"
    rounded: "{rounded.chip}"
    padding: "0.0625rem 0.375rem"
  chapter-key-current:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.ground}"
  hud:
    backgroundColor: "{colors.ground}"
    textColor: "{colors.ink-body}"
    rounded: "{rounded.hud}"
    padding: "0.375rem 0.75rem 0.375rem 0.375rem"
  bezel:
    backgroundColor: "{colors.bezel-mid}"
    rounded: "{rounded.bezel}"
    padding: "0.75rem"
  screen:
    backgroundColor: "{colors.ground}"
    textColor: "{colors.ink}"
    rounded: "{rounded.screen}"
  frame:
    backgroundColor: "{colors.frame-fill}"
    rounded: "{rounded.frame}"
    padding: "0.25rem"
  frame-inner:
    backgroundColor: "{colors.ground}"
    rounded: "{rounded.frame-inner}"
  rules-row:
    textColor: "{colors.ink-body}"
    padding: "1rem 0"
  keylist-row:
    textColor: "{colors.ink-body}"
    height: "4.25rem"
    padding: "0.75rem 0"
  table-cell:
    textColor: "{colors.ink-body}"
    padding: "0.9375rem 1rem 0.9375rem 0"
  state-chip:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.ink}"
    rounded: "{rounded.chip}"
    padding: "0.125rem 0.4375rem"
---

# Design System: trenchscope

## Overview

**Creative North Star: "The Lit Screen"**

The page is the product running. A real terminal, drawn cell for cell by the app itself, sits in a graphite bezel under a soft white spotlight, and everything else on the page is quiet enough to let it be the brightest thing. The site and the CLI are one system: the site palette is the `mono` theme in `packages/tui/src/theme.ts` (ground, ink, three greys, up, down, warn), so the screen and the page read as one surface and a change to one is a change to both.

The world is black and white. Ink on near-black for everything, hairline rules instead of fills, reverse video (ink background, ground text) for anything that is pressed, active or a key. Hue exists only where the data carries meaning: a muted green for up, a muted red for down, an amber for real warnings. One mono face, Spline Sans Mono, sets everything; JetBrains Mono draws only the terminal cells and the ASCII fields. Depth comes from light and tilt (a perspective stage, a spotlight, a bezel), not from shadows on content.

Behind the content runs a full-bleed ASCII trench: two ridges rendered by ASCII Magic, panned at different speeds, a band of light sweeping the near ridge, and a sparse canvas field of flickering glyphs. It steps back past the first screen.

**Key Characteristics:**
- One palette shared with the CLI `mono` theme; the page never invents a color the app does not have.
- Reverse video is the only emphasis fill: keycaps, the primary button, the current chapter key, selection.
- Hairline rules and one frame language (outer radius with a hairline, 4px padding, inner radius with a stronger hairline).
- Rem-scaled layout (Osmo scaling) so the composition holds its proportions between design frames.
- Motion is eased with four named curves and respects reduced motion everywhere.

## Colors

A monochrome ladder with three signal hues. The frontmatter is normative for every value.

### Primary
- **Ink** (`ink`, #ededed): text, rules that must read, the primary button fill, keycap fill, the progress line, the focus ring. `ink-bright` (#ffffff) is used only for the primary button hover.

### Secondary (signal hues, data only)
- **Muted Up** (`up`, #7cc794): price direction, and the live-render pip in the analyst frame.
- **Muted Down** (`down`, #e8847c): price direction. It appears inside the rendered tour frames; page chrome never uses it.
- **Amber Warn** (`warn`, #d9b46a): real warnings only: the "not published yet" install note and the Known issues label.

### Neutral
- **Ground** (`ground`, #0a0a0a): page and screen background, and the text color on reverse-video fills. Equals the app background.
- **Surface** (`surface`, #0e0e0e): install block fill. **Raised** (`raised`, #141414): state chips.
- **Hairline** (`hairline`, #1d1d1d): section rules, table rows, bar border. **Hairline Strong** (`hairline-strong`, #2c2c2c): frame and block borders, track lines. This one equals the app border.
- **Ink Body** (`ink-body`, #a6a6a6): prose, ledes, table cells. **Ink Quiet** (`ink-quiet`, #8c8c8c): captions, machine labels, inactive tabs. Both equal the app's muted and dim.
- **Ink Faint** (`ink-faint`, #4a4a4a): non-text only (completed chapter tracks, hover border). It does not clear text contrast and must never carry words.
- **Bezel set** (`bezel-top`, `bezel-mid`, `bezel-low`, `bezel-edge`, `screen-bar`, `frame-fill`): the graphite of the hardware around the screen. They exist only for the bezel, window bar and analyst frame.

### Named Rules
**The Shared Palette Rule.** The site palette and the CLI `mono` theme are one system. Ground, ink, ink-body, ink-quiet, hairline-strong, up, down and warn are the same values in both. A change goes to `packages/tui/src/theme.ts` and `site/styles.css` together, then the tour is regenerated.

**The Signal Only Rule.** Hue carries data, never decoration. Up and down mean price direction; amber means a warning. No accent color, no brand tint, no gradient fills with hue.

**The Reverse Video Rule.** Anything pressed, active, selected or a key is ink on ground inverted: ink fill, ground text. Nothing else gets a solid light fill.

## Typography

**Display and Body Font:** Spline Sans Mono (with ui-monospace), weights 400 to 700, loaded from Google Fonts. The whole page is mono (owner, 2026-10-18); JetBrains Mono draws only the terminal cells, the live trench and the glyph field, for its box-drawing and block coverage.
**Machine Font:** JetBrains Mono (with ui-monospace, SF Mono, Menlo), weights 400 and 700, ligatures off.

**Character:** Spline Sans Mono is a grotesque mono: firm at display sizes (tracked to -0.04em), even in prose, so the page reads like the terminal it sells. Weight and the ink ladder carry hierarchy, never a second family.

### Hierarchy
- **Display** (600, 5rem, 0.98, -0.04em): the single statement of the safety section, capped at 10ch.
- **Headline** (600, 4.625rem, 1.02, -0.04em): the hero line. Balanced wrap.
- **Title** (600, 2.375rem, 1.1, -0.035em): section headings, capped at 24ch.
- **Lede** (400, 1.1875rem, 1.55): hero lede, 40ch. **Sub** (400, 1.0625rem, 1.6): section subtext, 46ch.
- **Body** (400, 0.9375rem, 1.65): prose; descriptions cap near 52ch.
- **Label** (500, 0.875rem): nav, buttons, row titles.
- **Machine** (400, 0.8125rem to 0.9375rem): install commands, tabs, chapter keys, screen and frame bars, table heads and last column, footer. Never below 0.8125rem, which keeps it at 11px or more where the Osmo scale shrinks rem toward 992px.
- **Keycap** (700, 0.9375rem mono): all key labels.
- **Cell** (400, 14px on an 18px row): the tour grid, scaled by transform to the box width.

At 767px and below the headline falls to 2.375rem, the display to 2.75rem, the title to 1.75rem.

### Named Rules
**The Machine Voice Rule.** Mono is for commands, keys, source names the app prints, and cell data. Never set headings, nav or marketing sentences in mono.

**The Tight Display Rule.** Letter-spacing tightens as size grows (-0.03em at title, -0.035em at headline, -0.04em at display) and line-height drops to 1 or below; body stays at 1.5 to 1.6.

## Layout

An Osmo scaling system sets the root: `--size-container` is the viewport clamped between a min and max, and `html` font-size is that container divided by (ideal / 16), floored at 0.875rem. Design frames: 1440 ideal (992 to 1920) on desktop, 834 (768 to 991), 550 (480 to 767), 390 (320 to 479, floor 0.8125rem). Every rem in the stylesheet therefore scales with the viewport between frames; do not mix px for layout.

Content sits in a `.wrap`: full width to a 88rem maximum with a 2.5rem gutter (1rem at 767px and below). Sections are separated by 9rem of top padding (5.5rem narrow). The sticky bar is 3.75rem (3.5rem narrow) and anchors scroll with that offset plus 1.5rem.

Section compositions are two-column grids with generous gaps (4rem to 5rem), collapsing to one column at 991px: hero lede and install (5fr / 6fr), analyst copy and frame (6fr / 5fr), keys heading and a two-column ruled keylist (4fr / 8fr), safety statement and rules (5fr / 7fr), sources heading (sticky) and table (4fr / 8fr), close (6fr / 6fr). The chapter rail is six equal columns, three at 767px and below. The first viewport pairs the headline with lede and install on one baseline and lets the stage rise into the lower third.

Rhythm: rows of rules are 1rem vertical padding; keylist rows are 4.25rem tall; the hero stack opens at 2rem. Touch targets for tabs, copy, ghost controls, chapter buttons and the wordmark are at least 2.75rem tall; the primary button and the footer X grow to 2.75rem on touch pointers and at 767px and below.

## Elevation & Depth

The page is flat. Content never carries shadows; separation is hairline rules and tonal steps from ground to surface to raised. Depth belongs to the stage and the background: a perspective scene (2400px, origin top) tilts the bezel back (9deg at rest, 16deg with scale 0.94 on entry) and straightens it as it scrolls into view, with a slight lean toward the pointer (up to 2.2deg and 1.6deg). A white radial spotlight and a faint conic light cone sit behind the stage, and a soft white glow pools under the bezel.

### Shadow Vocabulary
- **Bezel** (`0 0 0 1px #343434 inset, 0 1px 0 #5a5a5a inset, 0 0 0 1px #000, 0 3rem 5rem -2.5rem rgb(0 0 0 / .95), 0 6rem 9rem -5rem rgb(255 255 255 / .06)`): the lit hardware edge and its fall-off. Used once.
- **Keycap** (`0 2px 0 #8c8c8c`): the physical key edge on the HUD keycap, collapsing to none on press. A key has a lip; this is the world's own material, not a general offset shadow.
- **Blur surfaces** (`backdrop-filter: blur(14px)` on the bar, `blur(8px)` on the HUD): translucent chrome over moving content.

### Named Rules
**The Flat Content Rule.** Cards, frames, tables and rules have no drop shadows. If a surface needs lifting, step the tone or draw a hairline.

**The One Lit Object Rule.** Only the stage is lit and tilted. A second tilted or glowing object would dilute it.

## Shapes

Rounded rectangles in one nesting language: an outer frame with a hairline, 0.25rem of padding, then an inner frame with a stronger hairline and a smaller radius. Frame 16px over inner 12px for the analyst panel; install block 14px with 10px-class inner content; bezel 1.375rem over screen 0.625rem (1rem and 0.5625rem narrow). Buttons are 8px, keycaps 7px, the skip link 6px, inline keys 5px, small chips 4px, the HUD 10px. Window dots are circles. Pips and the mark cursor are square. The mark is the wordmark followed by a blinking block cursor (0.5em by 1.05em).

## Components

### Buttons
- **Shape:** 8px radius, 2.5rem tall (primary; 2.75rem on touch and phones) or 2.75rem (ghost), label 0.875rem at 500.
- **Primary (ink):** ink fill, ground text, hover to white, active scale 0.97 on the punch easing.
- **Ghost:** 1px strong hairline, ink-body text, hover raises text to ink and border to faint ink.
- **Labels carry no arrows or chevrons.** The only icons are the clipboard glyph on copy and the pause and play glyphs on the tour control, which are not directional.

### Install block
A tabbed command block (curl, windows, npm, claude) with a copy control at the right. The tabs are a real `tablist` with one shared `tabpanel` (focusable, named by the selected tab); the copy control sits outside the tablist. Arrow keys, Home and End move between tabs, and the tab row scrolls sideways on narrow screens, so the underline and focus ring sit inside each tab. The program name is ink, its arguments ink-body, the `$` prompt ink-quiet and unselectable. The selected tab shows a 1px ink underline that scales in from the left. Tabs that are not yet published switch the note to amber. The large variant raises command size and padding for the closing section.

### Stage (bezel, screen, HUD, chapter rail)
The signature component. The bezel is a graphite gradient with an inset lip, the screen a ground-colored window with a 2.125rem title bar (dots, name, grid size), and a diagonal glass sheen. Cells are drawn as plain text from the generated tour data and scaled to fit. The HUD is a translucent chip at the bottom right that pops in with the key being pressed, using a reverse-video keycap that depresses on press. The chapter rail underneath is six buttons, each a 1px track that fills with ink as its chapter plays, a label, and a small key chip that goes reverse video for the current chapter; finished chapters dim to faint ink. A ghost Pause control sits beside the caption. The tour pauses when offscreen, hovered, hidden, or paused by hand, and shows a still screener under reduced motion.

### Rules lists
Definition lists as ruled rows: a 7.5rem term column (5.75rem narrow) in ink at 500, a description in ink-body, a top hairline per row and a closing hairline. Used for the analyst promises and the safety rules.

### Keylist
A two-column ruled list: keycaps (ink fill, ground text, mono bold, 2.25rem square minimum) in a 6.5rem column beside a one-line description with the verb in ink. Single column at 639px and below.

### Table
A hairline table with mono lowercase column heads, ink row heads, ink-body cells and a right-aligned mono last column. No fills, no zebra. At 639px and below the key column wraps so the table fits the screen without sideways scroll.

### Frame
The analyst panel container: outer frame with hairline, inner frame with a bar (mono caption left, a square up-colored pip and "live render" right) and a cropped cell render of the real analyst panel at true proportions.

### ASCII background
Three stacked tile layers, a far ridge (opacity .2, 240s pan), a near ridge (.26, 130s pan) and a lit copy of the near ridge (.85) revealed by a moving mask band every 11s, all behind a top fade mask so the upper third stays clean. A canvas field of `. · : + x * = % # $` glyphs at 5 to 18 percent ink, denser toward the bottom, changes a few cells every 110ms. On scroll the whole layer fades to .4 and the near ridge rises 9vh. Under reduced motion the pan, sweep and flicker stop and the lit layer is hidden.

The two ridges are `site/assets/trench-far.webp` and `trench-near.webp`: authored plates of periodic sample price data, rendered by ASCII Magic (asciiStudio style, recipe code in each `.webp.json` sidecar), converted to grayscale and resized to 2880 wide. They are tileable and must keep their sidecars.

### Live trench (WebGL2)
When WebGL2 is available (`site/fx.js`), the near ridge, its lit copy and the canvas glyph field give way to a live ASCII shader: the ridge is a candle chart (4 cells per candle, body, centre wick, gap) that scrolls one cell every 420ms and prints a new candle every 4 steps from the right, its forming candle ticking every 160ms. Glyphs come from the ramp ` .·:-=+*x#%@█`, picked per cell by brightness; ink #ededed only, alpha .42 desktop and .34 phone, 9 by 16 px cells (7 by 13 on phones). It draws at about 6 fps at rest, since nothing changes faster than the 160ms tick, and at 30 fps only while the pointer or a key-press ring is moving it. The ridge sits between 57 and 84 percent of the viewport height. The pointer lifts the ridge under it and brightens nearby glyphs; each key the tour presses sends a ring through the field from the HUD. The ASCII Magic far ridge stays behind it at .14. It pauses when the tab is hidden, draws one still frame under reduced motion, and the plates return if the context is lost. A head script marks `<html class="webgl2">` so WebGL2 browsers never download the near plates; `fx.js` removes the mark whenever the live trench cannot run.

### Cursors
On fine pointers the cursor is a 1-bit pixel hand at 2x (`site/assets/cursors/hand.svg`, hotspot 9 1), redrawn from the API site's set in ink #ededed on ground #0a0a0a; over anything clickable it turns pop green (`hand-pop.svg`). Touch, forced colours and higher-contrast preferences keep the native cursor.

### Colour pops
The owner asked for colour pops (2026-10-18). They are the app's own state colours at full strength, `--pop-up` #52e08a, `--pop-down` #ff6a5c and `--pop-warn` #f5c451, and appear only where something is live or confirms: the period that ends every heading, the blinking block cursors (wordmark, headline, typing), the active install tab and chapter progress, text selection, the copied state, keyless `none` cells, keycap presses and hovers, the not-yet-published and known-issues notes, click sparks, and in the live trench the newest candle (green or red by direction), a few coloured sky sparks and the key-press ring. Everything else stays ink on black.

The CLI carries the same pop through the `mono` theme's `pop` token (`packages/tui/src/theme.ts`): the block cursor after the wordmark, the filter caret, the sorted column, the live dot and the selected-row marker. Footer keycaps stay ink, and price direction keeps its muted pair (#7cc794 and #e8847c), so the pop never reads as a price move.

### Link preview
`site/og.png` (1200 by 630) matches the X banner: the halftone keycap row low and right on black, and the lowercase wordmark centred in Spline Sans Mono. It is built in media-studio (job 20261019-164232-trenchscope-og-5d80) from the banner's keycap plate; `site/og.html`, the older screener card, is no longer the source. The `og:image` tag points at https://www.trenchscope.dev/og.png.

`site/assets/brand/trenchscope-mark.svg` is the logo: a keycap with a pixel `t`, halftone dots on the bevel, in #0a0a0a and #ededed only (traced with Recraft vectorize from the owner's render). It carries its own dark cap plate so it sits on light or dark grounds. Favicons at 16 and 32 px are hand-drawn pixel versions (`favicon.svg`, `favicon.ico`) because the halftone turns to grey that small; 180 px and up come from the trace (`apple-touch-icon.png`, `icon-192.png`, `icon-512.png`, `icon-maskable-512.png`, listed in `site.webmanifest`). The header still uses the text wordmark.

### Motion

- **Headings** are typed in once by a block caret: a clip wipe left to right in 820ms on `energy`, the caret fading after.
- **List rows** (rules, keys, table) wipe in like a feed: clip plus 6px rise, 55ms stagger capped at 400ms.
- **Mono labels** decrypt left to right in the CLI's own hex and line glyphs (`0-9 A-F ∷ ⋮ ⋯ ╳ ◇ ◆`), never katakana, with no reflow.
- **Install commands** type once at 26ms a character, behind a block cursor. Picking a tab mid-type stops the typing.
- **Keycaps** press in a 70ms wave as the keys section arrives.
- **Clicks** throw eight 1.5px ink line sparks over 420ms, adapted from React Bits Click Spark.
- **The Install button** leans up to 7px toward the pointer on a spring, adapted from React Bits Magnet.
- **The screen glass** carries a soft light under the pointer, after React Bits Glare Hover.

Every one of these is off under reduced motion, and every element is visible by default if scripts do not run.

Four named easings on `:root`: `osmo` cubic-bezier(0.625, 0.05, 0, 1) for reveals and underlines (400ms to 900ms), `energy` cubic-bezier(0.32, 0.72, 0, 1) for the pointer lean (600ms), `punch` cubic-bezier(0.19, 1, 0.22, 1) for press and pop (300ms to 520ms), `smooth` cubic-bezier(0.38, 0.005, 0.215, 1) for color fades (200ms to 300ms) and the light sweep. Reduced motion removes all animation and transition.

### Generated frames
`site/tour.json` (160 by 46) and `site/tour-narrow.json` (60 by 44) are rendered by the app through `packages/cli/tools/site-frames.mjs` in the `mono` theme at 12 fps, chapters Launch, Screener, Token, New pairs, Analyst, Watchlist. The same run writes `site/tour-analyst.json`: the token chapter cropped to the analyst panel (columns 106 to 159, rows 2 to 31), which the analyst section plays so phones never download the wide tour. The tour renders the full screener table (`--full`), not the simple view the interactive app opens on. They are regenerated whenever the CLI look or the sample data changes and are never hand-edited or redrawn.

## Do's and Don'ts

### Do:
- **Do** take every color from the frontmatter tokens, and keep the site and `mono` theme values identical.
- **Do** use reverse video (ink fill, ground text) for keys, the current chapter and the primary action.
- **Do** keep mono for typed and printed text only, with ligatures off.
- **Do** use rem for layout so the Osmo scaling holds; design both the desktop and the 390px frame.
- **Do** keep controls at least 2.75rem tall and keep a visible 2px ink focus ring with 3px offset.
- **Do** regenerate the tour with `site-frames.mjs` whenever the app's look changes.
- **Do** put provenance (a `.webp.json` sidecar) beside every shipping raster.

### Don't:
- **Don't** add hue beyond up, down and warn; no blue accent, no coral, no launchpad colors.
- **Don't** use em dashes (U+2014) anywhere in copy, code comments or docs.
- **Don't** put arrows or chevrons on buttons or calls to action.
- **Don't** hand-draw or screenshot-edit the CLI; frames come from the app.
- **Don't** present the npm or Homebrew names as live until they are published.
- **Don't** put shadows on content surfaces, or tilt or glow a second object next to the stage.
- **Don't** set ink-faint (#4a4a4a) as text.
