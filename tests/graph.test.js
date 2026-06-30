import { beforeAll, describe, expect, it } from "vitest";
import {
  extractGunRefs,
  extractRefSoul,
  nodeLabel,
  nodePreviewFields,
  clampInt,
  summarizeNodeFields,
  summarizeFieldValue,
  isTimestampMapNode,
  nodeHasContent,
} from "../src/worker.js";
import * as helpers from "./helpers.js";

beforeAll(async () => {
  await helpers.waitForServer();
}, 60_000);

describe("graph helpers", () => {
  it("extractRefSoul reads Gun soul links", () => {
    expect(extractRefSoul({ "#": "users/alice" })).toBe("users/alice");
    expect(extractRefSoul("plain")).toBeNull();
  });

  it("keeps Gun tombstones stored but hides empty nodes from the explorer", () => {
    expect(nodeHasContent({ _: { "#": "a" }, name: null })).toBe(false);
    expect(nodeHasContent({ _: { "#": "a" }, count: 0 })).toBe(true);
  });

  it("extractGunRefs finds direct and nested references", () => {
    const node = {
      _: { "#": "a", ">": {} },
      name: "Alice",
      friend: { "#": "b" },
      tags: [{ "#": "c" }],
    };
    const edges = extractGunRefs(node, "a");
    expect(edges).toContainEqual({ from: "a", to: "b", field: "friend" });
    expect(edges).toContainEqual({ from: "a", to: "c", field: "tags[0]" });
  });

  it("extractGunRefs preserves deeply nested relation paths", () => {
    const edges = extractGunRefs({
      profile: { groups: [{ owner: { "#": "users/admin" } }] },
    }, "users/alice");
    expect(edges).toContainEqual({
      from: "users/alice",
      to: "users/admin",
      field: "profile.groups[0].owner",
    });
  });

  it("nodeLabel prefers short string fields", () => {
    expect(nodeLabel({ name: "Alice" }, "users/alice")).toBe("Alice");
    expect(nodeLabel({ payload: "x".repeat(100) }, "test/node")).toBe("node");
  });

  it("nodePreviewFields truncates large strings", () => {
    const fields = nodePreviewFields({ payload: "x".repeat(200) });
    expect(fields.payload.length).toBeLessThan(200);
    expect(fields.payload.endsWith("…")).toBe(true);
  });

  it("clampInt treats null query params as fallback", () => {
    expect(clampInt(null, 200, 1, 500)).toBe(200);
    expect(clampInt("", 100, 1, 500)).toBe(100);
  });

  it("summarizeFieldValue handles refs, objects, and strings", () => {
    expect(summarizeFieldValue("friend", { "#": "users/bob" })).toMatchObject({
      type: "ref",
      ref: "users/bob",
    });
    const map = summarizeFieldValue("history", {
      t1: { at: 1 },
      t2: { at: 2 },
      t3: { at: 3 },
    });
    expect(map.type).toBe("object");
    expect(map.keyCount).toBe(3);
    expect(map.sampleKeys).toEqual(["t1", "t2", "t3"]);
    expect(summarizeFieldValue("note", "hello").preview).toBe("hello");
  });

  it("summarizeNodeFields collects refs", () => {
    const { fields, refs } = summarizeNodeFields({
      name: "Alice",
      friend: { "#": "b" },
    });
    expect(fields.some((f) => f.key === "name" && f.type === "string")).toBe(true);
    expect(refs).toContainEqual({ field: "friend", to: "b" });
  });

  it("collapses timestamp map nodes into entries summary", () => {
    const node = { _: { "#": "history", ">": {} } };
    for (let i = 0; i < 20; i++) {
      node[`t${1000 + i}`] = JSON.stringify({ at: String(1000 + i), nodes: [] });
    }
    expect(isTimestampMapNode(node)).toBe(true);
    const { fields } = summarizeNodeFields(node);
    expect(fields).toHaveLength(1);
    expect(fields[0].type).toBe("map");
    expect(fields[0].keyCount).toBe(20);
    expect(fields[0].entries.length).toBe(15);
    expect(fields[0].entries[0].type).toBe("object");
  });

  it("parses json strings in field values", () => {
    const field = summarizeFieldValue("snap", '{"at":"1","nodes":[]}');
    expect(field.type).toBe("object");
    expect(field.keyCount).toBe(2);
  });
});

describe("graph API", () => {
  it("returns linked subgraph from roots", async () => {
    await helpers.resetPeerStorage();
    const ts = Date.now();
    await helpers.putGraphNodeCustom("graph/alice", {
      name: "Alice",
      friend: { "#": "graph/bob" },
    }, ts);
    await helpers.putGraphNodeCustom("graph/bob", {
      name: "Bob",
    }, ts + 1);

    const aliceNode = await helpers.readGraphNode("graph/alice");
    expect(aliceNode?.friend).toEqual({ "#": "graph/bob" });

    const shallow = await helpers.fetchSubgraph({ roots: "graph/alice", depth: "0" });
    expect(shallow.edges).toContainEqual({
      from: "graph/alice",
      to: "graph/bob",
      field: "friend",
    });
    expect(shallow.missingTargets).toContain("graph/bob");

    const data = await helpers.fetchSubgraph({ roots: "graph/alice", depth: "1" });
    expect(data.nodes.map((n) => n.soul).sort()).toEqual(["graph/alice", "graph/bob"]);
  });

  it("lists souls with prefix and substring search", async () => {
    const byPrefix = await helpers.fetchGraphSouls({ prefix: "graph/", limit: "10" });
    expect(helpers.soulPaths(byPrefix)).toContain("graph/alice");

    const byQuery = await helpers.fetchGraphSouls({ q: "alice", limit: "10" });
    expect(helpers.soulPaths(byQuery)).toContain("graph/alice");
  });

  it("sorts souls by updated descending", async () => {
    const data = await helpers.fetchGraphSouls({ sort: "updated", limit: "10" });
    expect(data.souls[0].soul).toBe("graph/bob");
    expect(data.souls[0].updated).toBeGreaterThan(data.souls[1].updated);
  });

  it("returns structured node inspector payload", async () => {
    const node = await helpers.fetchGraphNode("graph/alice");
    expect(node.soul).toBe("graph/alice");
    expect(node.label).toBe("Alice");
    expect(node.fields.some((f) => f.key === "friend" && f.type === "ref")).toBe(true);
    expect(node.refs).toContainEqual({ field: "friend", to: "graph/bob" });
    expect(node.raw).toBeTruthy();
  });
});
