import { describe, it, expect, beforeEach } from "vitest";
import { nodeOldestTimestamp } from "../../src/worker.js";
import {
  TEST_EVICT_AT,
  TEST_EVICT_BYTES,
  PAYLOAD_SIZE,
  NODES_BELOW_THRESHOLD,
  nodesToTriggerEviction,
  FILL_LOG_EVERY,
  formatBytes,
  TEST_TIMEOUT_MS,
} from "./constants.js";

function logFillProgress(label, i, total, stats) {
  if (i % FILL_LOG_EVERY !== 0 && i !== total - 1) {
    return;
  }
  const storage = stats.storage;
  console.log(
    `[${label}] node ${i + 1}/${total} | storage ${formatBytes(storage.bytesUsed)} / ${formatBytes(TEST_EVICT_AT)} | graph nodes ${storage.graphNodes}${storage.lastEviction ? " | eviction ran" : ""}`,
  );
}

export function storageEvictionSuite(helpers) {
  describe("storage eviction", () => {
    let baselineBytes = 0;

    beforeEach(async () => {
      await helpers.resetPeerStorage();
      baselineBytes = await helpers.storageBytesUsed();
    });

    function addedBytes(bytesUsed) {
      return bytesUsed - baselineBytes;
    }

    it("nodeOldestTimestamp picks earliest field timestamp", () => {
      expect(nodeOldestTimestamp({ _: { ">": { a: 500, b: 900 } } })).toBe(500);
      expect(nodeOldestTimestamp({ _: { ">": {} } })).toBe(0);
    });

    it("does not evict while storage stays below threshold", async () => {
      expect(baselineBytes).toBeLessThan(TEST_EVICT_AT - PAYLOAD_SIZE * NODES_BELOW_THRESHOLD);

      for (let i = 0; i < NODES_BELOW_THRESHOLD; i++) {
        const soul = `young-${i}`;
        await helpers.putGraphNode(soul, PAYLOAD_SIZE, tsFor(i));
        const stats = await helpers.fetchStats();

        expect(addedBytes(stats.storage.bytesUsed)).toBeLessThan(TEST_EVICT_AT);
        expect(stats.storage.lastEviction).toBeNull();
        expect(await helpers.readGraphNode(soul)).not.toBeNull();
      }

      expect(await helpers.listStoredSouls()).toEqual(
        Array.from({ length: NODES_BELOW_THRESHOLD }, (_, i) => `young-${i}`),
      );
    });

    it(
      "fills to 1 GiB, auto-evicts ~500 MiB of oldest data, preserves system keys",
      async () => {
        await helpers.seedSystemKeys();

        const souls = [];
        let evictionSeen = false;
        let bytesAtEviction = null;
        let firstEviction = null;
        const nodeCount = nodesToTriggerEviction();

        console.log(
          `Filling ${nodeCount} nodes × ${formatBytes(PAYLOAD_SIZE)} toward ${formatBytes(TEST_EVICT_AT)} eviction threshold ...`,
        );

        for (let i = 0; i < nodeCount; i++) {
          const soul = `fill-${i}`;
          const ts = 1_000 + i * 1_000;
          souls.push({ soul, ts });
          await helpers.putGraphNode(soul, PAYLOAD_SIZE, ts);

          const stats = await helpers.fetchStats();
          logFillProgress("fill", i, nodeCount, stats);

          if (!evictionSeen && stats.storage.lastEviction) {
            evictionSeen = true;
            bytesAtEviction = stats.storage.bytesUsed;
            firstEviction = stats.storage.lastEviction;
            console.log(
              `Eviction triggered at ${formatBytes(bytesAtEviction)} | removed ${firstEviction.nodes} nodes | ~${formatBytes(firstEviction.bytesEstimate)} estimated`,
            );
          }
        }

        expect(evictionSeen).toBe(true);
        expect(firstEviction.nodes).toBeGreaterThan(0);
        expect(firstEviction.bytesEstimate).toBeGreaterThan(TEST_EVICT_BYTES * 0.25);

        const finalStats = await helpers.fetchStats();
        console.log(
          `After eviction: ${formatBytes(finalStats.storage.bytesUsed)} (limit ${formatBytes(TEST_EVICT_AT)})`,
        );
        expect(finalStats.storage.bytesUsed).toBeLessThan(TEST_EVICT_AT);

        const remaining = await helpers.listStoredSouls();
        expect(remaining.length).toBeLessThan(souls.length);
        expect(remaining).not.toContain("fill-0");
        expect(remaining).not.toContain("fill-1");
        expect(remaining).toContain(`fill-${nodeCount - 1}`);
        expect(await helpers.readGraphNode("fill-0")).toBeNull();
        expect(await helpers.readGraphNode(`fill-${nodeCount - 1}`)).not.toBeNull();

        const system = await helpers.readSystemKeys();
        expect(system.stats).not.toBeNull();
        expect(system.peerList).toEqual([{ id: "p1", url: "https://example.com/gun" }]);
        expect(system.throughput).not.toBeNull();

        console.log("Writing 5 more nodes to confirm eviction still runs under continued pressure ...");
        for (let i = 0; i < 5; i++) {
          await helpers.putGraphNode(`round-${i}`, PAYLOAD_SIZE, 100_000 + i);
        }
        const afterPressure = await helpers.fetchStats();
        expect(afterPressure.storage.lastEviction).not.toBeNull();
        expect(afterPressure.storage.bytesUsed).toBeLessThan(TEST_EVICT_AT);
      },
      TEST_TIMEOUT_MS,
    );
  });
}

function tsFor(i) {
  return 10_000 + i * 100;
}
