import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const conversionError = new Error("conversion failed");
  const shutdownError = new Error("shutdown failed");
  return {
    conversionError,
    convertRollout: vi.fn(async () => {
      throw conversionError;
    }),
    shutdown: vi.fn(async () => {
      throw shutdownError;
    }),
  };
});

vi.mock("../src/config.js", () => ({
  getConfig: vi.fn(async () => ({
    enabled: true,
    public_key: "pk-lf-test",
    secret_key: "sk-lf-test",
    base_url: "https://cloud.langfuse.com",
    max_chars: 20_000,
    debug: false,
    fail_on_error: true,
  })),
}));
vi.mock("../src/instrumentation.js", () => ({
  setupInstrumentation: vi.fn(() => ({ shutdown: mocks.shutdown })),
}));
vi.mock("../src/trace.js", () => ({ convertRollout: mocks.convertRollout }));
vi.mock("../src/utils.js", () => ({
  debugLog: vi.fn(),
  readStdin: vi.fn(async () => ({ transcript_path: "/tmp/rollout.jsonl" })),
  setDebug: vi.fn(),
}));

let runHook: () => Promise<void>;

beforeAll(async () => {
  ({ runHook } = await import("../src/index.js"));
  await vi.waitFor(() => expect(mocks.shutdown).toHaveBeenCalled());
});

afterEach(() => {
  process.exitCode = undefined;
});

describe("runHook", () => {
  it("preserves the conversion error when shutdown also fails", async () => {
    await expect(runHook()).rejects.toBe(mocks.conversionError);
  });
});
