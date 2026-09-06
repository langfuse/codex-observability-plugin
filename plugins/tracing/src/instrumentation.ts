import { LangfuseSpanProcessor } from "@langfuse/otel";
import { AlwaysOnSampler, ParentBasedSampler } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

import type { Config } from "./config.js";

export type Instrumentation = {
  /** Flush buffered spans and tear down the tracer provider. */
  shutdown: () => Promise<void>;
};

type InstrumentationOptions = {
  /** Whether spans are children of a process-level parent supplied by the launcher. */
  attached?: boolean;
};

/**
 * Configure an isolated OpenTelemetry tracer provider wired to Langfuse.
 *
 * We register a dedicated `NodeTracerProvider` (rather than the full auto-
 * instrumenting `NodeSDK`) so the bundle stays small and free of dynamic
 * instrumentation loading. Registering the provider also installs the
 * AsyncLocalStorage context manager that `propagateAttributes` relies on.
 *
 * We use `exportMode: "batched"` and flush once at the end: the whole rollout
 * is converted in-process, so batching every span into one (or a few) requests
 * is far faster than one request per span — important for the hook's timeout
 * budget. `shutdown()` below calls `forceFlush()` before the process exits.
 */
export function setupInstrumentation(
  config: Config,
  options: InstrumentationOptions = {},
): Instrumentation {
  const spanProcessor = new LangfuseSpanProcessor({
    publicKey: config.public_key,
    secretKey: config.secret_key,
    baseUrl: config.base_url,
    environment: config.environment,
    exportMode: "batched",
    // The hook only creates Langfuse spans, so export every recorded span.
    // Parent-based sampling below decides whether a span is recorded at all.
    shouldExportSpan: () => true,
  });

  const provider = new NodeTracerProvider({
    spanProcessors: [spanProcessor],
    // Attached mode treats the launcher's sampled bit as authoritative.
    // Standalone mode leaves this unset so standard OTEL_TRACES_SAMPLER
    // configuration keeps working exactly as it did before attached mode.
    ...(options.attached
      ? { sampler: new ParentBasedSampler({ root: new AlwaysOnSampler() }) }
      : {}),
  });
  provider.register();

  return {
    shutdown: async () => {
      await spanProcessor.forceFlush();
      await provider.shutdown();
    },
  };
}
