import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const testRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    env: {
      SQUADFLOW_AGENT_RUNTIME_CONFIG_ROOT: path.join(testRoot, "tests", "fixtures", "agent-runtime"),
    },
  },
});
