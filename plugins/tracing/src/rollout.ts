import { createReadStream } from "node:fs";

import { createSessionParser, sessionMetaFrom } from "./parse.js";
import type { RolloutLine, SessionMeta, Turn } from "./types.js";
import { debugLog } from "./utils.js";

// Limits apply before JSON decoding / retaining a turn. Omit oversized data,
// not the whole session, and explicitly label affected turns.
export const ROLLOUT_LIMITS = {
  recordBytes: 8 * 1024 * 1024,
  turnBytes: 32 * 1024 * 1024,
  contextBytes: 4 * 1024 * 1024,
  turns: 100_000,
};

/** A snapshot prevents a concurrently appended turn changing ordinals between passes. */
export async function* readRollout(
  file: string,
  size: number,
  maxRecordBytes = ROLLOUT_LIMITS.recordBytes,
): AsyncGenerator<{ line: RolloutLine; bytes: number }> {
  if (size === 0) return;
  const input = createReadStream(file, { end: size - 1, highWaterMark: 64 * 1024 });
  let parts: Buffer[] = [];
  let bytes = 0;
  let oversized = false;
  let lineNumber = 1;
  const append = (part: Buffer) => {
    bytes += part.length;
    if (oversized) return;
    if (bytes > maxRecordBytes) {
      debugLog(`Omitting rollout record ${lineNumber}: exceeds ${maxRecordBytes} bytes: ${file}`);
      oversized = true;
      parts = [];
      return;
    }
    if (part.length) parts.push(part);
  };
  const decode = () => {
    if (oversized) {
      oversized = false;
      parts = [];
      bytes = 0;
      lineNumber++;
      return {
        line: {
          timestamp: "",
          type: "event_msg",
          payload: { type: "langfuse_record_omitted" },
        } as RolloutLine,
        bytes: 0,
      };
    }
    const raw = Buffer.concat(parts, bytes).toString("utf8");
    const recordBytes = bytes;
    parts = [];
    bytes = 0;
    lineNumber++;
    let line: RolloutLine;
    try {
      line = JSON.parse(raw) as RolloutLine;
    } catch {
      return undefined; // Preserve the existing malformed-line tolerance.
    }
    if (!line || typeof line !== "object" || !line.payload || typeof line.payload !== "object") {
      return undefined;
    }
    // Compaction carries potentially large context snapshots the parser never uses.
    if (!["session_meta", "turn_context", "response_item", "event_msg"].includes(line.type)) {
      return undefined;
    }
    return { line, bytes: recordBytes };
  };
  try {
    for await (const chunk of input) {
      const buffer = chunk as Buffer;
      let start = 0;
      let newline: number;
      while ((newline = buffer.indexOf(10, start)) !== -1) {
        append(buffer.subarray(start, newline));
        const record = decode();
        if (record) yield record;
        start = newline + 1;
      }
      // Copy the trailing fragment so it does not pin an entire input chunk.
      append(Buffer.from(buffer.subarray(start)));
    }
    if (bytes) {
      const record = decode();
      if (record) yield record;
    }
  } finally {
    input.destroy();
  }
}

export async function readRolloutMeta(file: string, size: number): Promise<SessionMeta> {
  for await (const { line } of readRollout(file, size)) {
    if (line.type === "session_meta") return sessionMetaFrom(line);
  }
  return { sessionId: "unknown" };
}

export async function* readTurns(
  file: string,
  size: number,
  sessionMeta: SessionMeta,
): AsyncGenerator<Turn> {
  const parser = createSessionParser(sessionMeta, ROLLOUT_LIMITS.contextBytes);
  let turnBytes = 0;
  for await (const { line, bytes } of readRollout(file, size)) {
    if (line.type === "session_meta") continue;
    if (line.type === "event_msg" && line.payload.type === "task_started") turnBytes = 0;
    turnBytes += bytes;
    const boundary =
      line.type === "event_msg" &&
      ["task_started", "task_complete", "turn_aborted"].includes(String(line.payload.type));
    if (turnBytes > ROLLOUT_LIMITS.turnBytes && !boundary) {
      parser.push({
        timestamp: line.timestamp,
        type: "event_msg",
        payload: { type: "langfuse_record_omitted" },
      } as RolloutLine);
      continue;
    }
    const ready = parser.push(line);
    for (const turn of ready) {
      yield turn;
    }
    if (ready.length && !(line.type === "event_msg" && line.payload.type === "task_started")) {
      turnBytes = 0;
    }
  }
  for (const turn of parser.finish()) {
    yield turn;
  }
}
