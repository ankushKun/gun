# gun.js peer

Cloudflare Workers Gun.js-compatible peer with a stats dashboard and persistent
Durable Object storage.

## local

```bash
npm install
npm run dev
```

Dashboard at the `cf dev` URL, usually `http://localhost:8787`.
Gun clients should use the `/gun` peer endpoint:

```js
const gun = Gun({
  peers: ["https://your-worker.example.com/gun"],
});
```

## build

```bash
npm run build
```

## deploy

```bash
npm run deploy
```

Pushes to `main` also deploy through Workers Builds (`npx cf deploy`).

## config

`cloudflare.config.ts` is the only Worker config, used by `cf dev`, `cf build`,
and `cf deploy`. `wrangler.config.ts` only holds bundler settings (assets dir);
`cf` still uses Wrangler as its bundler, so keep the `wrangler` dev dependency.

`npm test` runs `cf dev --mode test`, a separate local worker (`gun-test`) with
small eviction thresholds and the e2e reset token, so tests never touch
`npm run dev` data.

Durable Object classes are declared in `exports` (this replaces Wrangler
`migrations`). To rename or remove `GunPeerObject`, turn its entry into a
`renamed` / `deleted` tombstone rather than deleting it.

## endpoints

- `/` - dashboard
- `/gun` - Gun-compatible WebSocket peer endpoint
- `/api/stats` - dashboard stats
- `/api/peers` - mesh peer list (GET public, POST/DELETE need `PEERS_EDIT_TOKEN`, and are disabled entirely when it is not set)
- `/api/peers/verify` - probe a gun peer url (POST, no auth)
- `/api/peers/reconnect` - force server-side mesh reconnect (POST, same auth as peer edits)
- `/api/graph/souls` - node index (`limit`, `cursor` = last soul of previous page, `prefix`, `q`, `sort=updated`)
- `/api/graph/node` - structured node inspector (`soul`)
- `/api/graph/subgraph` - nodes + reference edges for the explorer (`roots`, `prefix`, `depth`, `maxNodes`, `list` to include the recent soul list in the same call)
- `/explorer.html` - graph explorer UI
- `/health` - health check
- `/api/e2e/*` - test hooks, only with `E2E_RESET_TOKEN` (reset, nodes, seed, system, legacy, migrate, budget, housekeep, rows, flush)

## live souls (memory only)

Souls under the prefixes in `EPHEMERAL_PREFIXES` (default `ankush-one/live`) are
presence data: cursors, heartbeats, reactions, "listening now". Clients discard
them within seconds, so the peer keeps them in memory only and never spends a
SQLite row on them. They are merged with Gun's HAM state, relayed to every other
socket, and served to gets like any other node. When the object wakes with an
empty memory, a child put puts its key back into its parent (`…/cursors/site`),
so new visitors still learn who else is around. Entries expire after 2 minutes
without an update; an expired child also leaves its parent's key list, and a
get of a live parent never lists a child that is not in memory, so a new
visitor only fetches the people who are actually here. The explorer lists them
with a `live` tag.

Rows those souls left in SQL before this change are swept 500 at a time, every
10 minutes, by the housekeeping alarm. Tombstones (nodes whose fields are all
`null`) older than 30 days are collected once a day.

## daily row budget

Workers Free allows 5M `rows_read` and 100k `rows_written` per UTC day across
the account's SQLite-backed Durable Objects, and blocks **every** storage call
once a limit is crossed (that took the whole relay down on 2026-10-13). The
object counts the rows it spends (SQL cursors and KV calls alike), persists the
count in chunks, and sheds load in stages, measured against whichever limit is
closer:

| used | stage | effect |
| --- | --- | --- |
| 50% | `explorer-paused` | `/api/graph/*` answers 429 (live patches of in-memory souls still work); housekeeping stops |
| 80% | `writes-paused` | puts to stored souls are acked with `err`; live souls keep relaying |
| 92% | `reads-paused` | gets of stored souls not in the node cache answer `err` |

Durable Object requests are capped too (100k per UTC day on Free). The docs
only state the 20:1 ratio for incoming WebSocket messages on Paid, so the object
counts every inbound frame as one request (`FRAME_RATIO`, default 1) plus one per
socket upgrade or HTTP call, against `REQUESTS_DAILY_LIMIT` (default 100000).
At 70% it sends `{dam: "load", stage: "live-slow"}` to every socket, and again
to each new socket as it connects; it sends `stage: "ok"` when the day rolls
over. ankush.one stops its cursor stream and stretches presence beats to 60 s
while it is slow. Once the Cloudflare dashboard shows how Free actually counts
socket messages, set `FRAME_RATIO` to match. The dashboard polls every 15 s and
shows the requests meter next to the row meters.

If storage is blocked anyway, the object keeps serving memory-only traffic and
retries storage every minute. `/api/stats` reports `storage.budget`,
`storage.budget.requests`, `storage.health`, `storage.liveNodes` and `storage.sqlUsage.byCategory`
(`gun`, `explorer`, `housekeeping`, `system` since the object woke); the
dashboard shows both meters. Limits come from `ROWS_READ_DAILY_LIMIT` and
`ROWS_WRITTEN_DAILY_LIMIT`.

## repeated links

Gun's chained put (`gun.get("a").get("b").get("c").put(x)`) re-sends every link
on the path with a fresh state. Merged as a change, that rewrote the stored root
on every cursor move (2 rows per live put, 14 per chat message, measured). The
peer drops any incoming field that repeats the link it already holds: no state
bump, no write, no relay. Links only; primitives and nulls keep plain HAM.
Clients should still address souls directly (`gun.get("a/b/c")`), which also
saves the gets that resolve each step of the path.

## write-behind

Puts to stored souls are merged in memory, relayed and acked at once, and
written to SQLite 1 s after the last change to any soul, at most 5 s after the
first unwritten one. A burst on one soul (a sticky note drag, typing, a run of
paint strokes) costs one row write per flush instead of one per put. The pending
timer keeps the object from hibernating, so the buffer cannot be dropped that
way; a deploy landing inside the window can lose those seconds. A put whose
writer passed a callback (`ok` on the wire) is written before its ack. Gets, the
node inspector and the explorer listings read the buffer first;
`/api/stats` shows `storage.pendingWrites`.

## persistence

The old Node server used Gun Radisk with `file: "data"`. Cloudflare Workers do
not provide a persistent local filesystem for that model, so this version stores
Gun graph nodes in a SQLite `nodes` table inside the Durable Object instead. Writes
are acknowledged once merged in memory and stored within seconds (see
write-behind), and reads are served from
the Durable Object (hot nodes from an in-memory cache).

Listings use a partial index on live nodes, so explorer queries read rows in
proportion to the page size rather than the whole graph. Nodes written by older
versions (KV `node:` keys) are migrated in batches of 100 every 10 minutes to stay
inside the free tier's daily `rows_written` limit; until that finishes they are
still readable but may be missing from explorer listings. `/api/stats` reports
`storage.sqlUsage` (rows read/written since the object woke) and
`storage.migration`.
