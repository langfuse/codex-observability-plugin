import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Config } from "../src/config.js";
import { convertRollout } from "../src/trace.js";

const exporter = new InMemorySpanExporter();
let provider: NodeTracerProvider;

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

/** Copy the fixture session tree to a fresh temp dir (isolates sidecar writes). */
function stageFixtures(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lf-codex-trace-"));
  fs.cpSync(fixturesRoot, path.join(dir, "sessions"), { recursive: true });
  return path.join(dir, "sessions", "2026", "06", "03");
}

/**
 * The derivation external systems use to precompute a seeded trace id —
 * intentionally independent of the Langfuse SDK helper the plugin calls.
 */
const seededTraceId = (seed: string): string =>
  createHash("sha256").update(seed).digest("hex").slice(0, 32);

const attr = (span: ReadableSpan, key: string): string =>
  span.attributes[key] == null ? "" : String(span.attributes[key]);
const obsType = (span: ReadableSpan): string => attr(span, "langfuse.observation.type");
const startMs = (span: ReadableSpan): number => span.startTime[0] * 1000 + span.startTime[1] / 1e6;
const parentId = (span: ReadableSpan): string | undefined =>
  (span as unknown as { parentSpanContext?: { spanId?: string } }).parentSpanContext?.spanId ??
  (span as unknown as { parentSpanId?: string }).parentSpanId;

beforeAll(() => {
  provider = new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  provider.register();
});

afterAll(async () => {
  await provider.shutdown();
});

beforeEach(() => {
  exporter.reset();
});

