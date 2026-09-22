import { skillsForPrompt } from "./skills.js";
import type {
  EventMsgPayload,
  MessageContentPart,
  ModelStep,
  ResponseItemFunctionCall,
  ResponseItemFunctionCallOutput,
  ResponseItemCustomToolCall,
  ResponseItemLocalShellCall,
  ResponseItemMessage,
  ResponseItemWebSearchCall,
  RolloutLine,
  SessionMeta,
  SystemPrompt,
  ToolDefinition,
  TokenUsage,
  ToolCall,
  Turn,
  TurnContextPayload,
} from "./types.js";
import { isPrimitive, toText } from "./utils.js";

function extractImageUris(content: MessageContentPart[] | undefined): string[] {
  if (!Array.isArray(content)) return [];
  return content
    .map((part) =>
      part && typeof part === "object" && typeof part.image_url === "string" ? part.image_url : "",
    )
    .filter(Boolean);
}

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

export function parseArgs(raw: string): unknown {
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

type MutableTurn = Turn & { lastAgentMessage?: string; userInputFallback?: string };

const TURN_OPENING_EVENTS = new Set(["user_message", "item_completed", "agent_message"]);

function newTurn(startTime: number): MutableTurn {
  return {
    turnId: undefined,
    startTime,
    endTime: startTime,
    steps: [],
    subagentThreadIds: [],
    promptSkills: [],
    userImages: [],
    toolDefinitions: [],
    completed: false,
    aborted: false,
  };
}

export function parseSession(lines: RolloutLine[]): {
  sessionMeta: SessionMeta;
  turns: Turn[];
} {
  let sessionMeta: SessionMeta = { sessionId: "unknown" };
  const turns: Turn[] = [];

  let turn: MutableTurn | null = null;
  let step: ModelStep | null = null;
  let toolCallsById = new Map<string, ToolCall>();
  let lastTimestamp = Date.now();

  const developerMessages: string[] = [];
  const injectedContext: string[] = [];
  const toolDefinitions: ToolDefinition[] = [];
  let exportedSegmentCount = 0;

  const collect = (into: string[], text: string) => {
    if (!into.includes(text)) into.push(text);
  };

  const systemPromptFor = (): SystemPrompt | undefined => {
    const base = sessionMeta.baseInstructions;
    const segmentCount = (base ? 1 : 0) + developerMessages.length + injectedContext.length;
    if (segmentCount === 0) return undefined;
    const snapshot: SystemPrompt = {
      baseInstructions: base,
      developerMessages: [...developerMessages],
      injectedContext: [...injectedContext],
      changed: segmentCount !== exportedSegmentCount,
    };
    exportedSegmentCount = segmentCount;
    return snapshot;
  };

  function newStep(startTime: number): ModelStep {
    return { startTime, endTime: startTime, toolCalls: [] };
  }

  const ensureTurn = (ts: number): MutableTurn => (turn ??= newTurn(ts));
  const ensureStep = (ts: number) => (step ??= newStep(ts));

  const recordSubagentThread = (threadId: string) => {
    if (!turn!.subagentThreadIds.includes(threadId)) {
      turn!.subagentThreadIds.push(threadId);
    }
  };

  const closeStep = (ts: number, usage?: TokenUsage) => {
    if (!step) return;
    step.endTime = Math.max(step.endTime, ts);
    if (usage) step.usage = usage;
    turn!.steps.push(step);
    step = null;
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
    const isUnannouncedAndEmpty =
      !turn.turnId &&
      turn.userInput == null &&
      turn.finalOutput == null &&
      turn.steps.length === 0 &&
      turn.subagentThreadIds.length === 0;
    if (!isUnannouncedAndEmpty) {
      turn.systemPrompt = systemPromptFor();
      turn.toolDefinitions = [...toolDefinitions];
      turns.push(turn);
    }
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
      const p = line.payload as TurnContextPayload;
      t.model = p.model ?? t.model;
      const effort = typeof p.effort === "string" ? p.effort : p.reasoning_effort;
      if (typeof effort === "string") t.reasoningEffort = effort;
      t.invocationParams = line.payload as Record<string, unknown>;
      continue;
    }

    if (line.type === "response_item") {
      const p = line.payload as { type?: string } & Record<string, unknown>;
      ensureTurn(ts);

      if (p.type === "message") {
        const msg = p as unknown as ResponseItemMessage;
        const text = extractMessageText(msg.content as MessageContentPart[]);
        if (msg.role === "user") {
          for (const uri of extractImageUris(msg.content as MessageContentPart[])) {
            if (!turn!.userImages.includes(uri)) turn!.userImages.push(uri);
          }
        }
        if (msg.role === "assistant") {
          const s = ensureStep(ts);
          if (text) s.text = s.text ? `${s.text}\n${text}` : text;
        } else if (msg.role === "developer" && text) {
          collect(developerMessages, text);
        } else if (msg.role === "user" && text) {
          for (const name of skillsForPrompt(text)) {
            if (!turn!.promptSkills.includes(name)) turn!.promptSkills.push(name);
          }
          const isInjectedContext =
            /<\/?(environment_context|user_instructions|skill)\b/.test(text) ||
            /^# AGENTS\.md instructions for\b/.test(text.trim());
          if (isInjectedContext) {
            collect(injectedContext, text);
          } else if (!turn!.userInputFallback) {
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
          if (tc.name === "spawn_agent") {
            const spawned = parseArgs(toText(out.output));
            const agentId =
              spawned !== null && typeof spawned === "object"
                ? (spawned as { agent_id?: unknown }).agent_id
                : undefined;
            if (typeof agentId === "string" && agentId) recordSubagentThread(agentId);
          }
        }
      } else if (p.type === "tool_search_output") {
        const namespaces = Array.isArray(p.tools) ? p.tools : [];
        for (const ns of namespaces) {
          if (!ns || typeof ns !== "object") continue;
          const entry = ns as { type?: string; tools?: unknown[] } & ToolDefinition;
          const nested = Array.isArray(entry.tools) ? entry.tools : [entry];
          for (const raw of nested) {
            if (!raw || typeof raw !== "object") continue;
            const tool = raw as { name?: unknown; description?: unknown; parameters?: unknown };
            if (typeof tool.name !== "string" || !tool.name) continue;
            if (toolDefinitions.some((known) => known.name === tool.name)) continue;
            toolDefinitions.push({
              name: tool.name,
              ...(typeof tool.description === "string" ? { description: tool.description } : {}),
              ...(tool.parameters !== undefined ? { parameters: tool.parameters } : {}),
            });
          }
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

      if (TURN_OPENING_EVENTS.has(et)) ensureTurn(ts);
      else if (!turn) continue;

      if (et === "user_message" && typeof p.message === "string") {
        if (!turn!.userInput) turn!.userInput = p.message;
      } else if (et === "item_completed" && p.item?.type === "UserMessage") {
        const text = extractMessageText(p.item.content);
        if (text && !turn!.userInput) turn!.userInput = text;
      } else if (et === "agent_message" && typeof p.message === "string") {
        turn!.lastAgentMessage = p.message;
      } else if (et === "token_count") {
        if (p.info?.total_token_usage) turn!.totalUsage = p.info.total_token_usage;
        closeStep(ts, p.info?.last_token_usage ?? undefined);
      } else if (et === "task_complete") {
        finishTurn(ts, { completed: true, aborted: false });
      } else if (et === "turn_aborted") {
        finishTurn(ts, { completed: true, aborted: true });
      } else {
        if (et === "collab_agent_spawn_end" && typeof p.new_thread_id === "string") {
          recordSubagentThread(p.new_thread_id);
        }
        if (
          et === "sub_agent_activity" &&
          p.kind === "started" &&
          typeof p.agent_thread_id === "string"
        ) {
          recordSubagentThread(p.agent_thread_id);
        }
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

  if (turn) finishTurn(lastTimestamp, { completed: false, aborted: false });

  return { sessionMeta, turns };
}
