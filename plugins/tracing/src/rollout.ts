import * as fs from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";

import type { ParserContext } from "./parse.js";
import type { RolloutLine } from "./types.js";
import { loadUploadedTurnIds } from "./sidecar.js";

export type HistoryMessage = {
  role: "system" | "user" | "assistant" | "tool";
  [key: string]: unknown;
};

export type RolloutCheckpoint = {
  version: 1;
  offset: number;
  turnCount: number;
  lastTurnId: string;
  maxHistoryChars: number;
  context: ParserContext;
  history: HistoryMessage[];
  omittedMessages: number;
  identity: string;
  head: string;
  anchor: string;
};

export type RolloutRecord = { line: RolloutLine; start: number; end: number };
const CHUNK_SIZE = 64 * 1024;
const GUARD_SIZE = 4096;
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

async function readGuard(handle: fs.FileHandle, start: number, size: number): Promise<string> {
  const bytes = Buffer.alloc(size);
  const { bytesRead } = await handle.read(bytes, 0, size, start);
  return digest(bytes.subarray(0, bytesRead));
}

function validCheckpoint(value: unknown): value is RolloutCheckpoint {
  if (!value || typeof value !== "object") return false;
  const c = value as RolloutCheckpoint;
  const context = c.context;
  return (
    c.version === 1 &&
    Number.isSafeInteger(c.offset) &&
    c.offset >= 0 &&
    Number.isSafeInteger(c.turnCount) &&
    c.turnCount >= 0 &&
    typeof c.lastTurnId === "string" &&
    c.lastTurnId.length > 0 &&
    Number.isSafeInteger(c.omittedMessages) &&
    c.omittedMessages >= 0 &&
    typeof c.identity === "string" &&
    typeof c.head === "string" &&
    typeof c.anchor === "string" &&
    Array.isArray(c.history) &&
    c.history.every(
      (m) => m && typeof m === "object" && ["system", "user", "assistant", "tool"].includes(m.role),
    ) &&
    !!context &&
    typeof context.sessionMeta?.sessionId === "string" &&
    Array.isArray(context.developerMessages) &&
    context.developerMessages.every((m) => typeof m === "string") &&
    Array.isArray(context.injectedContext) &&
    context.injectedContext.every((m) => typeof m === "string") &&
    Array.isArray(context.toolDefinitions) &&
    context.toolDefinitions.every((t) => t && typeof t.name === "string") &&
    Number.isSafeInteger(context.exportedSegmentCount) &&
    context.exportedSegmentCount >= 0
  );
}

/** A checkpoint is an optimization, never a replacement for upload receipts. */
export async function openIncrementalRollout(file: string, maxHistoryChars: number) {
  const statePath = `${file}.langfuse.cursor`;

  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(file, "r");
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("Rollout must be a regular file");
    const identity = `${stat.dev}:${stat.ino}`;
    let checkpoint: RolloutCheckpoint | undefined;
    if (maxHistoryChars > 0) {
      try {
        const candidate: unknown = JSON.parse(await fs.readFile(statePath, "utf8"));
        if (
          validCheckpoint(candidate) &&
          candidate.identity === identity &&
          candidate.maxHistoryChars === maxHistoryChars &&
          candidate.offset <= stat.size &&
          (await loadUploadedTurnIds(file)).has(candidate.lastTurnId) &&
          candidate.head === (await readGuard(handle, 0, Math.min(GUARD_SIZE, candidate.offset))) &&
          candidate.anchor ===
            (await readGuard(
              handle,
              Math.max(0, candidate.offset - GUARD_SIZE),
              Math.min(GUARD_SIZE, candidate.offset),
            ))
        ) {
          checkpoint = candidate;
        }
      } catch {
        /* Missing/corrupt checkpoints rebuild from the original transcript. */
      }
    }
    const records: RolloutRecord[] = [];
    const buffer = Buffer.alloc(CHUNK_SIZE);
    let position = checkpoint?.offset ?? 0;
    let lineStart = position;
    let parts: Buffer[] = [];
    let bytesReadTotal = 0;
    // Snapshot EOF: a concurrently appended half-line belongs to the next hook.
    while (position < stat.size) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, stat.size - position),
        position,
      );
      if (!bytesRead) break;
      bytesReadTotal += bytesRead;
      let consumed = 0;
      for (let i = 0; i < bytesRead; i++) {
        if (buffer[i] !== 10) continue;
        const fragment = buffer.subarray(consumed, i);
        const raw = (parts.length ? Buffer.concat([...parts, fragment]) : fragment)
          .toString("utf8")
          .trim();
        const end = position + i + 1;
        if (raw) {
          try {
            records.push({ line: JSON.parse(raw) as RolloutLine, start: lineStart, end });
          } catch {
            /* Same malformed-complete-line policy as the existing parser. */
          }
        }
        parts = [];
        consumed = i + 1;
        lineStart = end;
      }
      if (consumed < bytesRead) parts.push(Buffer.from(buffer.subarray(consumed, bytesRead)));
      position += bytesRead;
    }
    return {
      checkpoint,
      records,
      bytesRead: bytesReadTotal,
      async commit(
        state: Omit<
          RolloutCheckpoint,
          "version" | "identity" | "head" | "anchor" | "maxHistoryChars"
        >,
      ) {
        if (maxHistoryChars <= 0) return;
        const value: RolloutCheckpoint = {
          ...state,
          version: 1,
          identity,
          maxHistoryChars,
          head: await readGuard(handle!, 0, Math.min(GUARD_SIZE, state.offset)),
          anchor: await readGuard(
            handle!,
            Math.max(0, state.offset - GUARD_SIZE),
            Math.min(GUARD_SIZE, state.offset),
          ),
        };
        const temporary = `${statePath}.tmp-${randomBytes(8).toString("hex")}`;
        try {
          await fs.writeFile(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 });
          await fs.rename(temporary, statePath);
        } finally {
          await fs.unlink(temporary).catch(() => undefined);
        }
      },
      async close() {
        await handle!.close();
      },
    };
  } catch (error) {
    await handle?.close();
    throw error;
  }
}
