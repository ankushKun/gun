import { bindings, defineConfig, exports } from "cf/config";

// Deployed with `cf deploy`. wrangler.toml stays for `wrangler dev` (npm run dev / npm test),
// so keep vars and bindings in sync between the two files.
export default defineConfig({
	accountId: "c19bfc6b0c700c267321ea7affb78bbd",
	worker: {
		name: "gun",
		compatibilityDate: "2026-05-14",
		entrypoint: "src/worker.js",
		observability: {
			enabled: true,
			headSamplingRate: 0.1,
		},
		env: {
			STORAGE_LIMIT_BYTES: bindings.text("5000000000"),
			STORAGE_EVICT_AT_BYTES: bindings.text("4294967296"),
			STORAGE_EVICT_BYTES: bindings.text("536870912"),
			GUN_PEER: bindings.durableObject({
				worker: "gun",
				exportName: "GunPeerObject",
			}),
			ASSETS: bindings.assets(),
		},
		// Live class created by wrangler migration v1 (new_sqlite_classes); holds the graph.
		exports: {
			GunPeerObject: exports.durableObject({ storage: "sqlite" }),
		},
		domains: ["gun.ankush.one"],
	},
});
