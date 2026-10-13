import { HISTORY_KEY_RE } from "../public/graph-inspector.js";

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type",
};

const THROUGHPUT_MAX_POINTS = 60;
// ponytail: sample on /api/stats (~5s dashboard poll), not a 1Hz DO alarm (~86k req/day).
const THROUGHPUT_SAMPLE_MS = 5000;
const THROUGHPUT_WINDOW_MS = THROUGHPUT_MAX_POINTS * THROUGHPUT_SAMPLE_MS;
const THROUGHPUT_GAP_MS = 120_000;
const MESH_ALARM_MS = 5 * 60 * 1000;

const MAX_MESH_PEERS = 20;
// Workers Free caps SQLite-backed DO storage at 5 GB per account; evict well before that.
const STORAGE_LIMIT_BYTES = 5 * 1000 * 1000 * 1000;
const STORAGE_EVICT_AT_BYTES = 4 * 1024 * 1024 * 1024;
const STORAGE_EVICT_BYTES = 512 * 1024 * 1024;

const GRAPH_SOULS_DEFAULT_LIMIT = 100;
const GRAPH_SOULS_MAX_LIMIT = 500;
const GRAPH_SUBGRAPH_DEFAULT_NODES = 200;
const GRAPH_SUBGRAPH_MAX_NODES = 500;
const GRAPH_SUBGRAPH_MAX_DEPTH = 2;
const GRAPH_FIELD_PREVIEW_LEN = 80;
const GRAPH_INSPECTOR_COLLAPSE_AT = 12;
const GRAPH_INSPECTOR_MAP_PREVIEW = 15;

// ponytail: hot nodes stay in memory so repeated Gun gets cost no rows_read while the DO is awake.
const NODE_CACHE_MAX_ENTRIES = 2000;
const NODE_CACHE_MAX_BYTES = 16 * 1024 * 1024;
const SEEN_MESSAGE_TTL_MS = 5 * 60 * 1000;
const SEEN_MESSAGE_MAX = 10_000;

// ponytail: legacy KV nodes move to SQL in small batches; ~3 rows_written per node
// (row + index + KV delete), so 100 per 10 min stays well under the 100k/day free limit.
const NODE_MIGRATION_KEY = "nodeMigration";
const NODE_MIGRATION_BATCH = 100;
const NODE_MIGRATION_INTERVAL_MS = 10 * 60 * 1000;

const NODE_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS nodes (
    soul TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    label TEXT NOT NULL,
    updated REAL NOT NULL,
    oldest REAL NOT NULL,
    bytes INTEGER NOT NULL,
    live INTEGER NOT NULL
  )`,
  // ponytail: covering + partial, so "most recent N" reads ~N index rows and skips tombstones.
  `CREATE INDEX IF NOT EXISTS nodes_live_updated ON nodes (updated DESC, soul, label) WHERE live = 1`,
];

const UPSERT_NODE_SQL = `INSERT INTO nodes (soul, data, label, updated, oldest, bytes, live)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(soul) DO UPDATE SET
    data = excluded.data,
    label = excluded.label,
    updated = excluded.updated,
    oldest = excluded.oldest,
    bytes = excluded.bytes,
    live = excluded.live`;

const INSERT_LEGACY_NODE_SQL = `INSERT INTO nodes (soul, data, label, updated, oldest, bytes, live)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(soul) DO NOTHING`;

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "permissions-policy": "geolocation=(), microphone=(), camera=()",
};

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      ...JSON_HEADERS,
      ...SECURITY_HEADERS,
      ...(init.headers || {}),
    },
  });
}

function routeToPeerObject(request, env) {
  const id = env.GUN_PEER.idFromName("default");
  return env.GUN_PEER.get(id).fetch(request);
}

function detectStorageBackend(storage) {
  // ponytail: CF exposes sqlite vs legacy kv only via storage.sql; no local/prod string
  if (storage?.sql) {
    return "durable-object-sqlite";
  }
  return "durable-object-kv";
}

/** LRU of parsed nodes keyed by soul. `node: null` caches a known miss. */
class NodeCache {
  constructor(maxEntries = NODE_CACHE_MAX_ENTRIES, maxBytes = NODE_CACHE_MAX_BYTES) {
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    this.entries = new Map();
    this.bytes = 0;
  }

  get(soul) {
    const entry = this.entries.get(soul);
    if (!entry) {
      return undefined;
    }
    this.entries.delete(soul);
    this.entries.set(soul, entry);
    return entry;
  }

  set(soul, node, json = null) {
    this.delete(soul);
    // ponytail: parsed object + json string ≈ 3× the serialized size
    const size = json ? json.length * 3 : 64;
    if (size > this.maxBytes / 4) {
      return;
    }
    this.entries.set(soul, { node, json, size });
    this.bytes += size;
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      const [oldest] = this.entries.keys();
      this.delete(oldest);
    }
  }

  delete(soul) {
    const entry = this.entries.get(soul);
    if (entry) {
      this.bytes -= entry.size;
      this.entries.delete(soul);
    }
  }

  clear() {
    this.entries.clear();
    this.bytes = 0;
  }
}

function nodeRowValues(soul, node, json) {
  return [
    soul,
    json,
    nodeLabel(node, soul),
    nodeUpdated(node),
    nodeOldestTimestamp(node),
    json.length,
    nodeHasContent(node) ? 1 : 0,
  ];
}

/** Smallest string greater than every string starting with `prefix`, or null if unsafe. */
function prefixUpperBound(prefix) {
  const last = prefix.charCodeAt(prefix.length - 1);
  if (!prefix || last >= 0xd800) {
    return null;
  }
  return prefix.slice(0, -1) + String.fromCharCode(last + 1);
}

/** WHERE fragments for soul prefix / substring filters; range keeps prefix on the primary key. */
function soulFilterSql(prefix, query) {
  const clauses = [];
  const params = [];
  if (prefix) {
    clauses.push("soul >= ?", "substr(soul, 1, length(?)) = ?");
    params.push(prefix, prefix, prefix);
    const upper = prefixUpperBound(prefix);
    if (upper) {
      clauses.push("soul < ?");
      params.push(upper);
    }
  }
  if (query) {
    clauses.push("instr(lower(soul), ?) > 0");
    params.push(query.toLowerCase());
  }
  return { clauses, params };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: JSON_HEADERS });
    }

    if (url.pathname === "/health") {
      return json({ status: "healthy", timestamp: Date.now() });
    }

    if (
      url.pathname === "/api/stats" ||
      url.pathname === "/api/peers" ||
      url.pathname === "/api/peers/verify" ||
      url.pathname === "/api/peers/reconnect" ||
      url.pathname.startsWith("/api/e2e/") ||
      url.pathname === "/api/storage" ||
      url.pathname.startsWith("/api/graph/") ||
      url.pathname === "/gun"
    ) {
      return routeToPeerObject(request, env);
    }

    if (env.ASSETS) {
      const response = await env.ASSETS.fetch(request);
      if (response.status !== 404) {
        return withSecurityHeaders(response);
      }
    }

    return new Response("not found", { status: 404, headers: SECURITY_HEADERS });
  },
};

function withSecurityHeaders(response) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function pruneThroughputSamples(samples, now, windowMs = THROUGHPUT_WINDOW_MS, maxPoints = THROUGHPUT_MAX_POINTS) {
  const cutoff = now - windowMs;
  let pruned = samples.filter((s) => s.t >= cutoff);
  if (pruned.length > maxPoints) {
    pruned = pruned.slice(-maxPoints);
  }
  return pruned;
}

function normalizePeerUrl(raw) {
  if (typeof raw !== "string" || !raw.trim()) {
    return { ok: false, error: "url required" };
  }

  let input = raw.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) {
    input = `https://${input}`;
  }

  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    return { ok: false, error: "invalid url" };
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, error: "only http(s) peer urls allowed" };
  }

  if (parsed.username || parsed.password) {
    return { ok: false, error: "credentials in url not allowed" };
  }

  if (isBlockedHost(parsed.hostname)) {
    return { ok: false, error: "host not allowed" };
  }

  let path = parsed.pathname.replace(/\/+$/, "") || "";
  if (!path.endsWith("/gun")) {
    path = `${path}/gun`.replace(/\/{2,}/g, "/");
  }
  parsed.pathname = path;

  return { ok: true, url: parsed.toString().replace(/\/+$/, "") || `${parsed.origin}/gun` };
}

function isBlockedHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host === "0.0.0.0" ||
    host === "::1"
  ) {
    return true;
  }

  const ipMatch = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipMatch) {
    const octets = ipMatch.slice(1).map(Number);
    if (octets.some((n) => n > 255)) return true;
    const [a, b] = octets;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
  }

  if (host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd")) {
    return true;
  }

  return false;
}

async function probeGunPeer(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: { accept: "application/json,text/plain,*/*" },
    });

    const upgrade = (res.headers.get("upgrade") || "").toLowerCase();
    const body = await res.text().catch(() => "");
    const gunHint =
      res.status === 426 ||
      upgrade === "websocket" ||
      /websocket required|gun|relay peer|\/gun/i.test(body);

    return {
      reachable: true,
      gunLike: gunHint,
      status: res.status,
      verified: gunHint || (res.ok && body.length < 4096),
    };
  } catch (err) {
    return {
      reachable: false,
      gunLike: false,
      verified: false,
      status: 0,
      error: err?.name === "AbortError" ? "timeout" : "unreachable",
    };
  } finally {
    clearTimeout(timer);
  }
}

function requireEditAuth(request, env) {
  const token = env.PEERS_EDIT_TOKEN;
  if (!token) {
    return true;
  }
  const auth = request.headers.get("authorization") || "";
  return auth === `Bearer ${token}` || auth === token;
}

function e2eAuthorized(request, env) {
  const token = env.E2E_RESET_TOKEN;
  if (!token) {
    return false;
  }
  return request.headers.get("x-e2e-token") === token;
}

