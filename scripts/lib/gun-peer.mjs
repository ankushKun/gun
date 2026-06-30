import Gun from "gun";
import { gunPeerUrl } from "../../tests/shared/constants.js";

export const DEFAULT_PEER_URL = process.env.WORKER_URL || process.env.GUN_PEER_URL || "http://127.0.0.1:8787";
const MANIFEST_MARK = "\x1f";

export function peerBaseUrl(url = DEFAULT_PEER_URL) {
  return url.replace(/\/+$/, "").replace(/\/gun$/i, "");
}

export function manifestSoul(prefix) {
  return `${prefix}/__manifest`;
}

export function encodeManifestKey(soul) {
  return soul.replace(/\//g, MANIFEST_MARK);
}

export function decodeManifestKey(key) {
  return key.replace(/\x1f/g, "/");
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function formatBytes(n) {
  if (n == null || Number.isNaN(n)) return "unknown";
  const units = ["B", "KB", "MB", "GB"];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function parseArgs(argv, defaults = {}) {
  const opts = { ...defaults };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      opts.help = true;
    } else if (arg === "--yes" || arg === "-y") {
      opts.yes = true;
    } else if (arg === "--url") {
      opts.url = argv[++i] || "";
    } else if (arg === "--prefix") {
      opts.prefix = argv[++i] ?? "";
    } else if (arg === "--q" || arg === "--query") {
      opts.query = argv[++i] ?? "";
    } else if (arg === "--interval") {
      opts.interval = Number(argv[++i]);
    } else if (arg === "--random") {
      opts.random = Number(argv[++i]);
    } else if (arg === "--no-random") {
      opts.random = 0;
    } else if (arg === "--local") {
      opts.local = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (opts.url) {
    opts.url = peerBaseUrl(opts.url);
  }
  return opts;
}

/** Worker graph API — listing for drain-peer; stats for clear-do-storage */
export async function fetchStats(baseUrl) {
  const response = await fetch(`${peerBaseUrl(baseUrl)}/api/stats`);
  if (!response.ok) {
    throw new Error(`stats failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

export async function fetchGraphSouls(baseUrl, params = {}) {
  const qs = new URLSearchParams(params);
  const response = await fetch(`${peerBaseUrl(baseUrl)}/api/graph/souls?${qs}`);
  if (!response.ok) {
    throw new Error(`graph souls failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

export async function fetchGraphNode(baseUrl, soul) {
  const response = await fetch(
    `${peerBaseUrl(baseUrl)}/api/graph/node?soul=${encodeURIComponent(soul)}`,
  );
  if (!response.ok) {
    throw new Error(`graph node failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

export function soulPaths(data) {
  return (data.souls ?? []).map((row) => (typeof row === "string" ? row : row.soul));
}

/** Paginate /api/graph/souls until every visible soul is listed. */
export async function listAllGraphSouls(baseUrl, { prefix = "", query = "" } = {}) {
  const souls = [];
  let cursor;
  do {
    const params = { limit: "500" };
    if (prefix) {
      params.prefix = prefix.endsWith("/") ? prefix : `${prefix}/`;
    }
    if (query) {
      params.q = query;
    }
    if (cursor) {
      params.cursor = cursor;
    }
    const page = await fetchGraphSouls(baseUrl, params);
    souls.push(...soulPaths(page));
    cursor = page.truncated && page.cursor ? page.cursor : undefined;
  } while (cursor);
  return souls;
}

export async function listVisibleGraphSouls(baseUrl, { prefix = "", query = "" } = {}) {
  const params = { limit: "500", sort: "updated" };
  if (prefix) {
    params.prefix = prefix.endsWith("/") ? prefix : `${prefix}/`;
  }
  if (query) {
    params.q = query;
  }
  const page = await fetchGraphSouls(baseUrl, params);
  return soulPaths(page);
}

export function runScript(main) {
  Promise.resolve()
    .then(() => main())
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error?.message || error);
      process.exit(1);
    });
}

export function createGun(baseUrl) {
  return Gun({
    peers: [gunPeerUrl(baseUrl)],
    localStorage: false,
    radisk: false,
    rad: false,
    axe: false,
    multicast: false,
  });
}

export function gunPut(gun, soul, data, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`put timed out for ${soul}`)), timeoutMs);
    gun.get(soul).put(data, (ack) => {
      clearTimeout(timer);
      if (ack?.err) {
        reject(new Error(`put failed for ${soul}: ${ack.err}`));
        return;
      }
      resolve(ack);
    });
  });
}

export function gunOnce(gun, soul, timeoutMs = 10_000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    gun.get(soul).once((data) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

function isRef(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && value["#"]);
}

function gunPutAt(gun, soul, field, index, value) {
  const chain = index == null ? gun.get(soul).get(field) : gun.get(soul).get(field).get(index);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`put timed out for ${soul}/${field}`)), 30_000);
    const payload = isRef(value) ? gun.get(value["#"]) : value;
    chain.put(payload, (ack) => {
      clearTimeout(timer);
      if (ack?.err) {
        reject(new Error(`put failed for ${soul}/${field}: ${ack.err}`));
        return;
      }
      resolve(ack);
    });
  });
}

/** Write one soul via Gun.js only; returns every soul path touched. */
export async function gunWriteSoul(gun, soul, data) {
  const touched = new Set([soul]);
  const scalars = {};

  for (const [key, value] of Object.entries(data)) {
    if (value === null || value === undefined) {
      scalars[key] = value;
    } else if (typeof value !== "object") {
      scalars[key] = value;
    } else if (isRef(value)) {
      scalars[key] = gun.get(value["#"]);
    } else if (Array.isArray(value)) {
      continue;
    } else {
      const childSoul = `${soul}/${key}`;
      touched.add(childSoul);
      for (const path of await gunWriteSoul(gun, childSoul, value)) {
        touched.add(path);
      }
    }
  }

  if (Object.keys(scalars).length > 0) {
    await gunPut(gun, soul, scalars);
  }

  for (const [field, items] of Object.entries(data)) {
    if (!Array.isArray(items)) {
      continue;
    }
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      if (item && typeof item === "object" && !Array.isArray(item) && !isRef(item)) {
        const childSoul = `${soul}/${field}/${i}`;
        touched.add(childSoul);
        for (const path of await gunWriteSoul(gun, childSoul, item)) {
          touched.add(path);
        }
      } else {
        await gunPutAt(gun, soul, field, i, item);
      }
    }
  }

  return [...touched];
}

export async function gunWriteManifest(gun, prefix, souls) {
  const body = {};
  for (const soul of souls) {
    body[encodeManifestKey(soul)] = true;
  }
  const path = manifestSoul(prefix);
  await gunPut(gun, path, body);
  return path;
}

export async function gunReadManifest(gun, prefix) {
  const raw = await gunOnce(gun, manifestSoul(prefix));
  if (!raw || typeof raw !== "object") {
    return [];
  }
  return Object.keys(raw)
    .filter((key) => key !== "_" && raw[key] != null)
    .map(decodeManifestKey)
    .sort();
}

export function gunDeleteSoul(gun, soul) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`delete timed out for ${soul}`)), 30_000);
    gun.get(soul).put(null, (ack) => {
      clearTimeout(timer);
      if (ack?.err) {
        reject(new Error(`delete failed for ${soul}: ${ack.err}`));
        return;
      }
      resolve(ack);
    });
  });
}

/** Tombstone via Gun using field list from the worker graph inspector. */
export async function gunTombstoneSoul(gun, baseUrl, soul) {
  try {
    const node = await fetchGraphNode(baseUrl, soul);
    if (node.raw && typeof node.raw === "object") {
      const payload = {};
      for (const key of Object.keys(node.raw)) {
        if (key !== "_") {
          payload[key] = null;
        }
      }
      if (Object.keys(payload).length > 0) {
        return gunPut(gun, soul, payload);
      }
    }
  } catch {
    // already hidden from the graph index
  }
  return gunDeleteSoul(gun, soul);
}

export async function gunRemoveManifestEntry(gun, prefix, soul) {
  const key = encodeManifestKey(soul);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`manifest update timed out for ${soul}`)), 30_000);
    gun.get(manifestSoul(prefix)).get(key).put(null, (ack) => {
      clearTimeout(timer);
      if (ack?.err) {
        reject(new Error(`manifest update failed for ${soul}: ${ack.err}`));
        return;
      }
      resolve(ack);
    });
  });
}
