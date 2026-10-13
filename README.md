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
- `/api/peers` - mesh peer list (GET public, POST/DELETE need `PEERS_EDIT_TOKEN` when set)
- `/api/peers/verify` - probe a gun peer url (POST, no auth)
- `/api/peers/reconnect` - force server-side mesh reconnect (POST, same auth as peer edits)
- `/api/graph/souls` - node index (`limit`, `cursor` = last soul of previous page, `prefix`, `q`, `sort=updated`)
- `/api/graph/node` - structured node inspector (`soul`)
- `/api/graph/subgraph` - nodes + reference edges for the explorer (`roots`, `prefix`, `depth`, `maxNodes`, `list` to include the recent soul list in the same call)
- `/explorer.html` - graph explorer UI
- `/health` - health check

## persistence

The old Node server used Gun Radisk with `file: "data"`. Cloudflare Workers do
not provide a persistent local filesystem for that model, so this version stores
Gun graph nodes in a SQLite `nodes` table inside the Durable Object instead. Each
write is acknowledged after the graph merge is stored, and reads are served from
the Durable Object (hot nodes from an in-memory cache).

Listings use a partial index on live nodes, so explorer queries read rows in
proportion to the page size rather than the whole graph. Nodes written by older
versions (KV `node:` keys) are migrated in batches of 100 every 10 minutes to stay
inside the free tier's daily `rows_written` limit; until that finishes they are
still readable but may be missing from explorer listings. `/api/stats` reports
`storage.sqlUsage` (rows read/written since the object woke) and
`storage.migration`.
