import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Config } from "../src/config.js";
import { openIncrementalRollout } from "../src/rollout.js";
import { markTurnUploaded } from "../src/sidecar.js";
import { buildSubagentIndex, convertRollout } from "../src/trace.js";

const exporter = new InMemorySpanExporter();
let provider: NodeTracerProvider;
const temporary: string[] = [];
const config: Config = {
  enabled: true,
  public_key: "test-public",
  secret_key: "test-secret",
  base_url: "http://127.0.0.1",
  skill_tags: true,
  max_history_chars: 2_000,
  debug: false,
  fail_on_error: true,
};
const row = (type: string, payload: Record<string, unknown>) =>
  JSON.stringify({
    timestamp: "2026-11-10T10:00:00.000Z",
    type,
    payload,
  }) + "\n";
const event = (type: string, payload: Record<string, unknown> = {}) =>
  row("event_msg", { type, ...payload });
function turn(n: number, complete = true): string {
  return (
    event("task_started", { turn_id: `t${n}` }) +
    row("turn_context", { model: "test-model", effort: "medium" }) +
    event("user_message", { message: `question ${n} 中文` }) +
    row("response_item", {
      type: "function_call",
      name: "exec_command",
      call_id: `call-${n}`,
      arguments: '{"cmd":"echo proof"}',
    }) +
    row("response_item", {
      type: "function_call_output",
      call_id: `call-${n}`,
      output: `proof ${n}`,
    }) +
    row("response_item", {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: `answer ${n}` }],
    }) +
    event("token_count", {
      info: { last_token_usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } },
    }) +
    (complete ? event("task_complete", { turn_id: `t${n}` }) : "")
  );
}
function stage(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-incremental-"));
  temporary.push(dir);
  const day = path.join(dir, "sessions", "2026", "11", "10");
  fs.mkdirSync(day, { recursive: true });
  const file = path.join(day, "rollout.jsonl");
  fs.writeFileSync(
    file,
    row("session_meta", {
      id: "test-session",
      base_instructions: { text: "system instructions" },
    }) +
      row("response_item", {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "developer instructions" }],
      }),
  );
  return file;
}
const options = (file: string, overrides: Partial<Config> = {}) => ({
  config: { ...config, ...overrides },
  onTurnExported: (id: string) => markTurnUploaded(file, id),
});
const attrs = (key: string) => exporter.getFinishedSpans().map((s) => s.attributes[key]);
const cursor = (file: string) => JSON.parse(fs.readFileSync(`${file}.langfuse.cursor`, "utf8"));

