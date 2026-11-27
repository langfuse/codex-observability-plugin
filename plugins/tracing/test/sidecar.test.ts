import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { withRolloutLock } from "../src/sidecar.js";

const tmpDirs: string[] = [];

function makeRolloutPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lf-codex-lock-"));
  tmpDirs.push(dir);
  return path.join(dir, "rollout.jsonl");
}

afterEach(() => {
  while (tmpDirs.length) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

describe("withRolloutLock", () => {
  it("throws without executing callback when lock acquisition times out", async () => {
    const rollout = makeRolloutPath();
    fs.writeFileSync(`${rollout}.langfuse.lock`, `${process.pid}\n`);
    let called = false;

    await expect(
      withRolloutLock(
        rollout,
        async () => {
          called = true;
        },
        { timeoutMs: 80, retryMs: 10, staleMs: 60_000 },
      ),
    ).rejects.toThrow(/lock/i);

    expect(called).toBe(false);
  });

  it("reclaims a lock left behind by a dead process", async () => {
    const rollout = makeRolloutPath();
    // 9999999 is not a running PID; stale check reclaims it immediately without waiting 60s.
    fs.writeFileSync(`${rollout}.langfuse.lock`, "9999999\n");
    const past = new Date(Date.now() - 5_000);
    fs.utimesSync(`${rollout}.langfuse.lock`, past, past);
    let called = false;

    await withRolloutLock(
      rollout,
      async () => {
        called = true;
      },
      { timeoutMs: 500, retryMs: 10, staleMs: 60_000 },
    );

    expect(called).toBe(true);
    expect(fs.existsSync(`${rollout}.langfuse.lock`)).toBe(false);
  });

  it("refreshes the lock mtime heartbeat while work is in progress", async () => {
    const rollout = makeRolloutPath();
    let sawWaiterFail = false;

    await withRolloutLock(
      rollout,
      async () => {
        await new Promise((r) => setTimeout(r, 120));
        await expect(
          withRolloutLock(
            rollout,
            async () => {
              throw new Error("live lock was stolen");
            },
            { timeoutMs: 100, retryMs: 15, staleMs: 80, heartbeatMs: 25 },
          ),
        ).rejects.toThrow(/lock/i);
        sawWaiterFail = true;
      },
      { timeoutMs: 500, retryMs: 10, staleMs: 80, heartbeatMs: 25 },
    );

    expect(sawWaiterFail).toBe(true);
  });

  it("does not unlink a lock owned by another process if lock token changed", async () => {
    const rollout = makeRolloutPath();
    const lockPath = `${rollout}.langfuse.lock`;
    await withRolloutLock(
      rollout,
      async () => {
        // Simulate external lock replacement (even if the OS reuses the freed inode)
        fs.rmSync(lockPath);
        fs.writeFileSync(lockPath, `${process.pid}:external-owner\n`);
      },
      { timeoutMs: 200, retryMs: 10, staleMs: 60_000 },
    );

    expect(fs.existsSync(lockPath)).toBe(true);
    expect(fs.readFileSync(lockPath, "utf-8").trim()).toBe(`${process.pid}:external-owner`);
    fs.rmSync(lockPath, { force: true });
  });

  it("retries acquisition immediately after reclaiming a stale lock even at the deadline", async () => {
    const rollout = makeRolloutPath();
    fs.writeFileSync(`${rollout}.langfuse.lock`, "9999999:dead-owner\n");
    let called = false;

    await withRolloutLock(
      rollout,
      async () => {
        called = true;
      },
      { timeoutMs: 0, retryMs: 50, staleMs: 60_000 },
    );

    expect(called).toBe(true);
  });

  it("serializes concurrent callers so only one holds the lock at a time", async () => {
    const rollout = makeRolloutPath();
    let active = 0;
    let maxActive = 0;
    let completed = 0;

    await Promise.all(
      Array.from({ length: 6 }, () =>
        withRolloutLock(
          rollout,
          async () => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            await new Promise((r) => setTimeout(r, 15));
            active -= 1;
            completed += 1;
          },
          { timeoutMs: 2_000, retryMs: 5, staleMs: 60_000 },
        ),
      ),
    );

    expect(maxActive).toBe(1);
    expect(completed).toBe(6);
  });

  it("clears an empty expired claim directory so an orphaned lock can still be reclaimed", async () => {
    const { createHash } = await import("node:crypto");
    const rollout = makeRolloutPath();
    const lockPath = `${rollout}.langfuse.lock`;
    const deadToken = "9999999:dead-owner";
    const digest = createHash("sha256").update(deadToken).digest("hex").slice(0, 16);
    const claimDir = `${lockPath}.claim.${digest}`;

    fs.writeFileSync(lockPath, `${deadToken}\n`);
    fs.mkdirSync(claimDir);
    const past = new Date(Date.now() - 20_000);
    fs.utimesSync(claimDir, past, past);

    let called = false;
    await withRolloutLock(
      rollout,
      async () => {
        called = true;
      },
      { timeoutMs: 200, retryMs: 10, staleMs: 60_000 },
    );

    expect(called).toBe(true);
    expect(fs.existsSync(claimDir)).toBe(false);
  });

  it("escalates past a dead slot-0 recovery file via slot-1 to reclaim an orphaned lock", async () => {
    const { createHash } = await import("node:crypto");
    const rollout = makeRolloutPath();
    const lockPath = `${rollout}.langfuse.lock`;
    const deadToken = "9999999:dead-owner";
    const digest = createHash("sha256").update(deadToken).digest("hex").slice(0, 16);
    const claimDir = `${lockPath}.claim.${digest}`;

    fs.writeFileSync(lockPath, `${deadToken}\n`);
    fs.mkdirSync(claimDir);
    fs.writeFileSync(path.join(claimDir, "slot-0"), "9999998:dead-claimer\n");

    let called = false;
    await withRolloutLock(
      rollout,
      async () => {
        called = true;
      },
      { timeoutMs: 200, retryMs: 10, staleMs: 60_000 },
    );

    expect(called).toBe(true);
    expect(fs.existsSync(claimDir)).toBe(false);
  });
});
