import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Config } from "../src/config.js";
import { convertRollout } from "../src/trace.js";

let generationCalls = 0;
vi.mock("@langfuse/tracing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@langfuse/tracing")>();
  return {
    ...actual,
    startObservation: vi.fn((name: string, ...rest: unknown[]) => {
      if (name === "LLM" && ++generationCalls === 2) throw new Error("emit boom");
      return (actual.startObservation as (...args: unknown[]) => unknown)(name, ...rest);
    }),
  };
});

const exporter = new InMemorySpanExporter();
let provider: NodeTracerProvider;

const baseConfig: Config = {
  enabled: true,
  public_key: "pk-lf-test",
  secret_key: "sk-lf-test",
  base_url: "https://cloud.langfuse.com",
  debug: false,
  fail_on_error: false,
};

const line = (ts: string, type: string, payload: Record<string, unknown>) =>
  JSON.stringify({ timestamp: ts, type, payload });

function stageRollout(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lf-codex-emit-fail-"));
  const sessionsDir = path.join(dir, "sessions", "2026", "06", "03");
  fs.mkdirSync(sessionsDir, { recursive: true });
  const file = path.join(sessionsDir, "rollout-three-turns.jsonl");

  const lines = [line("2026-06-03T12:00:00.000Z", "session_meta", { id: "sess-emit-fail" })];
  for (const n of [1, 2, 3]) {
    const t = `2026-06-03T12:0${n}`;
    lines.push(
      line(`${t}:00.000Z`, "event_msg", { type: "task_started", turn_id: `turn-${n}` }),
      line(`${t}:00.100Z`, "event_msg", { type: "user_message", message: `q${n}` }),
      line(`${t}:01.000Z`, "response_item", {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: `a${n}` }],
      }),
      line(`${t}:01.100Z`, "event_msg", { type: "token_count" }),
      line(`${t}:01.200Z`, "event_msg", { type: "task_complete", turn_id: `turn-${n}` }),
    );
  }
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
}

beforeAll(() => {
  provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  provider.register();
});

afterAll(async () => {
  await provider.shutdown();
});

beforeEach(() => {
  exporter.reset();
  generationCalls = 0;
});

describe("a turn whose conversion fails", () => {
  it("is exported as an ERROR trace and does not take the other turns with it", async () => {
    const exported = await convertRollout(stageRollout(), { config: baseConfig });

    expect(exported).toEqual(["turn-1", "turn-2", "turn-3"]);

    const roots = exporter.getFinishedSpans().filter((s) => s.name === "Codex Turn");
    const byTurn = Object.fromEntries(
      roots.map((s) => [s.attributes["langfuse.observation.metadata.codex.turn_id"], s]),
    );
    expect(Object.keys(byTurn).sort()).toEqual(["turn-1", "turn-2", "turn-3"]);
    expect(byTurn["turn-2"].attributes["langfuse.observation.level"]).toBe("ERROR");
    expect(byTurn["turn-2"].attributes["langfuse.observation.status_message"]).toContain(
      "emit boom",
    );
    expect(byTurn["turn-1"].attributes["langfuse.observation.level"]).toBeUndefined();
  });
});
