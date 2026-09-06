import type { SpanContext } from "@opentelemetry/api";
import { parseTraceParent } from "@opentelemetry/core";

import { debugLog } from "./utils.js";

export const EXTERNAL_TRACEPARENT_ENV_VAR = "LANGFUSE_CODEX_TRACEPARENT";

/** Read the transient W3C parent context supplied by the process owner. */
export function readExternalParentSpanContext(
  env: Readonly<Record<string, string | undefined>>,
  failOnError: boolean,
): SpanContext | undefined {
  const value = env[EXTERNAL_TRACEPARENT_ENV_VAR];
  if (value === undefined) return undefined;

  const parsed = parseTraceParent(value);
  if (parsed) {
    return { ...parsed, isRemote: true };
  }

  const error = new Error(`${EXTERNAL_TRACEPARENT_ENV_VAR} must be a valid W3C traceparent value`);
  debugLog(
    `invalid ${EXTERNAL_TRACEPARENT_ENV_VAR}; falling back to trace_seed or an auto-generated trace`,
  );
  if (failOnError) throw error;
  return undefined;
}
