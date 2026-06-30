import { describe, expect, it } from "vitest";
import { gridStep, prepareGraph, settleGraph, typeOfValue } from "../public/explorer.js";

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
});
