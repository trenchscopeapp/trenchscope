# example-widgets

The example pack for dexterm's popup **widget API** (task-1358 Tier 5). One widget, `movers`, tiles the screener's
biggest 5-minute movers and the latest alerts in a loopback HUD window, in the terminal's own theme.

```sh
dexterm pack verify packs/example-widgets                       # the install card
dexterm pack add packs/example-widgets --accept-unsigned        # installs; the widget lands DISABLED
cat ~/.dexterm/packs/example-widgets@1.0.0/widgets/movers/movers.html   # read what you are about to let the host serve
dexterm pack widget example-widgets movers --enable             # consent
dexterm --workspace example-widgets/movers                      # or ctrl+w o in any workspace that lists the widget
```

The API is documented in `packages/popup/WIDGETS.md`. The pack is unsigned on purpose (an example, not a product):
its only contribution besides the widget is a workspace that opens it, so "accept unsigned" costs nothing here.
