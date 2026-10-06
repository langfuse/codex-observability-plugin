import { type Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  createTraceId,
  LangfuseOtelSpanAttributes,
  propagateAttributes,
  startObservation,
  type LangfuseGenerationAttributes,
  type LangfuseObservation,
} from "@langfuse/tracing";
import { TraceFlags, type SpanContext } from "@opentelemetry/api";

import type { Config } from "./config.js";
import { ExportBatch } from "./export-batch.js";
import { currentIdSeed, seedIds, type ExportReceipt } from "./instrumentation.js";
import { parseArgs } from "./parse.js";
import { readRollout, readRolloutMeta, readTurns, ROLLOUT_LIMITS } from "./rollout.js";
import { loadUploadedTurnIds } from "./sidecar.js";
import { skillsForToolCall, traceTags } from "./skills.js";
import type {
  EventMsgPayload,
  ModelStep,
  RolloutLine,
  SessionMeta,
  SystemPrompt,
  TokenUsage,
  ToolCall,
  ToolDefinition,
  Turn,
} from "./types.js";
import { debugLog, toText } from "./utils.js";

const MAX_ROUTING_BYTES = 8 * 1024 * 1024;

type SubagentRollout = {
  threadId: string;
  parentThreadId?: string;
  file: string;
  startTime: number;
  nickname?: string;
};

export type SubagentIndex = {
  byParent: Map<string, SubagentRollout[]>;
  byThread: Map<string, SubagentRollout>;
  truncated?: boolean;
};

async function readSessionMeta(
  file: string,
): Promise<
  { threadId: string; parentThreadId?: string; startTime: number; nickname?: string } | undefined
> {
  let handle;
  try {
    handle = await fs.open(file, "r");
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf-8");
    const newline = text.indexOf("\n");
    const line = newline === -1 ? text : text.slice(0, newline);
    const parsed = JSON.parse(line) as RolloutLine;
    if (parsed.type !== "session_meta") return undefined;
    const p = parsed.payload as {
      id?: string;
      parent_thread_id?: string | null;
      agent_nickname?: string | null;
      source?: { subagent?: { thread_spawn?: { agent_nickname?: string | null } } };
    };
    if (typeof p.id !== "string") return undefined;
    const ts = Date.parse(parsed.timestamp);
    const nickname = p.agent_nickname ?? p.source?.subagent?.thread_spawn?.agent_nickname;
    return {
      threadId: p.id,
      parentThreadId: typeof p.parent_thread_id === "string" ? p.parent_thread_id : undefined,
      startTime: Number.isFinite(ts) ? ts : 0,
      nickname: typeof nickname === "string" && nickname ? nickname : undefined,
    };
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
}

export async function buildSubagentIndex(
  rolloutFile: string,
  options: { includeEarlierDays?: boolean } = {},
): Promise<SubagentIndex> {
  const root = path.resolve(path.dirname(rolloutFile), "../../..");
  const fromDay = path.relative(root, path.dirname(rolloutFile));
  const bounded = !options.includeEarlierDays && /^\d{4}\/\d{2}\/\d{2}$/.test(fromDay);
  const index: SubagentIndex = { byParent: new Map(), byThread: new Map() };
  let indexBytes = 0;

  async function walk(dir: string, rel: string): Promise<void> {
    if (bounded && rel && rel < fromDay.slice(0, rel.length)) return;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, rel ? `${rel}/${entry.name}` : entry.name);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const meta = await readSessionMeta(full);
      if (!meta) continue;
      if (index.byThread.has(meta.threadId)) continue;
      const rollout: SubagentRollout = {
        threadId: meta.threadId,
        parentThreadId: meta.parentThreadId,
        file: full,
        startTime: meta.startTime,
        nickname: meta.nickname,
      };
      const bytes = Buffer.byteLength(JSON.stringify(rollout));
      if (indexBytes + bytes > MAX_ROUTING_BYTES) {
        index.truncated = true;
        continue;
      }
      indexBytes += bytes;
      index.byThread.set(meta.threadId, rollout);
      if (!meta.parentThreadId) continue;
      index.byParent.set(meta.parentThreadId, [
        ...(index.byParent.get(meta.parentThreadId) ?? []),
        rollout,
      ]);
    }
  }

  await walk(root, "");
  return index;
}