describe("convertRollout", () => {
  it("emits an agent → generation → tool tree with backdated timestamps", async () => {
    const dir = stageFixtures();
    await convertRollout(path.join(dir, "rollout-basic-main.jsonl"), { config: baseConfig });

    const spans = exporter.getFinishedSpans();
    const root = spans.find((s) => s.name === "Codex Turn");
    expect(root, "expected a 'Codex Turn' root span").toBeDefined();
    expect(obsType(root!)).toBe("agent");
    expect(parentId(root!)).toBeUndefined(); // top-level turn = its own trace
    expect(attr(root!, "langfuse.observation.input")).toContain("List the files");
    expect(attr(root!, "langfuse.observation.output")).toContain("two files");

    // Backdated to the turn's task_started timestamp.
    expect(startMs(root!)).toBe(Date.parse("2026-06-03T10:00:01.000Z"));

    // Two generations, both children of the root, named "LLM" (the model name
    // lives in the model attribute, not the observation name).
    const generations = spans.filter((s) => obsType(s) === "generation");
    expect(generations).toHaveLength(2);
    for (const gen of generations) {
      expect(gen.name).toBe("LLM");
      expect(parentId(gen)).toBe(root!.spanContext().spanId);
      expect(attr(gen, "langfuse.observation.model.name")).toBe("gpt-5.4");
    }
    // Usage buckets must be mutually exclusive for Langfuse cost inference.
    const usageDetails = generations.map(
      (g) => JSON.parse(attr(g, "langfuse.observation.usage_details")) as Record<string, number>,
    );
    expect(usageDetails).toContainEqual({
      input: 100,
      output: 15,
      output_reasoning_tokens: 5,
      total: 120,
    });
    expect(usageDetails).toContainEqual({
      input: 100,
      cache_read_input_tokens: 50,
      output: 30,
      total: 180,
    });

    // One tool span, nested under a generation, with the captured command output.
    const tools = spans.filter((s) => obsType(s) === "tool");
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("exec_command");
    expect(attr(tools[0], "langfuse.observation.metadata.codex.tool_name")).toBe("exec_command");
    expect(attr(tools[0], "langfuse.observation.output")).toContain("file1.txt");
    expect(generations.map((g) => g.spanContext().spanId)).toContain(parentId(tools[0]));
  });

  it("nests subagent turns under the spawning turn and marks errors/interruptions", async () => {
    const dir = stageFixtures();
    await convertRollout(path.join(dir, "rollout-parent.jsonl"), { config: baseConfig });

    const spans = exporter.getFinishedSpans();
    const parent = spans.find((s) => s.name === "Codex Turn" && obsType(s) === "agent");
    const child = spans.find((s) => s.name === "Codex Subagent Turn" && obsType(s) === "agent");
    expect(parent).toBeDefined();
    expect(child).toBeDefined();
    expect(parentId(parent!)).toBeUndefined();
    expect(parentId(child!)).toBeDefined();

    // The subagent turn is nested somewhere under the parent's trace.
    expect(child!.spanContext().traceId).toBe(parent!.spanContext().traceId);
    expect(attr(child!, "langfuse.observation.input")).toContain("tell a joke");

    // Subagent generations are distinguishable from main-thread ones.
    const childGeneration = spans.find(
      (s) => obsType(s) === "generation" && parentId(s) === child!.spanContext().spanId,
    );
    expect(childGeneration?.name).toBe("LLM Subagent");

    // Aborted turn is flagged on the parent root.
    expect(attr(parent!, "langfuse.observation.level")).toBe("WARNING");

    // The failing exec is recorded as an ERROR-level tool span.
    const failedTool = spans.find(
      (s) => obsType(s) === "tool" && attr(s, "langfuse.observation.level") === "ERROR",
    );
    expect(failedTool, "expected a failed tool span").toBeDefined();
    expect(attr(failedTool!, "langfuse.observation.status_message")).toContain("command failed");
  });

  it("captures web search, local shell, and MCP tool calls with specific names", async () => {
    const dir = stageFixtures();
    await convertRollout(path.join(dir, "rollout-tools-main.jsonl"), { config: baseConfig });

    const spans = exporter.getFinishedSpans();
    const toolNames = spans
      .filter((s) => obsType(s) === "tool")
      .map((s) => s.name)
      .sort();
    // Call arguments (command, query) stay out of the name — they are the input.
    expect(toolNames).toEqual(["linear.create_issue", "local_shell", "web_search"]);

    const webSearch = spans.find((s) => s.name === "web_search")!;
    expect(attr(webSearch, "langfuse.observation.input")).toContain("langfuse codex plugin");

    const shell = spans.find((s) => s.name === "local_shell")!;
    expect(attr(shell, "langfuse.observation.output")).toContain("clean");
  });

  it("skips turns already recorded in the sidecar (dedup)", async () => {
    const dir = stageFixtures();
    const file = path.join(dir, "rollout-basic-main.jsonl");

    await convertRollout(file, { config: baseConfig });
    const firstCount = exporter.getFinishedSpans().length;
    expect(firstCount).toBeGreaterThan(0);
    expect(fs.existsSync(`${file}.langfuse`)).toBe(true);

    exporter.reset();
    await convertRollout(file, { config: baseConfig });
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });
});

