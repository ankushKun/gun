/** Single source of truth for storage eviction tests (npm test). */
export const STORAGE_EVICT_AT_BYTES = 1 * 1024 * 1024 * 1024;
export const STORAGE_EVICT_BYTES = 500 * 1024 * 1024;
export const PAYLOAD_SIZE = 512 * 1024; // 512 KiB per node (under DO SQLite ~2 MiB/value)

export const TEST_EVICT_AT =
  Number(process.env.STORAGE_EVICT_AT_BYTES) || STORAGE_EVICT_AT_BYTES;
export const TEST_EVICT_BYTES =
  Number(process.env.STORAGE_EVICT_BYTES) || STORAGE_EVICT_BYTES;

/** Nodes to write without crossing the eviction threshold. */
export const NODES_BELOW_THRESHOLD = 4;

/** Nodes to write to cross threshold and trigger eviction. */
export function nodesToTriggerEviction(extra = 2) {
  return Math.ceil(STORAGE_EVICT_AT_BYTES / PAYLOAD_SIZE) + extra;
}

/** Log every N nodes during long fills. */
export const FILL_LOG_EVERY = 50;

export function formatBytes(bytes) {
  if (bytes >= 1024 ** 3) {
    return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
  }
  if (bytes >= 1024 ** 2) {
    return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  return `${bytes} B`;
}

export const TEST_TIMEOUT_MS = 30 * 60 * 1000;

export function gunPeerUrl(baseUrl) {
  return `${baseUrl.replace(/\/+$/, "")}/gun`;
}

export function gunPeerWsUrl(baseUrl) {
  return gunPeerUrl(baseUrl).replace(/^http/, "ws");
}
