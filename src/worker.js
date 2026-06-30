const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type",
};

const THROUGHPUT_MAX_POINTS = 60;
const THROUGHPUT_WINDOW_MS = THROUGHPUT_MAX_POINTS * 1000;
const THROUGHPUT_ALARM_MS = 1000;
const THROUGHPUT_GAP_MS = 120_000;

const MAX_MESH_PEERS = 20;
const STORAGE_LIMIT_BYTES = 10 * 1024 * 1024 * 1024;
const STORAGE_EVICT_AT_BYTES = 9 * 1024 * 1024 * 1024;
const STORAGE_EVICT_BYTES = 1 * 1024 * 1024 * 1024;

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "permissions-policy": "geolocation=(), microphone=(), camera=()",
};

function normalizeStorageListPage(page) {
  if (page instanceof Map) {
    return {
      entries: [...page.keys()].map((name) => ({ name })),
      listComplete: true,
      cursor: undefined,
    };
  }
  const keys = page?.keys;
  const entries = Array.isArray(keys)
    ? keys.map((key) => (typeof key === "string" ? { name: key } : key))
    : keys && typeof keys[Symbol.iterator] === "function"
      ? [...keys].map((key) => (typeof key === "string" ? { name: key } : key))
      : page?.entries instanceof Map
        ? [...page.entries.keys()].map((name) => ({ name }))
        : [];
  return {
    entries,
    listComplete: page?.list_complete !== false,
    cursor: page?.cursor,
  };
}

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
    this.connections = new Map();
    this.remotePeers = new Map();
    this.startTime = Date.now();
    this.initialized = this.initialize();
  }

  async initialize() {
    const stats = await this.state.storage.get("stats");
    if (stats) {
      this.stats = {
        startTime: stats.startTime || this.startTime,
        totalConnections: stats.totalConnections || 0,
        messagesProcessed: stats.messagesProcessed || 0,
        bytesTransferred: stats.bytesTransferred || 0,
        graphNodes: stats.graphNodes || 0,
      };
    } else {
      this.stats = {
        startTime: this.startTime,
        totalConnections: 0,
        messagesProcessed: 0,
        bytesTransferred: 0,
        graphNodes: 0,
      };
      await this.persistStats();
    }

    await this.syncGraphNodeCountIfNeeded();
    await this.loadThroughput();
    await this.loadPeerList();
    await this.syncRemoteMesh();
    await this.state.storage.setAlarm(Date.now() + THROUGHPUT_ALARM_MS);
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
    await this.persistThroughput();
  }

  async alarm() {
    await this.initialized;
    await this.recordThroughputSample();
    await this.evictOldGraphDataIfNeeded();
    await this.syncRemoteMesh();
    await this.state.storage.setAlarm(Date.now() + THROUGHPUT_ALARM_MS);
  }

  async recordThroughputSample(now = Date.now()) {
    const tp = this.throughput;
    if (!tp.lastSampleTime) {
      tp.lastMessages = this.stats.messagesProcessed;
      tp.lastBytes = this.stats.bytesTransferred;
      tp.lastSampleTime = now;
      await this.persistThroughput();
      return;
    }

    const elapsed = now - tp.lastSampleTime;
    if (elapsed > THROUGHPUT_GAP_MS) {
      tp.lastMessages = this.stats.messagesProcessed;
      tp.lastBytes = this.stats.bytesTransferred;
      tp.lastSampleTime = now;
      tp.samples = pruneThroughputSamples(tp.samples, now);
      await this.persistThroughput();
      return;
    }

    if (elapsed < THROUGHPUT_ALARM_MS * 0.9) {
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
    await this.persistThroughput();
  }

  persistThroughput() {
    return this.state.storage.put("throughput", this.throughput);
  }

  async syncGraphNodeCountIfNeeded() {
    if (this.stats.graphNodes > 0) {
      return;
    }

    // ponytail: one O(n) list on cold start when counter missing; not per poll
    let count = 0;
    let cursor;
    do {
      const page = await this.state.storage.list({ prefix: "node:", cursor });
      const { entries, listComplete, cursor: nextCursor } = normalizeStorageListPage(page);
      count += entries.length;
      cursor = listComplete ? undefined : nextCursor;
    } while (cursor);

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
      await this.recordThroughputSample();
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
    const connectionId = crypto.randomUUID();

    server.accept();
    this.connections.set(connectionId, server);
    this.stats.totalConnections += 1;
    await this.persistStats();

    server.addEventListener("message", (event) => {
      this.handleRawMessage(event.data, server).catch(() => {
        safeSend(server, { err: "message processing failed" });
      });
    });

    server.addEventListener("close", () => {
      this.connections.delete(connectionId);
    });

    server.addEventListener("error", () => {
      this.connections.delete(connectionId);
    });

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  async handleHttpMessage(request) {
    const text = await request.text();
    this.stats.messagesProcessed += 1;
    this.stats.bytesTransferred += text.length;

    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      await this.persistStats();
      return json({ err: "invalid json" }, { status: 400 });
    }

    const replies = await this.processPayload(payload);
    await this.persistStats();
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
      await this.persistStats();
      return;
    }

    const replies = await this.processPayload(payload, sender);
    for (const reply of replies) {
      safeSend(sender, reply);
    }

    await this.persistStats();
  }

  async processPayload(payload, sender) {
    const messages = Array.isArray(payload) ? payload : [payload];
    const replies = [];

    for (const message of messages) {
      if (!message || typeof message !== "object") {
        continue;
      }

      if (message.put && typeof message.put === "object") {
        await this.mergeGraph(message.put);
        replies.push({ "@": message["#"], ok: 1 });
        this.relayPut(message.put, sender);
      }

      if (message.get && typeof message.get === "object") {
        replies.push(await this.readGraph(message));
      }
    }

    return replies;
  }

  async mergeGraph(graph) {
    await this.evictOldGraphDataIfNeeded();

    for (const [soul, incomingNode] of Object.entries(graph)) {
      if (!incomingNode || typeof incomingNode !== "object") {
        continue;
      }

      const key = nodeKey(soul);
      const stored = await this.state.storage.get(key);
      if (!stored) {
        this.stats.graphNodes += 1;
      }
      const existingNode = stored || {
        _: { "#": soul, ">": {} },
      };
      const merged = mergeNode(soul, existingNode, incomingNode);
      await this.putNode(key, merged);
    }

    await this.evictOldGraphDataIfNeeded();
  }

  async putNode(key, value) {
    try {
      await this.state.storage.put(key, value);
    } catch {
      await this.evictOldGraphDataIfNeeded();
      await this.state.storage.put(key, value);
    }
  }

  async listGraphNodeCandidates() {
    const candidates = [];
    let cursor;
    do {
      const page = await this.state.storage.list({ prefix: "node:", cursor });
      const { entries, listComplete, cursor: nextCursor } = normalizeStorageListPage(page);
      for (const entry of entries) {
        const node = await this.state.storage.get(entry.name);
        if (!node) {
          continue;
        }
        candidates.push({
          key: entry.name,
          age: nodeOldestTimestamp(node),
          size: JSON.stringify(node).length,
        });
      }
      cursor = listComplete ? undefined : nextCursor;
    } while (cursor);
    return candidates;
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
      const candidates = await this.listGraphNodeCandidates();
      if (!candidates.length) {
        break;
      }

      candidates.sort((a, b) => a.age - b.age || a.key.localeCompare(b.key));

      let batchFreed = 0;
      let batchEvicted = 0;
      for (const candidate of candidates) {
        if (batchFreed >= evictBytes) {
          break;
        }
        await this.state.storage.delete(candidate.key);
        batchFreed += candidate.size;
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
    return { evictAt, evictBytes, limitBytes: STORAGE_LIMIT_BYTES };
  }

  async e2eReset() {
    await this.state.storage.deleteAll();
    this.startTime = Date.now();
    this.stats = {
      startTime: this.startTime,
      totalConnections: 0,
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
    await this.persistThroughput();
    await this.persistPeerList();
    return { ok: true };
  }

  async e2eListNodes() {
    const souls = [];
    let cursor;
    do {
      const page = await this.state.storage.list({ prefix: "node:", cursor });
      const { entries, listComplete, cursor: nextCursor } = normalizeStorageListPage(page);
      for (const entry of entries) {
        souls.push(entry.name.replace(/^node:/, ""));
      }
      cursor = listComplete ? undefined : nextCursor;
    } while (cursor);
    souls.sort();
    return { souls };
  }

  async e2eSeed() {
    await this.state.storage.put("peerList", [{ id: "p1", url: "https://example.com/gun" }]);
    await this.state.storage.put("throughput", {
      samples: [{ t: Date.now(), msg: 1, byte: 2 }],
      lastMessages: 0,
      lastBytes: 0,
      lastSampleTime: Date.now(),
    });
    await this.loadPeerList();
    await this.loadThroughput();
    return { ok: true };
  }

  async e2eSystemSnapshot() {
    return {
      stats: await this.state.storage.get("stats"),
      peerList: await this.state.storage.get("peerList"),
      throughput: await this.state.storage.get("throughput"),
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

    const node = await this.state.storage.get(nodeKey(soul));
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

  relayPut(graph, sender) {
    const message = { "#": crypto.randomUUID(), put: graph };
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
    for (const socket of this.connections.values()) {
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
    const live = this.connections.size;
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
        total: this.stats.totalConnections,
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
        backend: "sqlite",
        persistent: true,
        bytesUsed,
        limitBytes: STORAGE_LIMIT_BYTES,
        evictAtBytes: this.storageLimits().evictAt,
        evictBytes: this.storageLimits().evictBytes,
        graphNodes: this.stats.graphNodes,
        lastEviction: this.stats.lastEviction ?? null,
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

export {
  nodeOldestTimestamp,
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
  console.assert(isBlockedHost("127.0.0.1"), "blocks loopback");
  console.assert(isBlockedHost("10.0.0.5"), "blocks private ip");
  console.assert(normalizePeerUrl("relay.example.com").url.endsWith("/gun"), "normalizes gun path");
  console.assert(nodeOldestTimestamp({ _: { ">": { a: 5, b: 10 } } }) === 5, "oldest node timestamp");
}