describe("deterministic trace ids (trace_seed)", () => {
  const seed = "ci-run-42";
  const seededConfig: Config = { ...baseConfig, trace_seed: seed };

  const turnRoots = () =>
    exporter
      .getFinishedSpans()
      .filter((s) => s.name === "Codex Turn" || s.name === "Codex Subagent Turn")
      .sort((a, b) => startMs(a) - startMs(b));

  it("derives the N-th main-thread turn's trace id from `${seed}:${N}`", async () => {
    const dir = stageFixtures();
    await convertRollout(path.join(dir, "rollout-two-turns-main.jsonl"), {
      config: seededConfig,
    });

    const roots = turnRoots();
    expect(roots).toHaveLength(2);
    expect(roots[0].spanContext().traceId).toBe(seededTraceId(`${seed}:1`));
    expect(roots[1].spanContext().traceId).toBe(seededTraceId(`${seed}:2`));

    // Every span (generations included) lands in one of the two seeded traces.
    const traceIds = new Set(exporter.getFinishedSpans().map((s) => s.spanContext().traceId));
    expect([...traceIds].sort()).toEqual(
      [seededTraceId(`${seed}:1`), seededTraceId(`${seed}:2`)].sort(),
    );
  });

  it("keeps generations and tool spans in the seeded trace", async () => {
    const dir = stageFixtures();
    await convertRollout(path.join(dir, "rollout-basic-main.jsonl"), { config: seededConfig });

    const spans = exporter.getFinishedSpans();
    const expected = seededTraceId(`${seed}:1`);
    expect(spans.length).toBeGreaterThan(2); // root + generations + tool
    for (const span of spans) {
      expect(span.spanContext().traceId).toBe(expected);
    }
    // Structure is unchanged: root agent span with its generations beneath it.
    const root = spans.find((s) => s.name === "Codex Turn")!;
    expect(obsType(root)).toBe("agent");
    const generations = spans.filter((s) => obsType(s) === "generation");
    expect(generations).toHaveLength(2);
    for (const gen of generations) {
      expect(parentId(gen)).toBe(root.spanContext().spanId);
    }
  });

  it("scopes subagent-thread rollouts by thread id so they don't collide", async () => {
    const dir = stageFixtures();
    await convertRollout(path.join(dir, "rollout-child-thread-child.jsonl"), {
      config: seededConfig,
    });

    const roots = turnRoots();
    expect(roots).toHaveLength(1);
    expect(roots[0].spanContext().traceId).toBe(seededTraceId(`${seed}:thread-child:1`));
    expect(roots[0].spanContext().traceId).not.toBe(seededTraceId(`${seed}:1`));
  });

  it("nests subagent turns inside the parent's seeded trace", async () => {
    const dir = stageFixtures();
    await convertRollout(path.join(dir, "rollout-parent.jsonl"), { config: seededConfig });

    const roots = turnRoots();
    expect(roots).toHaveLength(2); // parent turn + nested subagent turn
    const expected = seededTraceId(`${seed}:1`);
    for (const root of roots) {
      expect(root.spanContext().traceId).toBe(expected);
    }
  });

  it("leaves trace ids auto-generated when the seed is unset", async () => {
    const dir = stageFixtures();
    await convertRollout(path.join(dir, "rollout-two-turns-main.jsonl"), { config: baseConfig });

    const roots = turnRoots();
    expect(roots).toHaveLength(2);
    for (const root of roots) {
      // Same shape as before the feature: true root span, random trace id.
      expect(parentId(root)).toBeUndefined();
      expect(root.spanContext().traceId).not.toBe(seededTraceId(`${seed}:1`));
      expect(root.spanContext().traceId).not.toBe(seededTraceId(`${seed}:2`));
    }
    expect(roots[0].spanContext().traceId).not.toBe(roots[1].spanContext().traceId);
  });

  it("keeps sidecar dedup working when a seed is set", async () => {
    const dir = stageFixtures();
    const file = path.join(dir, "rollout-two-turns-main.jsonl");

    await convertRollout(file, { config: seededConfig });
    expect(turnRoots()).toHaveLength(2);
    expect(fs.existsSync(`${file}.langfuse`)).toBe(true);

    exporter.reset();
    await convertRollout(file, { config: seededConfig });
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });

  it("numbers turns over the full rollout even when earlier turns are deduped", async () => {
    const dir = stageFixtures();
    const file = path.join(dir, "rollout-two-turns-main.jsonl");

    // Pretend turn 1 was uploaded by a previous hook invocation.
    fs.writeFileSync(`${file}.langfuse`, "turn-a\n");
    await convertRollout(file, { config: seededConfig });

    const roots = turnRoots();
    expect(roots).toHaveLength(1);
    expect(roots[0].spanContext().traceId).toBe(seededTraceId(`${seed}:2`));
  });
});