type TurnSummary = Pick<Turn, "turnId" | "startTime" | "endTime" | "subagentThreadIds"> & {
  nicknames: string[];
};

function spawnNicknames(turn: Turn): string[] {
  const names: string[] = [];
  for (const step of turn.steps) {
    for (const tc of step.toolCalls) {
      if (tc.name !== "spawn_agent" || tc.output == null) continue;
      const out = parseArgs(toText(tc.output));
      const nickname =
        out !== null && typeof out === "object"
          ? (out as { nickname?: unknown }).nickname
          : undefined;
      if (typeof nickname === "string" && nickname) names.push(nickname);
    }
  }
  return names;
}

function turnIndexByNickname(turns: TurnSummary[]): Map<string, number> {
  const byNickname = new Map<string, number>();
  const ambiguous = new Set<string>();
  turns.forEach((turn, index) => {
    for (const nickname of turn.nicknames) {
      if (byNickname.has(nickname) && byNickname.get(nickname) !== index) {
        ambiguous.add(nickname);
      }
      byNickname.set(nickname, index);
    }
  });
  for (const nickname of ambiguous) byNickname.delete(nickname);
  return byNickname;
}

function turnIndexAt(turns: TurnSummary[], startTime: number): number {
  const running = turns.findIndex((t) => startTime >= t.startTime && startTime <= t.endTime);
  if (running !== -1) return running;
  let last = 0;
  for (let i = 0; i < turns.length; i++) {
    if (turns[i].startTime <= startTime) last = i;
  }
  return last;
}

/**
 * Placeholder parent span id used to pin a deterministic trace id on a root
 * span (the pattern the Langfuse SDK documents for custom trace ids). The id
 * never exists as a real span, so Langfuse still renders the turn as the
 * trace root.
 */
const SEED_PARENT_SPAN_ID = "0123456789abcdef";

/**
 * Derive the deterministic trace id for a turn from `config.trace_seed`.
 *
 * Main-thread turn N (1-based, rollout order):  createTraceId(`${seed}:${N}`)
 * Subagent-thread turn N:                       createTraceId(`${seed}:${threadId}:${N}`)
 *
 * The main-thread form deliberately excludes the thread id so external systems
 * can precompute trace ids (hex(sha256(seed)).slice(0, 32)) before the Codex
 * thread exists. Returns `undefined` (auto-generated ids) when no seed is set
 * or derivation fails — the hook must never block an upload.
 */
async function seededTraceParent(
  config: Config,
  sessionMeta: SessionMeta,
  turnNumber: number,
): Promise<SpanContext | undefined> {
  if (!config.trace_seed) return undefined;
  try {
    const seed = sessionMeta.isSubagentThread
      ? `${config.trace_seed}:${sessionMeta.sessionId}:${turnNumber}`
      : `${config.trace_seed}:${turnNumber}`;
    return {
      traceId: await createTraceId(seed),
      spanId: SEED_PARENT_SPAN_ID,
      traceFlags: TraceFlags.SAMPLED,
      isRemote: true,
    };
  } catch (error) {
    debugLog("failed to derive seeded trace id; falling back to auto-generated:", error);
    if (config.fail_on_error) throw error;
    return undefined;
  }
}

