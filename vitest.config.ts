import { defaultExclude, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Git worktrees are checked out under `.claude/`, so without this every
    // test file in the repo would be collected a second time from there.
    exclude: [...defaultExclude, "**/.claude/**"],
  },
});
