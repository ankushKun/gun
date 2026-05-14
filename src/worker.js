const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};

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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: JSON_HEADERS });
    }

    if (url.pathname === "/health") {
      return json({ status: "healthy", timestamp: Date.now() });
    }

    if (url.pathname === "/api/stats" || url.pathname === "/gun") {
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

export class GunPeerObject {
  constructor(state) {
    this.state = state;
    this.connections = new Map();
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
      };
      return;
    }

    this.stats = {
      startTime: this.startTime,
      totalConnections: 0,
      messagesProcessed: 0,
      bytesTransferred: 0,
    };
    await this.persistStats();
  }

  async fetch(request) {
    await this.initialized;

    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: JSON_HEADERS });
    }

    if (url.pathname === "/api/stats") {
      return json(this.statsPayload());
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
    let payload;
    try {
      payload = await request.json();
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
        this.broadcast({ "#": crypto.randomUUID(), put: message.put }, sender);
      }

      if (message.get && typeof message.get === "object") {
        replies.push(await this.readGraph(message));
      }
    }

    return replies;
  }

  async mergeGraph(graph) {
    for (const [soul, incomingNode] of Object.entries(graph)) {
      if (!incomingNode || typeof incomingNode !== "object") {
        continue;
      }

      const existingNode = (await this.state.storage.get(nodeKey(soul))) || {
        _: { "#": soul, ">": {} },
      };
      const merged = mergeNode(soul, existingNode, incomingNode);
      await this.state.storage.put(nodeKey(soul), merged);
    }
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
        current: this.connections.size,
        total: this.stats.totalConnections,
        activePeers: this.connections.size,
      },
      performance: {
        messagesProcessed: this.stats.messagesProcessed,
        bytesTransferred: this.stats.bytesTransferred,
      },
      storage: {
        backend: "durable-object-storage",
        persistent: true,
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
