import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { LangfuseAPIClient } from "@langfuse/core";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { startObservation } from "@langfuse/tracing";
import { AlwaysOnSampler } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { expect, it, vi } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const bundle = path.join(repoRoot, "plugins/tracing/dist/index.mjs");
const fixture = path.join(
  repoRoot,
  "plugins/tracing/test/fixtures/sessions/2026/06/03/rollout-basic-main.jsonl",
);

function getCredentials(): { publicKey: string; secretKey: string; baseUrl: string } {
  const publicKey = process.env.LANGFUSE_CODEX_PUBLIC_KEY ?? process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_CODEX_SECRET_KEY ?? process.env.LANGFUSE_SECRET_KEY;
  const baseUrl =
    process.env.LANGFUSE_CODEX_BASE_URL ??
    process.env.LANGFUSE_BASE_URL ??
    "https://cloud.langfuse.com";

  if (!publicKey || !secretKey) {
    throw new Error(
      "test:e2e requires LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY (or their LANGFUSE_CODEX_* variants)",
    );
  }
  // Validate before either process attempts to export.
  new URL(baseUrl);
  return { publicKey, secretKey, baseUrl };
}

/** Copy the fixture with current timestamps so backend retention filters include it. */
function stageFixture(tempDir: string): string {
  const lines = fs
    .readFileSync(fixture, "utf-8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { timestamp: string; [key: string]: unknown });
  const firstTimestamp = Date.parse(lines[0].timestamp);
  const stagedStart = Date.now() - 10_000;

  for (const line of lines) {
    line.timestamp = new Date(
      stagedStart + Date.parse(line.timestamp) - firstTimestamp,
    ).toISOString();
  }

  const transcript = path.join(tempDir, "rollout-e2e.jsonl");
  fs.writeFileSync(transcript, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  return transcript;
}

it("joins a real Master span and bundled Codex observations in Langfuse", async ({
  onTestFinished,
}) => {
  const credentials = getCredentials();
  const api = new LangfuseAPIClient({
    environment: credentials.baseUrl,
    username: credentials.publicKey,
    password: credentials.secretKey,
  });
  const requestOptions = { timeoutInSeconds: 10, maxRetries: 0 };
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lf-codex-attached-e2e-"));
  onTestFinished(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const transcript = stageFixture(tempDir);
  const processor = new LangfuseSpanProcessor({
    ...credentials,
    environment: "codex-plugin-e2e",
    shouldExportSpan: () => true,
  });
  const provider = new NodeTracerProvider({
    spanProcessors: [processor],
    sampler: new AlwaysOnSampler(),
  });
  provider.register();

  const master = startObservation(
    "Master Agent Run",
    { metadata: { "e2e.source": "codex-observability-plugin" } },
    { asType: "agent", startTime: new Date(Date.now() - 15_000) },
  );
  const { traceId, spanId } = master.otelSpan.spanContext();
  master.end();
  onTestFinished(async () => {
    try {
      await provider.shutdown();
    } finally {
      await api.trace.delete(traceId, requestOptions);
    }
  });
  await processor.forceFlush();

  const hook = spawnSync(process.execPath, [bundle], {
    cwd: repoRoot,
    input: JSON.stringify({ hook_event_name: "Stop", transcript_path: transcript }),
    encoding: "utf-8",
    timeout: 45_000,
    env: {
      ...process.env,
      CODEX_HOME: tempDir,
      TRACE_TO_LANGFUSE: "true",
      LANGFUSE_CODEX_PUBLIC_KEY: credentials.publicKey,
      LANGFUSE_CODEX_SECRET_KEY: credentials.secretKey,
      LANGFUSE_CODEX_BASE_URL: credentials.baseUrl,
      LANGFUSE_CODEX_ENVIRONMENT: "codex-plugin-e2e",
      LANGFUSE_CODEX_TRACEPARENT: `00-${traceId}-${spanId}-01`,
      LANGFUSE_CODEX_FAIL_ON_ERROR: "true",
      OTEL_TRACES_SAMPLER: "always_off",
    },
  });
  if (hook.error) throw hook.error;
  expect(hook.status, hook.stderr).toBe(0);

  const observations = await vi.waitUntil(
    async () => {
      const { data } = await api.legacy.observationsV1.getMany(
        { traceId, limit: 100 },
        requestOptions,
      );
      return data.length >= 5 && data; // Master, Codex turn, two generations, and tool.
    },
    { timeout: 60_000, interval: 1_000 },
  );
  const masterObservation = observations.find((observation) => observation.id === master.id)!;
  const codexTurn = observations.find((observation) => observation.name === "Codex Turn")!;
  const generations = observations.filter((observation) => observation.name === "LLM");
  const tool = observations.find((observation) => observation.name === "exec_command")!;

  expect(masterObservation.type).toBe("AGENT");
  expect(masterObservation.parentObservationId).toBeNull();
  expect(codexTurn.type).toBe("AGENT");
  expect(codexTurn.parentObservationId).toBe(master.id);
  expect(generations).toHaveLength(2);
  expect(generations.every((generation) => generation.type === "GENERATION")).toBe(true);
  expect(generations.every((generation) => generation.parentObservationId === codexTurn.id)).toBe(
    true,
  );
  expect(tool.type).toBe("TOOL");
  expect(generations.map((generation) => generation.id)).toContain(tool.parentObservationId);
  expect(observations.every((observation) => observation.traceId === traceId)).toBe(true);
});
