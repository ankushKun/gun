import { beforeAll, describe, expect, it } from "vitest";
import { EphemeralStore, dropRepeatedLinks } from "../src/worker.js";
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
function putMessage(soul, fields, state, extra = {}) {
  const states = Object.fromEntries(Object.keys(fields).map((key) => [key, state]));
  return { "#": `wb-${++counter}`, ...extra, put: { [soul]: { _: { "#": soul, ">": states }, ...fields } } };
}
function getMessage(soul) {
  return { "#": `wb-${++counter}`, get: { "#": soul } };
}
const settle = (ms = 300) => new Promise((resolve) => setTimeout(resolve, ms));
const written = async () => (await helpers.fetchStats()).storage.sqlUsage.rowsWritten;

describe("repeated links", () => {
  it("drops fields that repeat the link already held, and keeps everything else", () => {
    const held = { _: { "#": "a", ">": { live: 1, apps: 1, n: 1 } }, live: { "#": "a/live" }, apps: { "#": "a/apps" }, n: 5 };
    const same = { _: { "#": "a", ">": { live: 9, apps: 9 } }, live: { "#": "a/live" }, apps: { "#": "a/apps" } };
    expect(dropRepeatedLinks(held, same)).toBeNull();
    const mixed = { _: { "#": "a", ">": { live: 9, n: 9, x: 9 } }, live: { "#": "a/live" }, n: 5, x: { "#": "a/x" } };
    expect(dropRepeatedLinks(held, mixed)).toEqual({ _: { "#": "a", ">": { n: 9, x: 9 } }, n: 5, x: { "#": "a/x" } });
    const moved = { _: { "#": "a", ">": { live: 9 } }, live: { "#": "elsewhere" } };
    expect(dropRepeatedLinks(held, moved)).toBe(moved);
    expect(dropRepeatedLinks(null, same)).toBe(same);
  });

  it("costs no rows and is not relayed when a chained put re-sends the path", async () => {
    await helpers.resetPeerStorage();
    await helpers.putGraphNodeCustom("ankush-one", { apps: { "#": "ankush-one/apps" } }, 1_000);
    const writer = await openSocket();
    const listener = await openSocket();
    try {
      const before = await written();
      for (let i = 0; i < 10; i++) {
        const ack = await rpc(writer, putMessage("ankush-one", { apps: { "#": "ankush-one/apps" } }, 2_000 + i, { ok: { "@": 1, "/": 1 } }));
        expect(ack.ok).toBe(1);
      }
      await settle();
      expect((await written()) - before).toBe(0);
      expect(listener.received.filter((m) => m.put)).toHaveLength(0);
      const read = await rpc(writer, getMessage("ankush-one"));
      expect(read.put["ankush-one"]._[">"].apps).toBe(1_000);
    } finally {
      writer.ws.close();
      listener.ws.close();
    }
  });
});

describe("write-behind", () => {
  it("relays and acks at once, serves the buffer, and writes a burst once", async () => {
    await helpers.resetPeerStorage();
    const writer = await openSocket();
    const listener = await openSocket();
    try {
      const before = await written();
      for (let i = 0; i < 25; i++) {
        const ack = await rpc(writer, putMessage("ankush-one/apps/sticky/shared", { x: i, moveTs: 1_000 + i }, 1_000 + i));
        expect(ack.ok).toBe(1);
      }
      await settle(100);
      expect(listener.received.filter((m) => m.put)).toHaveLength(25);
      const pending = await helpers.fetchStats();
      expect(pending.storage.pendingWrites).toBe(1);
      expect(pending.storage.sqlUsage.rowsWritten - before).toBeLessThanOrEqual(1); // a budget persist at most
      const read = await rpc(writer, getMessage("ankush-one/apps/sticky/shared"));
      expect(read.put["ankush-one/apps/sticky/shared"]).toMatchObject({ x: 24 });
      const listed = await helpers.fetchGraphSouls({ sort: "updated", limit: "10" });
      expect(listed.souls.map((r) => r.soul)).toContain("ankush-one/apps/sticky/shared");

      await settle(1_600);
      const after = await helpers.fetchStats();
      expect(after.storage.pendingWrites).toBe(0);
      // One insert (row + index) and the stats counter, instead of ~75 rows.
      expect(after.storage.sqlUsage.rowsWritten - before).toBeLessThanOrEqual(5);
      expect(await helpers.listStoredSouls()).toContain("ankush-one/apps/sticky/shared");
    } finally {
      writer.ws.close();
      listener.ws.close();
    }
  });

  it("flushes at least every 5s while puts keep coming", async () => {
    await helpers.resetPeerStorage();
    const writer = await openSocket();
    try {
      const start = Date.now();
      let i = 0;
      while (Date.now() - start < 6_500) {
        await rpc(writer, putMessage("ankush-one/apps/sticky/shared", { x: ++i }, 1_000 + i));
        await settle(400);
      }
      const system = await helpers.fetchStats();
      expect(system.storage.graphNodes).toBe(1); // written while the stream never paused for 1s
    } finally {
      writer.ws.close();
    }
  }, 20_000);

  it("writes before acking a put whose writer waits on the ack", async () => {
    await helpers.resetPeerStorage();
    const writer = await openSocket();
    try {
      const ack = await rpc(writer, putMessage("ankush-one/apps/guestbook/entries/v1", { name: "a" }, 1_000, { ok: { "@": 1, "/": 1 } }));
      expect(ack.ok).toBe(1);
      const stats = await helpers.fetchStats();
      expect(stats.storage.pendingWrites).toBe(0);
      expect(stats.storage.graphNodes).toBe(1);
    } finally {
      writer.ws.close();
    }
  });
});

