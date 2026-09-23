/**
 * Reads the external parent span from the hook environment ("attached mode"), so
 * top-level Codex turns nest under a launching application's span instead of
 * opening their own trace: `LANGFUSE_CODEX_TRACEPARENT` wins over
 * `LANGFUSE_CODEX_PARENT_TRACE_ID` + `LANGFUSE_CODEX_PARENT_SPAN_ID`. Env only,
 * never `langfuse.json`; unscoped `TRACEPARENT` ignored (Codex injects its own);
 * sampled flag discarded; blank means unset; malformed falls back unless
 * `LANGFUSE_CODEX_FAIL_ON_ERROR=true`. Mirrors the Claude Code plugin.
 */

import { TraceFlags, type SpanContext } from "@opentelemetry/api";

import { debugLog } from "./utils.js";

export const EXTERNAL_TRACEPARENT_ENV_VAR = "LANGFUSE_CODEX_TRACEPARENT";
export const EXTERNAL_PARENT_TRACE_ID_ENV_VAR = "LANGFUSE_CODEX_PARENT_TRACE_ID";
export const EXTERNAL_PARENT_SPAN_ID_ENV_VAR = "LANGFUSE_CODEX_PARENT_SPAN_ID";

const TRACEPARENT = /^00-(?!0{32})([0-9a-f]{32})-(?!0{16})([0-9a-f]{16})-[0-9a-f]{2}$/;

function parseTraceparent(value: string): SpanContext | undefined {
  const match = TRACEPARENT.exec(value.trim().toLowerCase());
  if (!match) return undefined;
  return {
    traceId: match[1],
    spanId: match[2],
    traceFlags: TraceFlags.SAMPLED,
    isRemote: true,
  };
}

function readEnv(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function reject(message: string, failOnError: boolean): undefined {
  debugLog(`${message}; falling back to trace_seed or an auto-generated trace`);
  if (failOnError) throw new Error(message);
  return undefined;
}

export function readExternalParentSpanContext(
  env: Readonly<Record<string, string | undefined>>,
  failOnError: boolean,
): SpanContext | undefined {
  const traceparent = readEnv(env, EXTERNAL_TRACEPARENT_ENV_VAR);
  if (traceparent !== undefined) {
    return (
      parseTraceparent(traceparent) ??
      reject(`${EXTERNAL_TRACEPARENT_ENV_VAR} must be a valid W3C traceparent value`, failOnError)
    );
  }

  const traceId = readEnv(env, EXTERNAL_PARENT_TRACE_ID_ENV_VAR);
  const spanId = readEnv(env, EXTERNAL_PARENT_SPAN_ID_ENV_VAR);
  if (traceId === undefined && spanId === undefined) return undefined;

  return (
    parseTraceparent(`00-${traceId}-${spanId}-01`) ??
    reject(
      `${EXTERNAL_PARENT_TRACE_ID_ENV_VAR} and ${EXTERNAL_PARENT_SPAN_ID_ENV_VAR} must both be ` +
        `set to valid non-zero hex ids (32 and 16 characters)`,
      failOnError,
    )
  );
}
