import {
  TEST_EVICT_AT,
  TEST_EVICT_BYTES,
  PAYLOAD_SIZE,
  gunPeerUrl,
  gunPeerWsUrl,
} from "./shared/constants.js";

const BASE_URL = (process.env.E2E_BASE_URL || "http://127.0.0.1:8799").replace(/\/+$/, "");
const E2E_TOKEN = process.env.E2E_RESET_TOKEN || "local-e2e-only";

function e2eHeaders(extra = {}) {
  return {
    "x-e2e-token": E2E_TOKEN,
    ...extra,
  };
}

async function e2eFetch(path, init = {}) {
  return fetch(`${BASE_URL}${path}`, init);
}

function gunPutMessage(soul, payloadSize, timestamp) {
  const payload = "x".repeat(payloadSize);
  return {
    "#": `put-${soul}-${timestamp}`,
    put: {
      [soul]: {
        _: { "#": soul, ">": { payload: timestamp } },
        payload,
      },
    },
  };
}

function gunGetMessage(soul) {
  return {
    "#": `get-${soul}`,
    get: { "#": soul },
  };
}

/** Write via WebSocket /gun — same path real Gun clients use (updates throughput graph). */
export async function putGraphNode(soul, payloadSize, timestamp) {
  const message = JSON.stringify(gunPutMessage(soul, payloadSize, timestamp));
  const ws = new WebSocket(gunPeerWsUrl(BASE_URL));

  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });

  try {
    const reply = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`put timed out for ${soul}`)), 120_000);
      ws.addEventListener("message", (event) => {
        clearTimeout(timer);
        try {
          resolve(JSON.parse(String(event.data)));
        } catch (error) {
          reject(error);
        }
      }, { once: true });
      ws.send(message);
    });

    if (reply?.err) {
      throw new Error(`put failed for ${soul}: ${reply.err}`);
    }
    return reply;
  } finally {
    ws.close();
  }
}

/** Read via HTTP POST /gun (Gun-compatible get envelope). */
export async function readGraphNode(soul) {
  const response = await e2eFetch("/gun", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(gunGetMessage(soul)),
  });
  if (!response.ok) {
    throw new Error(`get failed for ${soul}: ${response.status}`);
  }
  const data = await response.json();
  return data.put?.[soul] ?? null;
}

export async function waitForServer(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE_URL}/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // wrangler still starting
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`gun peer not reachable at ${BASE_URL}/health within ${timeoutMs}ms`);
}

export async function resetPeerStorage() {
  const response = await e2eFetch("/api/e2e/reset", {
    method: "POST",
    headers: e2eHeaders(),
  });
  if (!response.ok) {
    throw new Error(`e2e reset failed: ${response.status} ${await response.text()}`);
  }
}

export async function fetchStats() {
  const response = await e2eFetch("/api/stats");
  if (!response.ok) {
    throw new Error(`stats failed: ${response.status}`);
  }
  return response.json();
}

export async function storageBytesUsed() {
  const stats = await fetchStats();
  return stats.storage.bytesUsed ?? 0;
}

export async function listStoredSouls() {
  const response = await e2eFetch("/api/e2e/nodes", {
    headers: e2eHeaders(),
  });
  if (!response.ok) {
    throw new Error(`e2e nodes failed: ${response.status}`);
  }
  const data = await response.json();
  return data.souls ?? [];
}

export async function seedSystemKeys() {
  const response = await e2eFetch("/api/e2e/seed", {
    method: "POST",
    headers: e2eHeaders(),
  });
  if (!response.ok) {
    throw new Error(`e2e seed failed: ${response.status}`);
  }
}

export async function readSystemKeys() {
  const response = await e2eFetch("/api/e2e/system", {
    headers: e2eHeaders(),
  });
  if (!response.ok) {
    throw new Error(`e2e system failed: ${response.status}`);
  }
  return response.json();
}

export { TEST_EVICT_AT, TEST_EVICT_BYTES, PAYLOAD_SIZE, BASE_URL, gunPeerUrl, gunPeerWsUrl };
