import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { LangfuseSpanProcessor } from "@langfuse/otel";
import { TraceFlags, type SpanContext } from "@opentelemetry/api";
import { InMemorySpanExporter, type ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Config } from "../src/config.js";
import { convertRollout } from "../src/trace.js";

const EXTERNAL_TRACE_ID = "0af7651916cd43dd8448eb211c80319c";
const EXTERNAL_SPAN_ID = "b7ad6b7169203331";

const parentSpanContext: SpanContext = {
  traceId: EXTERNAL_TRACE_ID,
  spanId: EXTERNAL_SPAN_ID,
  traceFlags: TraceFlags.SAMPLED,
  isRemote: true,
};

const baseConfig: Config = {
  enabled: true,
  public_key: "pk-lf-test",
  secret_key: "sk-lf-test",
  base_url: "https://cloud.langfuse.com",
  skill_tags: true,
  debug: false,
  fail_on_error: false,
};

const fixturesRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/sessions");

function stageFixtures(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lf-codex-own-"));
  fs.cpSync(fixturesRoot, path.join(dir, "sessions"), { recursive: true });
  return path.join(dir, "sessions", "2026", "06", "03");
}

const exporter = new InMemorySpanExporter();
let processor: LangfuseSpanProcessor;
let provider: NodeTracerProvider;

beforeAll(() => {
  processor = new LangfuseSpanProcessor({
    publicKey: baseConfig.public_key,
    secretKey: baseConfig.secret_key,
    baseUrl: baseConfig.base_url,
    exportMode: "immediate",
    exporter,
    shouldExportSpan: () => true,
  });
  provider = new NodeTracerProvider({ spanProcessors: [processor] });
  provider.register();
});

afterAll(async () => {
  await provider.shutdown();
});

beforeEach(() => {
  exporter.reset();
});

const turnRoot = async (): Promise<ReadableSpan> => {
  await processor.forceFlush();
  const root = exporter
    .getFinishedSpans()
    .find((s) => s.name === "Codex Turn" || s.name === "Codex Subagent Turn");
  expect(root).toBeDefined();
  return root!;
};

const traceLevelKeys = (span: ReadableSpan): string[] =>
  Object.keys(span.attributes)
    .filter((k) => k.startsWith("langfuse.trace.") || k === "session.id" || k === "user.id")
    .sort();

describe("trace ownership in attached mode", () => {
  const config: Config = {
    ...baseConfig,
    user_id: "operator",
    tags: ["codex"],
    metadata: { run: "ci" },
  };

  it("does not claim the application's trace as a Codex app root", async () => {
    const dir = stageFixtures();
    await convertRollout(path.join(dir, "rollout-basic-main.jsonl"), {
      config,
      parentSpanContext,
    });

    const root = await turnRoot();
    expect(root.spanContext().traceId).toBe(EXTERNAL_TRACE_ID);
    expect(root.attributes["langfuse.internal.is_app_root"]).toBe(false);
  });

  it("leaves trace-level name, user, tags, and metadata to the application", async () => {
    const dir = stageFixtures();
    await convertRollout(path.join(dir, "rollout-basic-main.jsonl"), {
      config,
      parentSpanContext,
    });

    expect(traceLevelKeys(await turnRoot())).toEqual([]);
  });

  it("still owns the trace root and its attributes in standalone mode", async () => {
    const dir = stageFixtures();
    await convertRollout(path.join(dir, "rollout-basic-main.jsonl"), { config });

    const root = await turnRoot();
    expect(root.attributes["langfuse.internal.is_app_root"]).toBe(true);
    expect(root.attributes["langfuse.trace.name"]).toBe("Codex Turn");
    expect(root.attributes["langfuse.trace.tags"]).toEqual(["codex"]);
    expect(root.attributes["langfuse.trace.metadata.run"]).toBe("ci");
    expect(root.attributes["user.id"]).toBe("operator");
    expect(root.attributes["session.id"]).toBe("sess-basic");
  });
});
