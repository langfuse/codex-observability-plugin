import type {
  EventMsgPayload,
  MessageContentPart,
  ModelStep,
  RateLimitsSnapshot,
  ResponseItemFunctionCall,
  ResponseItemFunctionCallOutput,
  ResponseItemCustomToolCall,
  ResponseItemLocalShellCall,
  ResponseItemMessage,
  ResponseItemWebSearchCall,
  RolloutLine,
  SessionMeta,
  TokenUsage,
  ToolCall,
  Turn,
} from "./types.js";
import { isPrimitive, toText } from "./utils.js";

/** Extract printable text from a Codex message `content` array. */
function extractMessageText(content: MessageContentPart[] | undefined): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      if (part.type === "input_text" || part.type === "output_text" || part.type === "text") {
        return typeof part.text === "string" ? part.text : "";
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/** Extract reasoning text, skipping encrypted-only reasoning items. */
function extractReasoning(item: {
  content?: unknown[] | string | null;
  summary?: unknown[];
}): string {
  if (typeof item.content === "string") return item.content;
  if (Array.isArray(item.content)) {
    return item.content
      .map((c) =>
        c && typeof c === "object" && "text" in c
          ? toText((c as { text: unknown }).text)
          : toText(c),
      )
      .filter(Boolean)
      .join("\n");
  }
  if (Array.isArray(item.summary) && item.summary.length > 0) {
    return item.summary
      .map((s) => toText(s))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function parseArgs(raw: string): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function extractToolError(payload: EventMsgPayload): string | undefined {
  const explicit = payload.error ?? payload.codex_error_info;
  if (explicit != null) {
    return isPrimitive(explicit) ? String(explicit) : JSON.stringify(explicit);
  }
  const streams = [payload.stdout, payload.stderr]
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .join("\n");
  if (typeof payload.aggregated_output === "string" && payload.aggregated_output) {
    return payload.aggregated_output;
  }
  if (streams) return streams;
  if (typeof payload.exit_code === "number") return `Exit code: ${payload.exit_code}`;
  return undefined;
}

/** A turn that is still being assembled. */
type MutableTurn = Turn & { lastAgentMessage?: string; userInputFallback?: string };

function newTurn(startTime: number): MutableTurn {
  return {
    turnId: undefined,
    startTime,
    endTime: startTime,
    steps: [],
    subagentThreadIds: [],
    completed: false,
    aborted: false,
  };
}

/**
 * Parse a Codex rollout into session metadata and a list of fully assembled
 * turns.
 *
 * Codex interleaves model I/O (`response_item`) with lifecycle events
 * (`event_msg`). We reconstruct each turn as a sequence of model steps (one per
 * model response, delimited by `token_count` events) plus the tool calls each
 * step issued. Tool execution details (status, exit code, output) arrive later
 * as `*_end` events and are matched back to their call by `call_id`.
 */
export function parseSession(lines: RolloutLine[]): {
  sessionMeta: SessionMeta;
  turns: Turn[];
} {
  let sessionMeta: SessionMeta = { sessionId: "unknown" };
  const turns: Turn[] = [];

  let turn: MutableTurn | null = null;
  let step: ModelStep | null = null;
  let toolCallsById = new Map<string, ToolCall>();
  let lastRateLimits: RateLimitsSnapshot | undefined;
  let lastTimestamp = Date.now();

  function newStep(startTime: number): ModelStep {
    return { startTime, endTime: startTime, toolCalls: [] };
  }

  const ensureTurn = (ts: number): MutableTurn => (turn ??= newTurn(ts));
  const ensureStep = (ts: number) => (step ??= newStep(ts));

  const closeStep = (ts: number, usage?: TokenUsage, rateLimitsAfter?: RateLimitsSnapshot) => {
    if (!step) return;
    step.endTime = Math.max(step.endTime, ts);
    if (usage) step.usage = usage;
    if (lastRateLimits) step.rateLimitsBefore = lastRateLimits;
    if (rateLimitsAfter) step.rateLimitsAfter = rateLimitsAfter;
    turn!.steps.push(step);
    step = null;
    if (rateLimitsAfter) lastRateLimits = rateLimitsAfter;
  };

  const finishTurn = (ts: number, opts: { completed: boolean; aborted: boolean }) => {
    if (!turn) return;
    closeStep(ts);
    turn.endTime = Math.max(turn.endTime, ts);
    turn.completed = opts.completed;
    turn.aborted = opts.aborted;
    turn.userInput = turn.userInput ?? turn.userInputFallback;
    turn.finalOutput = turn.lastAgentMessage ?? turn.steps.filter((s) => s.text).at(-1)?.text;
    delete turn.lastAgentMessage;
    delete turn.userInputFallback;
    turns.push(turn);
    turn = null;
    toolCallsById = new Map();
  };

  for (const line of lines) {
    const ts = Number.isFinite(Date.parse(line.timestamp))
      ? Date.parse(line.timestamp)
      : lastTimestamp;
    lastTimestamp = ts;

    if (line.type === "session_meta") {
      const p = line.payload as RolloutLine["payload"] & {
        id?: string;
        cli_version?: string;
        model_provider?: string | null;
        base_instructions?: { text?: string } | null;
        parent_thread_id?: string | null;
        thread_source?: string | null;
      };
      sessionMeta = {
        sessionId: typeof p.id === "string" ? p.id : sessionMeta.sessionId,
        cliVersion: p.cli_version,
        modelProvider: p.model_provider ?? undefined,
        baseInstructions: p.base_instructions?.text,
        isSubagentThread: typeof p.parent_thread_id === "string" || p.thread_source === "subagent",
      };
      continue;
    }

    if (line.type === "turn_context") {
      const t = ensureTurn(ts);
      const p = line.payload as { model?: string };
      t.model = p.model ?? t.model;
      t.invocationParams = line.payload as Record<string, unknown>;
      continue;
    }

    if (line.type === "response_item") {
      // `payload.type` is an open string set across Codex versions, so we
      // switch on it and cast into the concrete shape per branch rather than
      // relying on discriminated-union narrowing.
      const p = line.payload as { type?: string } & Record<string, unknown>;
      ensureTurn(ts);

      if (p.type === "message") {
        const msg = p as unknown as ResponseItemMessage;
        const text = extractMessageText(msg.content as MessageContentPart[]);
        if (msg.role === "assistant") {
          const s = ensureStep(ts);
          if (text) s.text = s.text ? `${s.text}\n${text}` : text;
        } else if (msg.role === "user" && text) {
          // Codex injects <environment_context>/<user_instructions> as user
          // messages; keep only the first that does not look like wrapper XML.
          if (
            !turn!.userInputFallback &&
            !/^<(environment_context|user_instructions)/.test(text.trim())
          ) {
            turn!.userInputFallback = text;
          }
        }
      } else if (p.type === "function_call") {
        const call = p as unknown as ResponseItemFunctionCall;
        const s = ensureStep(ts);
        const tc: ToolCall = {
          callId: call.call_id,
          name: call.name,
          args: parseArgs(call.arguments),
          startTime: ts,
        };
        s.toolCalls.push(tc);
        toolCallsById.set(tc.callId, tc);
      } else if (p.type === "custom_tool_call") {
        const call = p as unknown as ResponseItemCustomToolCall;
        const s = ensureStep(ts);
        const tc: ToolCall = {
          callId: call.call_id,
          name: call.name,
          args: parseArgs(call.input),
          startTime: ts,
        };
        s.toolCalls.push(tc);
        toolCallsById.set(tc.callId, tc);
      } else if (p.type === "local_shell_call") {
        // Built-in local shell tool: the command lives in `action`, and
        // exec_command_end / function_call_output enrich it like any function
        // call.
        const call = p as unknown as ResponseItemLocalShellCall;
        const s = ensureStep(ts);
        const tc: ToolCall = {
          callId: call.call_id ?? call.id ?? `local_shell_${ts}_${s.toolCalls.length}`,
          name: "local_shell",
          args: call.action ?? undefined,
          startTime: ts,
        };
        s.toolCalls.push(tc);
        toolCallsById.set(tc.callId, tc);
      } else if (p.type === "web_search_call") {
        // Server-side web search: there is no output item, and the
        // web_search_end event may be recorded before or after this item, so
        // merge with an existing call when one was already registered.
        const call = p as unknown as ResponseItemWebSearchCall;
        const callId = call.id ?? `web_search_${ts}`;
        const existing = toolCallsById.get(callId);
        if (existing) {
          existing.args = existing.args ?? call.action ?? undefined;
          existing.endTime = Math.max(existing.endTime ?? ts, ts);
        } else {
          const s = ensureStep(ts);
          const tc: ToolCall = {
            callId,
            name: "web_search",
            args: call.action ?? undefined,
            startTime: ts,
          };
          s.toolCalls.push(tc);
          toolCallsById.set(callId, tc);
        }
      } else if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
        const out = p as unknown as ResponseItemFunctionCallOutput;
        const tc = toolCallsById.get(out.call_id);
        if (tc) {
          if (tc.output == null) tc.output = out.output;
          tc.endTime = Math.max(tc.endTime ?? ts, ts);
        }
      } else if (p.type === "reasoning") {
        const reasoning = extractReasoning(
          p as { content?: unknown[] | string | null; summary?: unknown[] },
        );
        if (reasoning) {
          const s = ensureStep(ts);
          s.reasoning = s.reasoning ? `${s.reasoning}\n${reasoning}` : reasoning;
        }
      }
      continue;
    }

    if (line.type === "event_msg") {
      const p = line.payload as EventMsgPayload;
      const et = p.type;

      if (et === "task_started") {
        if (turn) finishTurn(ts, { completed: false, aborted: false });
        turn = newTurn(ts);
        turn.turnId = typeof p.turn_id === "string" ? p.turn_id : undefined;
        continue;
      }

      ensureTurn(ts);

      if (et === "user_message" && typeof p.message === "string") {
        if (!turn!.userInput) turn!.userInput = p.message;
      } else if (et === "agent_message" && typeof p.message === "string") {
        turn!.lastAgentMessage = p.message;
      } else if (et === "token_count") {
        if (p.info?.total_token_usage) turn!.totalUsage = p.info.total_token_usage;
        closeStep(ts, p.info?.last_token_usage ?? undefined, p.rate_limits ?? undefined);
      } else if (et === "task_complete") {
        finishTurn(ts, { completed: true, aborted: false });
      } else if (et === "turn_aborted") {
        finishTurn(ts, { completed: true, aborted: true });
      } else {
        // A subagent spawn records the child thread *and* (since it carries a
        // call_id ending in "_end") enriches the spawning tool call below.
        if (et === "collab_agent_spawn_end" && typeof p.new_thread_id === "string") {
          turn!.subagentThreadIds.push(p.new_thread_id);
        }
        // MCP tool calls are function calls with a mangled name
        // (`server__tool`); the begin/end events carry the clean server/tool
        // split, which makes a much better observation name.
        if (
          (et === "mcp_tool_call_begin" || et === "mcp_tool_call_end") &&
          typeof p.call_id === "string"
        ) {
          const tc = toolCallsById.get(p.call_id);
          const inv = p.invocation;
          if (tc && typeof inv?.server === "string" && typeof inv?.tool === "string") {
            tc.mcp = { server: inv.server, tool: inv.tool };
          }
        }
        // Web searches run server-side inside the model response. The end
        // event can be recorded before the web_search_call response item, so
        // register the call here if it is not known yet.
        if (et === "web_search_end" && typeof p.call_id === "string") {
          let tc = toolCallsById.get(p.call_id);
          if (!tc) {
            tc = { callId: p.call_id, name: "web_search", args: undefined, startTime: ts };
            ensureStep(ts).toolCalls.push(tc);
            toolCallsById.set(tc.callId, tc);
          }
          tc.args =
            tc.args ?? p.action ?? (typeof p.query === "string" ? { query: p.query } : undefined);
        }
        // Tool execution lifecycle events (exec_command_end, patch_apply_end,
        // mcp_tool_call_end, collab_*_end, …) match a call by id and add
        // timing, status, and output.
        if (typeof p.call_id === "string" && et.endsWith("_end")) {
          const tc = toolCallsById.get(p.call_id);
          if (tc) {
            tc.endTime = Math.max(tc.endTime ?? ts, ts);
            if (p.status === "failed" || p.status === "declined") {
              tc.error = extractToolError(p);
            }
            if (tc.output == null) {
              tc.output = p.aggregated_output ?? p.stdout ?? (p as { result?: unknown }).result;
            }
          }
        }
      }
      continue;
    }
  }

  // Trailing, not-yet-completed turn (e.g. session ended mid-response).
  if (turn) finishTurn(lastTimestamp, { completed: false, aborted: false });

  return { sessionMeta, turns };
}
