import { appendFileSync, chmodSync, mkdirSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const enabled = process.env.LANGFUSE_CODEX_DIAGNOSTICS === "true";
const run = `${process.pid}-${Date.now()}`;

/** Deliberately excludes raw error messages, paths, payloads and credentials. */
export function diagnostic(
  event: string,
  fields: Record<string, string | number | boolean> = {},
): void {
  if (!enabled) return;
  const record = JSON.stringify({ time: new Date().toISOString(), run, event, ...fields });
  console.error(`[langfuse-diagnostic] ${record}`);
  try {
    const dir = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "langfuse-diagnostics");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, "hook.jsonl");
    try {
      if (statSync(file).size > 1024 * 1024) renameSync(file, `${file}.previous`);
    } catch {
      /* First run or competing rotation. */
    }
    appendFileSync(file, record + "\n", { mode: 0o600 });
    chmodSync(file, 0o600);
  } catch {
    /* Diagnostics must never block the hook. */
  }
}

export function diagnosticError(event: string, error: unknown): void {
  const e = error as {
    code?: unknown;
    name?: unknown;
    status?: unknown;
    statusCode?: unknown;
    message?: unknown;
  } | null;
  const code =
    typeof e?.code === "string" && /^[A-Z][A-Z0-9_]{0,40}$/.test(e.code) ? e.code : "UNKNOWN";
  const status = e?.statusCode ?? e?.status;
  const message = typeof e?.message === "string" ? e.message : "";
  const httpMatch = message.match(/\b(?:HTTP|status|code)\s*[:=]?\s*(\d{3})\b/i);
  diagnostic(event, {
    code,
    ...(typeof status === "number"
      ? { http_status: status }
      : httpMatch
        ? { http_status: Number(httpMatch[1]) }
        : {}),
    category: /heap|memory/i.test(message)
      ? "memory"
      : /timeout|timed out/i.test(message)
        ? "timeout"
        : /401|403|unauthorized/i.test(message)
          ? "authentication"
          : /404/i.test(message)
            ? "endpoint"
            : /network|socket|connect/i.test(message)
              ? "network"
              : "unknown",
  });
}