beforeAll(() => {
  provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  provider.register();
});
afterAll(() => provider.shutdown());
beforeEach(() => exporter.reset());
afterEach(() => {
  for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("incremental root Stop hooks", () => {
  it("resumes from acknowledged bytes and retains generation history, instructions, tools and usage", async () => {
    const file = stage();
    fs.appendFileSync(file, turn(1));
    await convertRollout(file, options(file));
    const offset = fs.statSync(file).size;
    expect(cursor(file).offset).toBe(offset);
    exporter.reset();
    const addition = turn(2);
    fs.appendFileSync(file, addition);
    const reader = await openIncrementalRollout(file, config.max_history_chars);
    try {
      expect(reader.checkpoint?.offset).toBe(offset);
      expect(reader.bytesRead).toBe(Buffer.byteLength(addition));
      expect(reader.records[0].line.payload.type).toBe("task_started");
    } finally {
      await reader.close();
    }
    expect(await convertRollout(file, options(file))).toEqual(["t2"]);
    const warm = exporter.getFinishedSpans();
    const generation = warm.find(
      (s) => s.attributes["langfuse.observation.type"] === "generation",
    )!;
    expect(String(generation.attributes["langfuse.observation.input"])).toContain(
      "question 1 中文",
    );
    expect(String(generation.attributes["langfuse.observation.input"])).toContain(
      "system instructions",
    );
    expect(String(generation.attributes["langfuse.observation.input"])).toContain(
      "developer instructions",
    );
    expect(
      warm.find((s) => s.name === "exec_command")!.attributes["langfuse.observation.output"],
    ).toContain("proof 2");
    expect(
      JSON.parse(String(generation.attributes["langfuse.observation.usage_details"])).total_tokens,
    ).toBe(15);
    fs.unlinkSync(`${file}.langfuse.cursor`);
    fs.writeFileSync(`${file}.langfuse`, "t1\n");
    exporter.reset();
    await convertRollout(file, options(file));
    const cold = exporter
      .getFinishedSpans()
      .find((s) => s.attributes["langfuse.observation.type"] === "generation")!;
    expect(cold.attributes["langfuse.observation.input"]).toEqual(
      generation.attributes["langfuse.observation.input"],
    );
    if (process.platform !== "win32")
      expect(fs.statSync(`${file}.langfuse.cursor`).mode & 0o777).toBe(0o600);
  });

  it("keeps omission counts identical to a cold parse after a bounded-history restart", async () => {
    const file = stage();
    for (let n = 1; n <= 6; n++) {
      fs.appendFileSync(file, turn(n));
      await convertRollout(file, options(file, { max_history_chars: 400 }));
    }
    const warmGeneration = exporter
      .getFinishedSpans()
      .filter((s) => s.attributes["langfuse.observation.type"] === "generation")
      .at(-1)!;
    expect(String(warmGeneration.attributes["langfuse.observation.input"])).toContain(
      "earlier message(s) omitted",
    );
    fs.unlinkSync(`${file}.langfuse.cursor`);
    fs.writeFileSync(`${file}.langfuse`, "t1\nt2\nt3\nt4\nt5\n");
    exporter.reset();
    await convertRollout(file, options(file, { max_history_chars: 400 }));
    const coldGeneration = exporter
      .getFinishedSpans()
      .find((s) => s.attributes["langfuse.observation.type"] === "generation")!;
    expect(coldGeneration.attributes["langfuse.observation.input"]).toEqual(
      warmGeneration.attributes["langfuse.observation.input"],
    );
  });

  it("does not skip an incomplete UTF-8 tail, and retries after it becomes a complete line", async () => {
    const file = stage();
    fs.appendFileSync(file, turn(1));
    await convertRollout(file, options(file));
    const offset = cursor(file).offset;
    const next = Buffer.from(turn(2));
    const split = next.indexOf(Buffer.from("中文")) + 1;
    fs.appendFileSync(file, next.subarray(0, split));
    exporter.reset();
    expect(await convertRollout(file, options(file))).toEqual([]);
    expect(cursor(file).offset).toBe(offset);
    fs.appendFileSync(file, next.subarray(split));
    expect(await convertRollout(file, options(file))).toEqual(["t2"]);
    expect(
      attrs("langfuse.observation.input").some((x) => String(x).includes("question 2 中文")),
    ).toBe(true);
  });

  it("exports the last stopped turn before task_complete without consuming its late records", async () => {
    const file = stage();
    fs.appendFileSync(file, turn(1, false));
    expect(await convertRollout(file, { ...options(file), stoppedTurnId: "t1" })).toEqual(["t1"]);
    expect(fs.existsSync(`${file}.langfuse.cursor`)).toBe(false);
    fs.appendFileSync(file, event("task_complete", { turn_id: "t1" }) + turn(2));
    exporter.reset();
    expect(await convertRollout(file, options(file))).toEqual(["t2"]);
    expect(cursor(file).turnCount).toBe(2);
    expect(cursor(file).offset).toBe(fs.statSync(file).size);
  });

  it("does not advance the cursor on failed acknowledgement, and retries the same turn", async () => {
    const file = stage();
    fs.appendFileSync(file, turn(1));
    await convertRollout(file, options(file));
    const before = cursor(file);
    fs.appendFileSync(file, turn(2));
    await expect(
      convertRollout(file, {
        config,
        onTurnExported: async () => {
          throw new Error("upload failed");
        },
      }),
    ).rejects.toThrow("upload failed");
    expect(cursor(file)).toEqual(before);
    expect(await convertRollout(file, options(file))).toEqual(["t2"]);
    expect(cursor(file).lastTurnId).toBe("t2");
  });

  it("decodes long UTF-8 lines crossing read chunks without losing the completion boundary", async () => {
    const file = stage();
    const text = "中文🌍".repeat(20_000);
    const first = turn(1).replace("answer 1", text);
    fs.appendFileSync(file, first);
    await convertRollout(file, options(file));
    const root = exporter.getFinishedSpans().find((s) => s.name === "Codex Turn")!;
    expect(root.attributes["langfuse.observation.output"]).toBe(text);
    expect(cursor(file).offset).toBe(fs.statSync(file).size);
    fs.appendFileSync(file, turn(2));
    exporter.reset();
    expect(await convertRollout(file, options(file))).toEqual(["t2"]);
    expect(
      exporter.getFinishedSpans().find((s) => s.name === "Codex Turn")!.attributes[
        "langfuse.observation.output"
      ],
    ).toBe("answer 2");
  });

  it("rebuilds a corrupt, replaced or truncated transcript checkpoint without hiding new turns", async () => {
    const file = stage();
    fs.appendFileSync(file, turn(1));
    await convertRollout(file, options(file));
    fs.writeFileSync(`${file}.langfuse.cursor`, "not json");
    fs.appendFileSync(file, turn(2));
    expect(await convertRollout(file, options(file))).toEqual(["t2"]);
    const replacement = `${file}.replacement`;
    fs.writeFileSync(replacement, row("session_meta", { id: "test-session" }) + turn(3));
    fs.renameSync(replacement, file);
    expect(await convertRollout(file, options(file))).toEqual(["t3"]);
    fs.writeFileSync(file, row("session_meta", { id: "test-session" }) + turn(4));
    expect(await convertRollout(file, options(file))).toEqual(["t4"]);
  });

  it("does not trust a checkpoint after receipts were removed or history limit changed", async () => {
    const file = stage();
    fs.appendFileSync(file, turn(1));
    await convertRollout(file, options(file));
    fs.unlinkSync(`${file}.langfuse`);
    expect(await convertRollout(file, options(file))).toEqual(["t1"]);
    const reader = await openIncrementalRollout(file, 100);
    try {
      expect(reader.checkpoint).toBeUndefined();
    } finally {
      await reader.close();
    }
  });

  it("retains tool definitions discovered before the acknowledged cursor", async () => {
    const file = stage();
    const first = turn(1).replace(
      event("task_complete", { turn_id: "t1" }),
      row("response_item", {
        type: "tool_search_output",
        tools: [
          {
            name: "remembered_tool",
            description: "prior definition",
            parameters: { type: "object" },
          },
        ],
      }) + event("task_complete", { turn_id: "t1" }),
    );
    fs.appendFileSync(file, first);
    await convertRollout(file, options(file));
    fs.appendFileSync(file, turn(2));
    exporter.reset();
    await convertRollout(file, options(file));
    const generation = exporter
      .getFinishedSpans()
      .find((s) => s.attributes["langfuse.observation.type"] === "generation")!;
    const input = JSON.parse(String(generation.attributes["langfuse.observation.input"]));
    expect(input[0].tools).toEqual([
      { name: "remembered_tool", description: "prior definition", parameters: { type: "object" } },
    ]);
  });

  it("switches to ownership-preserving reads when a subagent appears after a checkpoint", async () => {
    const file = stage();
    fs.appendFileSync(file, turn(1));
    await convertRollout(file, options(file));
    const child = path.join(path.dirname(file), "rollout-child.jsonl");
    fs.writeFileSync(
      child,
      row("session_meta", { id: "child-session", parent_thread_id: "test-session" }) +
        turn(1) +
        turn(3),
    );
    const second = turn(2).replace(
      event("task_complete", { turn_id: "t2" }),
      event("collab_agent_spawn_end", { new_thread_id: "child-session", call_id: "call-2" }) +
        event("task_complete", { turn_id: "t2" }),
    );
    fs.appendFileSync(file, second);
    exporter.reset();
    expect(await convertRollout(file, options(file))).toEqual(["t2"]);
    const roots = exporter
      .getFinishedSpans()
      .filter((s) => s.name === "Codex Turn" || s.name === "Codex Subagent Turn");
    expect(roots.map((s) => s.attributes["langfuse.observation.metadata.codex.turn_id"])).toEqual([
      "t3",
      "t2",
    ]);
  });

  it("preserves seeded turn numbering across warm hooks", async () => {
    const file = stage();
    fs.appendFileSync(file, turn(1));
    await convertRollout(file, options(file, { trace_seed: "seed" }));
    fs.appendFileSync(file, turn(2));
    exporter.reset();
    await convertRollout(file, options(file, { trace_seed: "seed" }));
    const warmTrace = exporter
      .getFinishedSpans()
      .find((s) => s.name === "Codex Turn")!
      .spanContext().traceId;
    fs.unlinkSync(`${file}.langfuse.cursor`);
    fs.writeFileSync(`${file}.langfuse`, "t1\n");
    exporter.reset();
    await convertRollout(file, options(file, { trace_seed: "seed" }));
    expect(
      exporter
        .getFinishedSpans()
        .find((s) => s.name === "Codex Turn")!
        .spanContext().traceId,
    ).toBe(warmTrace);
  });

  it("does not open earlier sessions when discovering subagents of a timestamped rollout", async () => {
    const file = stage();
    const day = path.dirname(file);
    const own = path.join(day, "rollout-2026-11-10T12-00-00-parent.jsonl");
    fs.renameSync(file, own);
    fs.appendFileSync(own, turn(1));
    const earlier = path.join(day, "rollout-2026-11-10T09-00-00-unrelated.jsonl");
    fs.writeFileSync(earlier, row("session_meta", { id: "unrelated" }) + turn(1));
    const later = path.join(day, "rollout-2026-11-10T13-00-00-child.jsonl");
    fs.writeFileSync(
      later,
      row("session_meta", { id: "child-session", parent_thread_id: "test-session" }) + turn(1),
    );
    // An unreadable earlier file proves it is never opened during discovery.
    fs.writeFileSync(earlier, "not json at all\n");
    const index = await buildSubagentIndex(own);
    expect(index.byThread.has("unrelated")).toBe(false);
    expect(index.byParent.get("test-session")?.map((s) => s.threadId)).toEqual(["child-session"]);
  });

  it("prunes earlier day directories but still finds them when explicitly unbounded", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-day-prune-"));
    temporary.push(root);
    const day = path.join(root, "2026", "11", "10");
    fs.mkdirSync(day, { recursive: true });
    const own = path.join(day, "rollout-2026-11-10T12-00-00-parent.jsonl");
    fs.writeFileSync(own, row("session_meta", { id: "test-session" }) + turn(1));
    const old = path.join(root, "2025", "01", "01");
    fs.mkdirSync(old, { recursive: true });
    fs.writeFileSync(
      path.join(old, "rollout-2025-01-01T00-00-00-ancient.jsonl"),
      row("session_meta", { id: "ancient-child", parent_thread_id: "test-session" }) + turn(1),
    );
    expect((await buildSubagentIndex(own)).byThread.has("ancient-child")).toBe(false);
    expect(
      (await buildSubagentIndex(own, { includeEarlierDays: true })).byThread.has("ancient-child"),
    ).toBe(true);
  });
});
