import { beforeAll, describe, expect, it } from "vitest";
import { NodeCache, prefixUpperBound, soulFilterSql } from "../src/worker.js";
import { mergeLivePatch } from "../public/explorer.js";
import * as helpers from "./helpers.js";

const E2E_TOKEN = process.env.E2E_RESET_TOKEN || "local-e2e-only";

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

async function sqlRowsRead() {
  return (await helpers.fetchStats()).storage.sqlUsage.rowsRead;
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

function sendAndAwaitAck(socket, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("ack timed out")), 10_000);
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

function putMessage(id, soul, fields, state) {
  const states = Object.fromEntries(Object.keys(fields).map((key) => [key, state]));
  return { "#": id, put: { [soul]: { _: { "#": soul, ">": states }, ...fields } } };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

describe("row-read helpers", () => {
  it("NodeCache evicts least recently used entries", () => {
    const cache = new NodeCache(2, 1024 * 1024);
    cache.set("a", { a: 1 }, "{}");
    cache.set("b", { b: 1 }, "{}");
    cache.get("a");
    cache.set("c", { c: 1 }, "{}");
    expect(cache.get("a")).toBeTruthy();
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("c")).toBeTruthy();
  });

  it("NodeCache caches misses and skips oversized nodes", () => {
    const cache = new NodeCache(10, 1000);
    cache.set("missing", null);
    expect(cache.get("missing")).toEqual({ node: null, json: null, size: 64 });
    cache.set("huge", {}, "x".repeat(1000));
    expect(cache.get("huge")).toBeUndefined();
  });

  it("prefix bounds cover every soul with the prefix", () => {
    expect(prefixUpperBound("graph/")).toBe("graph0");
    expect(prefixUpperBound("")).toBeNull();
    expect(prefixUpperBound("a\ud83d")).toBeNull();
    expect(soulFilterSql("", "").clauses).toEqual([]);
    expect(soulFilterSql("a/", "Bob").params).toEqual(["a/", "a/", "a/", "a0", "bob"]);
  });

  it("mergeLivePatch updates, adds, and drops dirty souls", () => {
    const graph = {
      nodes: [
        { soul: "a", label: "A", updated: 1 },
        { soul: "b", label: "B", updated: 2 },
      ],
      edges: [{ from: "a", to: "b", field: "friend" }],
      truncated: false,
    };
    const rows = [{ soul: "b", label: "B", updated: 2 }, { soul: "a", label: "A", updated: 1 }];
    const patch = {
      nodes: [
        { soul: "a", label: "A2", updated: 5 },
        { soul: "c", label: "C", updated: 4 },
        { soul: "z", ghost: true },
      ],
      edges: [{ from: "c", to: "z", field: "link" }],
    };
    const merged = mergeLivePatch(graph, rows, patch, ["a", "b", "c"]);
    expect(merged.nodes.map((node) => node.soul).sort()).toEqual(["a", "c", "z"]);
    expect(merged.nodes.find((node) => node.soul === "a").label).toBe("A2");
    expect(merged.edges).toEqual([{ from: "c", to: "z", field: "link" }]);
    expect(merged.rows.map((row) => row.soul)).toEqual(["a", "c"]);

    const filtered = mergeLivePatch(graph, rows, patch, ["a", "c"], false);
    expect(filtered.nodes.map((node) => node.soul).sort()).toEqual(["a", "b"]);
  });
});

