/** Ordered sample souls for seeding: leaves before referrers where possible. */

import { randomUUID } from "node:crypto";

const ADJECTIVES = ["brisk", "quiet", "amber", "velvet", "crisp", "lunar", "wired", "mossy"];
const NOUNS = ["relay", "pixel", "beacon", "vector", "shard", "signal", "ledger", "socket"];

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

/** Changes every seed run — drives explorer update pulses on fixed souls. */
function volatileSeed(now = Date.now()) {
  return {
    seedAt: now,
    seedNonce: randomUUID().slice(0, 8),
    seedRoll: Number(Math.random().toFixed(6)),
    pingMs: Math.floor(Math.random() * 380) + 20,
  };
}

export function buildRandomGraph(prefix = "sample", count = 12) {
  if (!Number.isFinite(count) || count < 1) {
    return [];
  }

  const p = (path) => `${prefix}/${path}`;
  const ref = (path) => ({ "#": p(path) });
  const runId = randomUUID().slice(0, 8);
  const ids = Array.from({ length: count }, () => randomUUID().slice(0, 8));
  const entries = [];

  for (let i = 0; i < count; i += 1) {
    const id = ids[i];
    const peerId = ids[(i + 1) % count];
    const node = {
      kind: "random",
      runId,
      index: i,
      label: `${pick(ADJECTIVES)} ${pick(NOUNS)} ${id.slice(0, 4)}`,
      score: Number((Math.random() * 100).toFixed(2)),
      luck: Math.random() > 0.5,
      tags: [pick(ADJECTIVES), pick(NOUNS), runId],
      peer: ref(`random/nodes/${peerId}`),
      payload: JSON.stringify({ runId, n: Math.random(), ts: Date.now() }),
      meta: { roll: Math.random(), hue: Math.floor(Math.random() * 360) },
    };
    if (i % 3 === 0) {
      node.anchor = ref("users/alice");
    }
    entries.push([p(`random/nodes/${id}`), node]);
  }

  entries.push([p("random/hub"), {
    kind: "random-hub",
    runId,
    spawned: Date.now(),
    members: ids.slice(0, Math.min(5, count)).map((id) => ref(`random/nodes/${id}`)),
    backlink: ref("index"),
  }]);

  return entries;
}

