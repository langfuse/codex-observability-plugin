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
 * turns twice. A run that arrives while the lock is held waits instead of
 * exiting: the running export's transcript snapshot may predate the new turn,
 * so only a later run can deliver it.
 *
 * Codex kills background hooks at timeout and session end without letting them
 * release, so a lock whose owner is gone is reclaimed.
 */
export async function acquireRunLock(rolloutFile: string): Promise<() => Promise<void>> {
  const lockPath = `${rolloutFile}.langfuse.lock`;
  for (;;) {
    try {
      const handle = await fs.open(lockPath, "wx");
      await handle.writeFile(String(process.pid));
      return async () => {
        await handle.close();
        await fs.rm(lockPath, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await lockOwnerAlive(lockPath)) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        continue;
      }
      await fs.rm(lockPath, { force: true });
    }
  }
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
