import { describe, expect, it } from "vitest";
import { gridStep, jsonDiffPaths, normalizePreviewJson, prepareGraph, settleGraph, typeOfValue } from "../public/explorer.js";
import { groupInspectorFields, isArrayShapedNode, isHistoryKey, objectToArray } from "../public/graph-inspector.js";

describe("graph explorer data", () => {
  it("links edges to nodes and counts relations", () => {
    const graph = prepareGraph({
      nodes: [{ soul: "a" }, { soul: "b" }],
      edges: [{ from: "a", to: "b", field: "friend" }],
    });
    expect(graph.edges[0].source.soul).toBe("a");
    expect(graph.nodes.map((node) => node.degree)).toEqual([1, 1]);
  });

  it("preserves layout and fades graph changes", () => {
    const first = prepareGraph({ nodes: [{ soul: "a", label: "A" }], edges: [] });
    first.nodes[0].x = 123;
    first.nodes[0].opacity = 1;
    const next = prepareGraph({ nodes: [{ soul: "a", label: "A2" }, { soul: "b" }], edges: [] }, first);
    expect(next.nodes.find((node) => node.soul === "a")).toMatchObject({ x: 123, opacity: 1, pulse: 1 });
    expect(next.nodes.find((node) => node.soul === "b")).toMatchObject({ opacity: 0, pulse: 1 });
    const removed = prepareGraph({ nodes: [], edges: [] }, next);
    expect(removed.nodes.every((node) => node.exiting)).toBe(true);
  });

  it("keeps the transformed dot grid readable at every zoom", () => {
    expect(gridStep(0.12)).toBeGreaterThanOrEqual(14);
    expect(gridStep(4)).toBeLessThanOrEqual(44);
  });

  it("settles the initial graph before its first frame", () => {
    const graph = prepareGraph({
      nodes: [{ soul: "a" }, { soul: "b" }],
      edges: [{ from: "a", to: "b", field: "link" }],
    });
    const dist = () => Math.hypot(graph.nodes[0].x - graph.nodes[1].x, graph.nodes[0].y - graph.nodes[1].y);
    const minDist = graph.nodes[0].radius + graph.nodes[1].radius + 26;
    const before = dist();
    settleGraph(graph);
    expect(dist()).toBeGreaterThan(minDist - 1);
    expect(dist()).toBeGreaterThan(before * 0.35);
  });

  it("recognizes rich inspector values without executing them", () => {
    expect(typeOfValue("https://cdn.example/image.webp")).toBe("image");
    expect(typeOfValue("https://cdn.example/movie.mp4?x=1")).toBe("video");
    expect(typeOfValue('{"safe":true}')).toBe("json");
    expect(typeOfValue("<img src=x onerror=alert(1)>")).toBe("string");
  });

  it("diffs nested json paths for live highlight", () => {
    const before = { window: { latest: { nodes: [{ successcount: 1 }] } } };
    const after = { window: { latest: { nodes: [{ successcount: 2 }] } } };
    const diff = jsonDiffPaths(before, after);
    expect(diff.changed.has("window.latest.nodes.0.successcount")).toBe(true);
    expect(diff.added.size).toBe(0);
    expect(diff.removed.size).toBe(0);
    expect(jsonDiffPaths(before, before).changed.size).toBe(0);
    const added = jsonDiffPaths(before, { ...before, extra: true });
    expect(added.added.has("extra")).toBe(true);
    const removed = jsonDiffPaths({ ...before, extra: true }, before);
    expect(removed.removed.has("extra")).toBe(true);
  });

  it("normalizes embedded json strings for preview", () => {
    const raw = { window: '{"latest":{"at":1}}', plain: "hello" };
    expect(normalizePreviewJson(raw)).toEqual({ window: { latest: { at: 1 } }, plain: "hello" });
    expect(normalizePreviewJson('{"a":1}')).toEqual({ a: 1 });
    expect(normalizePreviewJson("not json")).toBe("not json");
    expect(normalizePreviewJson({ deep: { nested: '{"x":1}' } }, 1)).toEqual({ deep: { nested: '{"x":1}' } });
  });

  it("groups array-shaped nodes into a single items field", () => {
    const raw = { _: { "#": "sample/skills" }, 0: "figma", 1: "research", 2: "writing" };
    expect(isArrayShapedNode(raw)).toBe(true);
    expect(objectToArray(raw)).toEqual(["figma", "research", "writing"]);
    const groups = groupInspectorFields(raw);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ id: "__items__", label: "items", type: "array" });
    expect(groups[0].value).toEqual(["figma", "research", "writing"]);
  });

  it("collapses tombstones and history keys in inspector field groups", () => {
    expect(isHistoryKey("s:1783012809209")).toBe(true);
    expect(isHistoryKey("t123")).toBe(true);
    expect(isHistoryKey("done")).toBe(false);

    const cleared = {
      head: { latest: 1 },
      "s:1": null,
      "s:2": null,
      "s:3": null,
      "s:4": null,
      "s:5": null,
    };
    const clearedGroups = groupInspectorFields(cleared);
    expect(clearedGroups.map((group) => group.id)).toEqual(["head", "__cleared__"]);
    expect(clearedGroups[1]).toMatchObject({ label: "cleared fields (5)", collapsed: true });

    const history = { head: { ok: true } };
    for (let i = 0; i < 15; i++) history[`t${1000 + i}`] = { at: String(1000 + i) };
    const historyGroups = groupInspectorFields(history);
    expect(historyGroups.map((group) => group.id)).toEqual(["head", "__history__"]);
    expect(historyGroups[1]).toMatchObject({ label: "state history (15)", collapsed: true, type: "object" });
  });
});
