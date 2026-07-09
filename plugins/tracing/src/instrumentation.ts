import { LangfuseSpanProcessor } from "@langfuse/otel";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

import type { Config } from "./config.js";

export type Instrumentation = {
  /** Flush buffered spans and tear down the tracer provider. */
  shutdown: () => Promise<void>;
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
 *
 * Resource attributes: honor `OTEL_SERVICE_NAME` / `OTEL_RESOURCE_ATTRIBUTES`
 * when set (same contract as the Claude Code Python plugin), with a stable
 * default of `service.name=codex` so traces do not land as `unknown_service:node`.
 */
function buildResource(config: Config) {
  const serviceName = process.env.OTEL_SERVICE_NAME?.trim() || "codex";

  const attrs: Record<string, string> = {
    "service.name": serviceName,
  };

  // Merge OTEL_RESOURCE_ATTRIBUTES (comma-separated key=value) if present.
  const raw = process.env.OTEL_RESOURCE_ATTRIBUTES?.trim();
  if (raw) {
    for (const part of raw.split(",")) {
      const idx = part.indexOf("=");
      if (idx <= 0) continue;
      const k = part.slice(0, idx).trim();
      const v = part.slice(idx + 1).trim();
      if (k) attrs[k] = v;
    }
  }

  // Map Langfuse plugin environment → deployment.environment.name when not set.
  if (!attrs["deployment.environment.name"] && config.environment) {
    attrs["deployment.environment.name"] = config.environment;
  }

  return resourceFromAttributes(attrs);
}

export function setupInstrumentation(config: Config): Instrumentation {
  const spanProcessor = new LangfuseSpanProcessor({
    publicKey: config.public_key,
    secretKey: config.secret_key,
    baseUrl: config.base_url,
    environment: config.environment,
    exportMode: "batched",
    // The hook only ever creates Langfuse spans, so export all of them.
    shouldExportSpan: () => true,
  });

  const provider = new NodeTracerProvider({
    resource: buildResource(config),
    spanProcessors: [spanProcessor],
  });
  provider.register();

  return {
    shutdown: async () => {
      await spanProcessor.forceFlush();
      await provider.shutdown();
    },
  };
}
