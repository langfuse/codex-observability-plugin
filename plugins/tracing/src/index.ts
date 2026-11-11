import { getConfig } from "./config.js";
import { diagnostic, diagnosticError } from "./diagnostics.js";
import { setupInstrumentation } from "./instrumentation.js";
import { readExternalParentSpanContext } from "./parent-context.js";
import { markTurnUploaded } from "./sidecar.js";
import { convertRollout } from "./trace.js";
import type { HookInput } from "./types.js";
import { debugLog, readStdin, setDebug } from "./utils.js";

let failOnError = process.env.LANGFUSE_CODEX_FAIL_ON_ERROR === "true";

/**
 * Entry point for the Codex `Stop` hook.
 *
 * Codex pipes a JSON payload to stdin after every turn. We resolve config,
 * bail out unless tracing is explicitly enabled, then convert the rollout
 * transcript into Langfuse traces.
 *
 * The hook fails open: any error is logged (in debug mode) and swallowed so a
 * tracing problem never blocks the Codex session. Set
 * `LANGFUSE_CODEX_FAIL_ON_ERROR=true` while testing if you want Codex to report
 * hook failures instead.
 */
export async function runHook(): Promise<void> {
  const started = Date.now();
  diagnostic("hook_started");
  let hookInput: HookInput;
  try {
    hookInput = await readStdin<HookInput>();
  } catch (error) {
    diagnosticError("stdin_failed", error);
    return;
  }

  const config = await getConfig();
  setDebug(config.debug);
  failOnError = config.fail_on_error;

  diagnostic("config_loaded", {
    enabled: config.enabled,
    has_credentials: !!config.public_key && !!config.secret_key,
    has_transcript: !!hookInput.transcript_path,
    has_turn_id: !!hookInput.turn_id,
  });
  if (!config.enabled) {
    debugLog("tracing disabled (set TRACE_TO_LANGFUSE=true to enable)");
    diagnostic("hook_skipped", { reason: "disabled" });
    return;
  }
  if (!config.public_key || !config.secret_key) {
    debugLog("missing LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY; skipping");
    diagnostic("hook_skipped", { reason: "missing_credentials" });
    return;
  }
  if (!hookInput.transcript_path) {
    debugLog("hook payload missing transcript_path; skipping");
    diagnostic("hook_skipped", { reason: "missing_transcript" });
    return;
  }

  const parentSpanContext = readExternalParentSpanContext(process.env, config.fail_on_error);
  if (parentSpanContext && config.trace_seed) {
    debugLog("trace_seed ignored: an external parent trace context takes precedence");
  }

  const instrumentation = setupInstrumentation(config);
  const transcriptPath = hookInput.transcript_path;
  let failure: unknown;

  try {
    await convertRollout(transcriptPath, {
      config,
      parentSpanContext,
      stoppedTurnId: hookInput.turn_id ?? undefined,
      // Flush and record each turn before converting the next: a backlog is
      // delivered incrementally instead of all-or-nothing, and only one turn's
      // spans are held in memory at a time. Record delivery only after the
      // flush: a turn marked despite a failed export is lost silently, while
      // an unmarked one is retried.
      onTurnExported: async (turnId) => {
        diagnostic("flush_started");
        try {
          await instrumentation.flush();
        } catch (error) {
          diagnosticError("flush_failed", error);
          throw error;
        }
        await markTurnUploaded(transcriptPath, turnId);
        diagnostic("turn_acknowledged");
      },
    });
  } catch (error) {
    failure = error;
    debugLog("failed to convert rollout:", error);
    diagnosticError("conversion_failed", error);
  }

  try {
    await instrumentation.shutdown();
  } catch (error) {
    failure ??= error;
    debugLog("error during flush/shutdown:", error);
    diagnosticError("shutdown_failed", error);
  }

  diagnostic("hook_finished", { success: !failure, duration_ms: Date.now() - started });
  if (failure) {
    if (config.fail_on_error) throw failure;
    debugLog("export incomplete; leaving the remaining turns unmarked so they stay retryable");
  }
}

runHook().catch((error) => {
  diagnosticError("hook_fatal", error);
  if (process.env.LANGFUSE_CODEX_DEBUG === "true") {
    console.error("[langfuse-codex] fatal:", error);
  }
  if (failOnError) {
    process.exitCode = 1;
  }
});
