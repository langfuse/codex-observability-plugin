import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const bundle = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/index.mjs");
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function stage(count = 3, outputBytes = 32) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lf-streaming-hook-"));
  dirs.push(dir);
  const sessions = path.join(dir, "sessions/2026/10/05");
  await fs.mkdir(sessions, { recursive: true });
  const file = path.join(sessions, "rollout.jsonl");
  const handle = await fs.open(file, "w");
  let n = 0;
  const line = async (type: string, payload: Record<string, unknown>) => {
    await handle.writeFile(
      JSON.stringify({
        timestamp: new Date(Date.UTC(2026, 9, 5) + n++ * 100).toISOString(),
        type,
        payload,
      }) + "\n",
    );
  };
  await line("session_meta", { id: "streaming-session" });
  for (let i = 1; i <= count; i++) {
    await line("event_msg", { type: "task_started", turn_id: `turn-${i}` });
    await line("event_msg", { type: "user_message", message: `question ${i}` });
    await line("response_item", {
      type: "function_call",
      name: "exec_command",
      call_id: `call-${i}`,
      arguments: "{}",
    });
    await line("response_item", {
      type: "function_call_output",
      call_id: `call-${i}`,
      output: "x".repeat(outputBytes),
    });
    await line("event_msg", { type: "token_count" });
    await line("response_item", {
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: `answer ${i}` }],
    });
    await line("event_msg", { type: "task_complete" });
  }
  await handle.close();
  return { dir, file };
}

type WireSpan = {
  traceId: string;
  spanId: string;
  name: string;
  attributes: Array<{ key: string; value: { stringValue?: string; boolValue?: boolean } }>;
};
function parseSpans(body: string): WireSpan[] {
  const payload = JSON.parse(body) as {
    resourceSpans: Array<{ scopeSpans: Array<{ spans: WireSpan[] }> }>;
  };
  return payload.resourceSpans.flatMap((r) => r.scopeSpans.flatMap((s) => s.spans));
}
async function sidecar(file: string) {
  return (await fs.readFile(file + ".langfuse", "utf8").catch(() => ""))
    .split("\n")
    .filter(Boolean);
}
function run(dir: string, file: string, port: number) {
  const child = spawn(process.execPath, ["--max-old-space-size=128", bundle], {
    cwd: dir,
    env: {
      ...process.env,
      CODEX_HOME: dir,
      OTEL_TRACES_SAMPLER: "always_on",
      TRACE_TO_LANGFUSE: "true",
      LANGFUSE_PUBLIC_KEY: "pk-test",
      LANGFUSE_SECRET_KEY: "sk-test",
      LANGFUSE_BASE_URL: `http://127.0.0.1:${port}`,
      LANGFUSE_CODEX_FAIL_ON_ERROR: "true",
      LANGFUSE_CODEX_DEBUG: "true",
      LANGFUSE_CODEX_TRACE_SEED: "streaming-test",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const result = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stderr: string;
  }>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("hook timed out"));
    }, 15_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stderr });
    });
  });
  child.stdin.end(JSON.stringify({ transcript_path: file }));
  return { child, result };
}
async function receiver(
  onRequest: (body: string, response: http.ServerResponse) => void | Promise<void>,
) {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      void onRequest(Buffer.concat(chunks).toString(), res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as { port: number }).port,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
const ok = (res: http.ServerResponse) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end("{}");
};

describe("streaming delivery checkpoints", () => {
  for (const mode of ["rejection", "interruption"] as const) {
    it(`retries unfinished turns after ${mode}, preserving ids and confirmed checkpoints`, async () => {
      const { dir, file } = await stage();
      let child: ChildProcessWithoutNullStreams;
      let attempt = 0;
      const requests: WireSpan[][][] = [[], []];
      let marksAtFailure: string[] = [];
      const server = await receiver(async (body, res) => {
        requests[attempt].push(parseSpans(body));
        if (attempt === 0 && requests[0].length === 2) {
          marksAtFailure = await sidecar(file);
          if (mode === "interruption") {
            child.kill("SIGTERM");
            res.destroy();
          } else {
            res.writeHead(400);
            res.end("rejected");
          }
        } else ok(res);
      });
      try {
        const first = run(dir, file, server.port);
        child = first.child;
        const failure = await first.result;
        expect(failure.code).not.toBe(0);
        expect(marksAtFailure).toEqual(["turn-1"]);
        expect(await sidecar(file)).toEqual(["turn-1"]);
        attempt = 1;
        const retry = await run(dir, file, server.port).result;
        expect(retry.code, retry.stderr).toBe(0);
        expect(await sidecar(file)).toEqual(["turn-1", "turn-2", "turn-3"]);
        const identities = (spans: WireSpan[]) =>
          spans.map(({ traceId, spanId }) => ({ traceId, spanId }));
        expect(identities(requests[1][0])).toEqual(identities(requests[0][1]));
        expect(requests[1]).toHaveLength(2);
      } finally {
        await server.close();
      }
    });
  }

  it("processes growing history under a 128 MiB heap and explicitly labels omitted repeated input", async () => {
    const { dir, file } = await stage(120, 100_000);
    let spanCount = 0;
    let omitted = 0;
    let intactToolOutputs = 0;
    const server = await receiver((body, res) => {
      const spans = parseSpans(body);
      spanCount += spans.length;
      omitted += spans.filter((s) =>
        s.attributes.some(
          (a) =>
            a.key.endsWith("codex.generation_input.omitted") &&
            (a.value.boolValue === true || a.value.stringValue === "true"),
        ),
      ).length;
      intactToolOutputs += spans.filter(
        (s) =>
          s.name === "exec_command" &&
          s.attributes.some(
            (a) =>
              a.key === "langfuse.observation.output" &&
              a.value.stringValue?.includes("x".repeat(100_000)),
          ),
      ).length;
      ok(res);
    });
    try {
      const result = await run(dir, file, server.port).result;
      expect(result.code, result.stderr).toBe(0);
      expect(spanCount).toBe(120 * 4);
      expect(intactToolOutputs).toBe(120);
      expect(omitted).toBeGreaterThan(0);
      expect(await sidecar(file)).toHaveLength(120);
    } finally {
      await server.close();
    }
  }, 20_000);

  it("reports an oversized record without acknowledging the turn", async () => {
    const { dir, file } = await stage(1);
    await fs.appendFile(file, "x".repeat(8 * 1024 * 1024 + 1));
    let requests = 0;
    const server = await receiver((_body, res) => {
      requests++;
      ok(res);
    });
    try {
      const result = await run(dir, file, server.port).result;
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("exceeds 8388608 bytes");
      expect(requests).toBe(0);
      expect(await sidecar(file)).toEqual([]);
    } finally {
      await server.close();
    }
  });
});