describe("row-read budget", () => {
  it("explorer listing reads O(limit) rows, not O(stored nodes)", async () => {
    await helpers.resetPeerStorage();
    for (let i = 0; i < 60; i++) {
      await helpers.putGraphNodeCustom(`budget/n${String(i).padStart(2, "0")}`, { name: `n${i}` }, 1_000 + i);
    }

    const before = await sqlRowsRead();
    const data = await helpers.fetchSubgraph({ maxNodes: "5", depth: "0", list: "5" });
    const read = (await sqlRowsRead()) - before;

    expect(data.souls.map((row) => row.soul)).toEqual([
      "budget/n59", "budget/n58", "budget/n57", "budget/n56", "budget/n55",
    ]);
    expect(data.soulsTruncated).toBe(true);
    expect(data.nodes.filter((node) => !node.ghost)).toHaveLength(5);
    // Old code: list + get per node, twice ⇒ 240+ rows here.
    expect(read).toBeLessThan(30);
  });

  it("repeated Gun gets are served from the node cache", async () => {
    await helpers.readGraphNode("budget/n10");
    const before = await sqlRowsRead();
    for (let i = 0; i < 5; i++) {
      expect(await helpers.readGraphNode("budget/n10")).not.toBeNull();
      await helpers.readGraphNode("budget/does-not-exist");
    }
    expect((await sqlRowsRead()) - before).toBeLessThanOrEqual(1);
  });

  it("paginates souls with a real cursor and an exact prefix", async () => {
    await helpers.putGraphNodeCustom("budgetx/outside", { name: "outside" }, 5_000);
    const seen = [];
    let cursor;
    let pages = 0;
    do {
      const params = { prefix: "budget/", limit: "25" };
      if (cursor) params.cursor = cursor;
      const page = await helpers.fetchGraphSouls(params);
      seen.push(...helpers.soulPaths(page));
      cursor = page.truncated ? page.cursor : undefined;
      pages += 1;
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen).toHaveLength(60);
    expect(new Set(seen).size).toBe(60);
    expect(seen).not.toContain("budgetx/outside");
  });

  it("keeps tombstones stored but out of listings", async () => {
    await helpers.putGraphNodeCustom("budget/n00", { name: null }, 9_000);
    const stored = await helpers.readGraphNode("budget/n00");
    expect(stored).toMatchObject({ name: null });
    const listed = helpers.soulPaths(await helpers.fetchGraphSouls({ sort: "updated", limit: "500" }));
    expect(listed).not.toContain("budget/n00");
    expect(await helpers.listStoredSouls()).toContain("budget/n00");
  });
});

describe("put relay", () => {
  it("relays changed puts once with the original id and drops echoes", async () => {
    await helpers.resetPeerStorage();
    const writer = await openSocket();
    const listener = await openSocket();
    try {
      const first = putMessage("relay-1", "relay/a", { name: "A" }, 1_000);
      await sendAndAwaitAck(writer, first);
      await settle();
      expect(listener.received.filter((m) => m.put)).toEqual([
        { "#": "relay-1", put: first.put },
      ]);

      // Same id again (a mesh echo) is acked but not merged or relayed.
      const echo = putMessage("relay-1", "relay/a", { name: "changed" }, 2_000);
      await sendAndAwaitAck(writer, echo);
      // New id, identical data: nothing changed, so nothing to relay.
      await sendAndAwaitAck(writer, putMessage("relay-2", "relay/a", { name: "A" }, 1_000));
      await settle();
      expect(listener.received.filter((m) => m.put)).toHaveLength(1);
      expect(await helpers.readGraphNode("relay/a")).toMatchObject({ name: "A" });
    } finally {
      writer.ws.close();
      listener.ws.close();
    }
  });
});

describe("legacy KV migration", () => {
  it("serves legacy nodes before migration and moves them in batches", async () => {
    await helpers.resetPeerStorage();
    const legacy = {};
    for (let i = 0; i < 3; i++) {
      const soul = `legacy/n${i}`;
      legacy[soul] = { _: { "#": soul, ">": { name: 100 + i } }, name: `old ${i}` };
    }
    await e2ePost("/api/e2e/legacy", { nodes: legacy });

    expect((await helpers.fetchStats()).storage.migration.done).toBe(false);
    expect(await helpers.readGraphNode("legacy/n1")).toMatchObject({ name: "old 1" });

    // A newer put during migration must survive the later batch copy.
    await helpers.putGraphNodeCustom("legacy/n2", { name: "new 2" }, 500);

    const first = await e2ePost("/api/e2e/migrate?limit=1");
    expect(first).toEqual({ migrated: 1, done: false });
    let result = first;
    while (!result.done) {
      result = await e2ePost("/api/e2e/migrate?limit=1");
    }

    expect(await helpers.listStoredSouls()).toEqual(["legacy/n0", "legacy/n1", "legacy/n2"]);
    expect(await helpers.readGraphNode("legacy/n2")).toMatchObject({ name: "new 2" });
    expect(await helpers.readGraphNode("legacy/n0")).toMatchObject({ name: "old 0" });
    const stats = await helpers.fetchStats();
    expect(stats.storage.migration.done).toBe(true);
    expect(stats.storage.graphNodes).toBe(3);
  });
});
