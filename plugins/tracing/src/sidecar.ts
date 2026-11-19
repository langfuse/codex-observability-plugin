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
 * The lock is published atomically (temp file + hard link) with the owner pid
 * inside, so contenders never read a half-written lock. Codex kills background
 * hooks at timeout and session end without letting them release, so a lock
 * whose owner is gone is reclaimed.
 */
export async function acquireRunLock(rolloutFile: string): Promise<() => Promise<void>> {
  const lockPath = `${rolloutFile}.langfuse.lock`;
  for (;;) {
    const tmpPath = `${lockPath}.${process.pid}`;
    await fs.writeFile(tmpPath, String(process.pid));
    try {
      await fs.link(tmpPath, lockPath);
      return async () => {
        // Release only our own lock: another run may have reclaimed a stale
        // lock and handed the path to someone else while we ran.
        if ((await readLockOwner(lockPath)) === process.pid) await fs.rm(lockPath, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    } finally {
      await fs.rm(tmpPath, { force: true });
    }

    const owner = await readLockOwner(lockPath);
    if (owner === undefined) continue; // released meanwhile
    if (owner !== process.pid && owner !== null && pidAlive(owner)) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      continue;
    }

    // The owner is gone (or the pid was recycled by this very process).
    // Reclaim only while the lock still holds the pid we inspected. The
    // compare-and-unlink gap below has no atomic POSIX primitive; the worst
    // case is two runs exporting the same turns, which the server folds
    // because span ids are seeded per (session, turn).
    if ((await readLockOwner(lockPath)) === owner) await fs.rm(lockPath, { force: true });
  }
}

/** Owner pid of the lock: `undefined` when no lock exists, `null` when unreadable. */
async function readLockOwner(lockPath: string): Promise<number | null | undefined> {
  let content: string;
  try {
    content = await fs.readFile(lockPath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return null;
  }
  const pid = Number(content);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
