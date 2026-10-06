import * as path from "node:path";

import { LangfuseSpanProcessor } from "@langfuse/otel";
import { startObservation, setLangfuseTracerProvider } from "@langfuse/tracing";
import type { SpanExporter, ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setupInstrumentation, spanIdentity } from "../src/instrumentation.js";
import { convertRollout } from "../src/trace.js";

const state = vi.hoisted(() => ({ fail: false }));
vi.mock("@opentelemetry/exporter-trace-otlp-http", () => ({
  OTLPTraceExporter: class {
    export: SpanExporter["export"] = (_spans, callback) => {
      callback(state.fail ? { code: 1, error: new Error("export rejected") } : { code: 0 });
      state.fail = false;
    };
    async shutdown(): Promise<void> {}
  },
}));

const config = {
  enabled: true,
  public_key: "pk-test",
  secret_key: "sk-test",
  base_url: "http://localhost",
  skill_tags: true,
  debug: false,
  fail_on_error: false,
};
beforeEach(() => {
  state.fail = false;
  vi.stubEnv("OTEL_TRACES_SAMPLER", "always_on");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  setLangfuseTracerProvider(null);
});

describe("per-window span delivery receipts", () => {
  it("checkpoints healthy turns in the same batch as a preprocessing failure", async () => {
    const prototype = LangfuseSpanProcessor.prototype as unknown as {
      processEndedSpan(span: ReadableSpan): Promise<void>;
    };
    vi.spyOn(prototype, "processEndedSpan").mockRejectedValueOnce(
      new Error("preprocessing failed"),
    );
    const instrumentation = setupInstrumentation(config);
    const checkpoint = vi.fn(async (_id: string) => {});
    try {
      const file = path.resolve(
        "plugins/tracing/test/fixtures/sessions/2026/06/03/rollout-two-turns-main.jsonl",
      );
      const exported = await convertRollout(file, {
        config,
        flush: instrumentation.flush,
        onTurnExported: checkpoint,
      });
      expect(exported).toEqual(["turn-b"]);
      expect(checkpoint).toHaveBeenCalledExactlyOnceWith("turn-b");
    } finally {
      await instrumentation.shutdown();
    }
  });

  it("reports a preprocessing drop once and recovers for a later span in the same process", async () => {
    const prototype = LangfuseSpanProcessor.prototype as unknown as {
      processEndedSpan(span: ReadableSpan): Promise<void>;
    };
    vi.spyOn(prototype, "processEndedSpan").mockRejectedValueOnce(
      new Error("preprocessing failed"),
    );
    const instrumentation = setupInstrumentation(config);
    try {
      const dropped = startObservation("dropped");
      dropped.end();
      const receipt = await instrumentation.flush();
      expect([...receipt.failedSpanIds]).toEqual([spanIdentity(dropped.otelSpan.spanContext())]);
      startObservation("healthy").end();
      expect((await instrumentation.flush()).failedSpanIds.size).toBe(0);
    } finally {
      await instrumentation.shutdown();
    }
  });

  it("does not treat intentionally unsampled spans as failed deliveries", async () => {
    vi.stubEnv("OTEL_TRACES_SAMPLER", "always_off");
    const instrumentation = setupInstrumentation(config);
    try {
      startObservation("not sampled").end();
      expect((await instrumentation.flush()).failedSpanIds.size).toBe(0);
    } finally {
      await instrumentation.shutdown();
    }
  });

  it("rejects a transport failure but resets instrumentation for a subsequent independent batch", async () => {
    const instrumentation = setupInstrumentation(config);
    try {
      state.fail = true;
      startObservation("rejected").end();
      await expect(instrumentation.flush()).rejects.toThrow("export rejected");
      startObservation("healthy").end();
      expect((await instrumentation.flush()).failedSpanIds.size).toBe(0);
    } finally {
      await instrumentation.shutdown();
    }
  });
});
