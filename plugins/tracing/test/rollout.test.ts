import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { parseSession } from "../src/parse.js";
import { readRollout, readRolloutMeta, readTurns, ROLLOUT_LIMITS } from "../src/rollout.js";
import type { RolloutLine } from "../src/types.js";

const dirs: string[] = [];
const limits = { ...ROLLOUT_LIMITS };
afterEach(async () => {
  Object.assign(ROLLOUT_LIMITS, limits);
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});
const line = (type: string, payload: Record<string, unknown>) =>
  JSON.stringify({ timestamp: "2026-10-05T00:00:00.000Z", type, payload });
async function stage(contents: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lf-stream-"));
  dirs.push(dir);
  const file = path.join(dir, "rollout.jsonl");
  await fs.writeFile(file, contents);
  return { file, size: Buffer.byteLength(contents) };
}
async function records(file: string, size: number, limit?: number) {
  const result = [];
  for await (const record of readRollout(file, size, limit)) result.push(record.line);
  return result;
}
async function turns(file: string, size: number) {
  const meta = await readRolloutMeta(file, size);
  const result = [];
  for await (const turn of readTurns(file, size, meta)) result.push(turn);
  return { sessionMeta: meta, turns: result };
}

describe("bounded rollout reader", () => {
  it("matches the existing parser for every fixture including inherited and unfinished turns", async () => {
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/sessions");
    const files = (await fs.readdir(root, { recursive: true })).filter((p) => p.endsWith(".jsonl"));
    for (const relative of files) {
      const file = path.join(root, relative);
      const contents = await fs.readFile(file, "utf8");
      const lines = contents
        .trim()
        .split("\n")
        .map((raw) => JSON.parse(raw) as RolloutLine);
      expect(await turns(file, Buffer.byteLength(contents)), relative).toEqual(parseSession(lines));
    }
  });

  it("handles UTF-8 across chunk boundaries, CRLF, blank/malformed lines, and an unterminated final record", async () => {
    const contents =
      line("session_meta", { id: "test" }) +
      "\r\n\nnot-json\nnull\n" +
      line("event_msg", { type: "user_message", message: "界".repeat(70_000) });
    const { file, size } = await stage(contents);
    const result = await records(file, size);
    expect(result).toHaveLength(2);
    expect(result[1].payload).toMatchObject({ message: "界".repeat(70_000) });
  });

  it("does not read records appended after the snapshot", async () => {
    const { file, size } = await stage(line("session_meta", { id: "first" }) + "\n");
    await fs.appendFile(file, line("session_meta", { id: "second" }) + "\n");
    expect(await records(file, size)).toHaveLength(1);
  });

  it("rejects an oversized record before JSON decoding, including a record without a newline", async () => {
    for (const suffix of ["", "\n"]) {
      const { file, size } = await stage("x".repeat(200_000) + suffix);
      await expect(records(file, size, 100_000)).rejects.toThrow("record 1 exceeds 100000 bytes");
    }
  });

  it("does not retain compaction snapshots", async () => {
    const { file, size } = await stage(line("compacted", { text: "x".repeat(100_000) }));
    expect(await records(file, size)).toEqual([]);
  });

  it("bounds a turn composed of many individually small records", async () => {
    ROLLOUT_LIMITS.turnBytes = 400;
    const { file, size } = await stage(
      [
        line("event_msg", { type: "task_started", turn_id: "t1" }),
        ...Array.from({ length: 20 }, () =>
          line("event_msg", { type: "user_message", message: "hi" }),
        ),
      ].join("\n"),
    );
    await expect(turns(file, size)).rejects.toThrow("Rollout turn exceeds 400 bytes");
  });

  it("bounds context retained across turns", async () => {
    ROLLOUT_LIMITS.contextBytes = 20;
    const { file, size } = await stage(
      [
        line("session_meta", { id: "s", base_instructions: { text: "1234567890" } }),
        line("response_item", {
          type: "message",
          role: "developer",
          content: [{ type: "text", text: "abcdefghijk" }],
        }),
      ].join("\n"),
    );
    await expect(turns(file, size)).rejects.toThrow("Rollout context exceeds memory limit");
  });

  it("bounds the number of indexed turns and propagates file errors", async () => {
    ROLLOUT_LIMITS.turns = 1;
    const { file, size } = await stage(
      [
        line("event_msg", { type: "task_started", turn_id: "t1" }),
        line("event_msg", { type: "task_complete" }),
        line("event_msg", { type: "task_started", turn_id: "t2" }),
      ].join("\n"),
    );
    await expect(turns(file, size)).rejects.toThrow("too many turns");
    await fs.unlink(file);
    await expect(records(file, size)).rejects.toThrow("ENOENT");
  });
});
