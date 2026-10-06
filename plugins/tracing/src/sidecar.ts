import * as fs from "node:fs/promises";
import { debugLog } from "./utils.js";

/**
 * The `Stop` hook reads the rollout file again after each Codex turn.
 * The sidecar file (`<rolloutFile>.langfuse`) holds the ids of the sent turns.
 * The hook adds an id only after a flush. Retry a turn that has no id.
 */
export async function loadUploadedTurnIds(rolloutFile: string): Promise<Set<string>> {
  try {
    if ((await fs.stat(`${rolloutFile}.langfuse`)).size > 16 * 1024 * 1024) {
      throw new Error("Rollout upload sidecar exceeds memory limit");
    }
    const data = await fs.readFile(`${rolloutFile}.langfuse`, "utf-8");
    const lines = data.split("\n");
    // An interrupted append must not acknowledge a partial id.
    lines.pop();
    return new Set(lines.filter(Boolean));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
    throw error;
  }
}

export async function markTurnUploaded(rolloutFile: string, turnId: string): Promise<void> {
  let handle;
  try {
    handle = await fs.open(`${rolloutFile}.langfuse`, "a");
    await handle.writeFile(`${turnId}\n`, "utf-8");
    await handle.sync();
  } catch (error) {
    // Best-effort: a failed write only risks a duplicate upload next time.
    debugLog("failed to checkpoint uploaded turn; it may be retried:", error);
  } finally {
    await handle?.close();
  }
}
