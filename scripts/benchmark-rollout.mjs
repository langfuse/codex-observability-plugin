// Usage: node scripts/benchmark-rollout.mjs [bundle] [turns] [tool-output-bytes]
// Runs the real bundled hook under a 128 MiB heap against a local OTLP receiver.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, open, rm, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const bundle = resolve(process.argv[2] ?? "plugins/tracing/dist/index.mjs");
const turns = Number(process.argv[3] ?? 200);
const outputBytes = Number(process.argv[4] ?? 200_000);
const dir = await mkdtemp(join(tmpdir(), "codex-rollout-benchmark-"));
const sessions = join(dir, "sessions/2026/10/05");
await mkdir(sessions, { recursive: true });
const rollout = join(sessions, "rollout.jsonl");
const file = await open(rollout, "w");
let recordIndex = 0;
const line = async (type, payload) =>
  file.writeFile(
    JSON.stringify({
      timestamp: new Date(Date.UTC(2026, 9, 5) + recordIndex++ * 100).toISOString(),
      type,
      payload,
    }) + "\n",
  );
await line("session_meta", { id: "benchmark-session" });
for (let i = 0; i < turns; i++) {
  await line("event_msg", { type: "task_started", turn_id: `turn-${i}` });
  await line("event_msg", { type: "user_message", message: `Inspect file ${i}` });
  await line("response_item", {
    type: "function_call",
    name: "exec_command",
    call_id: `call-${i}`,
    arguments: '{"cmd":"cat example.txt"}',
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
    content: [{ type: "output_text", text: `File ${i} inspected.` }],
  });
  await line("event_msg", { type: "task_complete" });
}
await file.close();
let requests = 0;
let spans = 0;
const server = createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    requests++;
    const payload = JSON.parse(Buffer.concat(chunks).toString());
    for (const resource of payload.resourceSpans ?? []) {
      for (const scope of resource.scopeSpans ?? []) spans += scope.spans.length;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
try {
  const started = performance.now();
  const child = spawn(
    process.execPath,
    [
      "--max-old-space-size=128",
      "--input-type=module",
      "-e",
      `process.on('exit', () => console.error('MAX_RSS_KIB=' + process.resourceUsage().maxRSS)); await import(${JSON.stringify(pathToFileURL(bundle).href)});`,
    ],
    {
      cwd: dir,
      env: {
        ...process.env,
        CODEX_HOME: dir,
        OTEL_TRACES_SAMPLER: "always_on",
        TRACE_TO_LANGFUSE: "true",
        LANGFUSE_PUBLIC_KEY: "pk-test",
        LANGFUSE_SECRET_KEY: "sk-test",
        LANGFUSE_BASE_URL: `http://127.0.0.1:${server.address().port}`,
        LANGFUSE_CODEX_FAIL_ON_ERROR: "true",
        LANGFUSE_CODEX_DEBUG: "true",
      },
      stdio: ["pipe", "ignore", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-16000);
  });
  child.stdin.end(JSON.stringify({ transcript_path: rollout, turn_id: `turn-${turns - 1}` }));
  const timeout = setTimeout(() => child.kill("SIGKILL"), 120_000);
  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timeout);
  const marks = await readFile(rollout + ".langfuse", "utf8").catch(() => "");
  console.log(
    JSON.stringify(
      {
        bundle,
        turns,
        rolloutBytes: (await stat(rollout)).size,
        elapsedMs: Math.round(performance.now() - started),
        ...result,
        peakRssKiB: Number(/MAX_RSS_KIB=(\d+)/.exec(stderr)?.[1]) || null,
        requests,
        spans,
        checkpointedTurns: marks.split("\n").filter(Boolean).length,
        ...(result.code !== 0 ? { error: stderr.slice(-3000) } : {}),
      },
      null,
      2,
    ),
  );
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
}
