import { beforeAll, describe, expect, it } from "vitest";
import { EphemeralStore, budgetStage, parseEphemeralPrefixes } from "../src/worker.js";
import * as helpers from "./helpers.js";

const E2E_TOKEN = process.env.E2E_RESET_TOKEN || "local-e2e-only";
const LIVE = "ankush-one/live";

beforeAll(async () => {
  await helpers.waitForServer();
}, 60_000);

async function e2ePost(path, body) {
  const response = await fetch(`${helpers.BASE_URL}${path}`, {
    method: "POST",
    headers: { "x-e2e-token": E2E_TOKEN, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    throw new Error(`${path} failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function usage() {
  const stats = await helpers.fetchStats();
  return stats.storage.sqlUsage;
}

async function openSocket() {
  const ws = new WebSocket(helpers.gunPeerWsUrl(helpers.BASE_URL));
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  const received = [];
  ws.addEventListener("message", (event) => received.push(JSON.parse(String(event.data))));
  return { ws, received };
}

function rpc(socket, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("reply timed out")), 10_000);
    const onMessage = (event) => {
      const data = JSON.parse(String(event.data));
      if (data["@"] === message["#"]) {
        clearTimeout(timer);
        socket.ws.removeEventListener("message", onMessage);
        resolve(data);
      }
    };
    socket.ws.addEventListener("message", onMessage);
    socket.ws.send(JSON.stringify(message));
  });
}

let counter = 0;
function putMessage(soul, fields, state) {
  const states = Object.fromEntries(Object.keys(fields).map((key) => [key, state]));
  return { "#": `lb-${++counter}`, put: { [soul]: { _: { "#": soul, ">": states }, ...fields } } };
}
function getMessage(soul) {
  return { "#": `lb-${++counter}`, get: { "#": soul } };
}
const settle = (ms = 300) => new Promise((resolve) => setTimeout(resolve, ms));

describe("ephemeral store", () => {
  it("matches prefixes and their descendants only", () => {
    const store = new EphemeralStore(["ankush-one/live"]);
    expect(store.matches("ankush-one/live")).toBe(true);
    expect(store.matches("ankush-one/live/cursors/home/a")).toBe(true);
    expect(store.matches("ankush-one/liveness")).toBe(false);
    expect(store.matches("ankush-one/apps/paint")).toBe(false);
    expect(parseEphemeralPrefixes(" a/, b//,, ")).toEqual(["a", "b"]);
    expect(parseEphemeralPrefixes(undefined)).toEqual(["ankush-one/live"]);
  });

  it("expires by TTL, caps entries, and lists only nodes with content", () => {
    const store = new EphemeralStore(["x"], { ttlMs: 1000, maxEntries: 2 });
    const node = (soul, v) => ({ _: { "#": soul, ">": { v: 5 } }, v });
    store.set("x/a", node("x/a", 1), "{a}", 0);
    store.set("x/b", node("x/b", 2), "{b}", 10);
    store.set("x/c", node("x/c", null), "{c}", 20);
    expect(store.get("x/a", 20)).toBeUndefined(); // evicted by the entry cap
    expect(store.list({ now: 20 }).map((row) => row.soul)).toEqual(["x/b"]); // c has no content
    expect(store.get("x/b", 2000)).toBeUndefined(); // expired on read
    store.sweep(2000); // the rest expire on the next sweep
    expect(store.size).toBe(0);
  });

  it("budgetStage picks the stage from whichever limit is closer", () => {
    const limits = { rowsRead: 100, rowsWritten: 10 };
    expect(budgetStage({ rowsRead: 10, rowsWritten: 1 }, limits).stage).toBe("ok");
    expect(budgetStage({ rowsRead: 50, rowsWritten: 0 }, limits)).toMatchObject({ stage: "explorer-paused", rank: 1 });
    expect(budgetStage({ rowsRead: 0, rowsWritten: 8 }, limits)).toMatchObject({ stage: "writes-paused", rank: 2 });
    expect(budgetStage({ rowsRead: 93, rowsWritten: 0 }, limits)).toMatchObject({ stage: "reads-paused", rank: 3 });
  });
});

describe("live souls stay out of SQLite", () => {
  it("puts, gets and relays live souls at zero rows, and rebuilds the parent room", async () => {
    await helpers.resetPeerStorage();
    const writer = await openSocket();
    const listener = await openSocket();
    try {
      const before = await usage();
      for (let i = 0; i < 50; i++) {
        const ack = await rpc(writer, putMessage(`${LIVE}/cursors/home/v1`, { ox: i, oy: i * 2, a: "icon" }, 1_000 + i));
        expect(ack.ok).toBe(1);
      }
      const read = await rpc(writer, getMessage(`${LIVE}/cursors/home/v1`));
      expect(read.put[`${LIVE}/cursors/home/v1`]).toMatchObject({ ox: 49, oy: 98 });
      // The room and its ancestors were rebuilt from the child's soul path.
      const room = await rpc(writer, getMessage(`${LIVE}/cursors/home`));
      expect(room.put[`${LIVE}/cursors/home`].v1).toEqual({ "#": `${LIVE}/cursors/home/v1` });
      const live = await rpc(writer, getMessage(LIVE));
      expect(live.put[LIVE].cursors).toEqual({ "#": `${LIVE}/cursors` });
      const after = await usage();
      expect(after.rowsRead - before.rowsRead).toBe(0);
      expect(after.rowsWritten - before.rowsWritten).toBe(0);

      await settle();
      const relayed = listener.received.filter((m) => m.put && m.put[`${LIVE}/cursors/home/v1`]);
      expect(relayed.length).toBe(50);
      expect(listener.received.some((m) => m.put && m.put[`${LIVE}/cursors/home`])).toBe(true);

      // Not in SQL, but in the explorer (tagged live), and gone from it once tombstoned.
      expect(await helpers.listStoredSouls()).not.toContain(`${LIVE}/cursors/home/v1`);
      const listed = await helpers.fetchGraphSouls({ sort: "updated", limit: "50" });
      const row = listed.souls.find((r) => r.soul === `${LIVE}/cursors/home/v1`);
      expect(row).toMatchObject({ ephemeral: true });
      const sub = await helpers.fetchSubgraph({ roots: `${LIVE}/cursors/home`, depth: "1", maxNodes: "10" });
      expect(sub.nodes.find((n) => n.soul === `${LIVE}/cursors/home/v1`)).toMatchObject({ ephemeral: true });
      expect((await helpers.fetchGraphNode(`${LIVE}/cursors/home/v1`)).ephemeral).toBe(true);

      await rpc(writer, putMessage(`${LIVE}/cursors/home/v1`, { ox: null, oy: null, a: null }, 9_000));
      const gone = await helpers.fetchGraphSouls({ sort: "updated", limit: "50" });
      expect(gone.souls.map((r) => r.soul)).not.toContain(`${LIVE}/cursors/home/v1`);
      const stats = await helpers.fetchStats();
      expect(stats.storage.liveNodes).toBeGreaterThan(0);
      expect(stats.storage.graphNodes).toBe(0);
    } finally {
      writer.ws.close();
      listener.ws.close();
    }
  });
});

describe("daily row budget guard", () => {
  it("pauses the explorer, then stored writes, then uncached reads, and recovers", async () => {
    await helpers.resetPeerStorage();
    await helpers.putGraphNodeCustom("budget/stored", { name: "kept" }, 1_000);
    const socket = await openSocket();
    try {
      const limits = (await helpers.fetchStats()).storage.budget.limits;

      // Stage 1: explorer paused, everything else still works.
      await e2ePost("/api/e2e/budget", { rowsRead: Math.ceil(limits.rowsRead * 0.5) });
      expect((await helpers.fetchStats()).storage.budget.stage).toBe("explorer-paused");
      const paused = await fetch(`${helpers.BASE_URL}/api/graph/subgraph?list=10`);
      expect(paused.status).toBe(429);
      expect((await paused.json()).paused).toBe(true);
      // A live patch for in-memory souls costs nothing and still goes through.
      await rpc(socket, putMessage(`${LIVE}/presence/home/p1`, { ts: 1, nick: "a" }, 2_000));
      const livePatch = await fetch(`${helpers.BASE_URL}/api/graph/subgraph?roots=${encodeURIComponent(`${LIVE}/presence/home/p1`)}&depth=0`);
      expect(livePatch.status).toBe(200);
      expect((await rpc(socket, putMessage("budget/stored", { name: "still writable" }, 3_000))).ok).toBe(1);
      expect((await e2ePost("/api/e2e/housekeep")).skipped).toMatch(/housekeeping paused/);

      // Stage 2: stored writes refused, live puts fine, reads fine.
      await e2ePost("/api/e2e/budget", { rowsWritten: Math.ceil(limits.rowsWritten * 0.8) });
      expect((await helpers.fetchStats()).storage.budget.stage).toBe("writes-paused");
      const refused = await rpc(socket, putMessage("budget/stored", { name: "refused" }, 4_000));
      expect(refused.err).toMatch(/writes paused/);
      expect(refused.ok).toBeUndefined();
      expect((await rpc(socket, putMessage(`${LIVE}/presence/home/p1`, { ts: 2, nick: "a" }, 5_000))).ok).toBe(1);
      expect(await helpers.readGraphNode("budget/stored")).toMatchObject({ name: "still writable" });

      // Stage 3: uncached stored reads refused; cached and live still served.
      await e2ePost("/api/e2e/budget", { rowsRead: Math.ceil(limits.rowsRead * 0.92) });
      expect((await helpers.fetchStats()).storage.budget.stage).toBe("reads-paused");
      expect(await helpers.readGraphNode("budget/stored")).toMatchObject({ name: "still writable" }); // node cache
      const deferred = await rpc(socket, getMessage("budget/never-read"));
      expect(deferred.put).toBeNull();
      expect(deferred.err).toMatch(/reads paused/);
      const liveRead = await rpc(socket, getMessage(`${LIVE}/presence/home/p1`));
      expect(liveRead.put[`${LIVE}/presence/home/p1`]).toMatchObject({ ts: 2 });

      // Budget reset (a new UTC day): everything works again.
      await e2ePost("/api/e2e/budget", { rowsRead: 0, rowsWritten: 0 });
      expect((await helpers.fetchStats()).storage.budget.stage).toBe("ok");
      expect((await rpc(socket, putMessage("budget/stored", { name: "back" }, 6_000))).ok).toBe(1);
      expect((await fetch(`${helpers.BASE_URL}/api/graph/subgraph?list=10`)).status).toBe(200);
    } finally {
      socket.ws.close();
    }
  });

  it("counts KV and SQL rows into today's budget and persists them", async () => {
    await helpers.resetPeerStorage();
    const before = (await helpers.fetchStats()).storage.budget;
    for (let i = 0; i < 30; i++) {
      await helpers.putGraphNodeCustom(`budget/row${i}`, { name: `r${i}` }, 1_000 + i);
    }
    const after = (await helpers.fetchStats()).storage.budget;
    expect(after.day).toBe(before.day);
    expect(after.rowsWritten - before.rowsWritten).toBeGreaterThanOrEqual(90); // 3 rows per new node
    expect(after.rowsRead).toBeGreaterThanOrEqual(before.rowsRead);
    const system = await (await fetch(`${helpers.BASE_URL}/api/e2e/system`, { headers: { "x-e2e-token": E2E_TOKEN } })).json();
    expect(system.budget.day).toBe(after.day);
  });
});

describe("housekeeping", () => {
  it("sweeps rows that live souls left in SQL and collects old tombstones", async () => {
    await helpers.resetPeerStorage();
    const old = Date.now() - 40 * 24 * 60 * 60 * 1000;
    const node = (soul, fields, state) => ({ _: { "#": soul, ">": Object.fromEntries(Object.keys(fields).map((k) => [k, state])) }, ...fields });
    await e2ePost("/api/e2e/rows", {
      reopenSweep: true,
      nodes: {
        [`${LIVE}/cursors/home/stale`]: node(`${LIVE}/cursors/home/stale`, { ox: 1 }, 1_000),
        [`${LIVE}/presence/home`]: node(`${LIVE}/presence/home`, { a: { "#": "x" } }, 1_000),
        [LIVE]: node(LIVE, { cursors: { "#": `${LIVE}/cursors` } }, 1_000),
        "ankush-one/liveness": node("ankush-one/liveness", { name: "not live" }, 1_000),
        "apps/old-tombstone": node("apps/old-tombstone", { name: null }, old),
        "apps/fresh-tombstone": node("apps/fresh-tombstone", { name: null }, Date.now()),
        "apps/kept": node("apps/kept", { name: "kept" }, Date.now()),
      },
    });
    expect(await helpers.listStoredSouls()).toHaveLength(7);
    expect((await helpers.fetchStats()).storage.housekeeping.ephemeralSweepDone).toBe(false);

    const result = await e2ePost("/api/e2e/housekeep");
    expect(result.sweep).toEqual({ deleted: 3, done: true });
    expect(result.tombstones).toEqual({ collected: 1 });
    expect((await helpers.listStoredSouls()).sort()).toEqual(["ankush-one/liveness", "apps/fresh-tombstone", "apps/kept"]);
    const stats = await helpers.fetchStats();
    expect(stats.storage.graphNodes).toBe(3);
    expect(stats.storage.housekeeping).toMatchObject({ ephemeralSweepDone: true, sweptRows: 3, tombstonesCollected: 1 });
  });
});
