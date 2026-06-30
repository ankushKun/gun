#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_PEER_URL,
  fetchStats,
  formatBytes,
  parseArgs,
  peerBaseUrl,
  runScript,
} from "./lib/gun-peer.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOCAL_DO_DIR = path.join(
  root,
  ".wrangler",
  "state",
  "v3",
  "do",
  "gun-peer-server-GunPeerObject",
);

function usage() {
  console.log(`Usage: npm run clear-storage -- [options]

Erase GunPeerObject durable storage at once (graph, stats, peers, throughput).
Use drain-peer for gradual Gun.js tombstone deletes instead.

Options:
  --url <base>   Deployed worker origin (e.g. https://gun.ankush.one)
  --local        Delete local wrangler DO sqlite files (stop dev server first)
  --yes          Skip confirmation prompt

Remote auth (one required when --url is set):
  PEERS_EDIT_TOKEN   Bearer token for DELETE /api/storage
  E2E_RESET_TOKEN    x-e2e-token for POST /api/e2e/reset (fallback)

Examples:
  npm run clear-storage -- --url https://gun.ankush.one
  PEERS_EDIT_TOKEN=secret npm run clear-storage -- --url https://gun.ankush.one --yes
  npm run clear-storage -- --local --yes
`);
}

function parseClearArgs(argv) {
  const opts = parseArgs(argv, { local: false, yes: false, url: DEFAULT_PEER_URL });
  if (!opts.url) {
    opts.url = "";
  } else {
    opts.url = peerBaseUrl(opts.url);
  }
  return opts;
}

async function clearRemote(baseUrl) {
  const peersToken = process.env.PEERS_EDIT_TOKEN;
  const e2eToken = process.env.E2E_RESET_TOKEN;

  if (peersToken) {
    const response = await fetch(`${baseUrl}/api/storage`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${peersToken}` },
    });
    if (response.ok) {
      return response.json();
    }
    const body = await response.text();
    if (response.status !== 401 && response.status !== 404) {
      throw new Error(`DELETE /api/storage failed: ${response.status} ${body}`);
    }
  }

  if (e2eToken) {
    const response = await fetch(`${baseUrl}/api/e2e/reset`, {
      method: "POST",
      headers: { "x-e2e-token": e2eToken },
    });
    if (!response.ok) {
      throw new Error(`POST /api/e2e/reset failed: ${response.status} ${await response.text()}`);
    }
    return response.json();
  }

  throw new Error("set PEERS_EDIT_TOKEN or E2E_RESET_TOKEN for remote wipe");
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

async function clearLocal() {
  await rm(LOCAL_DO_DIR, { recursive: true, force: true });
  return LOCAL_DO_DIR;
}

async function main() {
  let opts;
  try {
    opts = parseClearArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    usage();
    process.exit(1);
  }

  if (opts.help) {
    usage();
    return;
  }

  if (!opts.local && !opts.url) {
    console.error("pass --url <worker> for deployed storage or --local for wrangler dev files\n");
    usage();
    process.exit(1);
  }

  if (!opts.yes) {
    const target = opts.local ? `local files at ${LOCAL_DO_DIR}` : `remote DO at ${opts.url}`;
    const ok = await confirm(`Erase all graph data and reset stats for ${target}?`);
    if (!ok) {
      console.log("aborted");
      return;
    }
  }

  if (opts.local) {
    const removed = await clearLocal();
    console.log(`removed ${removed}`);
    return;
  }

  const baseUrl = opts.url.replace(/\/+$/, "");
  const before = await fetchStats(baseUrl);
  console.log(
    `before: ${before.storage?.graphNodes ?? before.graph?.nodes ?? "?"} nodes, ` +
      `${formatBytes(before.storage?.bytesUsed)} used`,
  );

  const result = await clearRemote(baseUrl);
  const after = await fetchStats(baseUrl);
  console.log(
    `after: ${after.storage?.graphNodes ?? after.graph?.nodes ?? "?"} nodes, ` +
      `${formatBytes(after.storage?.bytesUsed)} used`,
  );
  console.log("ok:", result);
}

runScript(main);