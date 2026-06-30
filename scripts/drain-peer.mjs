#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import {
  DEFAULT_PEER_URL,
  createGun,
  gunDeleteSoul,
  gunReadManifest,
  gunRemoveManifestEntry,
  parseArgs,
  peerBaseUrl,
  runScript,
  sleep,
} from "./lib/gun-peer.mjs";
import { gunPeerUrl } from "../tests/shared/constants.js";

function usage() {
  console.log(`Usage: npm run drain-peer -- [options]

Gradually tombstone souls via Gun.js (/gun only).
Only removes souls listed in <prefix>/__manifest (written by seed-peer).

To wipe ALL peer storage at once (graph, stats, peers), use clear-storage instead:
  npm run clear-storage -- --url https://gun.ankush.one --yes

Options:
  --url <base>         Worker origin (default: ${DEFAULT_PEER_URL})
  --prefix <name>      Manifest prefix (default: sample)
  --interval <ms>      Delay between deletes (default: 500)
  --yes                Skip confirmation

Examples:
  npm run drain-peer -- --prefix sample
  npm run drain-peer -- --url https://gun.ankush.one --interval 100 --yes
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

  if (!opts.yes) {
    const ok = await confirm(
      `Gradually delete souls listed in ${opts.prefix}/__manifest on ${opts.url}?`,
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
  console.log(`manifest: ${opts.prefix}/__manifest`);

  let deleted = 0;
  while (true) {
    const souls = await gunReadManifest(gun, opts.prefix);
    const pending = souls.filter((soul) => soul !== `${opts.prefix}/__manifest`);
    if (!pending.length) {
      break;
    }

    const soul = pending[pending.length - 1];
    try {
      await gunDeleteSoul(gun, soul);
    } catch (error) {
      console.warn(`\nwarn: ${error.message}`);
    }
    await gunRemoveManifestEntry(gun, opts.prefix, soul);
    deleted += 1;
    process.stdout.write(
      `\rdeleted ${deleted}  remaining ~${pending.length - 1}  last: ${soul.slice(0, 40)}`,
    );

    if (opts.interval > 0) {
      await sleep(opts.interval);
    }
  }

  await gunDeleteSoul(gun, `${opts.prefix}/__manifest`);
  console.log(`\ndone: tombstoned ${deleted} souls via Gun`);
  console.log("note: keys may remain in DO storage; run npm run clear-storage to wipe the worker");
}

runScript(main);