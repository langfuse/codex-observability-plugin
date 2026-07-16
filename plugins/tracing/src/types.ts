/**
 * Types for the subset of OpenAI Codex rollout JSONL we consume.
 *
 * Codex persists every session as a newline-delimited JSON ("rollout") file at
 * `~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<threadId>.jsonl`. Each line
 * is `{ timestamp, type, payload }`, tagged by `type`:
 *
 * - `session_meta`  — one per file; session id, CLI version, model provider, …
 * - `turn_context`  — model + invocation parameters for the current turn
 * - `response_item` — model I/O items (messages, reasoning, tool calls, outputs)
 * - `event_msg`     — lifecycle events (turn start/complete, token usage, tool
 *                     execution begin/end, subagent spawn, …)
 * - `compacted`     — context-compaction markers (ignored)
 *
 * Only the fields the tracer reads are typed strictly; everything else is left
 * open via index signatures so we never crash on an unknown Codex version.
 */

export type SessionMetaPayload = {
  id: string;
  cli_version?: string;
  model_provider?: string | null;
  base_instructions?: { text: string } | null;
  [key: string]: unknown;
};

export type MessageContentPart = {
  type: string;
  text?: string;
  image_url?: unknown;
  [key: string]: unknown;
};

export type ResponseItemMessage = {
  type: "message";
  role: string;
  content: MessageContentPart[];
};

export type ResponseItemFunctionCall = {
  type: "function_call";
  name: string;
  call_id: string;
  arguments: string;
};

export type ResponseItemFunctionCallOutput = {
  type: "function_call_output";
  call_id: string;
  output: unknown;
};

export type ResponseItemCustomToolCall = {
  type: "custom_tool_call";
  call_id: string;
  name: string;
  input: string;
};

export type ResponseItemCustomToolCallOutput = {
  type: "custom_tool_call_output";
  call_id: string;
  output: unknown;
};

/** Server-side web search performed by the model (no separate output item). */
export type ResponseItemWebSearchCall = {
  type: "web_search_call";
  id?: string | null;
  status?: string | null;
  /** `{ type: "search", query }`, `{ type: "open_page", url }`, … */
  action?: Record<string, unknown> | null;
};

/** Shell execution for models using the built-in local shell tool. */
export type ResponseItemLocalShellCall = {
  type: "local_shell_call";
  id?: string | null;
  call_id?: string | null;
  status?: string | null;
  /** `{ type: "exec", command: string[], … }` */
  action?: Record<string, unknown> | null;
};

export type ResponseItemReasoning = {
  type: "reasoning";
  summary?: unknown[];
  content?: unknown[] | string | null;
  encrypted_content?: string | null;
};

export type ResponseItemOther = {
  type: string;
  [key: string]: unknown;
};

export type ResponseItem =
  | ResponseItemMessage
  | ResponseItemFunctionCall
  | ResponseItemFunctionCallOutput
  | ResponseItemCustomToolCall
  | ResponseItemCustomToolCallOutput
  | ResponseItemWebSearchCall
  | ResponseItemLocalShellCall
  | ResponseItemReasoning
  | ResponseItemOther;

export type TurnContextPayload = {
  model?: string;
  [key: string]: unknown;
};

export type TokenUsage = {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  cached_input_tokens?: number;
  reasoning_output_tokens?: number;
};

export type RateLimitWindow = {
  used_percent?: number;
  window_minutes?: number | null;
  resets_at?: number | null;
};

export type RateLimitsSnapshot = {
  limit_id?: string | null;
  primary?: RateLimitWindow | null;
  secondary?: RateLimitWindow | null;
  credits?: {
    has_credits?: boolean;
    unlimited?: boolean;
    balance?: string | null;
  } | null;
  plan_type?: string | null;
  rate_limit_reached_type?: string | null;
};

export type EventMsgPayload = {
  type: string;
  turn_id?: string | null;
  call_id?: string;
  /** token_count */
  info?: {
    total_token_usage?: TokenUsage;
    last_token_usage?: TokenUsage;
    model_context_window?: number;
  } | null;
  rate_limits?: RateLimitsSnapshot | null;
  /** collab_agent_spawn_end */
  new_thread_id?: string | null;
  /** mcp_tool_call_begin / mcp_tool_call_end */
  invocation?: { server?: string; tool?: string; arguments?: unknown } | null;
  /** web_search_end */
  query?: string;
  action?: Record<string, unknown> | null;
  /** exec_command_end / patch_apply_end */
  status?: string;
  exit_code?: number;
  stdout?: string;
  stderr?: string;
  aggregated_output?: string;
  error?: unknown;
  codex_error_info?: unknown;
  [key: string]: unknown;
};

export type RolloutLine =
  | { timestamp: string; type: "session_meta"; payload: SessionMetaPayload }
  | { timestamp: string; type: "response_item"; payload: ResponseItem }
  | { timestamp: string; type: "turn_context"; payload: TurnContextPayload }
  | { timestamp: string; type: "event_msg"; payload: EventMsgPayload }
  | { timestamp: string; type: string; payload: Record<string, unknown> };

/** Payload Codex passes to the `Stop` hook on stdin. */
export type HookInput = {
  session_id?: string;
  turn_id?: string | null;
  transcript_path: string;
  hook_event_name?: string;
};

/** Resolved session-level metadata. */
export type SessionMeta = {
  sessionId: string;
  cliVersion?: string;
  modelProvider?: string;
  baseInstructions?: string;
  /**
   * Whether this rollout belongs to a subagent thread rather than the main
   * session. Codex marks subagent rollouts with `parent_thread_id` and/or
   * `thread_source: "subagent"` in `session_meta`.
   */
  isSubagentThread?: boolean;
};

/** A single tool invocation, assembled from response items + event_msg. */
export type ToolCall = {
  callId: string;
  name: string;
  args: unknown;
  startTime: number;
  endTime?: number;
  output?: unknown;
  error?: string;
  /** Server/tool split for MCP calls, taken from mcp_tool_call_* events. */
  mcp?: { server: string; tool: string };
};

/** A single model response within a turn (one LLM call). */
export type ModelStep = {
  startTime: number;
  endTime: number;
  reasoning?: string;
  text?: string;
  toolCalls: ToolCall[];
  usage?: TokenUsage;
  rateLimitsBefore?: RateLimitsSnapshot;
  rateLimitsAfter?: RateLimitsSnapshot;
};

/** A fully assembled Codex turn, ready to convert into Langfuse observations. */
export type Turn = {
  turnId?: string;
  startTime: number;
  endTime: number;
  model?: string;
  invocationParams?: Record<string, unknown>;
  userInput?: string;
  finalOutput?: string;
  steps: ModelStep[];
  subagentThreadIds: string[];
  /** Whether a `task_complete`/`turn_aborted` event was seen for this turn. */
  completed: boolean;
  /** Whether the turn ended via `turn_aborted` (user interruption). */
  aborted: boolean;
  totalUsage?: TokenUsage;
};
