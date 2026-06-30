#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import {
  DEFAULT_PEER_URL,
  createGun,
  gunWriteManifest,
  gunWriteSoul,
  parseArgs,
  peerBaseUrl,
  runScript,
  sleep,
} from "./lib/gun-peer.mjs";
import { gunPeerUrl } from "../tests/shared/constants.js";
import { buildSampleGraph } from "./lib/sample-graph.mjs";

function usage() {
  console.log(`Usage: npm run seed-peer -- [options]

Populate the gun peer with sample graph data via Gun.js only (/gun WebSocket).

Options:
  --url <base>      Worker origin (default: ${DEFAULT_PEER_URL})
  --prefix <name>   Soul prefix (default: sample)
  --yes             Skip confirmation

Writes a ${"`"}<prefix>/__manifest${"`"} soul listing everything seeded (used by drain-peer).

Examples:
  npm run seed-peer
  npm run seed-peer -- --url https://gun.ankush.one --prefix demo --yes
`);
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
      prefix: "sample",
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

  const graph = buildSampleGraph(opts.prefix);
  if (!opts.yes) {
    const ok = await confirm(
      `Write ${graph.length} sample souls under "${opts.prefix}/" to ${opts.url} via Gun?`,
    );
    if (!ok) {
      console.log("aborted");
      return;
    }
  }

  opts.url = peerBaseUrl(opts.url);
  const gun = createGun(opts.url);
  await sleep(300);

  console.log(`peer: ${gunPeerUrl(opts.url)}`);
  console.log(`prefix: ${opts.prefix}/`);

  const written = new Set();
  let count = 0;
  for (const [soul, data] of graph) {
    const touched = await gunWriteSoul(gun, soul, data);
    for (const path of touched) {
      written.add(path);
    }
    count += 1;
    process.stdout.write(`\rseeded ${count}/${graph.length}  ${soul.slice(0, 48).padEnd(48)}`);
  }
  console.log("");

  written.add(await gunWriteManifest(gun, opts.prefix, written));
  await sleep(500);

  console.log(`manifest: ${opts.prefix}/__manifest (${written.size} souls)`);
  console.log("roots:", `${opts.prefix}/index`, `${opts.prefix}/users/alice`);
}

runScript(main);