function isTokenCount(value: number | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function toUsageDetails(
  usage: TokenUsage | undefined,
): LangfuseGenerationAttributes["usageDetails"] {
  if (!usage) return undefined;
  const {
    input_tokens: input,
    output_tokens: output,
    total_tokens: total,
    cached_input_tokens: cached,
    reasoning_output_tokens: reasoning,
  } = usage;

  if (
    !isTokenCount(input) ||
    !isTokenCount(output) ||
    !isTokenCount(total) ||
    total !== input + output
  ) {
    debugLog("dropping usage: missing or inconsistent token counts", usage);
    return undefined;
  }
  if (
    (cached !== undefined && (!isTokenCount(cached) || cached > input)) ||
    (reasoning !== undefined && (!isTokenCount(reasoning) || reasoning > output))
  ) {
    debugLog("dropping usage: implausible cached/reasoning details", usage);
    return undefined;
  }

  // The runtime supports this documented shape, but the SDK type still
  // exposes only its legacy camelCase usage interface.
  return {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: total,
    ...(cached !== undefined ? { prompt_tokens_details: { cached_tokens: cached } } : {}),
    ...(reasoning !== undefined
      ? { completion_tokens_details: { reasoning_tokens: reasoning } }
      : {}),
  } as unknown as LangfuseGenerationAttributes["usageDetails"];
}

function buildGenerationOutput(step: ModelStep): Record<string, unknown> | undefined {
  const output: Record<string, unknown> = {};
  if (step.text) output.content = step.text;
  if (step.reasoning) output.reasoning = step.reasoning;
  if (step.toolCalls.length > 0) {
    output.tool_calls = step.toolCalls.map((tc) => ({
      id: tc.callId,
      name: tc.name,
      arguments: tc.args,
    }));
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

function toolObservationName(tc: ToolCall): string {
  const skill = skillsForToolCall(tc)[0];
  if (skill) return `skill:${skill}`;
  if (tc.mcp) return `${tc.mcp.server}.${tc.mcp.tool}`;
  return tc.name || "tool";
}

function systemPromptText(systemPrompt: SystemPrompt | undefined): string | undefined {
  if (!systemPrompt) return undefined;
  const segments = [
    systemPrompt.baseInstructions,
    ...systemPrompt.developerMessages,
    ...systemPrompt.injectedContext,
  ].filter((segment): segment is string => typeof segment === "string" && segment.length > 0);
  return segments.length > 0 ? segments.join("\n\n") : undefined;
}

function systemPromptMetadata(systemPrompt: SystemPrompt): Record<string, unknown> {
  const baseChars = systemPrompt.baseInstructions?.length ?? 0;
  const developerChars = systemPrompt.developerMessages.reduce((n, m) => n + m.length, 0);
  const injectedChars = systemPrompt.injectedContext.reduce((n, m) => n + m.length, 0);
  return {
    "codex.system_prompt.total_chars": baseChars + developerChars + injectedChars,
    "codex.system_prompt.base_instructions_chars": baseChars,
    "codex.system_prompt.developer_chars": developerChars,
    "codex.system_prompt.developer_message_count": systemPrompt.developerMessages.length,
    "codex.system_prompt.injected_context_chars": injectedChars,
    "codex.system_prompt.injected_context_count": systemPrompt.injectedContext.length,
    "codex.system_prompt.changed_this_turn": systemPrompt.changed,
    ...(systemPrompt.truncated ? { "codex.system_prompt.truncated": true } : {}),
  };
}

type ChatMlToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments?: string };
};
type ChatMlThinkingPart = { type: "thinking"; content: string };
type ChatMlMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | ContentPart[] }
  | {
      role: "assistant";
      content?: string;
      thinking?: ChatMlThinkingPart[];
      tool_calls?: ChatMlToolCall[];
    }
  | { role: "tool"; tool_call_id: string; name: string; content: string; is_error?: true };

function assistantMessage(step: ModelStep): ChatMlMessage {
  return {
    role: "assistant",
    ...(step.text ? { content: step.text } : {}),
    ...(step.reasoning ? { thinking: [{ type: "thinking", content: step.reasoning }] } : {}),
    ...(step.toolCalls.length > 0
      ? {
          tool_calls: step.toolCalls.map((tc) => ({
            id: tc.callId,
            type: "function" as const,
            function: {
              name: toolObservationName(tc),
              ...(tc.args !== undefined ? { arguments: toText(tc.args) } : {}),
            },
          })),
        }
      : {}),
  };
}

function toolMessages(step: ModelStep): ChatMlMessage[] {
  return step.toolCalls.map((tc) => ({
    role: "tool" as const,
    tool_call_id: tc.callId,
    name: toolObservationName(tc),
    content: tc.output != null ? toText(tc.output) : (tc.error ?? ""),
    ...(tc.error ? { is_error: true as const } : {}),
  }));
}

function turnHistoryMessages(turn: Turn): ChatMlMessage[] {
  const messages: ChatMlMessage[] = [];
  const user = userMessage(turn);
  if (user) messages.push(user);
  for (const step of turn.steps) {
    messages.push(assistantMessage(step));
    messages.push(...toolMessages(step));
  }
  return messages;
}

