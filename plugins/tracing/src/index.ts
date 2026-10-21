import { getConfig } from "./config.js";
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
  let hookInput: HookInput;
  try {
    hookInput = await readStdin<HookInput>();
  } catch (error) {
    return;
  }

  const config = await getConfig();
  setDebug(config.debug);
  failOnError = config.fail_on_error;

  if (!config.enabled) {
    debugLog("tracing disabled (set TRACE_TO_LANGFUSE=true to enable)");
    return;
  }
  if (!config.public_key || !config.secret_key) {
    debugLog("missing LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY; skipping");
    return;
  }
  if (!hookInput.transcript_path) {
    debugLog("hook payload missing transcript_path; skipping");
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
        await instrumentation.flush();
        await markTurnUploaded(transcriptPath, turnId);
      },
    });
  } catch (error) {
    failure = error;
    debugLog("failed to convert rollout:", error);
  }

  try {
    await instrumentation.shutdown();
  } catch (error) {
    failure ??= error;
    debugLog("error during flush/shutdown:", error);
  }

  if (failure) {
    if (config.fail_on_error) throw failure;
    debugLog("export incomplete; leaving the remaining turns unmarked so they stay retryable");
  }
}

runHook().catch((error) => {
  if (process.env.LANGFUSE_CODEX_DEBUG === "true") {
    console.error("[langfuse-codex] fatal:", error);
  }
  if (failOnError) {
    process.exitCode = 1;
  }
});
