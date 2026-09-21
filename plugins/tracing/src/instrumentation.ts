import { createHash, randomBytes } from "node:crypto";

import { LangfuseSpanProcessor } from "@langfuse/otel";
import { setLangfuseTracerProvider } from "@langfuse/tracing";
import {
  defaultResource,
  detectResources,
  envDetector,
  resourceFromAttributes,
} from "@opentelemetry/resources";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

import type { Config } from "./config.js";

const TRACE_ID_HEX_CHARS = 32;
const SPAN_ID_HEX_CHARS = 16;

let idSeed: string | undefined;
let idCounter = 0;

export function seedIds(seed: string | undefined): void {
  idSeed = seed;
  idCounter = 0;
}

export function currentIdSeed(): string | undefined {
  return idSeed;
}

function seededId(kind: "trace" | "span"): string {
  const hexChars = kind === "trace" ? TRACE_ID_HEX_CHARS : SPAN_ID_HEX_CHARS;
  if (idSeed === undefined) return randomBytes(hexChars / 2).toString("hex");
  return createHash("sha256")
    .update(`${idSeed}:${kind}:${idCounter++}`)
    .digest("hex")
    .slice(0, hexChars);
}

export type Instrumentation = {
  /** Flush buffered spans and tear down the tracer provider. */
  shutdown: () => Promise<void>;
};

const DEFAULT_SERVICE_NAME = "codex";

function buildResource() {
  return defaultResource()
    .merge(resourceFromAttributes({ "service.name": DEFAULT_SERVICE_NAME }))
    .merge(detectResources({ detectors: [envDetector] }));
}

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
export function setupInstrumentation(config: Config): Instrumentation {
  const spanProcessor = new LangfuseSpanProcessor({
    publicKey: config.public_key,
    secretKey: config.secret_key,
    baseUrl: config.base_url,
    environment: config.environment,
    exportMode: "batched",
    shouldExportSpan: () => true,
  });

  const provider = new NodeTracerProvider({
    resource: buildResource(),
    spanProcessors: [spanProcessor],
    idGenerator: {
      generateTraceId: () => seededId("trace"),
      generateSpanId: () => seededId("span"),
    },
  });
  provider.register();

  // Bind explicitly: the global registry can refuse the registration silently.
  setLangfuseTracerProvider(provider);

  return {
    shutdown: async () => {
      await spanProcessor.forceFlush();
      await provider.shutdown();
      setLangfuseTracerProvider(null);
    },
  };
}