export const MAX_GENERATION_INPUT_BYTES = 256 * 1024;
type HistoryGroup = { messages: ChatMlMessage[]; bytes: number };

const messageBytes = (messages: ChatMlMessage[]) =>
  messages.reduce((bytes, message) => bytes + Buffer.byteLength(JSON.stringify(message)) + 1, 0);

/** Evict whole turns/steps so a retained tool result keeps its assistant call. */
class GenerationHistory {
  private groups: HistoryGroup[] = [];
  private bytes = 0;
  truncated = false;

  append(messages: ChatMlMessage[]): void {
    const bytes = messageBytes(messages);
    if (!messages.length) return;
    if (bytes > MAX_GENERATION_INPUT_BYTES - 2) {
      // One oversized group cannot fit, but later small groups still can.
      this.truncated = true;
      return;
    }
    this.groups.push({ messages, bytes });
    this.bytes += bytes;
    while (this.bytes > MAX_GENERATION_INPUT_BYTES - 2) {
      this.bytes -= this.groups.shift()!.bytes;
      this.truncated = true;
    }
  }

  recent(budget: number): { messages: ChatMlMessage[]; bytes: number; truncated: boolean } {
    let bytes = 0;
    let first = this.groups.length;
    while (first > 0 && bytes + this.groups[first - 1].bytes <= budget) {
      bytes += this.groups[--first].bytes;
    }
    return {
      messages: this.groups.slice(first).flatMap((group) => group.messages),
      bytes,
      truncated: this.truncated || first > 0,
    };
  }
}

function generationInput(
  system: string | undefined,
  user: ChatMlMessage | undefined,
  prefix: GenerationHistory | undefined,
  steps: GenerationHistory,
  definitions: ToolDefinition[],
): { input: unknown; truncated: boolean } {
  let pinned: ChatMlMessage[] = [
    ...(system ? [{ role: "system" as const, content: system }] : []),
    ...(user ? [user] : []),
  ];
  let truncated = false;
  // Reserve room for recent history even when a single prompt is enormous.
  if (messageBytes(pinned) > MAX_GENERATION_INPUT_BYTES / 2) {
    pinned = pinned.map((message) => {
      if (messageBytes([message]) <= MAX_GENERATION_INPUT_BYTES / 4) return message;
      let text = "content" in message ? toText(message.content) : toText(message);
      let bounded: ChatMlMessage;
      do {
        text = text.slice(0, Math.floor(text.length / 2));
        bounded = {
          role: message.role === "system" ? "system" : "user",
          content: `${text}\n[Input truncated; see turn span.]`,
        };
      } while (messageBytes([bounded]) > MAX_GENERATION_INPUT_BYTES / 4);
      return bounded;
    });
    truncated = true;
  }
  let tools = definitions;
  let toolsBytes = tools.length ? Buffer.byteLength(JSON.stringify(tools)) + 10 : 0;
  if (toolsBytes > MAX_GENERATION_INPUT_BYTES / 4) {
    tools = [];
    toolsBytes = 0;
    truncated = true;
  }
  const budget = MAX_GENERATION_INPUT_BYTES - messageBytes(pinned) - toolsBytes - 2;
  const current = steps.recent(budget);
  const previous = prefix?.recent(budget - current.bytes);
  const messages = [
    ...pinned.filter((message) => message.role === "system"),
    ...(previous?.messages ?? []),
    ...pinned.filter((message) => message.role === "user"),
    ...current.messages,
  ];
  return {
    input: attachToolDefinitions(messages.length ? messages : undefined, tools),
    truncated: truncated || current.truncated || previous?.truncated === true,
  };
}

