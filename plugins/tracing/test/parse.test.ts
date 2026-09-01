import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseSession } from "../src/parse.js";
import type { RolloutLine } from "../src/types.js";

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/sessions/2026/06/03",
);

function loadFixture(name: string): RolloutLine[] {
  return fs
    .readFileSync(path.join(fixturesDir, name), "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RolloutLine);
}

describe("parseSession", () => {
  it("reconstructs a basic single-turn session with a tool call", () => {
    const { sessionMeta, turns } = parseSession(loadFixture("rollout-basic-main.jsonl"));

    expect(sessionMeta).toMatchObject({
      sessionId: "sess-basic",
      cliVersion: "0.123.0",
      modelProvider: "openai",
    });

    expect(turns).toHaveLength(1);
    const turn = turns[0];
    expect(turn.turnId).toBe("turn-1");
    expect(turn.completed).toBe(true);
    expect(turn.aborted).toBe(false);
    expect(turn.model).toBe("gpt-5.4");
    expect(turn.reasoningEffort).toBe("medium");
    expect(turn.userInput).toBe("List the files in the repo");
    expect(turn.finalOutput).toBe("There are two files: file1.txt and file2.txt.");
    expect(turn.totalUsage?.total_tokens).toBe(300);

    // Two model steps: (reasoning + tool call) then (final assistant message).
    expect(turn.steps).toHaveLength(2);

    const [step1, step2] = turn.steps;
    expect(step1.reasoning).toBe("I'll list files with ls.");
    expect(step1.toolCalls).toHaveLength(1);
    expect(step1.usage?.total_tokens).toBe(120);

    const tool = step1.toolCalls[0];
    expect(tool.name).toBe("exec_command");
    expect(tool.args).toEqual({ command: ["ls"] });
    expect(tool.output).toBe("file1.txt\nfile2.txt");
    expect(tool.error).toBeUndefined();
    // End time advanced by the exec_command_end / function_call_output events.
    expect(tool.endTime).toBe(Date.parse("2026-06-03T10:00:03.100Z"));

    expect(step2.text).toBe("There are two files: file1.txt and file2.txt.");
    expect(step2.toolCalls).toHaveLength(0);
  });

  it("captures subagent threads, tool errors, and interruption", () => {
    const { turns } = parseSession(loadFixture("rollout-parent.jsonl"));

    expect(turns).toHaveLength(1);
    const turn = turns[0];
    expect(turn.turnId).toBe("turn-parent");
    expect(turn.completed).toBe(true);
    expect(turn.aborted).toBe(true);
    expect(turn.userInput).toBe("Spawn a subagent to tell a joke");
    expect(turn.subagentThreadIds).toEqual(["thread-child"]);

    // ...and the failing exec is captured with its error.
    const tools = turn.steps.flatMap((s) => s.toolCalls);
    const failing = tools.find((t) => t.name === "exec_command");
    expect(failing?.error).toBe("command failed");
    expect(turn.startTime).toBe(Date.parse("2026-06-03T11:00:01.000Z"));
    expect(turn.endTime).toBe(Date.parse("2026-06-03T11:00:05.000Z"));
  });

  it("captures reasoning effort from applied thread settings", () => {
    const lines: RolloutLine[] = [
      { timestamp: "2026-06-03T12:00:00.000Z", type: "session_meta", payload: { id: "s" } },
      {
        timestamp: "2026-06-03T12:00:01.000Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: "t" },
      },
      {
        timestamp: "2026-06-03T12:00:01.100Z",
        type: "turn_context",
        payload: { model: "gpt-5.6-luna", effort: "xhigh" },
      },
      {
        timestamp: "2026-06-03T12:00:01.200Z",
        type: "event_msg",
        payload: {
          type: "thread_settings_applied",
          thread_settings: { reasoning_effort: "max" },
        },
      },
      {
        timestamp: "2026-06-03T12:00:02.000Z",
        type: "event_msg",
        payload: { type: "task_complete", turn_id: "t" },
      },
    ];

    const { turns } = parseSession(lines);
    expect(turns[0].reasoningEffort).toBe("max");
  });

  it("records subagent threads from sub_agent_activity, ignoring non-started kinds", () => {
    const event = (ts: string, payload: Record<string, unknown>): RolloutLine => ({
      timestamp: ts,
      type: "event_msg",
      payload: { ...payload },
    });
    const lines: RolloutLine[] = [
      { timestamp: "2026-06-03T13:00:00.000Z", type: "session_meta", payload: { id: "s" } },
      event("2026-06-03T13:00:01.000Z", { type: "task_started", turn_id: "t" }),
      event("2026-06-03T13:00:02.000Z", {
        type: "sub_agent_activity",
        event_id: "c1",
        agent_thread_id: "thread-a",
        agent_path: "/root/worker",
        kind: "started",
      }),
      // The same spawn reported again — legacy format and a repeated activity.
      event("2026-06-03T13:00:02.100Z", {
        type: "collab_agent_spawn_end",
        call_id: "c1",
        new_thread_id: "thread-a",
      }),
      event("2026-06-03T13:00:02.200Z", {
        type: "sub_agent_activity",
        event_id: "c1",
        agent_thread_id: "thread-a",
        agent_path: "/root/worker",
        kind: "started",
      }),
      // Later lifecycle kinds reference an existing child and must not register.
      event("2026-06-03T13:00:03.000Z", {
        type: "sub_agent_activity",
        event_id: "c2",
        agent_thread_id: "thread-b",
        agent_path: "/root/other",
        kind: "interacted",
      }),
      event("2026-06-03T13:00:03.100Z", {
        type: "sub_agent_activity",
        event_id: "c3",
        agent_thread_id: "thread-c",
        agent_path: "/root/other",
        kind: "interrupted",
      }),
      event("2026-06-03T13:00:04.000Z", { type: "task_complete", turn_id: "t" }),
    ];
    const { turns } = parseSession(lines);
    expect(turns).toHaveLength(1);
    expect(turns[0].subagentThreadIds).toEqual(["thread-a"]);
  });

  it("treats a trailing, never-completed turn as not completed", () => {
    const lines: RolloutLine[] = [
      { timestamp: "2026-06-03T12:00:00.000Z", type: "session_meta", payload: { id: "s" } },
      {
        timestamp: "2026-06-03T12:00:01.000Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: "t" },
      },
      {
        timestamp: "2026-06-03T12:00:01.200Z",
        type: "turn_context",
        payload: { model: "gpt-5.4" },
      },
      {
        timestamp: "2026-06-03T12:00:01.300Z",
        type: "event_msg",
        payload: { type: "user_message", message: "hi" },
      },
      {
        timestamp: "2026-06-03T12:00:02.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "working..." }],
        },
      },
    ];
    const { turns } = parseSession(lines);
    expect(turns).toHaveLength(1);
    expect(turns[0].completed).toBe(false);
    expect(turns[0].userInput).toBe("hi");
  });

  it("falls back to the first non-wrapper user message when no user_message event exists", () => {
    const lines: RolloutLine[] = [
      { timestamp: "2026-06-03T12:00:00.000Z", type: "session_meta", payload: { id: "s" } },
      {
        timestamp: "2026-06-03T12:00:01.000Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: "t" },
      },
      {
        timestamp: "2026-06-03T12:00:01.100Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "<environment_context>cwd=/x</environment_context>" },
          ],
        },
      },
      {
        timestamp: "2026-06-03T12:00:01.200Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "real question" }],
        },
      },
      {
        timestamp: "2026-06-03T12:00:02.000Z",
        type: "event_msg",
        payload: { type: "task_complete", turn_id: "t" },
      },
    ];
    const { turns } = parseSession(lines);
    expect(turns[0].userInput).toBe("real question");
  });

  it("captures web search, local shell, and MCP tool calls", () => {
    const { turns } = parseSession(loadFixture("rollout-tools-main.jsonl"));

    expect(turns).toHaveLength(1);
    const tools = turns[0].steps.flatMap((s) => s.toolCalls);
    expect(tools).toHaveLength(3);

    // web_search_end (event) precedes the web_search_call item in the fixture;
    // the two must merge into a single call.
    const webSearch = tools.find((t) => t.name === "web_search");
    expect(webSearch?.args).toEqual({ type: "search", query: "langfuse codex plugin" });
    expect(webSearch?.endTime).toBe(Date.parse("2026-06-03T12:00:02.600Z"));

    const shell = tools.find((t) => t.name === "local_shell");
    expect(shell?.args).toMatchObject({ command: ["bash", "-lc", "git status"] });
    expect(shell?.output).toBe("clean");

    const mcp = tools.find((t) => t.name === "linear__create_issue");
    expect(mcp?.mcp).toEqual({ server: "linear", tool: "create_issue" });
  });

  it("merges a web_search_call item with a later web_search_end event", () => {
    const lines: RolloutLine[] = [
      { timestamp: "2026-06-03T12:00:00.000Z", type: "session_meta", payload: { id: "s" } },
      {
        timestamp: "2026-06-03T12:00:01.000Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: "t" },
      },
      {
        timestamp: "2026-06-03T12:00:02.000Z",
        type: "response_item",
        payload: {
          type: "web_search_call",
          id: "ws-1",
          status: "completed",
          action: { type: "search", query: "q" },
        },
      },
      {
        timestamp: "2026-06-03T12:00:02.500Z",
        type: "event_msg",
        payload: { type: "web_search_end", call_id: "ws-1", query: "q" },
      },
      {
        timestamp: "2026-06-03T12:00:03.000Z",
        type: "event_msg",
        payload: { type: "task_complete", turn_id: "t" },
      },
    ];
    const { turns } = parseSession(lines);
    const tools = turns[0].steps.flatMap((s) => s.toolCalls);
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("web_search");
    expect(tools[0].args).toEqual({ type: "search", query: "q" });
    expect(tools[0].endTime).toBe(Date.parse("2026-06-03T12:00:02.500Z"));
  });

  it("parses custom tool calls and their outputs", () => {
    const lines: RolloutLine[] = [
      { timestamp: "2026-06-03T12:00:00.000Z", type: "session_meta", payload: { id: "s" } },
      {
        timestamp: "2026-06-03T12:00:01.000Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: "t" },
      },
      {
        timestamp: "2026-06-03T12:00:01.200Z",
        type: "turn_context",
        payload: { model: "gpt-5.4" },
      },
      {
        timestamp: "2026-06-03T12:00:02.000Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          name: "apply_patch",
          call_id: "c1",
          input: "*** Begin Patch",
        },
      },
      {
        timestamp: "2026-06-03T12:00:02.500Z",
        type: "response_item",
        payload: { type: "custom_tool_call_output", call_id: "c1", output: "patched" },
      },
      {
        timestamp: "2026-06-03T12:00:03.000Z",
        type: "event_msg",
        payload: { type: "task_complete", turn_id: "t" },
      },
    ];
    const { turns } = parseSession(lines);
    const tool = turns[0].steps.flatMap((s) => s.toolCalls)[0];
    expect(tool.name).toBe("apply_patch");
    expect(tool.args).toBe("*** Begin Patch");
    expect(tool.output).toBe("patched");
  });
});