export class GunPeerObject {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.remotePeers = new Map();
    this.startTime = Date.now();
    this.nodeCache = new NodeCache();
    this.seenMessages = new Map();
    this.sqlUsage = { rowsRead: 0, rowsWritten: 0, since: this.startTime };
    this.initialized = this.initialize();
  }

  ensureSchema() {
    for (const statement of NODE_SCHEMA) {
      this.sqlRun(statement);
    }
  }

  sqlAll(query, ...bindings) {
    const cursor = this.state.storage.sql.exec(query, ...bindings);
    const rows = cursor.toArray();
    this.sqlUsage.rowsRead += cursor.rowsRead;
    this.sqlUsage.rowsWritten += cursor.rowsWritten;
    return rows;
  }

  sqlRun(query, ...bindings) {
    this.sqlAll(query, ...bindings);
  }

  async initialize() {
    this.ensureSchema();
    const stats = await this.state.storage.get("stats");
    if (stats) {
      this.stats = {
        startTime: stats.startTime || this.startTime,
        messagesProcessed: stats.messagesProcessed || 0,
        bytesTransferred: stats.bytesTransferred || 0,
        graphNodes: stats.graphNodes || 0,
      };
    } else {
      this.stats = {
        startTime: this.startTime,
        messagesProcessed: 0,
        bytesTransferred: 0,
        graphNodes: 0,
      };
      await this.persistStats();
    }

    await this.loadNodeMigration();
    await this.syncGraphNodeCountIfNeeded();
    await this.loadThroughput();
    await this.loadPeerList();
    await this.syncRemoteMesh();
    await this.scheduleAlarm();
  }

  /** One alarm drives both mesh upkeep and legacy node migration; none when neither is needed. */
  async scheduleAlarm({ fromAlarm = false } = {}) {
    const now = Date.now();
    const due = [];
    if (this.peerList?.length) {
      due.push(now + MESH_ALARM_MS);
    }
    if (!this.migration.done) {
      due.push(Math.max(now + 1000, (this.migration.lastBatchAt || 0) + NODE_MIGRATION_INTERVAL_MS));
    }
    if (!due.length) {
      await this.state.storage.deleteAlarm();
      return;
    }
    const next = Math.min(...due);
    const existing = fromAlarm ? null : await this.state.storage.getAlarm();
    if (existing == null || existing > next) {
      await this.state.storage.setAlarm(next);
    }
  }

  async loadNodeMigration() {
    let migration = await this.state.storage.get(NODE_MIGRATION_KEY);
    if (!migration) {
      const legacy = await this.state.storage.list({ prefix: "node:", limit: 1 });
      migration = { done: legacy.size === 0, lastBatchAt: 0 };
      await this.state.storage.put(NODE_MIGRATION_KEY, migration);
    }
    this.migration = migration;
  }

  /** Move one batch of pre-SQL `node:` KV entries into the nodes table. */
  async migrateLegacyNodes(limit = NODE_MIGRATION_BATCH) {
    const page = await this.state.storage.list({ prefix: "node:", limit });
    for (const [key, node] of page) {
      const soul = key.slice("node:".length);
      if (!node || typeof node !== "object") {
        continue;
      }
      // DO NOTHING: a newer copy may already be in SQL from a put during migration.
      this.sqlRun(INSERT_LEGACY_NODE_SQL, ...nodeRowValues(soul, node, JSON.stringify(node)));
      this.nodeCache.delete(soul);
    }
    const keys = [...page.keys()];
    for (let i = 0; i < keys.length; i += 128) {
      await this.state.storage.delete(keys.slice(i, i + 128));
    }

    this.migration = { done: page.size < limit, lastBatchAt: Date.now() };
    await this.state.storage.put(NODE_MIGRATION_KEY, this.migration);
    if (this.migration.done) {
      // ponytail: one count after migration heals any drift in the graphNodes counter
      this.stats.graphNodes = this.sqlAll("SELECT COUNT(*) AS n FROM nodes")[0].n;
      await this.persistStats();
    }
    return { migrated: keys.length, done: this.migration.done };
  }

  async loadPeerList() {
    const stored = await this.state.storage.get("peerList");
    this.peerList = Array.isArray(stored) ? stored : [];
  }

  persistPeerList() {
    return this.state.storage.put("peerList", this.peerList);
  }

  async loadThroughput() {
    const stored = await this.state.storage.get("throughput");
    this.throughput = {
      samples: Array.isArray(stored?.samples) ? stored.samples : [],
      lastMessages: stored?.lastMessages ?? this.stats.messagesProcessed,
      lastBytes: stored?.lastBytes ?? this.stats.bytesTransferred,
      lastSampleTime: stored?.lastSampleTime ?? 0,
    };
    this.throughput.samples = pruneThroughputSamples(this.throughput.samples, Date.now());
  }

  async alarm() {
    await this.initialized;
    // ponytail: mesh upkeep + migration only; throughput samples come from /api/stats.
    // Ceiling: 288 alarms/day if peers configured.
    const migrationDue =
      !this.migration.done &&
      Date.now() - (this.migration.lastBatchAt || 0) >= NODE_MIGRATION_INTERVAL_MS * 0.9;
    if (migrationDue) {
      await this.migrateLegacyNodes();
    }
    if (this.peerList?.length) {
      await this.syncRemoteMesh();
    }
    await this.scheduleAlarm({ fromAlarm: true });
  }

  recordThroughputSample(now = Date.now()) {
    const tp = this.throughput;
    if (!tp.lastSampleTime) {
      tp.lastMessages = this.stats.messagesProcessed;
      tp.lastBytes = this.stats.bytesTransferred;
      tp.lastSampleTime = now;
      return;
    }

    const elapsed = now - tp.lastSampleTime;
    if (elapsed > THROUGHPUT_GAP_MS) {
      tp.lastMessages = this.stats.messagesProcessed;
      tp.lastBytes = this.stats.bytesTransferred;
      tp.lastSampleTime = now;
      tp.samples = pruneThroughputSamples(tp.samples, now);
      return;
    }

    if (elapsed < THROUGHPUT_SAMPLE_MS * 0.9) {
      return;
    }

    const seconds = elapsed / 1000;
    tp.samples.push({
      t: now,
      msg: (this.stats.messagesProcessed - tp.lastMessages) / seconds,
      byte: (this.stats.bytesTransferred - tp.lastBytes) / seconds,
    });
    tp.lastMessages = this.stats.messagesProcessed;
    tp.lastBytes = this.stats.bytesTransferred;
    tp.lastSampleTime = now;
    tp.samples = pruneThroughputSamples(tp.samples, now);
  }

  async syncGraphNodeCountIfNeeded() {
    if (this.stats.graphNodes > 0) {
      return;
    }

    // ponytail: one O(n) count on cold start when counter missing; not per poll
    const count = this.sqlAll("SELECT COUNT(*) AS n FROM nodes")[0].n;
    if (count > 0) {
      this.stats.graphNodes = count;
      await this.persistStats();
    }
  }

  async fetch(request) {
    await this.initialized;

    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: JSON_HEADERS });
    }

    if (url.pathname === "/api/stats") {
      this.recordThroughputSample();
      return json(this.statsPayload());
    }

    if (url.pathname === "/api/peers" && request.method === "GET") {
      return json({
        peers: this.peerListWithMeshStatus(),
        maxPeers: MAX_MESH_PEERS,
        editProtected: Boolean(this.env.PEERS_EDIT_TOKEN),
      });
    }

    if (url.pathname === "/api/peers/reconnect" && request.method === "POST") {
      if (!requireEditAuth(request, this.env)) {
        return json({ error: "unauthorized" }, { status: 401 });
      }
      await this.syncRemoteMesh(true);
      return json({ ok: true, peers: this.peerListWithMeshStatus() });
    }

    if (url.pathname === "/api/peers/verify" && request.method === "POST") {
      return json(await this.verifyPeerRequest(request));
    }

    if (url.pathname === "/api/peers" && request.method === "POST") {
      if (!requireEditAuth(request, this.env)) {
        return json({ error: "unauthorized" }, { status: 401 });
      }
      return json(await this.addPeerRequest(request));
    }

    if (url.pathname === "/api/peers" && request.method === "DELETE") {
      if (!requireEditAuth(request, this.env)) {
        return json({ error: "unauthorized" }, { status: 401 });
      }
      return json(await this.removePeerRequest(url));
    }

    if (url.pathname === "/api/storage" && request.method === "DELETE") {
      if (!requireEditAuth(request, this.env)) {
        return json({ error: "unauthorized" }, { status: 401 });
      }
      return json(await this.e2eReset());
    }

    if (url.pathname.startsWith("/api/e2e/")) {
      if (!e2eAuthorized(request, this.env)) {
        return json({ error: "e2e disabled" }, { status: 404 });
      }
      if (url.pathname === "/api/e2e/reset" && request.method === "POST") {
        return json(await this.e2eReset());
      }
      if (url.pathname === "/api/e2e/nodes" && request.method === "GET") {
        return json(await this.e2eListNodes());
      }
      if (url.pathname === "/api/e2e/seed" && request.method === "POST") {
        return json(await this.e2eSeed());
      }
      if (url.pathname === "/api/e2e/system" && request.method === "GET") {
        return json(await this.e2eSystemSnapshot());
      }
      if (url.pathname === "/api/e2e/legacy" && request.method === "POST") {
        return json(await this.e2eSeedLegacy(request));
      }
      if (url.pathname === "/api/e2e/migrate" && request.method === "POST") {
        return json(await this.e2eMigrate(url));
      }
    }

    if (url.pathname === "/api/graph/souls" && request.method === "GET") {
      return json(await this.graphListSouls(url));
    }

    if (url.pathname === "/api/graph/node" && request.method === "GET") {
      return json(await this.graphGetNode(url));
    }

    if (url.pathname === "/api/graph/subgraph" && request.method === "GET") {
      return json(await this.graphSubgraph(url));
    }

    if (url.pathname === "/gun") {
      if (request.headers.get("upgrade") === "websocket") {
        return this.handleWebSocket();
      }

      if (request.method === "POST") {
        return this.handleHttpMessage(request);
      }

      return json(
        {
          status: "websocket required",
          peer: "/gun",
        },
        { status: 426, headers: { upgrade: "websocket" } },
      );
    }

    return new Response("not found", { status: 404, headers: SECURITY_HEADERS });
  }

  async handleWebSocket() {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Hibernation API: DO can sleep while clients stay connected (cuts free-tier duration).
    this.state.acceptWebSocket(server);
    server.serializeAttachment({ id: crypto.randomUUID() });

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  async webSocketMessage(ws, message) {
    await this.initialized;
    try {
      await this.handleRawMessage(message, ws);
    } catch {
      safeSend(ws, { err: "message processing failed" });
    }
  }

  async webSocketClose(ws, code, reason) {
    try {
      ws.close(code, reason);
    } catch {
      // already closed
    }
  }

  async webSocketError(ws) {
    try {
      ws.close(1011, "WebSocket error");
    } catch {
      // already closed
    }
  }

  async handleHttpMessage(request) {
    const text = await request.text();
    this.stats.messagesProcessed += 1;
    this.stats.bytesTransferred += text.length;

    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      return json({ err: "invalid json" }, { status: 400 });
    }

    const replies = await this.processPayload(payload);
    return json(replies.length === 1 ? replies[0] : replies);
  }

  async handleRawMessage(raw, sender) {
    const text = await messageToText(raw);
    this.stats.messagesProcessed += 1;
    this.stats.bytesTransferred += text.length;

    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      safeSend(sender, { err: "invalid json" });
      return;
    }

    const replies = await this.processPayload(payload, sender);
    for (const reply of replies) {
      safeSend(sender, reply);
    }
  }

  async processPayload(payload, sender) {
    const messages = Array.isArray(payload) ? payload : [payload];
    const replies = [];

    for (const message of messages) {
      if (!message || typeof message !== "object") {
        continue;
      }

      if (message.put && typeof message.put === "object") {
        const id = typeof message["#"] === "string" && message["#"] ? message["#"] : null;
        // Duplicate ids are mesh echoes of a put we already merged and relayed.
        if (!id || !this.markSeen(id)) {
          const changed = await this.mergeGraph(message.put);
          if (Object.keys(changed).length) {
            this.relayPut(changed, sender, id);
          }
        }
        replies.push({ "@": message["#"], ok: 1 });
      }

      if (message.get && typeof message.get === "object") {
        replies.push(await this.readGraph(message));
      }
    }

    return replies;
  }

  /** Returns true if `id` was already seen recently; records it otherwise. */
  markSeen(id, now = Date.now()) {
    const seenAt = this.seenMessages.get(id);
    if (seenAt !== undefined && now - seenAt < SEEN_MESSAGE_TTL_MS) {
      return true;
    }
    this.seenMessages.delete(id);
    this.seenMessages.set(id, now);
    while (this.seenMessages.size > SEEN_MESSAGE_MAX) {
      const [oldest] = this.seenMessages.keys();
      this.seenMessages.delete(oldest);
    }
    return false;
  }

  /** Cache → SQL → (until migrated) legacy KV. `legacy` marks a node still living in KV. */
  async loadNodeEntry(soul) {
    const cached = this.nodeCache.get(soul);
    if (cached) {
      return { node: cached.node, json: cached.json, legacy: false };
    }

    const [row] = this.sqlAll("SELECT data FROM nodes WHERE soul = ?", soul);
    if (row) {
      const node = JSON.parse(row.data);
      this.nodeCache.set(soul, node, row.data);
      return { node, json: row.data, legacy: false };
    }

    if (!this.migration.done) {
      const node = await this.state.storage.get(nodeKey(soul));
      if (node) {
        return { node, json: JSON.stringify(node), legacy: true };
      }
    }

    this.nodeCache.set(soul, null);
    return { node: null, json: null, legacy: false };
  }

  async loadNode(soul) {
    return (await this.loadNodeEntry(soul)).node;
  }

  /** Merge a put graph; returns only the souls whose stored node actually changed. */
  async mergeGraph(graph) {
    const changed = {};
    let added = 0;
    for (const [soul, incomingNode] of Object.entries(graph)) {
      if (!incomingNode || typeof incomingNode !== "object") {
        continue;
      }

      const existing = await this.loadNodeEntry(soul);
      const merged = mergeNode(soul, existing.node || { _: { "#": soul, ">": {} } }, incomingNode);
      const json = JSON.stringify(merged);
      if (existing.node && existing.json === json) {
        continue;
      }
      await this.putNode(soul, merged, json);
      if (existing.legacy) {
        await this.state.storage.delete(nodeKey(soul));
      }
      if (!existing.node) {
        added += 1;
      }
      changed[soul] = incomingNode;
    }

    if (added) {
      this.stats.graphNodes += added;
      await this.persistStats();
    }
    await this.evictOldGraphDataIfNeeded();
    return changed;
  }

  async putNode(soul, node, json) {
    const values = nodeRowValues(soul, node, json);
    try {
      this.sqlRun(UPSERT_NODE_SQL, ...values);
    } catch {
      await this.evictOldGraphDataIfNeeded();
      this.sqlRun(UPSERT_NODE_SQL, ...values);
    }
    this.nodeCache.set(soul, node, json);
  }

  listGraphNodeCandidates() {
    // ponytail: full scan, but only when storage is past the eviction threshold
    return this.sqlAll("SELECT soul, bytes FROM nodes ORDER BY oldest, soul");
  }

  async evictOldGraphDataIfNeeded() {
    const { evictAt, evictBytes } = this.storageLimits();
    let bytesUsed = this.state.storage.sql?.databaseSize ?? 0;
    if (bytesUsed < evictAt) {
      return { evicted: 0 };
    }

    let totalEvicted = 0;
    let totalFreed = 0;

    // ponytail: O(n) scan over node keys only when >= threshold; deletes oldest nodes until target freed
    while (bytesUsed >= evictAt) {
      const candidates = this.listGraphNodeCandidates();
      if (!candidates.length) {
        break;
      }

      let batchFreed = 0;
      let batchEvicted = 0;
      for (const candidate of candidates) {
        if (batchFreed >= evictBytes) {
          break;
        }
        this.sqlRun("DELETE FROM nodes WHERE soul = ?", candidate.soul);
        this.nodeCache.delete(candidate.soul);
        batchFreed += candidate.bytes;
        batchEvicted += 1;
        this.stats.graphNodes = Math.max(0, (this.stats.graphNodes || 0) - 1);
      }

      if (batchEvicted === 0) {
        break;
      }

      totalEvicted += batchEvicted;
      totalFreed += batchFreed;
      this.stats.lastEviction = {
        at: Date.now(),
        nodes: batchEvicted,
        bytesEstimate: batchFreed,
      };
      await this.persistStats();

      bytesUsed = this.state.storage.sql?.databaseSize ?? 0;
      if (bytesUsed >= evictAt && batchFreed < evictBytes / 10) {
        break;
      }
    }

    return { evicted: totalEvicted, freed: totalFreed };
  }

  storageLimits() {
    const evictAt = Number(this.env?.STORAGE_EVICT_AT_BYTES) || STORAGE_EVICT_AT_BYTES;
    const evictBytes = Number(this.env?.STORAGE_EVICT_BYTES) || STORAGE_EVICT_BYTES;
    const limitBytes = Number(this.env?.STORAGE_LIMIT_BYTES) || STORAGE_LIMIT_BYTES;
    return { evictAt, evictBytes, limitBytes };
  }

  async e2eReset() {
    // deleteAll() drops SQL tables too on SQLite-backed objects.
    await this.state.storage.deleteAll();
    this.ensureSchema();
    this.nodeCache.clear();
    this.seenMessages.clear();
    this.migration = { done: true, lastBatchAt: 0 };
    await this.state.storage.put(NODE_MIGRATION_KEY, this.migration);
    this.startTime = Date.now();
    this.stats = {
      startTime: this.startTime,
      messagesProcessed: 0,
      bytesTransferred: 0,
      graphNodes: 0,
    };
    this.throughput = {
      samples: [],
      lastMessages: 0,
      lastBytes: 0,
      lastSampleTime: 0,
    };
    this.peerList = [];
    await this.persistStats();
    await this.persistPeerList();
    await this.state.storage.deleteAlarm();
    return { ok: true };
  }

  async e2eListNodes() {
    const souls = this.sqlAll("SELECT soul FROM nodes ORDER BY soul").map((row) => row.soul);
    return { souls };
  }

  async e2eSeed() {
    await this.state.storage.put("peerList", [{ id: "p1", url: "https://example.com/gun" }]);
    await this.loadPeerList();
    this.throughput.samples = [{ t: Date.now(), msg: 1, byte: 2 }];
    await this.scheduleAlarm();
    return { ok: true };
  }

  /** Test hook: write pre-SQL `node:` KV entries and reopen migration. */
  async e2eSeedLegacy(request) {
    const body = await request.json().catch(() => ({}));
    const nodes = body.nodes && typeof body.nodes === "object" ? body.nodes : {};
    for (const [soul, node] of Object.entries(nodes)) {
      await this.state.storage.put(nodeKey(soul), node);
    }
    this.migration = { done: false, lastBatchAt: 0 };
    await this.state.storage.put(NODE_MIGRATION_KEY, this.migration);
    this.nodeCache.clear();
    return { ok: true, count: Object.keys(nodes).length };
  }

  async e2eMigrate(url) {
    const limit = clampInt(url.searchParams.get("limit"), NODE_MIGRATION_BATCH, 1, 1000);
    return this.migrateLegacyNodes(limit);
  }

  async e2eSystemSnapshot() {
    return {
      stats: await this.state.storage.get("stats"),
      peerList: await this.state.storage.get("peerList"),
      throughput: this.throughput,
      alarm: await this.state.storage.getAlarm(),
    };
  }

  async graphListSouls(url) {
    const limit = clampInt(
      url.searchParams.get("limit"),
      GRAPH_SOULS_DEFAULT_LIMIT,
      1,
      GRAPH_SOULS_MAX_LIMIT,
    );
    const prefix = url.searchParams.get("prefix") || "";
    const query = (url.searchParams.get("q") || "").trim().toLowerCase();
    const sort = url.searchParams.get("sort") || "";
    const startCursor = url.searchParams.get("cursor") || undefined;

    if (sort === "updated") {
      return this.graphListSoulsByUpdated(limit, prefix, query);
    }
    return this.graphListSoulsBySoul(limit, prefix, query, startCursor);
  }

  /** Index-ordered page of live souls; `cursor` is the last soul of the previous page. */
  graphListSoulsBySoul(limit, prefix = "", query = "", startCursor = undefined) {
    const { clauses, params } = soulFilterSql(prefix, query);
    if (startCursor) {
      clauses.push("soul > ?");
      params.push(startCursor);
    }
    const rows = this.sqlAll(
      `SELECT soul, label, updated FROM nodes
        WHERE live = 1${clauses.map((c) => ` AND ${c}`).join("")}
        ORDER BY soul LIMIT ?`,
      ...params,
      limit + 1,
    );
    const truncated = rows.length > limit;
    const souls = rows.slice(0, limit);
    return {
      souls,
      cursor: truncated ? souls[souls.length - 1].soul : undefined,
      truncated,
    };
  }

  /** Most recently updated live souls; served from the partial covering index. */
  graphListSoulsByUpdated(limit, prefix = "", query = "") {
    const { clauses, params } = soulFilterSql(prefix, query);
    const rows = this.sqlAll(
      `SELECT soul, label, updated FROM nodes
        WHERE live = 1${clauses.map((c) => ` AND ${c}`).join("")}
        ORDER BY updated DESC, soul LIMIT ?`,
      ...params,
      limit + 1,
    );
    return {
      souls: rows.slice(0, limit),
      truncated: rows.length > limit,
    };
  }

  async graphGetNode(url) {
    const soul = (url.searchParams.get("soul") || "").trim();
    if (!soul) {
      return { error: "soul required" };
    }

    const node = await this.loadNode(soul);
    if (!nodeHasContent(node)) {
      return { error: "not found", soul };
    }

    const { fields, refs } = summarizeNodeFields(node);
    return {
      soul,
      label: nodeLabel(node, soul),
      updated: nodeUpdated(node),
      fields,
      refs,
      raw: node,
    };
  }

  async graphSubgraph(url) {
    const maxNodes = clampInt(
      url.searchParams.get("maxNodes"),
      GRAPH_SUBGRAPH_DEFAULT_NODES,
      1,
      GRAPH_SUBGRAPH_MAX_NODES,
    );
    const depth = clampInt(
      url.searchParams.get("depth"),
      1,
      0,
      GRAPH_SUBGRAPH_MAX_DEPTH,
    );
    // ponytail: `list` returns the sidebar soul list from the same index read (explorer makes one call).
    const listLimit = clampInt(url.searchParams.get("list"), 0, 0, GRAPH_SOULS_MAX_LIMIT);
    const prefix = url.searchParams.get("prefix") || "";
    const query = (url.searchParams.get("q") || "").trim().toLowerCase();
    const rootsParam = url.searchParams.get("roots") || "";
    let truncated = false;
    let listed = null;
    let seedSouls = rootsParam
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    if (!seedSouls.length || listLimit) {
      listed = this.graphListSoulsByUpdated(Math.max(maxNodes, listLimit), prefix, query);
    }
    if (!seedSouls.length) {
      seedSouls = listed.souls.slice(0, maxNodes).map((row) => row.soul);
      truncated = listed.truncated || listed.souls.length > maxNodes;
    }

    const subgraph = await this.buildSubgraph(seedSouls, depth, maxNodes);
    if (truncated) {
      subgraph.truncated = true;
    }
    if (listLimit) {
      subgraph.souls = listed.souls.slice(0, listLimit);
      subgraph.soulsTruncated = listed.truncated || listed.souls.length > listLimit;
    }
    return subgraph;
  }

  async buildSubgraph(seedSouls, maxDepth, maxNodes) {
    const nodesMap = new Map();
    const edges = [];
    const edgeKeys = new Set();
    const missingTargets = new Set();
    let truncated = false;

    const visited = new Set();
    const queue = [...new Set(seedSouls)].map((soul) => ({ soul, hop: 0 }));

    while (queue.length > 0 && nodesMap.size < maxNodes) {
      const { soul, hop } = queue.shift();
      if (nodesMap.has(soul)) {
        continue;
      }

      const node = await this.loadNode(soul);
      if (!nodeHasContent(node)) {
        continue;
      }
      visited.add(soul);

      nodesMap.set(soul, {
        soul,
        label: nodeLabel(node, soul),
        fields: nodePreviewFields(node),
        updated: nodeUpdated(node),
        bytes: nodeBytes(node),
      });

      for (const edge of extractGunRefs(node, soul)) {
        const key = `${edge.from}|${edge.field}|${edge.to}`;
        if (!edgeKeys.has(key)) {
          edgeKeys.add(key);
          edges.push(edge);
        }
        if (hop < maxDepth) {
          if (!nodesMap.has(edge.to)) {
            queue.push({ soul: edge.to, hop: hop + 1 });
          }
        } else if (!nodesMap.has(edge.to)) {
          missingTargets.add(edge.to);
        }
      }
    }

    if (queue.length > 0 && nodesMap.size >= maxNodes) {
      truncated = true;
    }

    for (const target of missingTargets) {
      if (nodesMap.size >= maxNodes) {
        truncated = true;
        break;
      }
      if (!nodesMap.has(target)) {
        nodesMap.set(target, {
          soul: target,
          label: nodeLabel(null, target),
          fields: {},
          updated: 0,
          ghost: true,
        });
      }
    }

    return {
      nodes: [...nodesMap.values()],
      edges,
      truncated,
      missingTargets: [...missingTargets],
    };
  }

  async readGraph(message) {
    const requestId = message["#"];
    const get = message.get || {};
    const soul = normalizeSoul(get["#"]);
    const field = typeof get["."] === "string" ? get["."] : null;

    if (!soul) {
      return { "@": requestId, put: null, err: "soul required" };
    }

    const node = await this.loadNode(soul);
    if (!node) {
      return { "@": requestId, put: null };
    }

    if (field) {
      if (!(field in node)) {
        return { "@": requestId, put: null };
      }

      return {
        "@": requestId,
        put: {
          [soul]: {
            _: {
              "#": soul,
              ">": {
              [field]: node._?.[">"]?.[field] ?? Date.now(),
              },
            },
            [field]: node[field],
          },
        },
      };
    }

    return { "@": requestId, put: { [soul]: node } };
  }

  async verifyPeerRequest(request) {
    let body;
    try {
      body = await request.json();
    } catch {
      return { ok: false, error: "invalid json" };
    }

    const normalized = normalizePeerUrl(body.url);
    if (!normalized.ok) {
      return { ok: false, error: normalized.error };
    }

    const probe = await probeGunPeer(normalized.url);
    return {
      ok: true,
      url: normalized.url,
      ...probe,
    };
  }

  async addPeerRequest(request) {
    let body;
    try {
      body = await request.json();
    } catch {
      return { ok: false, error: "invalid json" };
    }

    const normalized = normalizePeerUrl(body.url);
    if (!normalized.ok) {
      return { ok: false, error: normalized.error };
    }

    if (this.peerList.some((p) => p.url === normalized.url)) {
      return { ok: false, error: "peer already listed" };
    }

    if (this.peerList.length >= MAX_MESH_PEERS) {
      return { ok: false, error: `max ${MAX_MESH_PEERS} peers` };
    }

    const probe = await probeGunPeer(normalized.url);
    if (!probe.reachable || !probe.verified) {
      return { ok: false, error: "peer failed verification", probe };
    }

    const entry = {
      id: crypto.randomUUID(),
      url: normalized.url,
      addedAt: Date.now(),
      lastChecked: Date.now(),
      verified: true,
      lastStatus: probe.status,
    };
    this.peerList.push(entry);
    await this.persistPeerList();
    await this.connectRemotePeer(entry);
    await this.scheduleAlarm();
    return { ok: true, peer: { ...entry, meshStatus: entry.meshStatus || "connecting" } };
  }

  async removePeerRequest(url) {
    const id = url.searchParams.get("id");
    if (!id) {
      return { ok: false, error: "id required" };
    }

    const before = this.peerList.length;
    this.peerList = this.peerList.filter((p) => p.id !== id);
    if (this.peerList.length === before) {
      return { ok: false, error: "peer not found" };
    }

    this.disconnectRemotePeer(id);
    await this.persistPeerList();
    await this.scheduleAlarm();
    return { ok: true };
  }

  peerUrlToWs(url) {
    const parsed = new URL(url);
    parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
    return parsed.toString();
  }

  remoteStatus(peerId) {
    const conn = this.remotePeers.get(peerId);
    if (conn?.ws?.readyState === WebSocket.OPEN) {
      return "connected";
    }
    return conn?.status || "disconnected";
  }

  peerListWithMeshStatus() {
    return (this.peerList ?? []).map((peer) => ({
      ...peer,
      meshStatus: this.remoteStatus(peer.id),
    }));
  }

  disconnectRemotePeer(peerId) {
    const conn = this.remotePeers.get(peerId);
    if (conn?.reconnectTimer) {
      clearTimeout(conn.reconnectTimer);
    }
    if (conn?.ws) {
      try {
        conn.ws.close();
      } catch {
        // already closed
      }
    }
    this.remotePeers.delete(peerId);
  }

  scheduleRemoteReconnect(peer) {
    const conn = this.remotePeers.get(peer.id);
    if (conn?.reconnectTimer) {
      return;
    }
    const timer = setTimeout(() => {
      const current = this.remotePeers.get(peer.id);
      if (current) {
        current.reconnectTimer = undefined;
      }
      this.connectRemotePeer(peer).catch(() => {});
    }, 30_000);
    if (conn) {
      conn.reconnectTimer = timer;
      conn.status = "reconnecting";
    }
  }

  async connectRemotePeer(peer) {
    const existing = this.remotePeers.get(peer.id);
    if (existing?.ws?.readyState === WebSocket.OPEN) {
      return;
    }
    if (existing) {
      this.disconnectRemotePeer(peer.id);
    }

    const wsUrl = this.peerUrlToWs(peer.url);
    const ws = new WebSocket(wsUrl);

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout")), 10_000);
      ws.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      ws.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new Error("websocket error"));
        },
        { once: true },
      );
    });

    ws.addEventListener("message", (event) => {
      this.handleRawMessage(event.data, ws).catch(() => {});
    });

    ws.addEventListener("close", () => {
      this.remotePeers.delete(peer.id);
      if (this.peerList.some((p) => p.id === peer.id)) {
        this.scheduleRemoteReconnect(peer);
      }
    });

    this.remotePeers.set(peer.id, { ws, peer, status: "connected" });
  }

  async syncRemoteMesh(force = false) {
    const listed = new Set(this.peerList.map((p) => p.id));
    for (const id of [...this.remotePeers.keys()]) {
      if (!listed.has(id)) {
        this.disconnectRemotePeer(id);
      }
    }

    for (const peer of this.peerList) {
      if (force) {
        this.disconnectRemotePeer(peer.id);
      }
      try {
        await this.connectRemotePeer(peer);
      } catch {
        this.remotePeers.set(peer.id, { ws: null, peer, status: "disconnected" });
        this.scheduleRemoteReconnect(peer);
      }
    }
  }

  relayPut(graph, sender, id = null) {
    // Keep the original id so Gun peers (and our own markSeen) drop echoes.
    const messageId = id || crypto.randomUUID();
    if (!id) {
      this.markSeen(messageId);
    }
    const message = { "#": messageId, put: graph };
    this.broadcast(message, sender);
    this.forwardToRemotes(message, sender);
  }

  forwardToRemotes(message, sender) {
    for (const { ws } of this.remotePeers.values()) {
      if (ws && ws !== sender && ws.readyState === WebSocket.OPEN) {
        safeSend(ws, message);
      }
    }
  }

  broadcast(message, sender) {
    for (const socket of this.state.getWebSockets()) {
      if (socket !== sender) {
        safeSend(socket, message);
      }
    }
  }

  statsPayload() {
    const uptime = Date.now() - this.stats.startTime;
    const seconds = Math.floor(uptime / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    const live = this.state.getWebSockets().length;
    const bytesUsed = this.state.storage.sql?.databaseSize ?? null;

    return {
      status: "online",
      uptime: {
        ms: uptime,
        seconds,
        minutes,
        hours,
        days,
        formatted: `${days}d ${hours % 24}h ${minutes % 60}m ${seconds % 60}s`,
      },
      connections: {
        live,
        current: live,
        activePeers: live,
      },
      performance: {
        messagesProcessed: this.stats.messagesProcessed,
        bytesTransferred: this.stats.bytesTransferred,
      },
      throughput: {
        windowMs: THROUGHPUT_WINDOW_MS,
        maxPoints: THROUGHPUT_MAX_POINTS,
        samples: this.throughput?.samples ?? [],
      },
      storage: {
        backend: detectStorageBackend(this.state.storage),
        durableObjectClass: "GunPeerObject",
        persistent: true,
        bytesUsed,
        limitBytes: this.storageLimits().limitBytes,
        evictAtBytes: this.storageLimits().evictAt,
        evictBytes: this.storageLimits().evictBytes,
        graphNodes: this.stats.graphNodes,
        lastEviction: this.stats.lastEviction ?? null,
        // SQL rows since this instance woke; KV calls (stats, peers) are not included.
        sqlUsage: { ...this.sqlUsage },
        migration: { ...this.migration },
      },
      mesh: {
        peers: this.peerListWithMeshStatus(),
        connected: [...this.remotePeers.values()].filter(
          (c) => c.ws?.readyState === WebSocket.OPEN,
        ).length,
        maxPeers: MAX_MESH_PEERS,
        editProtected: Boolean(this.env.PEERS_EDIT_TOKEN),
        mode: "server",
      },
    };
  }

  persistStats() {
    return this.state.storage.put("stats", this.stats);
  }
}

