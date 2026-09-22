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
    expect(turn.systemPrompt).toEqual({
      baseInstructions: "You are Codex.",
      developerMessages: ["<environment_context>cwd=/repo</environment_context>"],
      injectedContext: [],
      changed: true,
    });

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

  it("captures an explicitly invoked skill without letting it leak into the prompt", () => {
    const { turns } = parseSession(loadFixture("rollout-skills-main.jsonl"));

    expect(turns).toHaveLength(1);
    expect(turns[0].promptSkills).toEqual(["git-workflow"]);
    expect(turns[0].userInput).toBe("Triage this crash with the bug-mentor skill");
  });

  it("carries the session system prompt onto every turn it stays in context for", () => {
    const line = (ts: string, type: string, payload: Record<string, unknown>): RolloutLine =>
      ({ timestamp: ts, type, payload }) as RolloutLine;
    const developer = (ts: string, text: string): RolloutLine =>
      line(ts, "response_item", {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text }],
      });
    const turn = (ts: string, id: string): RolloutLine[] => [
      line(ts, "event_msg", { type: "task_started", turn_id: id }),
      line(ts, "event_msg", { type: "user_message", message: `ask ${id}` }),
      line(ts, "event_msg", { type: "task_complete", turn_id: id }),
    ];

    const { turns } = parseSession([
      line("2026-06-03T14:00:00.000Z", "session_meta", {
        id: "s",
        base_instructions: { text: "You are Codex." },
      }),
      ...turn("2026-06-03T14:00:01.000Z", "t1").slice(0, 2),
      developer("2026-06-03T14:00:02.000Z", "<skills_instructions>skills</skills_instructions>"),
      line("2026-06-03T14:00:03.000Z", "event_msg", { type: "task_complete", turn_id: "t1" }),
      ...turn("2026-06-03T14:00:04.000Z", "t2"),
      ...turn("2026-06-03T14:00:05.000Z", "t3").slice(0, 2),
      developer("2026-06-03T14:00:06.000Z", "<multi_agent_mode>off</multi_agent_mode>"),
      line("2026-06-03T14:00:07.000Z", "event_msg", { type: "task_complete", turn_id: "t3" }),
    ]);

    expect(turns.map((t) => t.turnId)).toEqual(["t1", "t2", "t3"]);

    expect(turns[0].systemPrompt).toEqual({
      baseInstructions: "You are Codex.",
      developerMessages: ["<skills_instructions>skills</skills_instructions>"],
      injectedContext: [],
      changed: true,
    });
    expect(turns[1].systemPrompt).toEqual({
      baseInstructions: "You are Codex.",
      developerMessages: ["<skills_instructions>skills</skills_instructions>"],
      injectedContext: [],
      changed: false,
    });
    expect(turns[2].systemPrompt).toEqual({
      baseInstructions: "You are Codex.",
      developerMessages: [
        "<skills_instructions>skills</skills_instructions>",
        "<multi_agent_mode>off</multi_agent_mode>",
      ],
      injectedContext: [],
      changed: true,
    });
  });

  it("traces injected context without letting it become the turn input", () => {
    const line = (ts: string, type: string, payload: Record<string, unknown>): RolloutLine =>
      ({ timestamp: ts, type, payload }) as RolloutLine;
    const userMessage = (ts: string, text: string): RolloutLine =>
      line(ts, "response_item", {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
      });
    const ENV = "<environment_context><cwd>/repo</cwd><shell>zsh</shell></environment_context>";

    const { turns } = parseSession([
      line("2026-06-03T16:00:00.000Z", "session_meta", { id: "s" }),
      line("2026-06-03T16:00:01.000Z", "event_msg", { type: "task_started", turn_id: "t1" }),
      userMessage("2026-06-03T16:00:02.000Z", ENV),
      userMessage("2026-06-03T16:00:03.000Z", "What does this repo do?"),
      line("2026-06-03T16:00:04.000Z", "event_msg", { type: "task_complete", turn_id: "t1" }),
    ]);

    expect(turns).toHaveLength(1);
    expect(turns[0].userInput).toBe("What does this repo do?");
    expect(turns[0].systemPrompt?.injectedContext).toEqual([ENV]);
    expect(turns[0].systemPrompt?.developerMessages).toEqual([]);
  });

  it("does not let a developer message between turns create a turn of its own", () => {
    const line = (ts: string, type: string, payload: Record<string, unknown>): RolloutLine =>
      ({ timestamp: ts, type, payload }) as RolloutLine;

    const { turns } = parseSession([
      line("2026-06-03T15:00:00.000Z", "session_meta", { id: "s" }),
      line("2026-06-03T15:00:01.000Z", "event_msg", { type: "task_started", turn_id: "t1" }),
      line("2026-06-03T15:00:02.000Z", "event_msg", { type: "user_message", message: "hi" }),
      line("2026-06-03T15:00:03.000Z", "event_msg", { type: "task_complete", turn_id: "t1" }),
      line("2026-06-03T15:00:04.000Z", "response_item", {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "<multi_agent_mode>off</multi_agent_mode>" }],
      }),
    ]);

    expect(turns).toHaveLength(1);
    expect(turns[0].turnId).toBe("t1");
    expect(turns[0].systemPrompt).toBeUndefined();
  });

  it("captures attached images without altering the prompt text", () => {
    const line = (ts: string, type: string, payload: Record<string, unknown>): RolloutLine =>
      ({ timestamp: ts, type, payload }) as RolloutLine;
    const URI = "data:image/png;base64,iVBORw0KGgo=";

    const { turns } = parseSession([
      line("2026-06-03T17:00:00.000Z", "session_meta", { id: "s" }),
      line("2026-06-03T17:00:01.000Z", "event_msg", { type: "task_started", turn_id: "t1" }),
      line("2026-06-03T17:00:02.000Z", "response_item", {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "What is wrong here?" },
          { type: "input_image", image_url: URI, detail: "high" },
        ],
      }),
      line("2026-06-03T17:00:03.000Z", "event_msg", { type: "task_complete", turn_id: "t1" }),
    ]);

    expect(turns).toHaveLength(1);
    expect(turns[0].userImages).toEqual([URI]);
    expect(turns[0].userInput).toBe("What is wrong here?");
  });

  it("flattens the tool definitions Codex loaded for the session", () => {
    const line = (ts: string, type: string, payload: Record<string, unknown>): RolloutLine =>
      ({ timestamp: ts, type, payload }) as RolloutLine;

    const { turns } = parseSession([
      line("2026-06-03T18:00:00.000Z", "session_meta", { id: "s" }),
      line("2026-06-03T18:00:01.000Z", "event_msg", { type: "task_started", turn_id: "t1" }),
      line("2026-06-03T18:00:02.000Z", "response_item", {
        type: "tool_search_output",
        tools: [
          {
            type: "namespace",
            name: "codex_app",
            description: "Tools in the codex_app namespace.",
            tools: [
              {
                type: "function",
                name: "automation_update",
                description: "Manage recurring automations.",
                parameters: { type: "object" },
                strict: false,
              },
              { type: "function", name: "automation_list", description: "List automations." },
            ],
          },
        ],
      }),
      line("2026-06-03T18:00:03.000Z", "event_msg", { type: "user_message", message: "go" }),
      line("2026-06-03T18:00:04.000Z", "event_msg", { type: "task_complete", turn_id: "t1" }),
    ]);

    expect(turns[0].toolDefinitions).toEqual([
      {
        name: "automation_update",
        description: "Manage recurring automations.",
        parameters: { type: "object" },
      },
      { name: "automation_list", description: "List automations." },
    ]);
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

  it("takes reasoning effort per turn from turn_context, not from thread settings", () => {
    const lines: RolloutLine[] = [
      { timestamp: "2026-06-03T12:00:00.000Z", type: "session_meta", payload: { id: "s" } },
      {
        timestamp: "2026-06-03T12:00:01.000Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: "t1" },
      },
      {
        timestamp: "2026-06-03T12:00:01.100Z",
        type: "turn_context",
        payload: { model: "gpt-5.6-sol", effort: "high" },
      },
      {
        timestamp: "2026-06-03T12:00:02.000Z",
        type: "event_msg",
        payload: { type: "agent_message", message: "done" },
      },
      {
        timestamp: "2026-06-03T12:00:02.300Z",
        type: "event_msg",
        payload: { type: "task_complete", turn_id: "t1" },
      },
      {
        timestamp: "2026-06-03T12:00:02.900Z",
        type: "event_msg",
        payload: {
          type: "thread_settings_applied",
          thread_settings: { reasoning_effort: "low" },
        },
      },
      {
        timestamp: "2026-06-03T12:00:03.000Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: "t2" },
      },
      {
        timestamp: "2026-06-03T12:00:03.100Z",
        type: "turn_context",
        payload: { model: "gpt-5.6-sol", effort: "xhigh" },
      },
      {
        timestamp: "2026-06-03T12:00:04.000Z",
        type: "event_msg",
        payload: { type: "agent_message", message: "done again" },
      },
      {
        timestamp: "2026-06-03T12:00:04.300Z",
        type: "event_msg",
        payload: { type: "task_complete", turn_id: "t2" },
      },
    ];

    const { turns } = parseSession(lines);
    // The settings event between the turns creates no turn of its own (#78).
    expect(turns.map((t) => t.turnId)).toEqual(["t1", "t2"]);
    expect(turns[0].reasoningEffort).toBe("high");
    expect(turns[1].reasoningEffort).toBe("xhigh");
  });

  it("accepts reasoning_effort as a forward-compatible alias for effort", () => {
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
        payload: { model: "gpt-5.6-sol", reasoning_effort: "max" },
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

  it("records subagent threads from the spawn tool output when no spawn event is emitted", () => {
    const spawn = (callId: string, name: string): RolloutLine => ({
      timestamp: "2026-06-03T13:10:02.000Z",
      type: "response_item",
      payload: { type: "function_call", name, call_id: callId, arguments: "{}" },
    });
    const spawnOutput = (callId: string, output: string): RolloutLine => ({
      timestamp: "2026-06-03T13:10:02.800Z",
      type: "response_item",
      payload: { type: "function_call_output", call_id: callId, output },
    });
    const lines: RolloutLine[] = [
      { timestamp: "2026-06-03T13:10:00.000Z", type: "session_meta", payload: { id: "s" } },
      {
        timestamp: "2026-06-03T13:10:01.000Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: "t" },
      },
      spawn("c1", "spawn_agent"),
      spawnOutput("c1", '{"agent_id":"thread-a","nickname":"Lorentz"}'),
      spawn("c2", "spawn_agent"),
      spawnOutput("c2", '{"agent_id":"thread-b","nickname":"Mencius"}'),
      spawn("c3", "spawn_agent"),
      {
        timestamp: "2026-06-03T13:10:02.500Z",
        type: "event_msg",
        payload: {
          type: "sub_agent_activity",
          event_id: "c3",
          agent_thread_id: "thread-c",
          kind: "started",
        },
      },
      spawnOutput("c3", '{"agent_id":"thread-c","nickname":"Popper"}'),
      spawn("c4", "spawn_agent"),
      spawnOutput("c4", '{"error":"agent limit reached"}'),
      spawn("c5", "wait_agent"),
      spawnOutput("c5", '{"agent_id":"thread-a","status":{}}'),
      {
        timestamp: "2026-06-03T13:10:04.000Z",
        type: "event_msg",
        payload: { type: "task_complete", turn_id: "t" },
      },
    ];
    const { turns } = parseSession(lines);
    expect(turns).toHaveLength(1);
    expect(turns[0].subagentThreadIds).toEqual(["thread-a", "thread-b", "thread-c"]);
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
