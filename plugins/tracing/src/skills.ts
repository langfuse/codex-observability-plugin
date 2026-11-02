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

// Commands that read or execute the path they are given. Commands that only
// stage or move paths (git add, cp, rm, ...) are deliberately absent: a skill
// path in `git add -- .agents/skills/x/SKILL.md` is not a skill invocation.
const SKILL_READ_COMMANDS = new Set([
  "awk",
  "bat",
  "bash",
  "bun",
  "bunx",
  "cargo",
  "cat",
  "code",
  "deno",
  "dotnet",
  "fish",
  "go",
  "grep",
  "head",
  "java",
  "less",
  "more",
  "node",
  "npm",
  "npx",
  "open",
  "perl",
  "php",
  "pnpm",
  "powershell",
  "pwsh",
  "python",
  "python3",
  "rg",
  "ruby",
  "sed",
  "sh",
  "source",
  "tail",
  "uv",
  "uvx",
  "yarn",
  "zsh",
]);
const SHELL_INTERPRETERS = new Set(["bash", "fish", "powershell", "pwsh", "sh", "zsh"]);
const GIT_READ_SUBCOMMANDS = new Set(["blame", "cat-file", "diff", "grep", "log", "show"]);
const SHELL_WRAPPERS = new Set([
  "builtin",
  "command",
  "env",
  "nice",
  "nohup",
  "stdbuf",
  "sudo",
  "time",
  "timeout",
  "xargs",
]);
const WRAPPER_OPTIONS_WITH_VALUE = new Set([
  "-g",
  "--group",
  "-k",
  "--kill-after",
  "-n",
  "--adjustment",
  "-p",
  "--prompt",
  "-s",
  "--signal",
  "-u",
  "--user",
]);

const NESTED_COMMAND =
  /(?:cmd|command)\s*:\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`)/g;

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

function baseName(token: string): string {
  return token.split(/[\\/]/).pop() ?? token;
}

function tokenizeShell(segment: string): string[] {
  const tokens: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|`([^`]*)`|([^\s]+)/g;
  for (const match of segment.matchAll(pattern)) {
    const token = match[1] ?? match[2] ?? match[3] ?? match[4];
    if (token) tokens.push(token);
  }
  return tokens;
}

function shellSegments(text: string): string[] {
  return text.split(/\s*(?:&&|\|\||;|\n|\|)\s*/).filter((segment) => segment.trim().length > 0);
}

function unwrapShellTokens(tokens: string[]): string[] {
  let index = 0;
  while (index < tokens.length) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index])) {
      index += 1;
      continue;
    }
    const command = baseName(tokens[index]);
    if (!SHELL_WRAPPERS.has(command)) break;
    index += 1;
    while (index < tokens.length && tokens[index].startsWith("-")) {
      index += WRAPPER_OPTIONS_WITH_VALUE.has(tokens[index]) ? 2 : 1;
    }
    if (command === "timeout" && index < tokens.length && /^\d/.test(tokens[index])) {
      index += 1;
    }
  }
  return tokens.slice(index);
}

function isSkillPathToken(token: string): boolean {
  return /\/SKILL\.md$/.test(token) || /\/skills\/(?:\.[^/]+\/)?[^/]+\/scripts\//.test(token);
}

function commandReadsSkillPath(tokens: string[]): boolean {
  const commandTokens = unwrapShellTokens(tokens);
  if (commandTokens.length === 0) return false;
  // Codex sometimes records a bare script path (no interpreter). That is an
  // execution, unlike a path passed to a command that only stages it.
  if (commandTokens.length === 1) return isSkillPathToken(commandTokens[0]);

  const command = baseName(commandTokens[0]);
  if (command === "git") {
    const subcommand = commandTokens.slice(1).find((token) => !token.startsWith("-"));
    return subcommand !== undefined && GIT_READ_SUBCOMMANDS.has(subcommand);
  }
  if (SHELL_INTERPRETERS.has(command)) {
    const commandFlag = commandTokens.indexOf("-c");
    if (commandFlag >= 0 && commandTokens[commandFlag + 1]) {
      return shellSegments(commandTokens[commandFlag + 1]).some((segment) =>
        commandReadsSkillPath(tokenizeShell(segment)),
      );
    }
    return true;
  }
  return SKILL_READ_COMMANDS.has(command);
}

function nestedShellCommands(text: string): string[] {
  const commands: string[] = [];
  for (const match of text.matchAll(NESTED_COMMAND)) {
    const command = match[1] ?? match[2] ?? match[3];
    if (command) commands.push(command);
  }
  return commands;
}

function skillsFromShellText(text: string): string[] {
  const names: string[] = [];
  for (const segment of shellSegments(text)) {
    if (!commandReadsSkillPath(tokenizeShell(segment))) continue;
    for (const name of collect(segment, [SKILL_DOC, SKILL_SCRIPT])) {
      if (!names.includes(name)) names.push(name);
    }
  }
  return names;
}

function uniqueNames(groups: string[][]): string[] {
  const names: string[] = [];
  for (const group of groups) {
    for (const name of group) {
      if (!names.includes(name)) names.push(name);
    }
  }
  return names;
}

/** Skills a tool call picked up by reading a `SKILL.md` or running a skill script. */
export function skillsForToolCall(tc: ToolCall): string[] {
  const text = skillAccessText(tc);
  if (!text) return [];
  if (tc.name === "read_mcp_resource") return collect(text, [SKILL_DOC, SKILL_SCRIPT]);

  // Code-mode calls carry a nested `exec_command({cmd: "..."})`; classify the
  // nested command instead of trusting the surrounding program text.
  const nestedCommands = nestedShellCommands(text);
  if (nestedCommands.length > 0) {
    return uniqueNames(nestedCommands.map(skillsFromShellText));
  }
  return skillsFromShellText(text);
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
