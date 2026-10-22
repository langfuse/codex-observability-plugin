import type { LangfuseObservation } from "@langfuse/tracing";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";

import { spanIdentity, type ExportReceipt } from "./instrumentation.js";
import { debugLog } from "./utils.js";

type PendingTurn = {
  id: string;
  spanIds: Set<string>;
  success: boolean;
  checkpoint: (id: string) => Promise<void>;
};

/** Bound the queue across turns; acknowledge only complete, delivered turns. */
export class ExportBatch {
  private spans = 0;
  private bytes = 0;
  private turns: PendingTurn[] = [];
  private failedSpanIds = new Set<string>();
  private transportFailure: Error | undefined;
  incomplete = false;

  constructor(private deliver?: () => Promise<ExportReceipt | void>) {}

  async ended(observation: LangfuseObservation, spanIds: Set<string>): Promise<void> {
    spanIds.add(spanIdentity(observation.otelSpan.spanContext()));
    this.spans++;
    const { attributes } = observation.otelSpan as unknown as Pick<ReadableSpan, "attributes">;
    this.bytes += Buffer.byteLength(JSON.stringify(attributes ?? {}));
    if (this.spans >= 32 || this.bytes >= 4 * 1024 * 1024) await this.flush();
  }

  complete(turn: PendingTurn): void {
    this.turns.push(turn);
  }

  async flush(): Promise<void> {
    // A transport failure invalidates this entire unacknowledged batch. Never
    // let a later empty flush acknowledge spans that its exporter discarded.
    if (this.transportFailure) throw this.transportFailure;
    let receipt: ExportReceipt | void;
    try {
      receipt = await this.deliver?.();
    } catch (error) {
      this.transportFailure = error instanceof Error ? error : new Error(String(error));
      throw this.transportFailure;
    }
    for (const id of receipt?.failedSpanIds ?? []) this.failedSpanIds.add(id);
    this.spans = 0;
    this.bytes = 0;
    const turns = this.turns;
    this.turns = [];
    for (const turn of turns) {
      const missing = [...turn.spanIds].some((id) => this.failedSpanIds.has(id));
      for (const id of turn.spanIds) this.failedSpanIds.delete(id);
      if (turn.success && !missing) await turn.checkpoint(turn.id);
      else {
        this.incomplete = true;
        debugLog(`turn ${turn.id} was not completely delivered; leaving it retryable`);
      }
    }
    // Failures for a still-open parent/current turn remain until it completes.
  }
}