function mergeNode(soul, existingNode, incomingNode) {
  const existingState = existingNode._?.[">"] || {};
  const incomingState = incomingNode._?.[">"] || {};
  const merged = {
    ...existingNode,
    _: {
      "#": soul,
      ">": {
        ...existingState,
      },
    },
  };

  for (const [field, value] of Object.entries(incomingNode)) {
    if (field === "_") {
      continue;
    }

    const nextState = incomingState[field] ?? Date.now();
    const previousState = merged._[">"][field] ?? 0;
    if (nextState >= previousState) {
      merged[field] = value;
      merged._[">"][field] = nextState;
    }
  }

  return merged;
}

function normalizeSoul(value) {
  if (typeof value === "string") {
    return value;
  }

  if (value && typeof value === "object" && typeof value["="] === "string") {
    return value["="];
  }

  return null;
}

function nodeKey(soul) {
  return `node:${soul}`;
}

function nodeOldestTimestamp(node) {
  const states = node._?.[">"] || {};
  const times = Object.values(states).filter((n) => typeof n === "number");
  return times.length ? Math.min(...times) : 0;
}

function nodeUpdated(node) {
  const states = node._?.[">"] || {};
  const times = Object.values(states).filter((n) => typeof n === "number");
  return times.length ? Math.max(...times) : 0;
}