describe("user prompt extraction", () => {
  it("prefers the structured UserMessage over the injected context block", () => {
    const { turns } = parseSession(loadFixture("rollout-agents-preamble-main.jsonl"));

    expect(turns).toHaveLength(1);
    expect(turns[0]!.userInput).toBe("sag mal hallo");
    expect(turns[0]!.userInput).not.toContain("AGENTS.md instructions");
  });

  it("keeps a prompt that merely mentions the wrapper tags", () => {
    // Only the structured item can rescue this prompt: the fallback rejects
    // any text containing the wrapper elements.
    const prompt = "why does <environment_context> appear in my traces?";
    const lines = loadFixture("rollout-agents-preamble-main.jsonl").map((line) =>
      JSON.stringify(line).includes("sag mal hallo")
        ? (JSON.parse(JSON.stringify(line).replaceAll("sag mal hallo", prompt)) as RolloutLine)
        : line,
    );

    expect(parseSession(lines).turns[0]!.userInput).toBe(prompt);
  });

  it("rejects an AGENTS.md-prefixed wrapper in the fallback path", () => {
    // Older CLIs emit no structured user item; drop it from the fixture.
    const lines = loadFixture("rollout-agents-preamble-main.jsonl").filter(
      (line) =>
        !(
          line.type === "event_msg" && (line.payload as { type?: string }).type === "item_completed"
        ),
    );
    const { turns } = parseSession(lines);

    expect(turns[0]!.userInput).toBe("sag mal hallo");
  });
});
