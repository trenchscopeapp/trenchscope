# Vendored: TradingView Lightweight Charts™ 5.2.1 (Apache-2.0)

The chart popup (task-1325) renders with TradingView's open-source charting library, **self-hosted**: the
file below is served by the popup's own loopback server as one exact same-origin route
(`/vendor/lightweight-charts.standalone.production.js`). It is never loaded from a CDN, and it makes no
network requests of its own (the bundle contains no `fetch`/XHR/WebSocket/Worker calls).

| file | what |
|---|---|
| `lightweight-charts.standalone.production.js` | `dist/` file from the npm tarball, byte-for-byte (sha256 `e21cc5caa0226ef30bd8549c50b9ef926615f2a4ee6b4e486353477a55f598cf`) |
| `LICENSE` | Apache License 2.0, from the same tarball (identical to the `v5.2.1` git tag) |
| `NOTICE` | the attribution notice from the `v5.2.1` git tag (the npm tarball does not ship it); kept verbatim |
| `VERSION` | `5.2.1` |

Provenance: `npm view lightweight-charts@5.2.1 dist.tarball` →
`lightweight-charts-5.2.1.tgz`, sha1 `5a27ead719573607d4d3483ad2728c055ccea8fd` (matches the registry's
`dist.shasum`), integrity `sha512-IVwoK1RLFiLPubaKIjNbtjWLnpPMqiABSrTay6whmNa8L1+19292VtHJ+BWyPUuLCwF0tcQlhEWd1CLB2a1nsQ==`.
NOTICE: `https://raw.githubusercontent.com/tradingview/lightweight-charts/v5.2.1/NOTICE`.

## Attribution (required by the license, upstream README §License)

The chart page shows **both**: the library's `layout.attributionLogo` (a link to https://www.tradingview.com/
drawn on the chart) and a footer line carrying the NOTICE text verbatim plus the https://www.tradingview.com/
link. The logo's own `<style>` element is allowed by an exact CSP `sha256` hash computed from this file at
server start (no `'unsafe-inline'`). Do not remove either.

## Updating

Replace the four files from the new tarball / tag, update the hashes above and `VERSION`. The server test
(`test/server.test.ts`) pins that the route serves exactly this file and nothing else.