type ContentPart =
  { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

function toMultimodalContent(
  text: string | undefined,
  images: readonly string[],
): string | ContentPart[] | undefined {
  if (images.length === 0) return text;
  return [
    ...(text ? [{ type: "text" as const, text }] : []),
    ...images.map((url) => ({ type: "image_url" as const, image_url: { url } })),
  ];
}

function userMessage(turn: Turn): ChatMlMessage | undefined {
  const content = toMultimodalContent(turn.userInput, turn.userImages);
  return content === undefined ? undefined : { role: "user", content };
}

function attachToolDefinitions(
  input: ChatMlMessage[] | undefined,
  tools: ToolDefinition[],
): unknown {
  if (!input || tools.length === 0) return input;
  const [first, ...rest] = input;
  return first ? [{ ...first, tools }, ...rest] : input;
}

function generationEnd(step: ModelStep): number {
  const firstToolCall = step.toolCalls.reduce<number | undefined>(
    (earliest, tc) => (earliest === undefined ? tc.startTime : Math.min(earliest, tc.startTime)),
    undefined,
  );
  return Math.max(step.startTime, Math.min(firstToolCall ?? step.endTime, step.endTime));
}

async function emitTurn(
  turn: Turn,
  sessionMeta: SessionMeta,
  ctx: {
    config: Config;
    rolloutFile: string;
    parentObservation?: LangfuseObservation;
    parentSpanContext?: SpanContext;
    attached?: boolean;
    subagentIndex: SubagentIndex;
    seenThreadIds: Set<string>;
    unannouncedSubagents?: SubagentRollout[];
    inheritableTurnIds?: ReadonlySet<string>;
    historyPrefix?: GenerationHistory;
    batch: ExportBatch;
    spanIds: Set<string>;
    routingTruncated?: boolean;
    depth?: number;
  },
): Promise<boolean> {
  const isSubagent = sessionMeta.isSubagentThread === true || ctx.parentObservation != null;

  const outerSeed = currentIdSeed();
  seedIds(`${sessionMeta.sessionId}:${turn.turnId ?? "no-turn-id"}`);

  const root = startObservation(
    isSubagent ? "Codex Subagent Turn" : "Codex Turn",
    {
      input: toMultimodalContent(turn.userInput, turn.userImages),
      output: turn.finalOutput,
      level: turn.aborted ? "WARNING" : undefined,
      statusMessage: turn.aborted ? "Turn interrupted by user" : undefined,
      metadata: {
        "codex.turn_id": turn.turnId,
        "codex.thread_id": sessionMeta.sessionId,
        "codex.model": turn.model,
        "codex.reasoning_effort": turn.reasoningEffort,
        "codex.model_provider": sessionMeta.modelProvider,
        "codex.cli_version": sessionMeta.cliVersion,
        "codex.aborted": turn.aborted,
        "codex.tool_call_count": turn.steps.reduce((n, s) => n + s.toolCalls.length, 0),
        ...(turn.truncated ? { "codex.rollout.truncated": true } : {}),
        ...(ctx.routingTruncated || ctx.subagentIndex.truncated
          ? { "codex.routing.truncated": true }
          : {}),
        ...(ctx.attached && ctx.parentSpanContext
          ? {
              "codex.parent_trace_id": ctx.parentSpanContext.traceId,
              "codex.parent_span_id": ctx.parentSpanContext.spanId,
            }
          : {}),
        ...(turn.systemPrompt ? systemPromptMetadata(turn.systemPrompt) : {}),
        ...(turn.userImages.length ? { "codex.image_count": turn.userImages.length } : {}),
        ...(turn.toolDefinitions.length
          ? { "codex.tool_definition_count": turn.toolDefinitions.length }
          : {}),
      },
    },
    {
      asType: "agent",
      startTime: new Date(turn.startTime),
      parentSpanContext: ctx.parentObservation?.otelSpan.spanContext() ?? ctx.parentSpanContext,
    },
  );

  if (ctx.attached) {
    root.otelSpan.setAttribute(LangfuseOtelSpanAttributes.IS_APP_ROOT, false);
  }

  let failure: unknown;
  try {
    const systemMessage = systemPromptText(turn.systemPrompt);
    const history = new GenerationHistory();
    const user = userMessage(turn);
    const spawnObservations = new Map<string, LangfuseObservation>();

    for (let i = 0; i < turn.steps.length; i++) {
      const step = turn.steps[i];
      const input = generationInput(
        systemMessage,
        user,
        ctx.historyPrefix,
        history,
        turn.toolDefinitions,
      );
      const generation = startObservation(
        isSubagent ? "LLM Subagent" : "LLM",
        {
          input: input.input,
          output: buildGenerationOutput(step),
          model: turn.model,
          ...(turn.reasoningEffort
            ? { modelParameters: { reasoning_effort: turn.reasoningEffort } }
            : {}),
          usageDetails: toUsageDetails(step.usage),
          metadata: {
            "codex.step_index": i,
            ...(input.truncated ? { "codex.generation_input.truncated": true } : {}),
            "codex.reasoning_effort": turn.reasoningEffort,
          },
        },
        {
          asType: "generation",
          startTime: new Date(step.startTime),
          parentSpanContext: root.otelSpan.spanContext(),
        },
      );

      for (const tc of step.toolCalls) {
        const observation = emitToolCall(tc, root, step.endTime);
        if (tc.name === "spawn_agent") spawnObservations.set(tc.callId, observation);
        await ctx.batch.ended(observation, ctx.spanIds);
      }

      generation.end(new Date(generationEnd(step)));
      await ctx.batch.ended(generation, ctx.spanIds);
      history.append([assistantMessage(step), ...toolMessages(step)]);
    }

    const announced: SubagentRollout[] = [];
    for (const threadId of turn.subagentThreadIds) {
      const rollout = ctx.subagentIndex.byThread.get(threadId);
      if (!rollout) {
        debugLog(`subagent rollout not found for thread ${threadId}`);
        continue;
      }
      announced.push(rollout);
    }
    for (const sub of [...announced, ...(ctx.unannouncedSubagents ?? [])]) {
      if (ctx.seenThreadIds.has(sub.threadId)) continue;
      ctx.seenThreadIds.add(sub.threadId);
      const seedBeforeChild = currentIdSeed();
      await convertRollout(sub.file, {
        config: ctx.config,
        parentObservation: spawnObservations.get(turn.subagentSpawnCallIds[sub.threadId]) ?? root,
        subagentIndex: ctx.subagentIndex,
        seenThreadIds: ctx.seenThreadIds,
        ancestorTurnIds: ctx.inheritableTurnIds,
        batch: ctx.batch,
        spanIds: ctx.spanIds,
        depth: (ctx.depth ?? 0) + 1,
      });
      seedIds(seedBeforeChild);
    }
  } catch (error) {
    failure = error;
    debugLog(`failed to convert turn ${turn.turnId ?? "(no turn id)"}:`, error);
    root.update({
      level: "ERROR",
      statusMessage: `Trace conversion failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
  }

  root.end(new Date(turn.endTime));
  try {
    await ctx.batch.ended(root, ctx.spanIds);
  } finally {
    seedIds(outerSeed);
  }
  if (failure && ctx.config.fail_on_error) throw failure;
  return failure === undefined;
}

function emitToolCall(
  tc: ToolCall,
  parent: LangfuseObservation,
  fallbackEnd: number,
): LangfuseObservation {
  const tool = startObservation(
    toolObservationName(tc),
    {
      input: tc.args,
      output: tc.output != null ? toText(tc.output) : undefined,
      level: tc.error ? "ERROR" : undefined,
      statusMessage: tc.error,
      metadata: { "codex.call_id": tc.callId, "codex.tool_name": tc.name || "tool" },
    },
    {
      asType: "tool",
      startTime: new Date(tc.startTime),
      parentSpanContext: parent.otelSpan.spanContext(),
    },
  );
  tool.end(new Date(tc.endTime ?? fallbackEnd));
  return tool;
}

function isFinal(
  turn: Turn,
  stoppedTurnId: string | undefined,
  supersededByLaterTurn: boolean,
): turn is Turn & { turnId: string } {
  if (turn.turnId == null) return false;
  return turn.completed || supersededByLaterTurn || turn.turnId === stoppedTurnId;
}

async function readTurnIds(file: string): Promise<Set<string>> {
  const ids = new Set<string>();
  for await (const { line } of readRollout(file, (await fs.stat(file)).size)) {
    if (line.type !== "event_msg") continue;
    const p = line.payload as EventMsgPayload;
    if (p.type === "task_started" && typeof p.turn_id === "string") ids.add(p.turn_id);
  }
  return ids;
}

async function ancestorTurnIdsOf(
  sessionMeta: SessionMeta,
  index: SubagentIndex,
): Promise<Set<string>> {
  const owned = new Set<string>();
  const seen = new Set<string>([sessionMeta.sessionId]);
  let ancestor = sessionMeta.parentThreadId;
  while (ancestor && !seen.has(ancestor)) {
    seen.add(ancestor);
    const rollout = index.byThread.get(ancestor);
    if (rollout) {
      try {
        const before = owned.size;
        for (const id of await readTurnIds(rollout.file)) owned.add(id);
        debugLog(`ancestor ${ancestor} owns ${owned.size - before} turn(s)`);
      } catch (error) {
        debugLog(`failed to read ancestor ${ancestor}; not skipping its turns:`, error);
        break;
      }
    }
    ancestor = rollout?.parentThreadId;
  }
  return owned;
}

export async function convertRollout(
  rolloutFile: string,
  options: {
    config: Config;
    parentObservation?: LangfuseObservation;
    parentSpanContext?: SpanContext;
    subagentIndex?: SubagentIndex;
    seenThreadIds?: Set<string>;
    ancestorTurnIds?: ReadonlySet<string>;
    stoppedTurnId?: string;
    flush?: () => Promise<ExportReceipt | void>;
    onTurnExported?: (turnId: string) => Promise<void>;
    depth?: number;
    batch?: ExportBatch;
    spanIds?: Set<string>;
  },
): Promise<string[]> {
  if ((options.depth ?? 0) > 16) throw new Error("Subagent nesting exceeds memory limit");
  const size = (await fs.stat(rolloutFile)).size;
  const sessionMeta = await readRolloutMeta(rolloutFile, size);
  // The first pass keeps only routing metadata. A later spawn announcement can
  // disambiguate an earlier child, so routing must be resolved before emission.
  const turns: TurnSummary[] = [];
  let routingBytes = 0;
  let totalTurns = 0;
  let routingTruncated = false;
  for await (const turn of readTurns(rolloutFile, size, sessionMeta)) {
    totalTurns++;
    if (routingTruncated) continue;
    const summary = {
      turnId: turn.turnId,
      startTime: turn.startTime,
      endTime: turn.endTime,
      subagentThreadIds: turn.subagentThreadIds,
      nicknames: spawnNicknames(turn),
    };
    const bytes = Buffer.byteLength(JSON.stringify(summary));
    if (turns.length >= ROLLOUT_LIMITS.turns || routingBytes + bytes > MAX_ROUTING_BYTES) {
      routingTruncated = true;
      continue;
    }
    routingBytes += bytes;
    turns.push(summary);
  }
  const history = new GenerationHistory();
  debugLog(`indexed ${turns.length} of ${totalTurns} turn(s) from ${path.basename(rolloutFile)}`);

  const subagentIndex =
    options.subagentIndex ??
    (await buildSubagentIndex(rolloutFile, {
      includeEarlierDays: sessionMeta.isSubagentThread === true,
    }));
  const seenThreadIds = options.seenThreadIds ?? new Set<string>();
  seenThreadIds.add(sessionMeta.sessionId);

  const announced = new Set(turns.flatMap((t) => t.subagentThreadIds));
  const unannounced = (subagentIndex.byParent.get(sessionMeta.sessionId) ?? []).filter(
    (s) =>
      !announced.has(s.threadId) &&
      !seenThreadIds.has(s.threadId) &&
      (!routingTruncated || s.startTime <= (turns.at(-1)?.endTime ?? 0)),
  );
  const spawnTurnOf =
    unannounced.length > 0 ? turnIndexByNickname(turns) : new Map<string, number>();
  const byTurn = new Map<number, SubagentRollout[]>();
  for (const sub of unannounced) {
    const viaNickname = sub.nickname !== undefined ? spawnTurnOf.get(sub.nickname) : undefined;
    const i = viaNickname ?? turnIndexAt(turns, sub.startTime);
    debugLog(
      `recovered unannounced subagent ${sub.threadId} for thread ${sessionMeta.sessionId}: ` +
        `turn ${i + 1} via ${viaNickname !== undefined ? `nickname ${sub.nickname}` : "start time"}`,
    );
    byTurn.set(i, [...(byTurn.get(i) ?? []), sub]);
  }

  const ancestorTurnIds =
    options.ancestorTurnIds ??
    (sessionMeta.isSubagentThread
      ? await ancestorTurnIdsOf(sessionMeta, subagentIndex)
      : undefined);

  const carriedSubagents: SubagentRollout[] = [];
  const subagentsFor = (turnIndex: number): SubagentRollout[] | undefined => {
    const own = byTurn.get(turnIndex) ?? [];
    const all = carriedSubagents.length > 0 ? [...carriedSubagents, ...own] : own;
    carriedSubagents.length = 0;
    return all.length > 0 ? all : undefined;
  };

  const skipInherited = (turn: Turn, turnIndex: number): boolean => {
    if (!turn.turnId || !ancestorTurnIds?.has(turn.turnId)) return false;
    debugLog(`skipping turn ${turn.turnId}: inherited from an ancestor thread`);
    carriedSubagents.push(...(byTurn.get(turnIndex) ?? []));
    return true;
  };

  const inheritableTurnIds = new Set(ancestorTurnIds);
  for (const turn of turns) {
    if (turn.turnId) inheritableTurnIds.add(turn.turnId);
  }

  const uploaded = await loadUploadedTurnIds(rolloutFile);
  const exportedTurnIds: string[] = [];
  const attached = options.parentSpanContext != null;
  const batch = options.batch ?? new ExportBatch(options.flush);

  let turnIndex = -1;
  for await (const turn of readTurns(rolloutFile, size, sessionMeta)) {
    turnIndex++;
    try {
      if (skipInherited(turn, turnIndex)) continue;

      if (options.parentObservation) {
        const success = await emitTurn(turn, sessionMeta, {
          config: options.config,
          rolloutFile,
          parentObservation: options.parentObservation,
          subagentIndex,
          seenThreadIds,
          unannouncedSubagents: subagentsFor(turnIndex),
          inheritableTurnIds,
          historyPrefix: history,
          batch,
          spanIds: options.spanIds ?? new Set(),
          routingTruncated,
          depth: options.depth,
        });
        if (!success) throw new Error(`Subagent turn ${turn.turnId ?? "(no turn id)"} failed`);
        continue;
      }

      if (!isFinal(turn, options.stoppedTurnId, turnIndex < totalTurns - 1)) {
        debugLog(`skipping turn ${turn.turnId ?? "(no turn id)"}: not final`);
        continue;
      }
      if (uploaded.has(turn.turnId)) {
        continue;
      }

      const parentSpanContext =
        options.parentSpanContext ??
        (await seededTraceParent(options.config, sessionMeta, turnIndex + 1));
      const spanIds = new Set<string>();

      const emit = () =>
        emitTurn(turn, sessionMeta, {
          config: options.config,
          rolloutFile,
          parentSpanContext,
          attached,
          subagentIndex,
          seenThreadIds,
          unannouncedSubagents: subagentsFor(turnIndex),
          inheritableTurnIds,
          historyPrefix: history,
          batch,
          spanIds,
          routingTruncated,
          depth: options.depth,
        });

      let success: boolean;
      if (attached) {
        success = await emit();
      } else {
        const tags = traceTags(options.config, turn);
        success = await propagateAttributes(
          {
            sessionId: sessionMeta.sessionId,
            traceName: sessionMeta.isSubagentThread ? "Codex Subagent Turn" : "Codex Turn",
            ...(options.config.user_id ? { userId: options.config.user_id } : {}),
            ...(tags.length > 0 ? { tags } : {}),
            ...(options.config.metadata ? { metadata: options.config.metadata } : {}),
          },
          emit,
        );
      }

      batch.complete({
        id: turn.turnId,
        spanIds,
        success,
        checkpoint: async (id) => {
          await options.onTurnExported?.(id);
          uploaded.add(id);
          exportedTurnIds.push(id);
        },
      });
    } finally {
      history.append(turnHistoryMessages(turn));
    }
  }

  if (!options.batch) {
    await batch.flush();
    if (batch.incomplete && options.config.fail_on_error) {
      throw new Error("Some turns were not completely delivered; they will be retried");
    }
  }
  return exportedTurnIds;
}
