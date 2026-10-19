// trenchscope history recorder: schema (lane R-01, AI-SUITE-DESIGN §4.1; prototyped in
// dexterm/research/task-1287/recorder/schema.sql). Lives in the app's SQLite file (the one `--db`
// controls, next to the cache / watchlist / paper wallet tables) on node:sqlite, WAL mode.
//
// Differences from the prototype, all on purpose:
//   - no `runs` table: the app has no sweep runs, it observes rows as the data layer normalises them.
//     `sweeps` records the outcome re-observation calls instead (the request ledger the budget needs).
//   - token_snapshots gains `kind` ('live' = observed from the app's own rows, 'sweep' = an outcome
//     re-observation that cost a request), `hash` (change detection), `is_t0` (a labelling anchor),
//     `horizons_done` (bitmask of horizons already labelled for a t0 row) and `focus` (the row was a
//     watchlist / open-token row when written: the only rows that keep raw JSON).
//   - `mints` is a per-mint summary the sweep scheduler reads instead of scanning snapshots.
//   - feed_members is keyed on (t, feed, rank): the refresh tick is the run.
//   - chain_events and verdicts are created here (one schema owner) but written by R-02 / L-01.

export const SCHEMA_VERSION = 1;

export const HORIZONS_SEC = [3600, 7200, 21600, 86400, 259200] as const;
export type HorizonSec = (typeof HORIZONS_SEC)[number];
/** Every horizon labelled: the bitmask value of `horizons_done` for a finished t0 row. */
export const ALL_HORIZONS_MASK = (1 << HORIZONS_SEC.length) - 1;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS recorder_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS feed_members (
  t     INTEGER NOT NULL,                  -- refresh tick (unix ms) the list was observed at
  feed  TEXT NOT NULL,                     -- the data layer's discovery sub-feed id (jup:toptrending-1h, ds:boosts-top, ...)
  rank  INTEGER NOT NULL,
  mint  TEXT NOT NULL,
  PRIMARY KEY (t, feed, rank)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS feed_members_mint_t ON feed_members (mint, t);

CREATE TABLE IF NOT EXISTS token_snapshots (
  snap_id            INTEGER PRIMARY KEY AUTOINCREMENT,
  mint               TEXT NOT NULL,
  t                  INTEGER NOT NULL,     -- unix ms when the record was fetched (the newest part's fetchedAt)
  kind               TEXT NOT NULL,        -- 'live' | 'sweep'
  hash               TEXT NOT NULL,        -- change-detection hash of the normalised columns
  is_t0              INTEGER NOT NULL DEFAULT 0,
  horizons_done      INTEGER NOT NULL DEFAULT 0,
  next_due_t         INTEGER NOT NULL DEFAULT 0, -- t0 rows: when the labeler should look at this row next
  focus              INTEGER NOT NULL DEFAULT 0,
  symbol             TEXT, name TEXT,      -- stored FIREWALLED: control/bidi/zero-width stripped, length-capped
  launchpad          TEXT,
  created_at         INTEGER,
  age_sec            INTEGER,
  price_usd          REAL, mcap REAL, mcap_resolved REAL, mcap_flagged INTEGER, fdv REAL, liquidity_usd REAL,
  vol_m5 REAL, vol_h1 REAL, vol_h6 REAL, vol_h24 REAL,
  buys_m5 INTEGER, sells_m5 INTEGER, buys_h1 INTEGER, sells_h1 INTEGER, buys_h24 INTEGER, sells_h24 INTEGER,
  chg_m5 REAL, chg_h1 REAL, chg_h6 REAL, chg_h24 REAL,
  pair_address       TEXT, dex TEXT, pair_created_at INTEGER,
  src_market         TEXT NOT NULL,        -- 'dexscreener' | 'jupiter-tokens' | 'none'
  holder_count       INTEGER, holders_chg_pct REAL,
  top_holders_pct    REAL, dev_pct REAL, dev_mints INTEGER,
  organic_score      REAL,
  num_traders_h1     INTEGER, net_buyers_h1 INTEGER,
  buy_vol_h1 REAL, sell_vol_h1 REAL,
  mint_auth_enabled  INTEGER, freeze_auth_enabled INTEGER,
  is_verified INTEGER, is_sus INTEGER,
  src_audit          TEXT,
  rug_score REAL, lp_locked_pct REAL, src_risk TEXT,
  sources            TEXT NOT NULL,        -- JSON array of SourceId that contributed
  raw_json           TEXT                  -- normalised Token+Pair+Stats+Audit record; focus rows only; pruned after 7 d
);
CREATE INDEX IF NOT EXISTS token_snapshots_mint_t ON token_snapshots (mint, t);
CREATE INDEX IF NOT EXISTS token_snapshots_t ON token_snapshots (t);
CREATE INDEX IF NOT EXISTS token_snapshots_t0_pending ON token_snapshots (next_due_t) WHERE is_t0 = 1 AND horizons_done < ${ALL_HORIZONS_MASK};

CREATE TABLE IF NOT EXISTS mints (
  mint        TEXT PRIMARY KEY,
  first_t     INTEGER NOT NULL,
  last_live_t INTEGER NOT NULL,            -- newest 'live' snapshot
  last_any_t  INTEGER NOT NULL,            -- newest snapshot of any kind
  last_t0_t   INTEGER NOT NULL,            -- newest is_t0 anchor
  last_hash   TEXT NOT NULL,
  snapshots   INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS mints_last_live ON mints (last_live_t);

CREATE TABLE IF NOT EXISTS sweeps (
  sweep_id    INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at  INTEGER NOT NULL,
  finished_at INTEGER,
  mints       INTEGER NOT NULL,            -- mints re-observed
  calls       INTEGER NOT NULL,            -- DexScreener token-batch calls issued (30 mints each)
  answered    INTEGER NOT NULL DEFAULT 0,  -- mints DexScreener returned a pair for
  error       TEXT
);

CREATE TABLE IF NOT EXISTS chain_events (
  mint      TEXT NOT NULL,
  t         INTEGER NOT NULL,
  slot      INTEGER,
  signature TEXT NOT NULL,
  kind      TEXT NOT NULL,
  actor     TEXT,
  amount    REAL,
  evidence  TEXT NOT NULL,
  PRIMARY KEY (signature, kind)
);
CREATE INDEX IF NOT EXISTS chain_events_mint_t ON chain_events (mint, t);

CREATE TABLE IF NOT EXISTS outcomes (
  mint         TEXT NOT NULL,
  t0           INTEGER NOT NULL,
  horizon_sec  INTEGER NOT NULL,
  t1           INTEGER,                    -- the observation used (first at/after t0+horizon, within 2x); NULL when unobserved
  label        TEXT NOT NULL,              -- 'rug' | 'dead' | 'fade' | 'flat' | 'runner' | 'unobserved'
  label_tier   TEXT NOT NULL,              -- 'keyless-proxy' | 'chain-verified'
  mcap_ratio   REAL, liq_ratio REAL, price_ratio REAL,
  max_mcap_ratio REAL,
  evidence     TEXT NOT NULL,              -- JSON: the numbers and the rule that fired
  labeler_version TEXT NOT NULL,
  PRIMARY KEY (mint, t0, horizon_sec)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS outcomes_label ON outcomes (label, horizon_sec);

CREATE TABLE IF NOT EXISTS verdicts (
  verdict_id   INTEGER PRIMARY KEY AUTOINCREMENT,
  mint         TEXT NOT NULL,
  t            INTEGER NOT NULL,
  pack         TEXT NOT NULL,
  pack_version TEXT NOT NULL,
  model        TEXT,
  verdict      TEXT,
  rug_p        REAL,
  confidence   REAL,
  score        REAL,
  cost_usd     REAL, wall_ms INTEGER,
  input_hash   TEXT NOT NULL,
  run_file     TEXT
);
CREATE INDEX IF NOT EXISTS verdicts_mint_t ON verdicts (mint, t);

-- 0.1.5 dev history: which wallet created a coin, as a keyless source named it when trenchscope saw the coin
-- (Jupiter tokens v2 \`dev\`, a PumpPortal create, RugCheck new_tokens). First writer wins; never a guess.
CREATE TABLE IF NOT EXISTS creators (
  mint        TEXT PRIMARY KEY,
  creator     TEXT NOT NULL,
  source      TEXT NOT NULL,             -- 'jupiter-tokens' | 'pumpportal' | 'rugcheck' | 'goplus'
  first_t     INTEGER NOT NULL,          -- unix ms trenchscope first recorded the link
  created_at  INTEGER                    -- the coin's creation time when the source gave one
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS creators_creator ON creators (creator, first_t);
`;
