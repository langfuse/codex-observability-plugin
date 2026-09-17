/** Supported Codex session metadata layouts; conflicting identity fails closed. */
export function childIdentity(payload: Record<string, unknown>): {
  child: boolean;
  parent?: string;
  conflict: boolean;
} {
  const source = payload.source as
    { subagent?: { thread_spawn?: { parent_thread_id?: unknown } } } | undefined;
  const nested = source?.subagent?.thread_spawn;
  const parents = [payload.parent_thread_id, nested?.parent_thread_id].filter((x) => x != null);
  const conflict = parents.some((x) => typeof x !== "string" || !x) || new Set(parents).size > 1;
  return {
    child: parents.length > 0 || payload.thread_source === "subagent" || !!source?.subagent,
    parent: !conflict && typeof parents[0] === "string" ? parents[0] : undefined,
    conflict,
  };
}
