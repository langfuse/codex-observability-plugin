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
import { markTurnUploaded } from "../src/sidecar.js";
import { buildSubagentIndex, convertRollout } from "../src/trace.js";

const exporter = new InMemorySpanExporter();
let provider: NodeTracerProvider;

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

async function convertAndMark(
  file: string,
  options: { config: Config; stoppedTurnId?: string },
): Promise<string[]> {
  const exported = await convertRollout(file, options);
  for (const turnId of exported) await markTurnUploaded(file, turnId);
  return exported;
}

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
    expect(attr(root!, "langfuse.observation.metadata.codex.reasoning_effort")).toBe("medium");

    // Backdated to the turn's task_started timestamp.
    expect(startMs(root!)).toBe(Date.parse("2026-06-03T10:00:01.000Z"));

    // Two generations, both children of the root, named "LLM" (the model name
    // lives in the model attribute, not the observation name).
    const generations = spans
      .filter((s) => obsType(s) === "generation")
      .sort((a, b) => startMs(a) - startMs(b));
    expect(generations).toHaveLength(2);
    for (const gen of generations) {
      expect(gen.name).toBe("LLM");
      expect(parentId(gen)).toBe(root!.spanContext().spanId);
      expect(attr(gen, "langfuse.observation.model.name")).toBe("gpt-5.4");
      expect(attr(gen, "langfuse.observation.model.parameters")).toBe(
        JSON.stringify({ reasoning_effort: "medium" }),
      );
      expect(attr(gen, "langfuse.observation.metadata.codex.reasoning_effort")).toBe("medium");
    }
    // Usage is sent in Langfuse's OpenAI-compatible shape. Langfuse then
    // normalizes the inclusive parent counts and nested detail counts.
    const usages = generations.map((generation) => {
      const usage = attr(generation, "langfuse.observation.usage_details");
      expect(usage, "expected generation usage details").not.toBe("");
      return JSON.parse(usage);
    });
    expect(usages).toEqual([
      {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        prompt_tokens_details: { cached_tokens: 0 },
        completion_tokens_details: { reasoning_tokens: 5 },
      },
      {
        prompt_tokens: 150,
        completion_tokens: 30,
        total_tokens: 180,
        prompt_tokens_details: { cached_tokens: 50 },
        completion_tokens_details: { reasoning_tokens: 0 },
      },
    ]);
    // One tool span, nested under a generation, with the captured command output.
    const tools = spans.filter((s) => obsType(s) === "tool");
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("exec_command");
    expect(attr(tools[0], "langfuse.observation.metadata.codex.tool_name")).toBe("exec_command");
    expect(attr(tools[0], "langfuse.observation.output")).toContain("file1.txt");
    expect(generations.map((g) => g.spanContext().spanId)).toContain(parentId(tools[0]));
  });

  it("gives each generation the conversation up to that call", async () => {
    const dir = stageFixtures();
    await convertRollout(path.join(dir, "rollout-basic-main.jsonl"), { config: baseConfig });

    const spans = exporter.getFinishedSpans();
    expect(spans.find((s) => s.name === "system_prompt")).toBeUndefined();

    const generations = spans
      .filter((s) => obsType(s) === "generation")
      .sort((a, b) => startMs(a) - startMs(b));
    expect(generations).toHaveLength(2);

    const INSTRUCTIONS = "You are Codex.\n\n<environment_context>cwd=/repo</environment_context>";
    const SYSTEM = { role: "system", content: INSTRUCTIONS };
    const USER = { role: "user", content: "List the files in the repo" };

    expect(JSON.parse(attr(generations[0], "langfuse.observation.input"))).toEqual([SYSTEM, USER]);

    expect(JSON.parse(attr(generations[1], "langfuse.observation.input"))).toEqual([
      SYSTEM,
      USER,
      {
        role: "assistant",
        thinking: [{ type: "thinking", content: "I'll list files with ls." }],
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "exec_command", arguments: '{"command":["ls"]}' },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call-1",
        name: "exec_command",
        content: "file1.txt\nfile2.txt",
      },
    ]);

    const root = spans.find((s) => s.name === "Codex Turn");
    const meta = (key: string): string =>
      attr(root!, `langfuse.observation.metadata.codex.system_prompt.${key}`);
    expect(meta("total_chars")).toBe("66");
    expect(meta("developer_message_count")).toBe("1");
    expect(meta("changed_this_turn")).toBe("true");
  });

  it("carries earlier turns of the thread into a later turn's generation input", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lf-codex-hist-"));
    const day = path.join(dir, "sessions", "2026", "06", "03");
    fs.mkdirSync(day, { recursive: true });
    const file = path.join(day, "rollout-history.jsonl");
    const ts = (n: number): string => `2026-06-03T09:00:${String(n).padStart(2, "0")}.000Z`;
    const turn = (n: number, id: string, prompt: string, answer: string): unknown[] => [
      { timestamp: ts(n), type: "event_msg", payload: { type: "task_started", turn_id: id } },
      { timestamp: ts(n), type: "event_msg", payload: { type: "user_message", message: prompt } },
      {
        timestamp: ts(n + 1),
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: answer }],
        },
      },
      { timestamp: ts(n + 1), type: "event_msg", payload: { type: "token_count", info: {} } },
      { timestamp: ts(n + 2), type: "event_msg", payload: { type: "task_complete", turn_id: id } },
    ];
    fs.writeFileSync(
      file,
      [
        { timestamp: ts(0), type: "session_meta", payload: { id: "sess-hist" } },
        ...turn(1, "t1", "First question", "First answer"),
        ...turn(4, "t2", "Second question", "Second answer"),
      ]
        .map((l) => JSON.stringify(l))
        .join("\n"),
    );

    await convertAndMark(file, { config: baseConfig, stoppedTurnId: "t2" });

    const generations = exporter
      .getFinishedSpans()
      .filter((s) => obsType(s) === "generation")
      .sort((a, b) => startMs(a) - startMs(b));
    expect(generations).toHaveLength(2);

    expect(JSON.parse(attr(generations[0], "langfuse.observation.input"))).toEqual([
      { role: "user", content: "First question" },
    ]);

    expect(JSON.parse(attr(generations[1], "langfuse.observation.input"))).toEqual([
      { role: "user", content: "First question" },
      { role: "assistant", content: "First answer" },
      { role: "user", content: "Second question" },
    ]);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("sends attached images as multimodal content and the loaded tools on the call", async () => {
    const URI = "data:image/png;base64,iVBORw0KGgo=";
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lf-codex-media-"));
    const day = path.join(dir, "sessions", "2026", "06", "03");
    fs.mkdirSync(day, { recursive: true });
    const file = path.join(day, "rollout-media.jsonl");
    const ts = (n: number): string => `2026-06-03T19:00:0${n}.000Z`;
    fs.writeFileSync(
      file,
      [
        { timestamp: ts(0), type: "session_meta", payload: { id: "sess-media" } },
        { timestamp: ts(1), type: "event_msg", payload: { type: "task_started", turn_id: "t1" } },
        {
          timestamp: ts(1),
          type: "response_item",
          payload: {
            type: "tool_search_output",
            tools: [
              {
                type: "namespace",
                name: "shell",
                tools: [{ type: "function", name: "exec_command", description: "Run a command." }],
              },
            ],
          },
        },
        {
          timestamp: ts(2),
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "Look at this" },
              { type: "input_image", image_url: URI },
            ],
          },
        },
        {
          timestamp: ts(3),
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "ok" }],
          },
        },
        { timestamp: ts(3), type: "event_msg", payload: { type: "token_count", info: {} } },
        { timestamp: ts(4), type: "event_msg", payload: { type: "task_complete", turn_id: "t1" } },
      ]
        .map((l) => JSON.stringify(l))
        .join("\n"),
    );

    await convertAndMark(file, { config: baseConfig, stoppedTurnId: "t1" });

    const spans = exporter.getFinishedSpans();
    const root = spans.find((s) => s.name === "Codex Turn");

    expect(JSON.parse(attr(root!, "langfuse.observation.input"))).toEqual([
      { type: "text", text: "Look at this\n[image image/png ~0KB]" },
      { type: "image_url", image_url: { url: URI } },
    ]);
    expect(attr(root!, "langfuse.observation.metadata.codex.image_count")).toBe("1");
    expect(attr(root!, "langfuse.observation.metadata.codex.tool_definition_count")).toBe("1");

    const generation = spans.find((s) => obsType(s) === "generation");
    const input = JSON.parse(attr(generation!, "langfuse.observation.input"));
    expect(input[0].tools).toEqual([{ name: "exec_command", description: "Run a command." }]);

    fs.rmSync(dir, { recursive: true, force: true });
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

  it("nests subagent turns discovered via sub_agent_activity events", async () => {
    const dir = stageFixtures();
    await convertRollout(path.join(dir, "rollout-activity-main.jsonl"), { config: baseConfig });

    const spans = exporter.getFinishedSpans();
    const parent = spans.find((s) => s.name === "Codex Turn" && obsType(s) === "agent");
    const childTurns = spans.filter(
      (s) => s.name === "Codex Subagent Turn" && obsType(s) === "agent",
    );
    expect(parent).toBeDefined();
    // Exactly one child (the kind filter itself is pinned at parse level,
    // where non-"started" activities target distinct thread ids).
    expect(childTurns).toHaveLength(1);
    const child = childTurns[0];
    expect(child.spanContext().traceId).toBe(parent!.spanContext().traceId);
    expect(attr(child, "langfuse.observation.input")).toContain("compute the answer");

    const childGeneration = spans.find(
      (s) => obsType(s) === "generation" && parentId(s) === child.spanContext().spanId,
    );
    expect(childGeneration?.name).toBe("LLM Subagent");
    expect(attr(childGeneration!, "langfuse.observation.model.name")).toBe("gpt-5.4");
  });

  it("nests subagent turns discovered via the spawn tool output", async () => {
    const dir = stageFixtures();
    await convertRollout(path.join(dir, "rollout-spawn-output-main.jsonl"), { config: baseConfig });

    const spans = exporter.getFinishedSpans();
    const parent = spans.find((s) => s.name === "Codex Turn" && obsType(s) === "agent");
    const childTurns = spans.filter(
      (s) => s.name === "Codex Subagent Turn" && obsType(s) === "agent",
    );
    expect(parent).toBeDefined();
    expect(childTurns).toHaveLength(1);
    const child = childTurns[0];
    expect(child.spanContext().traceId).toBe(parent!.spanContext().traceId);
    expect(attr(child, "langfuse.observation.input")).toContain("hottest chilli");

    const childGeneration = spans.find(
      (s) => obsType(s) === "generation" && parentId(s) === child.spanContext().spanId,
    );
    expect(childGeneration?.name).toBe("LLM Subagent");
    expect(attr(childGeneration!, "langfuse.observation.model.name")).toBe("gpt-5.6-sol");
    expect(attr(child, "langfuse.observation.metadata.codex.thread_id")).toBe("thread-spawnout");
  });

  it("recovers an unannounced subagent by start time when its nickname is ambiguous", async () => {
    const dir = stageFixtures();
    await convertRollout(path.join(dir, "rollout-orphan-main.jsonl"), { config: baseConfig });

    const spans = exporter.getFinishedSpans();
    const childTurns = spans.filter(
      (s) => s.name === "Codex Subagent Turn" && obsType(s) === "agent",
    );
    expect(childTurns).toHaveLength(1);
    const child = childTurns[0];

    const parent = spans.find((s) => s.spanContext().spanId === parentId(child));
    expect(parent?.name).toBe("Codex Turn");
    expect(attr(parent!, "langfuse.observation.metadata.codex.turn_id")).toBe("turn-orphan-2");
    expect(child.spanContext().traceId).toBe(parent!.spanContext().traceId);

    const childGeneration = spans.find(
      (s) => obsType(s) === "generation" && parentId(s) === child.spanContext().spanId,
    );
    expect(childGeneration?.name).toBe("LLM Subagent");
    expect(attr(childGeneration!, "langfuse.observation.model.name")).toBe("gpt-5.6-sol");
  });

  it("skips an announced subagent whose rollout is missing, without failing the turn", async () => {
    const dir = stageFixtures();
    fs.rmSync(path.join(dir, "rollout-child-thread-act.jsonl"));
    await convertRollout(path.join(dir, "rollout-activity-main.jsonl"), { config: baseConfig });

    const spans = exporter.getFinishedSpans();
    expect(spans.filter((s) => s.name === "Codex Subagent Turn")).toHaveLength(0);
    const parent = spans.find((s) => s.name === "Codex Turn");
    expect(parent).toBeDefined();
    expect(attr(parent!, "langfuse.observation.output")).toContain("42");
  });

  it("attributes an unannounced subagent by nickname, overriding its start time", async () => {
    const dir = stageFixtures();
    await convertRollout(path.join(dir, "rollout-nickname-main.jsonl"), { config: baseConfig });

    const spans = exporter.getFinishedSpans();
    const childTurns = spans.filter((s) => s.name === "Codex Subagent Turn");
    expect(childTurns).toHaveLength(1);
    const child = childTurns[0];
    const parent = spans.find((s) => s.spanContext().spanId === parentId(child));

    expect(attr(parent!, "langfuse.observation.metadata.codex.turn_id")).toBe("turn-nick-1");
    expect(child.spanContext().traceId).toBe(parent!.spanContext().traceId);
  });

  it("indexes the sessions tree by declared parent, skipping days before the parent's", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lf-codex-index-"));
    const write = (day: string, name: string, first: unknown) => {
      const dir = path.join(root, day);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, name), `${JSON.stringify(first)}\n`);
    };
    const meta = (id: string, parent?: string, nickname?: string) => ({
      timestamp: "2026-06-03T12:00:00.000Z",
      type: "session_meta",
      payload: {
        id,
        ...(parent ? { parent_thread_id: parent } : {}),
        ...(nickname ? { agent_nickname: nickname } : {}),
      },
    });

    write("2026/06/03", "rollout-a-parent.jsonl", meta("parent"));
    write("2026/06/03", "rollout-b-kid1.jsonl", meta("kid1", "parent", "Lorentz"));
    write("2026/06/04", "rollout-c-kid2.jsonl", meta("kid2", "parent"));
    write("2026/06/02", "rollout-d-stale.jsonl", meta("stale", "parent"));
    write("2026/06/03", "rollout-e-broken.jsonl", "{not json");
    write("2026/06/03", "rollout-f-headless.jsonl", { type: "event_msg", payload: {} });
    write("2026/06/03", "rollout-g-kid3.jsonl", {
      timestamp: "2026-06-03T12:00:00.000Z",
      type: "session_meta",
      payload: {
        id: "kid3",
        parent_thread_id: "parent",
        source: { subagent: { thread_spawn: { agent_nickname: "Kepler" } } },
      },
    });

    const index = await buildSubagentIndex(path.join(root, "2026/06/03/rollout-a-parent.jsonl"));
    expect(
      index.byParent
        .get("parent")
        ?.map((s) => s.threadId)
        .sort(),
    ).toEqual(["kid1", "kid2", "kid3"]);
    expect(index.byThread.get("kid1")?.file).toBe(
      path.join(root, "2026/06/03/rollout-b-kid1.jsonl"),
    );
    expect(index.byThread.get("kid1")?.nickname).toBe("Lorentz");
    expect(index.byThread.get("kid3")?.nickname).toBe("Kepler");
    expect(index.byThread.get("kid2")?.nickname).toBeUndefined();
    expect(index.byThread.get("parent")?.file).toBe(
      path.join(root, "2026/06/03/rollout-a-parent.jsonl"),
    );
    expect(index.byParent.has("stale")).toBe(false);
  });

  it("does not nest an announced subagent twice when the tree also reports it", async () => {
    const dir = stageFixtures();
    await convertRollout(path.join(dir, "rollout-activity-main.jsonl"), { config: baseConfig });

    const spans = exporter.getFinishedSpans();
    expect(spans.filter((s) => s.name === "Codex Subagent Turn")).toHaveLength(1);
    expect(spans.filter((s) => s.name === "LLM Subagent")).toHaveLength(1);
  });

  it("skips ancestor turns replayed into a subagent rollout", async () => {
    const dir = stageFixtures();
    await convertRollout(path.join(dir, "rollout-inherited-main.jsonl"), { config: baseConfig });

    const turnIdOf = (s: ReadableSpan) => attr(s, "langfuse.observation.metadata.codex.turn_id");
    const turns = exporter
      .getFinishedSpans()
      .filter((s) => s.name === "Codex Turn" || s.name === "Codex Subagent Turn");

    expect(turns.map(turnIdOf).sort()).toEqual([
      "turn-inherited-leaf",
      "turn-inherited-parent",
      "turn-inherited-probe",
    ]);
    expect(turns.filter((s) => s.name === "Codex Turn").map(turnIdOf)).toEqual([
      "turn-inherited-parent",
    ]);
  });

  it("does not double-count usage from replayed ancestor turns", async () => {
    const dir = stageFixtures();
    await convertRollout(path.join(dir, "rollout-inherited-main.jsonl"), { config: baseConfig });

    const total = exporter
      .getFinishedSpans()
      .filter((s) => s.name === "LLM" || s.name === "LLM Subagent")
      .reduce((sum, span) => {
        const usage = attr(span, "langfuse.observation.usage_details");
        return sum + (usage ? Number(JSON.parse(usage).total_tokens ?? 0) : 0);
      }, 0);
    expect(total).toBe(215);
  });

  it("recovers ancestor turn ids when a subagent rollout is converted on its own", async () => {
    const dir = stageFixtures();
    await convertRollout(path.join(dir, "rollout-inherited-probe.jsonl"), { config: baseConfig });

    const turnIdOf = (s: ReadableSpan) => attr(s, "langfuse.observation.metadata.codex.turn_id");
    const turns = exporter
      .getFinishedSpans()
      .filter((s) => s.name === "Codex Turn" || s.name === "Codex Subagent Turn");

    expect(turns.map(turnIdOf).sort()).toEqual(["turn-inherited-leaf", "turn-inherited-probe"]);
    expect(turns.map(turnIdOf)).not.toContain("turn-inherited-parent");
  });

  it("walks the whole ancestor chain for a nested subagent rollout", async () => {
    const dir = stageFixtures();
    await convertRollout(path.join(dir, "rollout-inherited-leaf.jsonl"), { config: baseConfig });

    const turnIdOf = (s: ReadableSpan) => attr(s, "langfuse.observation.metadata.codex.turn_id");
    const turns = exporter
      .getFinishedSpans()
      .filter((s) => s.name === "Codex Turn" || s.name === "Codex Subagent Turn");

    expect(turns.map(turnIdOf).sort()).toEqual(["turn-inherited-leaf"]);
  });

  it("keeps a fork's own identity when it replays its parent's session_meta", async () => {
    const dir = stageFixtures();
    await convertRollout(path.join(dir, "rollout-replay-child.jsonl"), { config: baseConfig });

    const turnIdOf = (s: ReadableSpan) => attr(s, "langfuse.observation.metadata.codex.turn_id");
    const own = exporter
      .getFinishedSpans()
      .filter((s) => turnIdOf(s) === "turn-replay-child" && s.name.startsWith("Codex"));

    expect(own).toHaveLength(1);
    expect(own[0].name).toBe("Codex Subagent Turn");
    expect(attr(own[0], "langfuse.observation.metadata.codex.thread_id")).toBe(
      "thread-replay-child",
    );
    expect(
      exporter
        .getFinishedSpans()
        .map(turnIdOf)
        .filter((id) => id === "turn-replay-parent"),
    ).toEqual([]);
  });

  it("resolves an ancestor that lives in an earlier day directory", async () => {
    const dir = stageFixtures();
    const nextDay = path.join(dir, "..", "04", "rollout-replay-nextday.jsonl");
    await convertRollout(nextDay, { config: baseConfig });

    const turnIdOf = (s: ReadableSpan) => attr(s, "langfuse.observation.metadata.codex.turn_id");
    const turns = exporter
      .getFinishedSpans()
      .filter((s) => s.name === "Codex Turn" || s.name === "Codex Subagent Turn");

    expect(turns.map(turnIdOf)).toEqual(["turn-nextday-child"]);
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

  it("does not re-export a settings event between turns on every invocation", async () => {
    const dir = stageFixtures();
    const file = path.join(dir, "rollout-thread-settings-main.jsonl");

    await convertAndMark(file, { config: baseConfig });
    const roots = exporter.getFinishedSpans().filter((s) => s.name === "Codex Turn");
    expect(roots.map((s) => attr(s, "langfuse.observation.metadata.codex.turn_id")).sort()).toEqual(
      ["turn-a", "turn-b"],
    );

    exporter.reset();
    await convertAndMark(file, { config: baseConfig });
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });

  it("does not emit an id-less subagent turn for a settings event between the child's turns", async () => {
    const dir = stageFixtures();
    await convertRollout(path.join(dir, "rollout-settings-parent.jsonl"), { config: baseConfig });

    const childTurns = exporter
      .getFinishedSpans()
      .filter((s) => s.name === "Codex Subagent Turn" && obsType(s) === "agent");
    expect(
      childTurns.map((s) => attr(s, "langfuse.observation.metadata.codex.turn_id")).sort(),
    ).toEqual(["turn-c1", "turn-c2"]);
  });

  it("skips turns already recorded in the sidecar (dedup)", async () => {
    const dir = stageFixtures();
    const file = path.join(dir, "rollout-basic-main.jsonl");

    await convertAndMark(file, { config: baseConfig });
    const firstCount = exporter.getFinishedSpans().length;
    expect(firstCount).toBeGreaterThan(0);
    expect(fs.existsSync(`${file}.langfuse`)).toBe(true);

    exporter.reset();
    await convertAndMark(file, { config: baseConfig });
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

    await convertAndMark(file, { config: seededConfig });
    expect(turnRoots()).toHaveLength(2);
    expect(fs.existsSync(`${file}.langfuse`)).toBe(true);

    exporter.reset();
    await convertAndMark(file, { config: seededConfig });
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });

  it("does not let a settings event between turns consume a turn number", async () => {
    const dir = stageFixtures();
    await convertRollout(path.join(dir, "rollout-thread-settings-main.jsonl"), {
      config: seededConfig,
    });

    const roots = turnRoots();
    expect(roots).toHaveLength(2);
    expect(roots[0].spanContext().traceId).toBe(seededTraceId(`${seed}:1`));
    expect(roots[1].spanContext().traceId).toBe(seededTraceId(`${seed}:2`));
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

describe("skill observations", () => {
  it("names a skill-loading command after the skill, keeping its own timing", async () => {
    const dir = stageFixtures();
    await convertRollout(path.join(dir, "rollout-skills-main.jsonl"), { config: baseConfig });

    const tools = exporter
      .getFinishedSpans()
      .filter((s) => obsType(s) === "tool")
      .sort((a, b) => startMs(a) - startMs(b));
    expect(tools.map((s) => s.name)).toEqual([
      "skill:bug-mentor",
      "exec_command",
      "skill:skill-creator",
    ]);
    expect(attr(tools[0], "langfuse.observation.metadata.codex.tool_name")).toBe("exec_command");
    expect(startMs(tools[0])).toBe(Date.parse("2026-06-03T13:00:02.000Z"));
  });
});

describe("Stop hook turn lifecycle", () => {
  const exportedTurnIds = (): string[] =>
    exporter
      .getFinishedSpans()
      .filter((span) => span.name === "Codex Turn")
      .sort((a, b) => startMs(a) - startMs(b))
      .map((span) => attr(span, "langfuse.observation.metadata.codex.turn_id"));

  const sidecarIds = (file: string): string[] =>
    fs.existsSync(`${file}.langfuse`)
      ? fs.readFileSync(`${file}.langfuse`, "utf-8").split("\n").filter(Boolean)
      : [];

  const writeProgress = (file: string, lines: string[], lineCount: number): void =>
    fs.writeFileSync(file, `${lines.slice(0, lineCount).join("\n")}\n`);

  it("exports each turn exactly once over a full hook sequence", async () => {
    const dir = stageFixtures();
    const file = path.join(dir, "rollout-two-turns-main.jsonl");
    const lines = fs.readFileSync(file, "utf-8").trimEnd().split("\n");
    const completeA = lines.findIndex((line) => line.includes('"task_complete"'));

    writeProgress(file, lines, completeA);
    await convertAndMark(file, { config: baseConfig, stoppedTurnId: "turn-a" });
    expect(exportedTurnIds()).toEqual(["turn-a"]);
    expect(sidecarIds(file)).toEqual(["turn-a"]);

    exporter.reset();
    writeProgress(file, lines, lines.length - 1);
    await convertAndMark(file, { config: baseConfig, stoppedTurnId: "turn-b" });
    expect(exportedTurnIds()).toEqual(["turn-b"]);
    expect(sidecarIds(file)).toEqual(["turn-a", "turn-b"]);

    exporter.reset();
    writeProgress(file, lines, lines.length);
    await convertAndMark(file, { config: baseConfig, stoppedTurnId: "turn-b" });
    expect(exportedTurnIds()).toEqual([]);
    expect(sidecarIds(file)).toEqual(["turn-a", "turn-b"]);
  });

  it("never exports the empty fragments between turns", async () => {
    const dir = stageFixtures();
    const file = path.join(dir, "rollout-fragments.jsonl");
    fs.writeFileSync(
      file,
      [
        { timestamp: "2026-06-03T13:00:00.000Z", type: "session_meta", payload: { id: "sess-f" } },
        {
          timestamp: "2026-06-03T13:00:01.000Z",
          type: "event_msg",
          payload: { type: "task_started", turn_id: "turn-1" },
        },
        {
          timestamp: "2026-06-03T13:00:01.100Z",
          type: "event_msg",
          payload: { type: "user_message", message: "first" },
        },
        {
          timestamp: "2026-06-03T13:00:02.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "done" }],
          },
        },
        {
          timestamp: "2026-06-03T13:00:02.100Z",
          type: "event_msg",
          payload: { type: "task_complete", turn_id: "turn-1" },
        },
        {
          timestamp: "2026-06-03T13:00:10.000Z",
          type: "event_msg",
          payload: { type: "thread_settings_applied" },
        },
        {
          timestamp: "2026-06-03T13:00:10.100Z",
          type: "event_msg",
          payload: { type: "task_started", turn_id: "turn-2" },
        },
        {
          timestamp: "2026-06-03T13:00:11.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "also done" }],
          },
        },
        {
          timestamp: "2026-06-03T13:00:11.100Z",
          type: "event_msg",
          payload: { type: "task_complete", turn_id: "turn-2" },
        },
      ]
        .map((line) => JSON.stringify(line))
        .join("\n") + "\n",
    );

    await convertAndMark(file, { config: baseConfig, stoppedTurnId: undefined });

    expect(exportedTurnIds()).toEqual(["turn-1", "turn-2"]);
    expect(sidecarIds(file)).toEqual(["turn-1", "turn-2"]);
  });
});

describe("turn finality", () => {
  it("exports a superseded turn that never completed, and skips id-less fragments", async () => {
    const dir = stageFixtures();
    const file = path.join(dir, "rollout-superseded.jsonl");
    const line = (ts: string, type: string, payload: Record<string, unknown>) =>
      JSON.stringify({ timestamp: ts, type, payload });
    fs.writeFileSync(
      file,
      [
        line("2026-06-03T14:00:00.000Z", "session_meta", { id: "sess-s" }),
        line("2026-06-03T14:00:01.000Z", "event_msg", { type: "task_started", turn_id: "turn-1" }),
        line("2026-06-03T14:00:01.100Z", "event_msg", { type: "user_message", message: "erste" }),
        line("2026-06-03T14:00:02.000Z", "event_msg", { type: "agent_message", message: "ok" }),
        line("2026-06-03T14:00:02.100Z", "event_msg", { type: "task_complete", turn_id: "turn-1" }),
        // Between turns Codex injects a subagent notification and a settings
        // event; neither carries a turn_id.
        line("2026-06-03T14:00:30.000Z", "response_item", {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "<subagent_notification>done</subagent_notification>" },
          ],
        }),
        line("2026-06-03T14:00:31.000Z", "event_msg", { type: "thread_settings_applied" }),
        // turn-2: the user asked, Codex never wrote task_complete or turn_aborted.
        line("2026-06-03T14:01:00.000Z", "event_msg", { type: "task_started", turn_id: "turn-2" }),
        line("2026-06-03T14:01:00.100Z", "event_msg", {
          type: "user_message",
          message: "klappt es?",
        }),
        line("2026-06-03T14:02:00.000Z", "event_msg", { type: "task_started", turn_id: "turn-3" }),
        line("2026-06-03T14:02:00.100Z", "event_msg", {
          type: "user_message",
          message: "und jetzt?",
        }),
        line("2026-06-03T14:02:01.000Z", "event_msg", { type: "agent_message", message: "ja." }),
        line("2026-06-03T14:02:01.100Z", "event_msg", { type: "task_complete", turn_id: "turn-3" }),
      ].join("\n") + "\n",
    );

    const exported = await convertAndMark(file, { config: baseConfig });

    expect(exported).toEqual(["turn-1", "turn-2", "turn-3"]);
    const roots = exporter
      .getFinishedSpans()
      .filter((s) => s.name === "Codex Turn")
      .sort((a, b) => startMs(a) - startMs(b))
      .map((s) => attr(s, "langfuse.observation.metadata.codex.turn_id"));
    expect(roots).toEqual(["turn-1", "turn-2", "turn-3"]);
    expect(fs.readFileSync(`${file}.langfuse`, "utf-8").trim().split("\n")).toEqual([
      "turn-1",
      "turn-2",
      "turn-3",
    ]);
  });
});
