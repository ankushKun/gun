import { beforeAll } from "vitest";
import * as helpers from "./helpers.js";
import { storageEvictionSuite } from "./shared/eviction-suite.js";

beforeAll(async () => {
  await helpers.waitForServer();
}, 60_000);

storageEvictionSuite(helpers);
