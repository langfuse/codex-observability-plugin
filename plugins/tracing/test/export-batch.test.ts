import type { LangfuseObservation } from "@langfuse/tracing";
import { describe, expect, it, vi } from "vitest";

import { ExportBatch } from "../src/export-batch.js";
import { spanIdentity } from "../src/instrumentation.js";

function observation(id: number, bytes = 0): LangfuseObservation {
  return {
    otelSpan: {
      spanContext: () => ({
        traceId: "a".repeat(32),
        spanId: id.toString(16).padStart(16, "0"),
        traceFlags: 1,
      }),
      attributes: { output: "x".repeat(bytes) },
    },
  } as unknown as LangfuseObservation;
}

describe("bounded delivery batches", () => {
  it("isolates a dropped span to its own turn and does not poison later batches", async () => {
    const missing = spanIdentity(observation(2).otelSpan.spanContext());
    let first = true;
    const batch = new ExportBatch(async () => {
      const failedSpanIds = new Set(first ? [missing] : []);
      first = false;
      return { failedSpanIds };
    });
    const checkpoint = vi.fn(async (_id: string) => {});
    for (const n of [1, 2, 3]) {
      const spanIds = new Set<string>();
      await batch.ended(observation(n), spanIds);
      batch.complete({ id: `turn-${n}`, spanIds, success: true, checkpoint });
    }
    await batch.flush();
    expect(checkpoint.mock.calls.map((call) => call[0])).toEqual(["turn-1", "turn-3"]);
    const spanIds = new Set<string>();
    await batch.ended(observation(4), spanIds);
    batch.complete({ id: "turn-4", spanIds, success: true, checkpoint });
    await batch.flush();
    expect(checkpoint).toHaveBeenLastCalledWith("turn-4");
  });

  it("remembers failures across intermediate flushes until an open turn completes", async () => {
    const missing = spanIdentity(observation(1).otelSpan.spanContext());
    let first = true;
    const batch = new ExportBatch(async () => {
      const failedSpanIds = new Set(first ? [missing] : []);
      first = false;
      return { failedSpanIds };
    });
    const spanIds = new Set<string>();
    for (let n = 1; n <= 64; n++) await batch.ended(observation(n), spanIds);
    const checkpoint = vi.fn(async (_id: string) => {});
    batch.complete({ id: "large-turn", spanIds, success: true, checkpoint });
    await batch.flush();
    expect(checkpoint).not.toHaveBeenCalled();
    expect(batch.incomplete).toBe(true);
  });

  it("flushes by bytes as well as by count", async () => {
    const deliver = vi.fn(async () => ({ failedSpanIds: new Set<string>() }));
    const batch = new ExportBatch(deliver);
    await batch.ended(observation(1, 3 * 1024 * 1024), new Set());
    expect(deliver).not.toHaveBeenCalled();
    await batch.ended(observation(2, 3 * 1024 * 1024), new Set());
    expect(deliver).toHaveBeenCalledOnce();
  });

  it("cannot checkpoint a rejected batch after a later empty flush", async () => {
    const deliver = vi.fn(async () => {
      throw new Error("network failed");
    });
    const batch = new ExportBatch(deliver);
    const checkpoint = vi.fn(async (_id: string) => {});
    const spanIds = new Set<string>();
    await batch.ended(observation(1), spanIds);
    batch.complete({ id: "rejected", spanIds, success: true, checkpoint });
    await expect(batch.flush()).rejects.toThrow("network failed");
    await expect(batch.flush()).rejects.toThrow("network failed");
    expect(deliver).toHaveBeenCalledOnce();
    expect(checkpoint).not.toHaveBeenCalled();
  });
});
