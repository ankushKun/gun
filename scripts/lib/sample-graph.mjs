/** Ordered sample souls for seeding: leaves before referrers where possible. */

export function buildSampleGraph(prefix = "sample") {
  const p = (path) => `${prefix}/${path}`;
  const ref = (path) => ({ "#": p(path) });
  const now = Date.now();

  const history = { label: "Event history (timestamp map)" };
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
      reactions: { likes: 12, shares: 3, viewed: true },
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
    }],
  ];
}

export function sampleSoulCount(prefix = "sample") {
  return buildSampleGraph(prefix).length;
}
