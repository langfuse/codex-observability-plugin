import { describe, expect, it } from "vitest";

import { parseSession } from "../src/parse.js";

// Synthetic fixture from issue #110: a /goal-started turn where a later
// in-flight user message arrives before task_complete.
const GOAL_TURN_WITH_PROGRESS_MESSAGE = [
  { timestamp: "2000-01-01T00:00:00Z", type: "session_meta", payload: { id: "example-thread" } },
  {
    timestamp: "2000-01-01T00:00:01Z",
    type: "event_msg",
    payload: { type: "task_started", turn_id: "example-turn" },
  },
  {
    timestamp: "2000-01-01T00:00:02Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [
        {
          type: "input_text",
          text: '<codex_internal_context source="goal">\n<objective>Complete the example task</objective>\n</codex_internal_context>',
        },
      ],
    },
  },
  {
    timestamp: "2000-01-01T00:00:03Z",
    type: "event_msg",
    payload: {
      type: "item_completed",
      item: { type: "UserMessage", content: [{ type: "text", text: "What is the progress?" }] },
    },
  },
  {
    timestamp: "2000-01-01T00:00:04Z",
    type: "event_msg",
    payload: { type: "task_complete", turn_id: "example-turn" },
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
] as any[];

describe("goal turn input attribution (#110)", () => {
  it("keeps the initiating goal objective as the turn input instead of a later in-flight user message", () => {
    const { turns } = parseSession(GOAL_TURN_WITH_PROGRESS_MESSAGE);
    expect(turns).toHaveLength(1);
    expect(turns[0].userInput).toBe("Complete the example task");
  });

  it("keeps the goal objective when no later user message arrives", () => {
    const lines = GOAL_TURN_WITH_PROGRESS_MESSAGE.filter(
      (line) => !(line.type === "event_msg" && line.payload?.type === "item_completed"),
    );
    const { turns } = parseSession(lines);
    expect(turns).toHaveLength(1);
    expect(turns[0].userInput).toBe("Complete the example task");
  });

  it("does not expose the raw internal context wrapper as the turn input", () => {
    const { turns } = parseSession(GOAL_TURN_WITH_PROGRESS_MESSAGE);
    expect(turns[0].userInput).not.toContain("codex_internal_context");
  });
});
