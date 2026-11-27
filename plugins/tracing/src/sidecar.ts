import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

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

export type TurnExportState = {
  rootEmitted: boolean;
  traceId?: string;
  rootSpanId?: string;
  emittedStepIndices: number[];
  emittedToolCallIds: string[];
  toolCallSpanIds?: Record<string, string>;
};

export type RolloutExportState = Record<string, TurnExportState>;

const STATE_SUFFIX = ".langfuse.state";
const LOCK_SUFFIX = ".langfuse.lock";
const CLAIM_STALE_MS = 10_000;
const LOCK_STALE_MS = 60_000;
const LOCK_TIMEOUT_MS = 25_000;
const LOCK_RETRY_MS = 25;
const LOCK_HEARTBEAT_MS = 5_000;

export async function loadIncrementalState(rolloutFile: string): Promise<RolloutExportState> {
  try {
    const raw = await fs.readFile(`${rolloutFile}${STATE_SUFFIX}`, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as RolloutExportState;
  } catch {
    return {};
  }
}

export async function saveIncrementalState(
  rolloutFile: string,
  state: RolloutExportState,
): Promise<void> {
  const target = `${rolloutFile}${STATE_SUFFIX}`;
  const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
  try {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(tmp, `${JSON.stringify(state)}\n`, "utf-8");
    await fs.rename(tmp, target);
  } catch {
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
}

function isPidDead(ownerToken: string): boolean {
  const pidPart = ownerToken.trim().split(":")[0] ?? "";
  const pid = Number(pidPart);
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

async function tryAcquireFile(filePath: string, ownerToken: string): Promise<boolean> {
  const tmp = `${filePath}.tmp.${process.pid}.${randomUUID()}`;
  try {
    await fs.writeFile(tmp, `${ownerToken}\n`, { encoding: "utf-8", flag: "wx" });
    try {
      await fs.link(tmp, filePath);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") return false;
      if (code !== "EPERM" && code !== "EXDEV" && code !== "ENOTSUP") throw error;
    }
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => {});
  }

  // Fallback for filesystems that disallow hard links.
  try {
    const handle = await fs.open(filePath, "wx");
    try {
      await handle.writeFile(`${ownerToken}\n`, "utf-8");
      return true;
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

function tokenClaimDir(lockPath: string, token: string): string {
  const digest = createHash("sha256").update(token).digest("hex").slice(0, 16);
  return `${lockPath}.claim.${digest}`;
}

async function removeMatchingLock(lockPath: string, expectedToken: string): Promise<boolean> {
  try {
    const currentToken = (await fs.readFile(lockPath, "utf-8")).trim();
    if (currentToken !== expectedToken) return false;
    await fs.rm(lockPath, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Unlink `lockPath` only after winning an exclusive per-token claim directory
 * (`mkdir` on `.claim.<sha256(token)>`) and `slot-0` inside it. The claim
 * directory stays in place until after `lockPath` is removed.
 */
async function releaseTokenLock(lockPath: string, expectedToken: string): Promise<boolean> {
  const claimDir = tokenClaimDir(lockPath, expectedToken);
  try {
    await fs.mkdir(claimDir);
  } catch {
    return false;
  }

  try {
    const wonSlot = await tryAcquireFile(
      path.join(claimDir, "slot-0"),
      `${process.pid}:${randomUUID()}`,
    ).catch(() => false);
    if (!wonSlot) return false;
    return await removeMatchingLock(lockPath, expectedToken);
  } finally {
    await fs.rm(claimDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function isFileOrphaned(filePath: string, staleMs: number): Promise<boolean> {
  let handle;
  try {
    handle = await fs.open(filePath, "r");
  } catch {
    return false;
  }

  try {
    const st = await handle.stat();
    const owner = (await handle.readFile("utf-8")).trim();
    return Date.now() - st.mtimeMs > staleMs || (owner.length > 0 && isPidDead(owner));
  } catch {
    return false;
  } finally {
    await handle.close();
  }
}

async function findNextRecoverySlot(claimDir: string): Promise<number | undefined> {
  let entries: string[];
  try {
    entries = await fs.readdir(claimDir);
  } catch {
    return undefined;
  }

  let maxSlot = -1;
  for (const name of entries) {
    const match = /^slot-(\d+)$/.exec(name);
    if (!match) continue;
    const n = Number(match[1]);
    if (Number.isSafeInteger(n) && n > maxSlot) maxSlot = n;
  }

  if (maxSlot === -1) {
    try {
      const dirStat = await fs.stat(claimDir);
      return Date.now() - dirStat.mtimeMs > CLAIM_STALE_MS ? 0 : undefined;
    } catch {
      return undefined;
    }
  }

  const latestSlot = path.join(claimDir, `slot-${maxSlot}`);
  return (await isFileOrphaned(latestSlot, CLAIM_STALE_MS)) ? maxSlot + 1 : undefined;
}

async function tryReclaimStaleLock(lockPath: string, staleMs: number): Promise<boolean> {
  let handle;
  try {
    handle = await fs.open(lockPath, "r");
  } catch {
    return false;
  }

  let inspectedToken = "";
  let expired = false;
  let deadOwner = false;
  try {
    const st = await handle.stat();
    inspectedToken = (await handle.readFile("utf-8")).trim();
    expired = Date.now() - st.mtimeMs > staleMs;
    deadOwner = inspectedToken.length > 0 && isPidDead(inspectedToken);
  } catch {
    return false;
  } finally {
    await handle.close();
  }

  if (!inspectedToken || (!expired && !deadOwner)) return false;

  if (await releaseTokenLock(lockPath, inspectedToken)) return true;

  // Monotonic slot escalation inside `claimDir`: if an earlier claimer crashed
  // while holding `slot-N` (or before creating `slot-0`), waiters race via
  // atomic O_CREAT|O_EXCL for `slot-(N+1)`. `claimDir` stays occupied until
  // `lockPath` is removed, and nothing ever deletes a slot prematurely.
  const claimDir = tokenClaimDir(lockPath, inspectedToken);
  const nextSlot = await findNextRecoverySlot(claimDir);
  if (nextSlot === undefined) return false;

  const wonSlot = await tryAcquireFile(
    path.join(claimDir, `slot-${nextSlot}`),
    `${process.pid}:${randomUUID()}`,
  ).catch(() => false);
  if (!wonSlot) return false;

  try {
    return await removeMatchingLock(lockPath, inspectedToken);
  } finally {
    await fs.rm(claimDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function withRolloutLock<T>(
  rolloutFile: string,
  fn: () => Promise<T>,
  options?: {
    timeoutMs?: number;
    retryMs?: number;
    staleMs?: number;
    heartbeatMs?: number;
  },
): Promise<T> {
  const lockPath = `${rolloutFile}${LOCK_SUFFIX}`;
  const timeoutMs = options?.timeoutMs ?? LOCK_TIMEOUT_MS;
  const retryMs = options?.retryMs ?? LOCK_RETRY_MS;
  const staleMs = options?.staleMs ?? LOCK_STALE_MS;
  const heartbeatMs = options?.heartbeatMs ?? LOCK_HEARTBEAT_MS;
  const ownerToken = `${process.pid}:${randomUUID()}`;

  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  let acquired = false;

  while (true) {
    acquired = await tryAcquireFile(lockPath, ownerToken);
    if (acquired) break;

    const reclaimed = await tryReclaimStaleLock(lockPath, staleMs);
    if (reclaimed) {
      acquired = await tryAcquireFile(lockPath, ownerToken);
      if (acquired) break;
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, retryMs));
  }

  if (!acquired) {
    throw new Error(`timed out waiting for rollout lock: ${lockPath}`);
  }

  const heartbeat = setInterval(() => {
    const now = new Date();
    void fs
      .readFile(lockPath, "utf-8")
      .then((content) =>
        content.trim() === ownerToken ? fs.utimes(lockPath, now, now) : undefined,
      )
      .catch(() => {});
  }, heartbeatMs);
  heartbeat.unref();

  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    await releaseTokenLock(lockPath, ownerToken);
  }
}
