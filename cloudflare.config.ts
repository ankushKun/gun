import { bindings, defineConfig, exports } from "cf/config";
import {
	STORAGE_EVICT_AT_BYTES as TEST_EVICT_AT_BYTES,
	STORAGE_EVICT_BYTES as TEST_EVICT_BYTES,
} from "./tests/shared/constants.js";

// Single source of config for `cf dev`, `cf build`, and `cf deploy` (CI included).
// `--mode test` (npm test) runs as a separate local worker so e2e resets never touch
// `npm run dev` data, with small eviction thresholds and the e2e reset token enabled.
export default defineConfig(({ mode }) => {
	const test = mode === "test";
	const name = test ? "gun-test" : "gun";

	return {
		accountId: "c19bfc6b0c700c267321ea7affb78bbd",
		worker: {
			name,
			compatibilityDate: "2026-05-14",
			entrypoint: "src/worker.js",
			workersDev: true,
			previewUrls: true,
			domains: test ? [] : ["gun.ankush.one"],
			observability: {
				enabled: true,
				// sampled so request patterns show up without spending the free plan's
				// daily log allowance on every WebSocket message
				headSamplingRate: 0.1,
				// logs and traces default to 1 unless set, which overrides the rate above
				logs: { headSamplingRate: 0.1 },
				traces: { headSamplingRate: 0.1 },
			},
			env: {
				// Free plan: 5 GB total. Evict from 4 GiB, freeing 512 MiB per pass.
				STORAGE_LIMIT_BYTES: bindings.text("5000000000"),
				STORAGE_EVICT_AT_BYTES: bindings.text(String(test ? TEST_EVICT_AT_BYTES : 4294967296)),
				STORAGE_EVICT_BYTES: bindings.text(String(test ? TEST_EVICT_BYTES : 536870912)),
				// Presence-style souls (cursors, heartbeats, reactions) live in memory only.
				EPHEMERAL_PREFIXES: bindings.text("ankush-one/live"),
				// Free tier daily SQLite row limits; the object sheds load in stages before them.
				ROWS_READ_DAILY_LIMIT: bindings.text("5000000"),
				ROWS_WRITTEN_DAILY_LIMIT: bindings.text("100000"),
				...(test
					? { E2E_RESET_TOKEN: bindings.text(process.env.E2E_RESET_TOKEN || "local-e2e-only") }
					: {}),
				GUN_PEER: bindings.durableObject({ worker: name, exportName: "GunPeerObject" }),
				ASSETS: bindings.assets(),
			},
			// Durable Object lifecycle (replaces wrangler `migrations`). GunPeerObject was
			// created by the old v1 migration as a SQLite class and holds the graph.
			// To rename or remove it later, change this entry to a `renamed` / `deleted`
			// tombstone instead of dropping it, or Cloudflare rejects the deploy.
			exports: {
				GunPeerObject: exports.durableObject({ storage: "sqlite" }),
			},
		},
	};
});
