import { createHash, randomBytes } from "node:crypto";

import { LangfuseSpanProcessor } from "@langfuse/otel";
import { setLangfuseTracerProvider } from "@langfuse/tracing";
import { ExportResultCode } from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import type { SpanExporter, SpanProcessor } from "@opentelemetry/sdk-trace-base";
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
  /** Wait for delivery; reject even if an automatic batch failed earlier. */
  flush: () => Promise<void>;
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
 * Batch within turns, with explicit checkpoints to bound the export backlog.
 * Track delivery independently: a background batch can fail before forceFlush,
 * and the SDK can swallow preprocessing errors or discard an overflowing queue.
 * Neither case may cause the hook to mark an undelivered turn uploaded.
 */
export function setupInstrumentation(config: Config): Instrumentation {
  let ended = 0;
  let delivered = 0;
  let exportFailure: Error | undefined;
  const exporter = new OTLPTraceExporter({
    url: `${config.base_url.replace(/\/$/, "")}/api/public/otel/v1/traces`,
    headers: {
      Authorization: `Basic ${Buffer.from(`${config.public_key}:${config.secret_key}`).toString("base64")}`,
      "x-langfuse-public-key": config.public_key ?? "<missing>",
      "x-langfuse-sdk-name": "javascript",
    },
    timeoutMillis: Number(process.env.LANGFUSE_TIMEOUT ?? 5) * 1000,
  });
  const trackedExporter: SpanExporter = {
    export: (spans, callback) => {
      exporter.export(spans, (result) => {
        if (result.code === ExportResultCode.SUCCESS) delivered += spans.length;
        else exportFailure ??= result.error ?? new Error("Span export failed");
        callback(result);
      });
    },
    shutdown: () => exporter.shutdown(),
  };
  const spanProcessor = new LangfuseSpanProcessor({
    exporter: trackedExporter,
    publicKey: config.public_key,
    secretKey: config.secret_key,
    baseUrl: config.base_url,
    environment: config.environment,
    exportMode: "batched",
    shouldExportSpan: () => true,
  });

  const trackedProcessor: SpanProcessor = {
    onStart: (span, context) => spanProcessor.onStart(span, context),
    onEnd: (span) => {
      ended++;
      spanProcessor.onEnd(span);
    },
    forceFlush: () => spanProcessor.forceFlush(),
    shutdown: () => spanProcessor.shutdown(),
  };

  const flush = async () => {
    await spanProcessor.forceFlush();
    if (exportFailure) throw exportFailure;
    if (delivered !== ended) {
      throw new Error(`Incomplete span export: confirmed ${delivered} of ${ended} spans`);
    }
  };

  const provider = new NodeTracerProvider({
    resource: buildResource(),
    spanProcessors: [trackedProcessor],
    idGenerator: {
      generateTraceId: () => seededId("trace"),
      generateSpanId: () => seededId("span"),
    },
  });
  provider.register();

  // Bind explicitly: the global registry can refuse the registration silently.
  setLangfuseTracerProvider(provider);

  return {
    flush,
    shutdown: async () => {
      try {
        await flush();
      } finally {
        try {
          await provider.shutdown();
        } finally {
          setLangfuseTracerProvider(null);
        }
      }
    },
  };
}