describe("live rooms", () => {
  it("hide children that expired and drop them from the parent", () => {
    const store = new EphemeralStore(["live"], { ttlMs: 1000 });
    const node = (soul, fields) => ({ _: { "#": soul, ">": Object.fromEntries(Object.keys(fields).map((k) => [k, 1])) }, ...fields });
    const room = node("live/room", { a: { "#": "live/room/a" }, b: { "#": "live/room/b" }, c: { "#": "live/room/c" } });
    store.set("live/room", room, JSON.stringify(room), 0);
    store.set("live/room/a", node("live/room/a", { ts: 1 }), "{}", 0);
    store.set("live/room/b", node("live/room/b", { ts: 1 }), "{}", 900);
    store.touch("live/room", 900);
    // c was never seen since the object woke, a has expired by 1500.
    const view = store.view("live/room", 1500);
    expect(Object.keys(view.node).filter((k) => k !== "_")).toEqual(["b"]);
    expect(JSON.parse(view.json).c).toBeUndefined();
    // a's expiry also took its key out of the stored parent; c stays until it is put or the room expires.
    expect(store.get("live/room", 1500).node.a).toBeUndefined();
    expect(store.get("live/room", 1500).node.c).toEqual({ "#": "live/room/c" });
  });

  it("serve a room with only the people still here", async () => {
    await helpers.resetPeerStorage();
    const socket = await openSocket();
    try {
      await rpc(socket, putMessage(`${LIVE}/cursors/site`, { gone: { "#": `${LIVE}/cursors/site/gone` }, here: { "#": `${LIVE}/cursors/site/here` } }, 1_000));
      await rpc(socket, putMessage(`${LIVE}/cursors/site/here`, { ts: 1 }, 1_000));
      const room = await rpc(socket, getMessage(`${LIVE}/cursors/site`));
      expect(Object.keys(room.put[`${LIVE}/cursors/site`]).filter((k) => k !== "_")).toEqual(["here"]);
    } finally {
      socket.ws.close();
    }
  });
});

describe("daily request budget", () => {
  it("counts frames, tells clients to slow down past 70%, and tells new clients on hi", async () => {
    await helpers.resetPeerStorage();
    const socket = await openSocket();
    try {
      const before = (await helpers.fetchStats()).storage.budget.requests;
      await rpc(socket, getMessage("anything"));
      await rpc(socket, getMessage("anything"));
      const after = (await helpers.fetchStats()).storage.budget.requests;
      expect(after.frames - before.frames).toBe(2);
      expect(after.requests).toBeGreaterThan(before.requests);
      expect(after).toMatchObject({ frameRatio: 1, shedAt: 0.7, stage: "ok" });

      await e2ePost("/api/e2e/budget", { frames: Math.ceil(after.limit * 0.7) });
      await settle();
      expect(socket.received.find((m) => m.dam === "load")).toMatchObject({ stage: "live-slow" });
      expect((await helpers.fetchStats()).storage.budget.requests.stage).toBe("live-slow");

      // A browser's hi is the connection itself; other Gun peers send {dam: "?"}.
      const late = await openSocket();
      try {
        await settle();
        expect(late.received.filter((m) => m.dam === "load")).toHaveLength(1);
        expect(late.received[0]).toMatchObject({ dam: "load", stage: "live-slow" });
        late.ws.send(JSON.stringify({ "#": "hi-1", dam: "?", pid: "p" }));
        await settle();
        expect(late.received.filter((m) => m.dam === "load")).toHaveLength(2);
      } finally {
        late.ws.close();
      }

      await e2ePost("/api/e2e/budget", { frames: 0 });
      await settle();
      expect(socket.received.filter((m) => m.dam === "load").pop()).toMatchObject({ stage: "ok" });
    } finally {
      socket.ws.close();
    }
  });
});
