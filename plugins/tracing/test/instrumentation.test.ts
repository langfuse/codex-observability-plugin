import { context, trace, TraceFlags, type SpanContext } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Config } from "../src/config.js";
import { setupInstrumentation } from "../src/instrumentation.js";

const { finishedSpans } = vi.hoisted(() => ({ finishedSpans: [] as ReadableSpan[] }));

vi.mock("@langfuse/otel", () => ({
  LangfuseSpanProcessor: class {
    onStart(): void {}
    onEnd(span: ReadableSpan): void {
      finishedSpans.push(span);
    }
    async forceFlush(): Promise<void> {}
    async shutdown(): Promise<void> {}
  },
}));

const config: Config = {
  enabled: true,
  public_key: "pk-lf-test",
  secret_key: "sk-lf-test",
  base_url: "https://cloud.langfuse.com",
  max_chars: 20_000,
  debug: false,
  fail_on_error: false,
};

const parent = (traceFlags: TraceFlags): SpanContext => ({
  traceId: "0af7651916cd43dd8448eb211c80319c",
  spanId: "b7ad6b7169203331",
  traceFlags,
  isRemote: true,
});

afterEach(() => {
  vi.unstubAllEnvs();
  finishedSpans.length = 0;
  context.disable();
  trace.disable();
});

describe("setupInstrumentation", () => {
  it("makes the attached parent's sampled flag authoritative", async () => {
    vi.stubEnv("OTEL_TRACES_SAMPLER", "always_off");
    const instrumentation = setupInstrumentation(config, { attached: true });
    const { startObservation } = await import("@langfuse/tracing");

    for (const flag of [TraceFlags.SAMPLED, TraceFlags.NONE]) {
      startObservation(
        String(flag),
        {},
        { asType: "agent", parentSpanContext: parent(flag) },
      ).end();
    }

    expect(finishedSpans.map((span) => span.name)).toEqual([String(TraceFlags.SAMPLED)]);
    await instrumentation.shutdown();
  });

  it("preserves OTEL_TRACES_SAMPLER behavior in standalone mode", async () => {
    vi.stubEnv("OTEL_TRACES_SAMPLER", "always_off");
    const instrumentation = setupInstrumentation(config);
    const { startObservation } = await import("@langfuse/tracing");

    startObservation("standalone", {}, { asType: "agent" }).end();

    expect(finishedSpans).toHaveLength(0);
    await instrumentation.shutdown();
  });
});
