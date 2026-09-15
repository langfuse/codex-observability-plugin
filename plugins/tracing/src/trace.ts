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
import { parseArgs, parseSession } from "./parse.js";
import { loadUploadedTurnIds } from "./sidecar.js";
import type { ModelStep, RolloutLine, SessionMeta, TokenUsage, ToolCall, Turn } from "./types.js";
import { debugLog, toText, truncate } from "./utils.js";

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

/** Send Codex's inclusive counts using Langfuse's strict OpenAI usage schema. */
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

type Clip = {
  (value: string): string;
  (value: unknown): unknown;
};

/** Build a clip() that truncates long strings to `maxChars`. */
function makeClip(maxChars: number): Clip {
  function clip(value: string): string;
  function clip(value: unknown): unknown;
  function clip(value: unknown): unknown {
    if (typeof value !== "string") return value;
    const { text, meta } = truncate(value, maxChars);
    return meta ? `${text}\n…[truncated ${meta.originalLength - text.length} chars]` : text;
  }
  return clip;
}

function buildGenerationOutput(step: ModelStep, clip: Clip): Record<string, unknown> | undefined {
  const output: Record<string, unknown> = {};
  if (step.text) output.content = clip(step.text);
  if (step.reasoning) output.reasoning = clip(step.reasoning);
  if (step.toolCalls.length > 0) {
    output.tool_calls = step.toolCalls.map((tc) => ({
      id: tc.callId,
      name: tc.name,
      arguments: tc.args,
    }));
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

/**
 * Observation name for a tool call. MCP calls use the clean `server.tool`
 * split from the mcp_tool_call_* events instead of the mangled function name;
 * everything else uses the plain tool name. Call arguments (shell command,
 * search query, …) stay out of the name — they belong to the observation
 * input.
 */
function toolObservationName(tc: ToolCall): string {
  if (tc.mcp) return `${tc.mcp.server}.${tc.mcp.tool}`;
  return tc.name || "tool";
}

/** Emit a single turn (and its subagents) as a Langfuse observation tree. */
async function emitTurn(
  turn: Turn,
  sessionMeta: SessionMeta,
  ctx: {
    config: Config;
    rolloutFile: string;
    parentObservation?: LangfuseObservation;
    /** Pre-derived trace id for top-level turns (see seededTraceParent). */
    seededParent?: SpanContext;
    subagentIndex: SubagentIndex;
    seenThreadIds: Set<string>;
    unannouncedSubagents?: SubagentRollout[];
  },
): Promise<void> {
  const clip = makeClip(ctx.config.max_chars);

  // A turn belongs to a subagent when its rollout is marked as a subagent
  // thread or when it is being nested under a spawning turn.
  const isSubagent = sessionMeta.isSubagentThread === true || ctx.parentObservation != null;

  const root = startObservation(
    isSubagent ? "Codex Subagent Turn" : "Codex Turn",
    {
      input: turn.userInput != null ? clip(turn.userInput) : undefined,
      output: turn.finalOutput != null ? clip(turn.finalOutput) : undefined,
      level: turn.aborted ? "WARNING" : undefined,
      statusMessage: turn.aborted ? "Turn interrupted by user" : undefined,
      metadata: {
        "codex.turn_id": turn.turnId,
        "codex.thread_id": sessionMeta.sessionId,
        "codex.model": turn.model,
        "codex.model_provider": sessionMeta.modelProvider,
        "codex.cli_version": sessionMeta.cliVersion,
        "codex.aborted": turn.aborted,
        "codex.tool_call_count": turn.steps.reduce((n, s) => n + s.toolCalls.length, 0),
      },
    },
    {
      asType: "agent",
      startTime: new Date(turn.startTime),
      parentSpanContext: ctx.parentObservation?.otelSpan.spanContext() ?? ctx.seededParent,
    },
  );

  let previousToolResults: unknown = undefined;

  for (let i = 0; i < turn.steps.length; i++) {
    const step = turn.steps[i];
    const generation = startObservation(
      isSubagent ? "LLM Subagent" : "LLM",
      {
        input:
          i === 0
            ? turn.userInput != null
              ? clip(turn.userInput)
              : undefined
            : previousToolResults,
        output: buildGenerationOutput(step, clip),
        model: turn.model,
        usageDetails: toUsageDetails(step.usage),
        metadata: { "codex.step_index": i },
      },
      {
        asType: "generation",
        startTime: new Date(step.startTime),
        parentSpanContext: root.otelSpan.spanContext(),
      },
    );

    for (const tc of step.toolCalls) {
      emitToolCall(tc, generation, clip, step.endTime);
    }

    generation.end(new Date(step.endTime));

    previousToolResults =
      step.toolCalls.length > 0
        ? step.toolCalls.map((tc) => ({
            name: tc.name,
            output: tc.output != null ? clip(toText(tc.output)) : undefined,
            ...(tc.error ? { error: clip(tc.error) } : {}),
          }))
        : undefined;
  }

  // Subagent threads spawned by this turn are nested under the turn root.
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
    await convertRollout(sub.file, {
      config: ctx.config,
      parentObservation: root,
      subagentIndex: ctx.subagentIndex,
      seenThreadIds: ctx.seenThreadIds,
    });
  }

  root.end(new Date(turn.endTime));
}

function emitToolCall(
  tc: ToolCall,
  parent: LangfuseObservation,
  clip: Clip,
  fallbackEnd: number,
): void {
  const tool = startObservation(
    toolObservationName(tc),
    {
      input: tc.args,
      output: tc.output != null ? clip(toText(tc.output)) : undefined,
      level: tc.error ? "ERROR" : undefined,
      statusMessage: tc.error ? clip(tc.error) : undefined,
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

/**
 * Whether a turn is done growing and can be exported.
 *
 * Codex runs the `Stop` hook and appends `task_complete` only after it exits,
 * so the turn that just stopped is always still open on disk — `turn_id` from
 * the payload is the only signal that it is done. Waiting for the event alone
 * would defer that turn to the next invocation, which for a session's last turn
 * never comes; exporting every open turn duplicates it instead.
 */
function isFinal(turn: Turn, stoppedTurnId: string | undefined): boolean {
  if (turn.completed) return true;
  return turn.turnId != null && turn.turnId === stoppedTurnId;
}

/**
 * Convert a Codex rollout file into Langfuse traces.
 *
 * Top-level turns each become their own trace (grouped into a Langfuse session
 * via the Codex thread id). Subagent rollouts are nested under the spawning
 * turn via `parentObservation`.
 *
 * Returns the ids of the top-level turns that were emitted, for the caller to
 * record in the sidecar once the exporter has flushed.
 */
export async function convertRollout(
  rolloutFile: string,
  options: {
    config: Config;
    parentObservation?: LangfuseObservation;
    subagentIndex?: SubagentIndex;
    seenThreadIds?: Set<string>;
    stoppedTurnId?: string;
  },
): Promise<string[]> {
  const { sessionMeta, turns } = parseSession(await loadSession(rolloutFile));
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

  // Subagent rollout: nest everything under the parent turn, no dedup/session wrapping.
  if (options.parentObservation) {
    for (let turnIndex = 0; turnIndex < turns.length; turnIndex++) {
      await emitTurn(turns[turnIndex], sessionMeta, {
        config: options.config,
        rolloutFile,
        parentObservation: options.parentObservation,
        subagentIndex,
        seenThreadIds,
        unannouncedSubagents: byTurn.get(turnIndex),
      });
    }
    return [];
  }

  const uploaded = await loadUploadedTurnIds(rolloutFile);
  const exportedTurnIds: string[] = [];

  for (let turnIndex = 0; turnIndex < turns.length; turnIndex++) {
    const turn = turns[turnIndex];

    if (!isFinal(turn, options.stoppedTurnId)) {
      debugLog(`skipping turn ${turn.turnId ?? "(no turn id)"}: still open`);
      continue;
    }
    if (turn.turnId && uploaded.has(turn.turnId)) {
      continue; // already delivered by a previous hook invocation
    }

    // Turn numbering stays 1-based over the full rollout (including turns
    // skipped by dedup above) so the derived id is stable across hook runs.
    const seededParent = await seededTraceParent(options.config, sessionMeta, turnIndex + 1);

    await propagateAttributes(
      {
        sessionId: sessionMeta.sessionId,
        traceName: sessionMeta.isSubagentThread ? "Codex Subagent Turn" : "Codex Turn",
        ...(options.config.user_id ? { userId: options.config.user_id } : {}),
        ...(options.config.tags ? { tags: options.config.tags } : {}),
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
        });
      },
    );

    if (turn.turnId) {
      uploaded.add(turn.turnId);
      exportedTurnIds.push(turn.turnId);
    }
  }

  return exportedTurnIds;
}
