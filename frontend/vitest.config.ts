import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

/**
 * Unit tests for the web app's logic — the parts with rules worth pinning
 * down: what the dashboard claims, how search ranks, what an export contains.
 * They run in plain Node; anything that needs a DOM is out of scope here and
 * is checked in the browser.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@/": fileURLToPath(new URL("./", import.meta.url)),
      "@odysseus/protocol": fileURLToPath(
        new URL("../odysseus/packages/protocol/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["lib/**/*.test.ts"],
    environment: "node",
  },
});
