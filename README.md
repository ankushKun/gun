# gun.js peer

Cloudflare Workers Gun.js-compatible peer with a stats dashboard and persistent
Durable Object storage.

## local

```bash
npm install
npm run dev
```

Dashboard at the Wrangler dev URL, usually `http://localhost:8787`.
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

## endpoints

- `/` - dashboard
- `/gun` - Gun-compatible WebSocket peer endpoint
- `/api/stats` - dashboard stats
- `/health` - health check

## persistence

The old Node server used Gun Radisk with `file: "data"`. Cloudflare Workers do
not provide a persistent local filesystem for that model, so this version stores
Gun graph nodes in Durable Object storage instead. Each write is acknowledged
after the graph merge is stored, and reads are served from the Durable Object.
