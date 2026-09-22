import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  createTraceId,
  propagateAttributes,
  startObservation,
  type LangfuseGenerationAttributes,
  type LangfuseObservation,
} from "@langfuse/tracing";
import { TraceFlags, type SpanContext } from "@opentelemetry/api";

import type { Config } from "./config.js";
import { currentIdSeed, seedIds } from "./instrumentation.js";
import { parseArgs, parseSession } from "./parse.js";
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

async function loadSession(file: string): Promise<RolloutLine[]> {
  const data = await fs.readFile(file, "utf-8");
  const lines: RolloutLine[] = [];
  for (const raw of data.split("\n")) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    try {
      lines.push(JSON.parse(trimmed) as RolloutLine);
    } catch {
      // skip malformed lines rather than aborting the whole upload
    }
  }
  return lines;
}

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

export async function buildSubagentIndex(rolloutFile: string): Promise<SubagentIndex> {
  const root = path.resolve(path.dirname(rolloutFile), "../../..");
  const fromDay = path.relative(root, path.dirname(rolloutFile));
  const bounded = /^\d{4}\/\d{2}\/\d{2}$/.test(fromDay);
  const index: SubagentIndex = { byParent: new Map(), byThread: new Map() };

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

function turnIndexByNickname(turns: Turn[]): Map<string, number> {
  const byNickname = new Map<string, number>();
  const ambiguous = new Set<string>();
  turns.forEach((turn, index) => {
    for (const tc of turn.steps.flatMap((s) => s.toolCalls)) {
      if (tc.name !== "spawn_agent" || tc.output == null) continue;
      const out = parseArgs(toText(tc.output));
      const nickname =
        out !== null && typeof out === "object"
          ? (out as { nickname?: unknown }).nickname
          : undefined;
      if (typeof nickname !== "string" || !nickname) continue;
      if (byNickname.has(nickname) && byNickname.get(nickname) !== index) {
        ambiguous.add(nickname);
      }
      byNickname.set(nickname, index);
    }
  });
  for (const nickname of ambiguous) byNickname.delete(nickname);
  return byNickname;
}

function turnIndexAt(turns: Turn[], startTime: number): number {
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
  | { role: "user"; content: string }
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
  if (turn.userInput != null) messages.push({ role: "user", content: turn.userInput });
  for (const step of turn.steps) {
    messages.push(assistantMessage(step));
    messages.push(...toolMessages(step));
  }
  return messages;
}

function generationInput(
  systemMessage: string | undefined,
  historyPrefix: ChatMlMessage[],
  turn: Turn,
  stepIndex: number,
): ChatMlMessage[] | undefined {
  const messages: ChatMlMessage[] = [];
  if (systemMessage) messages.push({ role: "system", content: systemMessage });
  messages.push(...historyPrefix);
  if (turn.userInput != null) messages.push({ role: "user", content: turn.userInput });
  for (let j = 0; j < stepIndex; j++) {
    messages.push(assistantMessage(turn.steps[j]));
    messages.push(...toolMessages(turn.steps[j]));
  }
  return messages.length > 0 ? messages : undefined;
}

type ContentPart =
  { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

function validDataUri(uri: string): boolean {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(uri);
  return match !== null && !match[1].includes(";");
}

function toMultimodalContent(
  text: string | undefined,
  images: readonly string[],
): string | ContentPart[] | undefined {
  const urls = images.filter(validDataUri);
  if (urls.length === 0) return text;
  return [
    ...(text ? [{ type: "text" as const, text }] : []),
    ...urls.map((url) => ({ type: "image_url" as const, image_url: { url } })),
  ];
}

function attachToolDefinitions(
  input: ChatMlMessage[] | undefined,
  tools: ToolDefinition[],
): unknown {
  if (!input || tools.length === 0) return input;
  const [first, ...rest] = input;
  return first ? [{ ...first, tools }, ...rest] : input;
}

async function emitTurn(
  turn: Turn,
  sessionMeta: SessionMeta,
  ctx: {
    config: Config;
    rolloutFile: string;
    parentObservation?: LangfuseObservation;
    seededParent?: SpanContext;
    subagentIndex: SubagentIndex;
    seenThreadIds: Set<string>;
    unannouncedSubagents?: SubagentRollout[];
    inheritableTurnIds?: ReadonlySet<string>;
    historyPrefix?: ChatMlMessage[];
  },
): Promise<void> {
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
      parentSpanContext: ctx.parentObservation?.otelSpan.spanContext() ?? ctx.seededParent,
    },
  );

  let failure: unknown;
  try {
    const systemMessage = systemPromptText(turn.systemPrompt);
    const historyPrefix = ctx.historyPrefix ?? [];

    for (let i = 0; i < turn.steps.length; i++) {
      const step = turn.steps[i];
      const generation = startObservation(
        isSubagent ? "LLM Subagent" : "LLM",
        {
          input: attachToolDefinitions(
            generationInput(systemMessage, historyPrefix, turn, i),
            turn.toolDefinitions,
          ),
          output: buildGenerationOutput(step),
          model: turn.model,
          ...(turn.reasoningEffort
            ? { modelParameters: { reasoning_effort: turn.reasoningEffort } }
            : {}),
          usageDetails: toUsageDetails(step.usage),
          metadata: {
            "codex.step_index": i,
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
        emitToolCall(tc, generation, step.endTime);
      }

      generation.end(new Date(step.endTime));
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
        parentObservation: root,
        subagentIndex: ctx.subagentIndex,
        seenThreadIds: ctx.seenThreadIds,
        ancestorTurnIds: ctx.inheritableTurnIds,
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
  seedIds(outerSeed);
  if (failure && ctx.config.fail_on_error) throw failure;
}

function emitToolCall(tc: ToolCall, parent: LangfuseObservation, fallbackEnd: number): void {
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
  for (const line of await loadSession(file)) {
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
    subagentIndex?: SubagentIndex;
    seenThreadIds?: Set<string>;
    ancestorTurnIds?: ReadonlySet<string>;
    stoppedTurnId?: string;
  },
): Promise<string[]> {
  const { sessionMeta, turns } = parseSession(await loadSession(rolloutFile));

  const historyPrefixes: ChatMlMessage[][] = [];
  {
    const seen: ChatMlMessage[] = [];
    for (const turn of turns) {
      historyPrefixes.push([...seen]);
      seen.push(...turnHistoryMessages(turn));
    }
  }
  debugLog(`parsed ${turns.length} turn(s) from ${path.basename(rolloutFile)}`);

  const subagentIndex = options.subagentIndex ?? (await buildSubagentIndex(rolloutFile));
  const seenThreadIds = options.seenThreadIds ?? new Set<string>();
  seenThreadIds.add(sessionMeta.sessionId);

  const announced = new Set(turns.flatMap((t) => t.subagentThreadIds));
  const unannounced = (subagentIndex.byParent.get(sessionMeta.sessionId) ?? []).filter(
    (s) => !announced.has(s.threadId) && !seenThreadIds.has(s.threadId),
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

  const isInherited = (turn: Turn): boolean => {
    if (!turn.turnId || !ancestorTurnIds?.has(turn.turnId)) return false;
    debugLog(`skipping turn ${turn.turnId}: inherited from an ancestor thread`);
    return true;
  };

  const inheritableTurnIds = new Set(ancestorTurnIds);
  for (const turn of turns) {
    if (turn.turnId) inheritableTurnIds.add(turn.turnId);
  }

  if (options.parentObservation) {
    for (let turnIndex = 0; turnIndex < turns.length; turnIndex++) {
      const turn = turns[turnIndex];
      if (isInherited(turn)) continue;
      await emitTurn(turn, sessionMeta, {
        config: options.config,
        rolloutFile,
        parentObservation: options.parentObservation,
        subagentIndex,
        seenThreadIds,
        unannouncedSubagents: byTurn.get(turnIndex),
        inheritableTurnIds,
        historyPrefix: historyPrefixes[turnIndex],
      });
    }
    return [];
  }

  const uploaded = await loadUploadedTurnIds(rolloutFile);
  const exportedTurnIds: string[] = [];

  for (let turnIndex = 0; turnIndex < turns.length; turnIndex++) {
    const turn = turns[turnIndex];

    if (isInherited(turn)) continue;

    if (!isFinal(turn, options.stoppedTurnId, turnIndex < turns.length - 1)) {
      debugLog(`skipping turn ${turn.turnId ?? "(no turn id)"}: not final`);
      continue;
    }
    if (uploaded.has(turn.turnId)) {
      continue;
    }

    const seededParent = await seededTraceParent(options.config, sessionMeta, turnIndex + 1);

    const tags = traceTags(options.config, turn);

    await propagateAttributes(
      {
        sessionId: sessionMeta.sessionId,
        traceName: sessionMeta.isSubagentThread ? "Codex Subagent Turn" : "Codex Turn",
        ...(options.config.user_id ? { userId: options.config.user_id } : {}),
        ...(tags.length > 0 ? { tags } : {}),
        ...(options.config.metadata ? { metadata: options.config.metadata } : {}),
      },
      async () => {
        await emitTurn(turn, sessionMeta, {
          config: options.config,
          rolloutFile,
          seededParent,
          subagentIndex,
          seenThreadIds,
          unannouncedSubagents: byTurn.get(turnIndex),
          inheritableTurnIds,
          historyPrefix: historyPrefixes[turnIndex],
        });
      },
    );

    uploaded.add(turn.turnId);
    exportedTurnIds.push(turn.turnId);
  }

  return exportedTurnIds;
}
