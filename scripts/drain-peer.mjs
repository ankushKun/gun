#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import {
  DEFAULT_PEER_URL,
  createGun,
  fetchStats,
  formatBytes,
  gunTombstoneSoul,
  listVisibleGraphSouls,
  parseArgs,
  peerBaseUrl,
  runScript,
  sleep,
} from "./lib/gun-peer.mjs";
import { gunPeerUrl } from "../tests/shared/constants.js";

function usage() {
  console.log(`Usage: npm run drain-peer -- [options]

Gradually tombstone graph souls via Gun.js (/gun).
Lists souls from the worker /api/graph/souls API, deletes each over /gun.

For an instant full DO wipe (stats, peers, everything), use clear-storage instead:
  npm run clear-storage -- --url https://gun.ankush.one --yes

Options:
  --url <base>         Worker origin (default: ${DEFAULT_PEER_URL})
  --prefix <path>      Only souls under this prefix (default: all souls)
  --q, --query <text>  Substring filter on soul paths
  --interval <ms>      Delay between deletes (default: 500)
  --yes                Skip confirmation

Examples:
  npm run drain-peer -- --prefix sample
  npm run drain-peer -- --url https://gun.ankush.one --q sample --interval 100 --yes
`);
}

function drainScope(opts) {
  if (opts.prefix && opts.query) {
    return `souls under "${opts.prefix}/" matching "${opts.query}"`;
  }
  if (opts.prefix) {
    return `souls under "${opts.prefix}/"`;
  }
  if (opts.query) {
    return `souls matching "${opts.query}"`;
  }
  return "all visible graph souls";
}

async function confirm(message) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${message} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2), {
      url: peerBaseUrl(DEFAULT_PEER_URL),
      prefix: "",
      query: "",
      interval: 500,
      yes: false,
    });
  } catch (error) {
    console.error(error.message);
    usage();
    process.exit(1);
  }

  if (opts.help) {
    usage();
    return;
  }

  if (!Number.isFinite(opts.interval) || opts.interval < 0) {
    throw new Error("--interval must be a non-negative number");
  }

  const scope = drainScope(opts);
  if (!opts.yes) {
    const ok = await confirm(`Gradually delete ${scope} on ${opts.url}?`);
    if (!ok) {
      console.log("aborted");
      return;
    }
  }

  opts.url = peerBaseUrl(opts.url);
  const gun = createGun(opts.url);
  await sleep(300);

  const before = await fetchStats(opts.url);
  console.log(`peer: ${gunPeerUrl(opts.url)}`);
  console.log(`scope: ${scope}`);
  console.log(
    `before: ${before.storage?.graphNodes ?? "?"} nodes, ${formatBytes(before.storage?.bytesUsed)} used`,
  );

  let deleted = 0;
  while (true) {
    const souls = await listVisibleGraphSouls(opts.url, {
      prefix: opts.prefix,
      query: opts.query,
    });
    if (!souls.length) {
      break;
    }

    const soul = souls[0];
    try {
      await gunTombstoneSoul(gun, opts.url, soul);
    } catch (error) {
      console.warn(`\nwarn: ${error.message}`);
    }
    deleted += 1;
    const remaining = souls.length - 1;
    process.stdout.write(
      `\rdeleted ${deleted}  remaining ~${remaining}  last: ${soul.slice(0, 40)}`,
    );

    if (opts.interval > 0) {
      await sleep(opts.interval);
    }
  }

  const after = await fetchStats(opts.url);
  console.log(
    `\ndone: tombstoned ${deleted} souls via Gun; ` +
      `${after.storage?.graphNodes ?? "?"} nodes, ${formatBytes(after.storage?.bytesUsed)} used`,
  );
  console.log("note: tombstoned keys may remain in DO storage; run npm run clear-storage to wipe the worker");
}

runScript(main);
