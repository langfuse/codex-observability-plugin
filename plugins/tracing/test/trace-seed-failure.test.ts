import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Config } from "../src/config.js";
import { convertRollout } from "../src/trace.js";

// Force seeded trace-id derivation to fail so we can assert the hook fails
// open (uploads with auto-generated ids) unless fail_on_error is set.
vi.mock("@langfuse/tracing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@langfuse/tracing")>();
  return {
    ...actual,
    createTraceId: vi.fn(async () => {
      throw new Error("derivation boom");
    }),
  };
});

const exporter = new InMemorySpanExporter();
let provider: NodeTracerProvider;

const baseConfig: Config = {
  enabled: true,
  public_key: "pk-lf-test",
  secret_key: "sk-lf-test",
  base_url: "https://cloud.langfuse.com",
  max_chars: 20_000,
  debug: false,
  fail_on_error: false,
  trace_seed: "ci-run-42",
  trace_scope: "turn",
};

const fixturesRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/sessions");

function stageFixtures(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lf-codex-seed-fail-"));
  fs.cpSync(fixturesRoot, path.join(dir, "sessions"), { recursive: true });
  return path.join(dir, "sessions", "2026", "06", "03");
}

beforeAll(() => {
  provider = new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  provider.register();
});

afterAll(async () => {
  await provider.shutdown();
});

beforeEach(() => {
  exporter.reset();
});

describe("trace seed derivation failure", () => {
  it("falls back to auto-generated trace ids and still uploads", async () => {
    const dir = stageFixtures();
    await convertRollout(path.join(dir, "rollout-basic-main.jsonl"), { config: baseConfig });

    const root = exporter.getFinishedSpans().find((s) => s.name === "Codex Turn");
    expect(root, "expected the turn to upload despite the derivation failure").toBeDefined();
    expect(root!.spanContext().traceId).toMatch(/^[0-9a-f]{32}$/);
  });

  it("propagates the derivation error when fail_on_error is set", async () => {
    const dir = stageFixtures();
    await expect(
      convertRollout(path.join(dir, "rollout-basic-main.jsonl"), {
        config: { ...baseConfig, fail_on_error: true },
      }),
    ).rejects.toThrow("derivation boom");
  });
});
