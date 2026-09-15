import { describe, expect, it } from "vitest";

import { skillsForPrompt, skillsForToolCall, traceTags } from "../src/skills.js";
import type { ToolCall, Turn } from "../src/types.js";

const HOME = "/Users/dev/.codex";

function toolCall(name: string, args: unknown): ToolCall {
  return { callId: `call-${name}`, name, args, startTime: 0, endTime: 1 };
}

function exec(cmd: string): ToolCall {
  return toolCall("exec_command", { cmd, workdir: "/repo", max_output_tokens: 10_000 });
}

function turnWith(toolCalls: ToolCall[], promptSkills: string[] = []): Turn {
  return {
    startTime: 0,
    endTime: 1,
    steps: [{ startTime: 0, endTime: 1, toolCalls }],
    subagentThreadIds: [],
    promptSkills,
    completed: true,
    aborted: false,
  };
}

describe("skillsForToolCall", () => {
  it("detects a SKILL.md read, a skill script, and the real argument shapes", () => {
    expect(skillsForToolCall(exec(`cat ${HOME}/skills/bug-mentor/SKILL.md`))).toEqual([
      "bug-mentor",
    ]);
    expect(
      skillsForToolCall(exec(`node ${HOME}/skills/.system/openai-docs/scripts/fetch.mjs`)),
    ).toEqual(["openai-docs"]);
    expect(
      skillsForToolCall(
        toolCall("local_shell", {
          command: ["sed", "-n", "1,200p", ".agents/skills/security-review/SKILL.md"],
        }),
      ),
    ).toEqual(["security-review"]);
    expect(
      skillsForToolCall(
        toolCall(
          "exec",
          `const r = await tools.exec_command({cmd:"cat ${HOME}/skills/pdf/SKILL.md"});`,
        ),
      ),
    ).toEqual(["pdf"]);
    expect(
      skillsForToolCall(
        toolCall("read_mcp_resource", {
          server: "codex_apps",
          uri: "skill://plugin_connector_68df038e/figma-use/SKILL.md",
        }),
      ),
    ).toEqual(["figma-use"]);
  });

  it("ignores searches, unrelated source paths, and non-command tools", () => {
    expect(skillsForToolCall(exec("find .agents -type f -name 'SKILL.md'"))).toEqual([]);
    expect(
      skillsForToolCall(exec('rg -n "createSkill" web/src/features/skills/generated/')),
    ).toEqual([]);
    expect(
      skillsForToolCall(toolCall("apply_patch", "*** Add File: .agents/skills/new/SKILL.md")),
    ).toEqual([]);
    expect(
      skillsForToolCall(
        toolCall("exec_command", {
          cmd: "ls",
          justification: "following .agents/skills/git-workflow/SKILL.md",
        }),
      ),
    ).toEqual([]);
  });
});

describe("skillsForPrompt", () => {
  it("reads the name out of Codex's injected skill fragment", () => {
    const injected =
      "<skill>\n<name>bug-mentor</name>\n<path>/Users/dev/.codex/skills/bug-mentor/SKILL.md</path>\n---\nname: bug-mentor\n---\n\n# Bug Mentor\n</skill>";
    expect(skillsForPrompt(injected)).toEqual(["bug-mentor"]);
    expect(skillsForPrompt("read .agents/skills/code-review/SKILL.md please")).toEqual([]);
  });
});

describe("traceTags", () => {
  const turn = turnWith(
    [
      exec(`cat ${HOME}/skills/bug-mentor/SKILL.md`),
      exec("ls"),
      exec(".agents/skills/code/scripts/x.py"),
    ],
    ["git-workflow"],
  );

  it("appends explicitly invoked and command-detected skills to the configured tags", () => {
    expect(traceTags({ tags: ["lane:review"], skill_tags: true }, turn)).toEqual([
      "lane:review",
      "skill:git-workflow",
      "skill:bug-mentor",
      "skill:code",
    ]);
  });

  it("leaves the skills out when skill_tags is off", () => {
    expect(traceTags({ tags: ["lane:review"], skill_tags: false }, turn)).toEqual(["lane:review"]);
  });
});
