import * as fs from "node:fs/promises";

/**
 * Per-rollout dedup ledger.
 *
 * The `Stop` hook fires after every Codex turn and re-reads the whole rollout
 * file, so completed turns would be re-uploaded each time. We record uploaded
 * turn ids in a sidecar file (`<rolloutFile>.langfuse`) and skip them on
 * subsequent invocations.
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

export async function claimRolloutUpload(
  rolloutFile: string,
): Promise<(() => Promise<void>) | undefined> {
  const lockFile = `${rolloutFile}.langfuse.lock`;
  let lock: fs.FileHandle;
  try {
    lock = await fs.open(lockFile, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    try {
      const stat = await fs.stat(lockFile);
      if (Date.now() - stat.mtimeMs <= 60_000) return undefined;
      await fs.unlink(lockFile);
      return claimRolloutUpload(rolloutFile);
    } catch (lockError) {
      if ((lockError as NodeJS.ErrnoException).code === "ENOENT") {
        return claimRolloutUpload(rolloutFile);
      }
      throw lockError;
    }
  }

  return async () => {
    await lock.close();
    await fs.unlink(lockFile).catch(() => undefined);
  };
}
