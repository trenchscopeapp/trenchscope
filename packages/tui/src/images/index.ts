// @dexterm/tui — coin images in the terminal (task-1326).
export { protocolFromEnv, parseQueryReply, resolveProtocol, queryTerminal, CAPABILITY_QUERY, type ImageProtocol, type ImageCaps, type QueryFacts, type DetectEnv, type QueryIo } from './detect.ts';
export { sampleGrid, ditherTo256, nearest256, gridHex, luma, flattenTo, resampleRgba, type Pixels } from './pixels.ts';
export { drawBlockArt, drawPlaceholder, placeholderColor, placeholderInitial, type BlockMode, type BlockArtOpts, type PlaceholderOpts } from './blocks.ts';
export { cup, kittyTransmit, kittyPlace, kittyDeletePlacement, kittyDeleteAllPlacements, kittyFreeAll, itermInline, sixelEncode, KITTY_CHUNK } from './protocols.ts';
export { ImageLayer, type ImageSlot, type ImageLayerOptions, type SyncInput } from './layer.ts';
export { coinImage, COIN_ICON_W, COIN_HERO_W, COIN_HERO_H, type CoinImageSpec, type ImageMode } from './coin.ts';
