#!/usr/bin/env node
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const {
  STORAGE_EVICT_AT_BYTES,
  STORAGE_EVICT_BYTES,
} = await import(pathToFileURL(path.join(root, "tests/shared/constants.js")).href);

const port = process.env.E2E_PORT || "8799";
const baseUrl = process.env.E2E_BASE_URL || `http://127.0.0.1:${port}`;
const persistDir = path.join(root, ".wrangler", "e2e");
const e2eToken = process.env.E2E_RESET_TOKEN || "local-e2e-only";

async function waitForReady(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const health = await fetch(`${url}/health`);
      const reset = await fetch(`${url}/api/e2e/reset`, {
        method: "POST",
        headers: { "x-e2e-token": e2eToken },
      });
      if (health.ok && reset.ok) {
        return;
      }
    } catch {
      // still booting
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`timed out waiting for test server at ${url}`);
}

function run(command, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
      }
    });
  });
}

let devProcess;

async function startDev() {
  await rm(persistDir, { recursive: true, force: true });

  devProcess = spawn(
    "npx",
    [
      "wrangler",
      "dev",
      "--port",
      port,
      "--persist-to",
      persistDir,
      "--var",
      `STORAGE_EVICT_AT_BYTES:${STORAGE_EVICT_AT_BYTES}`,
      "--var",
      `STORAGE_EVICT_BYTES:${STORAGE_EVICT_BYTES}`,
      "--var",
      "E2E_RESET_TOKEN:local-e2e-only",
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        WRANGLER_LOG_PATH: path.join(root, ".wrangler", "logs"),
        CLOUDFLARE_TELEMETRY_DISABLED: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  devProcess.stdout?.on("data", (chunk) => process.stdout.write(chunk));
  devProcess.stderr?.on("data", (chunk) => process.stderr.write(chunk));

  await waitForReady(baseUrl);
}

function stopDev() {
  if (!devProcess || devProcess.killed) {
    return;
  }
  devProcess.kill("SIGTERM");
}

async function main() {
  let exitCode = 1;
  try {
    console.log(`Starting wrangler dev on ${baseUrl} ...`);
    console.log(`Open the dashboard here during tests (not :8787): ${baseUrl}`);
    await startDev();
    console.log("Running tests ...");
    await run("npx", ["vitest", "run"], {
      E2E_BASE_URL: baseUrl,
      E2E_RESET_TOKEN: e2eToken,
      STORAGE_EVICT_AT_BYTES: String(STORAGE_EVICT_AT_BYTES),
      STORAGE_EVICT_BYTES: String(STORAGE_EVICT_BYTES),
    });
    exitCode = 0;
  } catch (error) {
    console.error(error.message || error);
  } finally {
    stopDev();
    process.exit(exitCode);
  }
}

process.on("SIGINT", () => {
  stopDev();
  process.exit(130);
});

process.on("SIGTERM", () => {
  stopDev();
  process.exit(143);
});

main();
