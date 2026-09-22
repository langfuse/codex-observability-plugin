import type { Config } from "./config.js";
import type { ToolCall, Turn } from "./types.js";
import { toText } from "./utils.js";

const SKILL_ACCESS_TOOLS = new Set([
  "exec_command",
  "exec",
  "shell",
  "local_shell",
  "bash",
  "js",
  "read_mcp_resource",
]);
const SKILL_ACCESS_FIELDS = ["cmd", "command", "code", "uri"];

const SKILL_DOC = /([A-Za-z0-9._@+-]+)\/SKILL\.md\b/g;
const SKILL_SCRIPT = /\bskills\/(?:\.[A-Za-z0-9._-]+\/)?([A-Za-z0-9._@+-]+)\/scripts\//g;
const SKILL_PROMPT_FRAGMENT = /<skill>\s*<name>([^<\n]+)<\/name>/g;

const MAX_SKILL_NAME_LENGTH = 64;

function skillAccessText(tc: ToolCall): string | undefined {
  if (!SKILL_ACCESS_TOOLS.has(tc.name)) return undefined;
  if (typeof tc.args === "string") return tc.args;
  if (tc.args == null || typeof tc.args !== "object") return undefined;
  const args = tc.args as Record<string, unknown>;
  for (const field of SKILL_ACCESS_FIELDS) {
    const value = args[field];
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value.map((part) => toText(part)).join(" ");
  }
  return undefined;
}

function collect(text: string, patterns: RegExp[]): string[] {
  const names: string[] = [];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const name = match[1].trim();
      if (
        name.length > 0 &&
        name.length <= MAX_SKILL_NAME_LENGTH &&
        !name.startsWith(".") &&
        !names.includes(name)
      ) {
        names.push(name);
      }
    }
  }
  return names;
}

/** Skills a tool call picked up by reading a `SKILL.md` or running a skill script. */
export function skillsForToolCall(tc: ToolCall): string[] {
  const text = skillAccessText(tc);
  return text ? collect(text, [SKILL_DOC, SKILL_SCRIPT]) : [];
}

/** Skills explicitly invoked with the prompt, from Codex's injected `<skill>` fragments. */
export function skillsForPrompt(text: string): string[] {
  return text.includes("<skill>") ? collect(text, [SKILL_PROMPT_FRAGMENT]) : [];
}

/** Configured tags plus one `skill:<name>` per skill the turn used. */
export function traceTags(config: Pick<Config, "tags" | "skill_tags">, turn: Turn): string[] {
  const tags = [...(config.tags ?? [])];
  if (!config.skill_tags) return tags;

  const names = [...turn.promptSkills];
  for (const step of turn.steps) {
    for (const tc of step.toolCalls) {
      for (const name of skillsForToolCall(tc)) {
        if (!names.includes(name)) names.push(name);
      }
    }
  }
  for (const name of names) {
    const tag = `skill:${name}`;
    if (!tags.includes(tag)) tags.push(tag);
  }
  return tags;
}