function nodeHasContent(node) {
  return Boolean(node && Object.entries(node).some(([field, value]) => field !== "_" && value !== null));
}

function nodeBytes(node) {
  return JSON.stringify(node).length;
}

function clampInt(raw, fallback, min, max) {
  if (raw === null || raw === undefined || raw === "") {
    return fallback;
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function extractRefSoul(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const soul = value["#"];
  if (typeof soul === "string" && soul) {
    return soul;
  }
  return null;
}

function extractGunRefs(node, sourceSoul) {
  const edges = [];
  for (const [field, value] of Object.entries(node || {})) {
    if (field === "_") {
      continue;
    }
    collectGunRefEdges(edges, sourceSoul, field, value);
  }
  return edges;
}

function collectGunRefEdges(edges, sourceSoul, field, value, depth = 0) {
  const target = extractRefSoul(value);
  if (target) {
    edges.push({ from: sourceSoul, to: target, field });
    return;
  }
  if (!value || typeof value !== "object" || depth >= 12) {
    return;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      collectGunRefEdges(edges, sourceSoul, `${field}[${index}]`, value[index], depth + 1);
    }
    return;
  }
  for (const [nestedField, nestedValue] of Object.entries(value)) {
    collectGunRefEdges(edges, sourceSoul, `${field}.${nestedField}`, nestedValue, depth + 1);
  }
}

function truncatePreview(text, maxLen = GRAPH_FIELD_PREVIEW_LEN) {
  if (typeof text !== "string") {
    text = String(text);
  }
  return text.length > maxLen ? `${text.slice(0, maxLen)}…` : text;
}

function tryParseJsonValue(value) {
  if (typeof value !== "string") {
    return value;
  }
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return value;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function isTimestampMapNode(node) {
  const keys = Object.keys(node || {}).filter((k) => k !== "_");
  if (keys.length < GRAPH_INSPECTOR_COLLAPSE_AT) {
    return false;
  }
  const tsKeys = keys.filter((k) => HISTORY_KEY_RE.test(k));
  return tsKeys.length >= keys.length * 0.7;
}

function summarizeFieldValue(key, value, maxLen = GRAPH_FIELD_PREVIEW_LEN) {
  const ref = extractRefSoul(value);
  if (ref) {
    return {
      key,
      type: "ref",
      preview: ref,
      ref,
    };
  }
  if (typeof value === "string") {
    const parsed = tryParseJsonValue(value);
    if (parsed !== value) {
      const inner = summarizeFieldValue(key, parsed, maxLen);
      return { ...inner, key };
    }
    return {
      key,
      type: "string",
      preview: truncatePreview(value, maxLen),
    };
  }
  if (typeof value === "number") {
    return { key, type: "number", preview: String(value) };
  }
  if (typeof value === "boolean") {
    return { key, type: "boolean", preview: String(value) };
  }
  if (Array.isArray(value)) {
    const sample = value.slice(0, 3).map((item) => {
      const itemRef = extractRefSoul(item);
      if (itemRef) {
        return `#${itemRef}`;
      }
      if (typeof item === "string") {
        return truncatePreview(item, 24);
      }
      return typeof item;
    });
    return {
      key,
      type: "array",
      preview: `${value.length} items`,
      keyCount: value.length,
      sampleKeys: sample,
    };
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value);
    return {
      key,
      type: "object",
      preview: `${keys.length} entries`,
      keyCount: keys.length,
      sampleKeys: keys.slice(0, 5),
    };
  }
  return { key, type: "string", preview: String(value) };
}

function summarizeNodeFields(node, maxLen = GRAPH_FIELD_PREVIEW_LEN) {
  const refs = [];
  for (const [key, value] of Object.entries(node || {})) {
    if (key === "_") {
      continue;
    }
    const summary = summarizeFieldValue(key, tryParseJsonValue(value), maxLen);
    if (summary.type === "ref" && summary.ref) {
      refs.push({ field: key, to: summary.ref });
    }
  }

  if (isTimestampMapNode(node)) {
    const allKeys = Object.keys(node).filter((k) => k !== "_");
    const entries = allKeys
      .sort((a, b) => b.localeCompare(a))
      .slice(0, GRAPH_INSPECTOR_MAP_PREVIEW)
      .map((key) => summarizeFieldValue(key, tryParseJsonValue(node[key]), maxLen));
    return {
      fields: [{
        key: "entries",
        type: "map",
        preview: `${allKeys.length} timestamp entries (newest first)`,
        keyCount: allKeys.length,
        entries,
      }],
      refs,
    };
  }

  const fields = [];
  for (const [key, value] of Object.entries(node || {})) {
    if (key === "_") {
      continue;
    }
    fields.push(summarizeFieldValue(key, tryParseJsonValue(value), maxLen));
  }
  fields.sort((a, b) => a.key.localeCompare(b.key));
  return { fields, refs };
}

function nodePreviewFields(node, maxLen = GRAPH_FIELD_PREVIEW_LEN) {
  const fields = {};
  for (const [field, value] of Object.entries(node || {})) {
    if (field === "_") {
      continue;
    }
    if (typeof value === "string") {
      fields[field] = value.length > maxLen ? `${value.slice(0, maxLen)}…` : value;
    } else if (typeof value === "number" || typeof value === "boolean") {
      fields[field] = value;
    } else {
      const ref = extractRefSoul(value);
      if (ref) {
        fields[field] = `# → ${ref}`;
      }
    }
  }
  return fields;
}

function nodeLabel(node, soul) {
  for (const [field, value] of Object.entries(node || {})) {
    if (field === "_") {
      continue;
    }
    if (typeof value === "string" && value.length > 0 && value.length <= 40) {
      return value;
    }
  }
  const parts = soul.split("/");
  return parts[parts.length - 1] || soul;
}

export {
  NodeCache,
  prefixUpperBound,
  soulFilterSql,
  nodeOldestTimestamp,
  extractGunRefs,
  extractRefSoul,
  nodeLabel,
  nodePreviewFields,
  nodeUpdated,
  nodeHasContent,
  nodeBytes,
  clampInt,
  summarizeNodeFields,
  summarizeFieldValue,
  tryParseJsonValue,
  isTimestampMapNode,
};

async function messageToText(raw) {
  if (typeof raw === "string") {
    return raw;
  }

  if (raw instanceof ArrayBuffer) {
    return new TextDecoder().decode(raw);
  }

  if (ArrayBuffer.isView(raw)) {
    return new TextDecoder().decode(raw);
  }

  if (raw && typeof raw.text === "function") {
    return raw.text();
  }

  return String(raw);
}

function safeSend(socket, message) {
  try {
    socket.send(JSON.stringify(message));
  } catch {
    // Closed sockets are removed by their close/error handlers.
  }
}

// ponytail: self-check throughput pruning (worker bundle only; skip when imported by vitest in node)
if (typeof WebSocketPair !== "undefined" && typeof console !== "undefined" && console.assert) {
  const pruned = pruneThroughputSamples(
    [
      { t: 0, msg: 1, byte: 1 },
      { t: 50_000, msg: 2, byte: 2 },
      { t: 70_000, msg: 3, byte: 3 },
    ],
    52_000,
    5_000,
  );
  console.assert(pruned.length === 1 && pruned[0].t === 50_000, "throughput prune keeps in-window samples");
  console.assert(THROUGHPUT_SAMPLE_MS === 5000, "stats-driven sample interval");
  console.assert(THROUGHPUT_WINDOW_MS === 300_000, "60 samples × 5s = 5min window");
  console.assert(MESH_ALARM_MS === 300_000, "mesh maintenance every 5min");
  console.assert(isBlockedHost("127.0.0.1"), "blocks loopback");
  console.assert(isBlockedHost("10.0.0.5"), "blocks private ip");
  console.assert(normalizePeerUrl("relay.example.com").url.endsWith("/gun"), "normalizes gun path");
  console.assert(nodeOldestTimestamp({ _: { ">": { a: 5, b: 10 } } }) === 5, "oldest node timestamp");
  console.assert(
    extractGunRefs({ friend: { "#": "b" } }, "a").length === 1,
    "extractGunRefs finds soul link",
  );
}
