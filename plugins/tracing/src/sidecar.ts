import * as fs from "node:fs/promises";

/**
 * The `Stop` hook reads the rollout file again after each Codex turn.
 * The sidecar file (`<rolloutFile>.langfuse`) holds the ids of the sent turns.
 * The hook adds an id only after a flush. Retry a turn that has no id.
 */
export async function loadUploadedTurnIds(rolloutFile: string): Promise<Set<string>> {
  try {
    const data = await fs.readFile(`${rolloutFile}.langfuse`, "utf-8");
    return new Set(data.split("\n").filter(Boolean));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
    throw error;
  }
}

export async function markTurnUploaded(rolloutFile: string, turnId: string): Promise<void> {
  try {
    await fs.appendFile(`${rolloutFile}.langfuse`, `${turnId}\n`, "utf-8");
  } catch {
    // Best-effort: a failed write only risks a duplicate upload next time.
  }
}

/**
 * Single-flight lock for Stop-hook runs. Background hooks can overlap across
 * fast turns, and two runs over the same rollout would upload the same unmarked
 * turns twice. Returns a release function, or null when another run holds the
 * lock (the caller should exit and let the next Stop catch up).
 */
export async function acquireRunLock(rolloutFile: string): Promise<(() => Promise<void>) | null> {
  const lockPath = `${rolloutFile}.langfuse.lock`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await fs.open(lockPath, "wx");
      await handle.writeFile(String(process.pid));
      return async () => {
        await handle.close();
        await fs.rm(lockPath, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Codex kills background hooks at timeout and session end, which leaves a
      // stale lock behind. Steal it if its owner is gone; if the pid was
      // recycled we merely skip this run and retry at the next Stop.
      if (attempt === 0 && (await lockOwnerAlive(lockPath))) return null;
    }
  }
  return null;
}

async function lockOwnerAlive(lockPath: string): Promise<boolean> {
  const pid = Number(await fs.readFile(lockPath, "utf-8"));
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
