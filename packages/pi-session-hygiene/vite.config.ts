import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "session-hygiene",
    include: ["src/**/*.test.ts"],
  },
});
