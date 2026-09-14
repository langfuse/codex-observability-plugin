import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { getLangfuseTracerProvider, setLangfuseTracerProvider } from "@langfuse/tracing";
import type { ReadableSpan, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Config } from "../src/config.js";
import { setupInstrumentation } from "../src/instrumentation.js";
import { convertRollout } from "../src/trace.js";

// Capture the spans the plugin's own span processor receives, so the assertion
// needs no network and no Langfuse credentials.
const captured: ReadableSpan[] = [];

vi.mock("@langfuse/otel", () => ({
  LangfuseSpanProcessor: class implements SpanProcessor {
    onStart(): void {}
    onEnd(span: ReadableSpan): void {
      captured.push(span);
    }
    async forceFlush(): Promise<void> {}
    async shutdown(): Promise<void> {}
  },
}));

const OTEL_API_KEY = Symbol.for("opentelemetry.js.api.1");

const baseConfig: Config = {
  enabled: true,
  public_key: "pk-lf-test",
  secret_key: "sk-lf-test",
  base_url: "https://cloud.langfuse.com",
  max_chars: 20_000,
  debug: false,
  fail_on_error: false,
};

const fixturesRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/sessions");

function stageFixtures(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lf-codex-instr-"));
  fs.cpSync(fixturesRoot, path.join(dir, "sessions"), { recursive: true });
  return path.join(dir, "sessions", "2026", "06", "03");
}

/**
 * Put a foreign provider in the OpenTelemetry global registry. The registry
 * then refuses the plugin's own registration, which is what happens when
 * another instrumentation loads first in the hook process.
 */
function occupyGlobalRegistry(): unknown {
  const previous = (globalThis as Record<symbol, unknown>)[OTEL_API_KEY];
  const noopTracer = {
    startSpan: () => {
      throw new Error("span created on the foreign global provider");
    },
    startActiveSpan: () => {
      throw new Error("span created on the foreign global provider");
    },
  };
  (globalThis as Record<symbol, unknown>)[OTEL_API_KEY] = {
    version: "1.9.1",
    trace: { getTracer: () => noopTracer },
  };
  return previous;
}

let previousGlobal: unknown;

beforeEach(() => {
  captured.length = 0;
  previousGlobal = occupyGlobalRegistry();
});

afterEach(() => {
  (globalThis as Record<symbol, unknown>)[OTEL_API_KEY] = previousGlobal;
  setLangfuseTracerProvider(null);
});

describe("setupInstrumentation", () => {
  it("exports spans when the global registry already holds another provider", async () => {
    const instrumentation = setupInstrumentation(baseConfig);
    const dir = stageFixtures();

    await convertRollout(path.join(dir, "rollout-basic-main.jsonl"), { config: baseConfig });
    await instrumentation.shutdown();

    const root = captured.find((s) => s.name === "Codex Turn");
    expect(root, "the turn span never reached the plugin's span processor").toBeDefined();
  });

  it("releases the provider on shutdown", async () => {
    const instrumentation = setupInstrumentation(baseConfig);
    const bound = getLangfuseTracerProvider();

    await instrumentation.shutdown();

    expect(getLangfuseTracerProvider()).not.toBe(bound);
  });
});