export function buildSampleGraph(prefix = "sample") {
  const p = (path) => `${prefix}/${path}`;
  const ref = (path) => ({ "#": p(path) });
  const now = Date.now();
  const volatile = volatileSeed(now);

  const history = { label: "Event history (timestamp map)", refreshedAt: now };
  for (let i = 0; i < 18; i += 1) {
    const t = now + i * 1000;
    history[`t${t}`] = JSON.stringify({
      at: String(t),
      nodes: [`peer-${i}`, `client-${i % 3}`],
      msgPerSec: Number((i * 1.7 + 0.3).toFixed(2)),
    });
  }

  return [
    [p("types/primitives"), {
      stringField: "hello world",
      numberField: 42,
      floatField: 3.14159,
      booleanTrue: true,
      booleanFalse: false,
      zeroValue: 0,
      emptyString: "",
      ...volatile,
    }],
    [p("live/ticker"), {
      label: "Live ticker",
      note: "Re-seed to see explorer pulse animation on this node.",
      mood: pick(ADJECTIVES),
      counter: Math.floor(Math.random() * 10_000),
      ...volatile,
    }],
    [p("types/arrays"), {
      tags: ["alpha", "beta", "gamma"],
      numbers: [1, 2, 3, 5, 8],
      mixed: ["text", 42, true],
      refs: [ref("users/alice"), ref("users/bob")],
      flags: [true, false, true],
    }],
    [p("types/nested"), {
      address: {
        city: "San Francisco",
        zip: 94102,
        geo: { lat: 37.7749, lng: -122.4194 },
      },
      settings: {
        theme: "dark",
        notifications: { email: true, push: false, sms: null },
      },
    }],
    [p("types/json-string"), {
      snapshot: JSON.stringify({
        at: now,
        nonce: volatile.seedNonce,
        roll: volatile.seedRoll,
        nodes: ["a", "b", "c"],
        meta: { version: 1, source: "seed-peer" },
      }),
      note: "Stored as a string; explorer parses JSON-looking values.",
    }],
    [p("types/history"), history],
    [p("users/bob"), {
      name: "Bob Martinez",
      role: "engineer",
      email: "bob@example.com",
      active: true,
      score: 88.5,
    }],
    [p("users/carol"), {
      name: "Carol Okonkwo",
      role: "designer",
      email: "carol@example.com",
      skills: ["figma", "research", "css"],
    }],
    [p("users/diana"), {
      name: "Diana Reeves",
      role: "director",
      department: "Platform",
      reports: [ref("users/alice"), ref("users/carol")],
    }],
    [p("users/alice"), {
      name: "Alice Chen",
      role: "admin",
      email: "alice@example.com",
      friend: ref("users/bob"),
      manager: ref("users/diana"),
      team: ref("teams/engineering"),
      favoriteNumbers: [7, 13, 42],
      lastSeen: now,
      pingMs: volatile.pingMs,
      profile: {
        bio: "Builds graph tools.",
        links: { site: "https://example.com", repo: ref("projects/alpha") },
      },
    }],
    [p("teams/engineering"), {
      name: "Engineering",
      slug: "eng",
      lead: ref("users/diana"),
      members: [ref("users/alice"), ref("users/bob")],
      projects: [ref("projects/alpha"), ref("projects/beta")],
      meta: { headcount: 3, remote: true },
    }],
    [p("projects/alpha"), {
      title: "Graph Explorer",
      status: "active",
      priority: 1,
      owner: ref("users/alice"),
      contributors: [ref("users/bob")],
      tags: ["graph", "ui", "gun"],
      milestones: {
        alpha: { done: true, at: now - 86_400_000 },
        beta: { done: false, at: null },
      },
    }],
    [p("projects/beta"), {
      title: "Mesh Sync",
      status: "planning",
      owner: ref("users/bob"),
      dependsOn: ref("projects/alpha"),
      blockedBy: ref("projects/missing"),
    }],
    [p("posts/welcome"), {
      title: "Welcome to the sample graph",
      body: "Rich demo data for dashboard, explorer, and relation edge tests.",
      author: ref("users/alice"),
      coAuthors: [ref("users/bob"), ref("users/carol")],
      tags: ["announcement", "sample"],
      ...volatile,
      reactions: {
        likes: 10 + Math.floor(Math.random() * 90),
        shares: 1 + Math.floor(Math.random() * 12),
        viewed: true,
      },
    }],
    [p("catalog/widget"), {
      sku: "WDG-001",
      name: "Graph Widget",
      price: 19.99,
      inStock: true,
      supplier: ref("users/bob"),
      specs: { weight: "200g", color: "blue", dimensions: { w: 10, h: 4, d: 2 } },
    }],
    [p("chains/node-3"), { value: 3, next: null }],
    [p("chains/node-2"), { value: 2, next: ref("chains/node-3") }],
    [p("chains/head"), { value: 1, next: ref("chains/node-2") }],
    [p("lists/alpha-tasks"), {
      title: "Alpha backlog",
      items: [
        { text: "Wire explorer edges", done: true },
        { text: "Add latency colors", done: true },
        { assignee: ref("users/bob"), text: "Peer mesh UI", done: false },
      ],
    }],
    [p("edits/revised"), {
      title: "Current title",
      body: "Shows a tombstoned field alongside live data.",
      deprecatedField: null,
      revision: 2,
    }],
    [p("index"), {
      label: "Sample graph entry points",
      users: ref("users/alice"),
      team: ref("teams/engineering"),
      showcase: ref("types/primitives"),
      post: ref("posts/welcome"),
      chain: ref("chains/head"),
      ticker: ref("live/ticker"),
      ...volatile,
    }],
  ];
}

export function sampleSoulCount(prefix = "sample") {
  return buildSampleGraph(prefix).length;
}
