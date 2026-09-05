import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const pluginRootDir = process.env.TEST_PLUGIN_ROOT ?? path.join(repoRoot, "plugins/tracing");
const hookConfigFile = path.join(pluginRootDir, "hooks/hooks.json");

const tmpDirs: string[] = [];

type ProtobufField = { number: number; wireType: number; value: Buffer | bigint };

function protobufFields(message: Buffer): ProtobufField[] {
  const fields: ProtobufField[] = [];
  let offset = 0;
  const readVarint = (): bigint => {
    let value = 0n;
    let shift = 0n;
    while (offset < message.length) {
      const byte = message[offset++];
      value |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return value;
      shift += 7n;
    }
    throw new Error("truncated protobuf varint");
  };

  while (offset < message.length) {
    const tag = Number(readVarint());
    const number = tag >>> 3;
    const wireType = tag & 7;
    if (wireType === 0) {
      fields.push({ number, wireType, value: readVarint() });
    } else if (wireType === 1) {
      const value = message.readBigUInt64LE(offset);
      offset += 8;
      fields.push({ number, wireType, value });
    } else if (wireType === 2) {
      const length = Number(readVarint());
      const value = message.subarray(offset, offset + length);
      offset += length;
      fields.push({ number, wireType, value });
    } else if (wireType === 5) {
      offset += 4;
    } else {
      throw new Error(`unsupported protobuf wire type ${wireType}`);
    }
  }
  return fields;
}

type ExportedSpan = { traceId: string; parentSpanId: string; endTimeUnixNano: bigint };

function exportedSpans(requestBody: Buffer): ExportedSpan[] {
  if (requestBody[0] === "{".charCodeAt(0)) {
    const payload = JSON.parse(requestBody.toString("utf-8")) as {
      resourceSpans?: Array<{
        scopeSpans?: Array<{
          spans?: Array<{
            traceId?: string;
            parentSpanId?: string;
            endTimeUnixNano?: string;
          }>;
        }>;
      }>;
    };
    return (payload.resourceSpans ?? []).flatMap((resource) =>
      (resource.scopeSpans ?? []).flatMap((scope) =>
        (scope.spans ?? []).map((span) => ({
          traceId: span.traceId ?? "",
          parentSpanId: span.parentSpanId ?? "",
          endTimeUnixNano: BigInt(span.endTimeUnixNano ?? "0"),
        })),
      ),
    );
  }

  const nested = (message: Buffer, fieldNumber: number): Buffer[] =>
    protobufFields(message)
      .filter((field) => field.number === fieldNumber && Buffer.isBuffer(field.value))
      .map((field) => field.value as Buffer);

  return nested(requestBody, 1).flatMap((resourceSpans) =>
    nested(resourceSpans, 2).flatMap((scopeSpans) =>
      nested(scopeSpans, 2).map((span) => {
        const fields = protobufFields(span);
        const bytes = (number: number): Buffer => {
          const value = fields.find((field) => field.number === number)?.value;
          return Buffer.isBuffer(value) ? value : Buffer.alloc(0);
        };
        const endTime = fields.find((field) => field.number === 8)?.value;
        return {
          traceId: bytes(1).toString("hex"),
          parentSpanId: bytes(4).toString("hex"),
          endTimeUnixNano: typeof endTime === "bigint" ? endTime : 0n,
        };
      }),
    ),
  );
}

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function readHookCommand(): string {
  const config = JSON.parse(fs.readFileSync(hookConfigFile, "utf-8")) as {
    hooks: { Stop: Array<{ hooks: Array<{ command: string }> }> };
  };
  return config.hooks.Stop[0].hooks[0].command;
}

function runShellCommand(
  command: string,
  options: { cwd: string; env: NodeJS.ProcessEnv; input: string },
): Promise<{ code: number | null; stderr: string; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd: options.cwd,
      env: options.env,
      shell: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("hook command timed out"));
    }, 10_000);

    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(options.input);
  });
}

function runStopHook(options: {
  rollout: string;
  baseUrl: string;
  codexHome: string;
  sessionCwd: string;
  failOnError?: boolean;
}): Promise<{ code: number | null; stderr: string; stdout: string }> {
  return runShellCommand(readHookCommand(), {
    cwd: options.sessionCwd,
    env: {
      ...process.env,
      PLUGIN_ROOT: pluginRootDir,
      CODEX_HOME: options.codexHome,
      HOME: options.codexHome,
      TRACE_TO_LANGFUSE: "true",
      LANGFUSE_PUBLIC_KEY: "pk-lf-test",
      LANGFUSE_SECRET_KEY: "sk-lf-test",
      LANGFUSE_BASE_URL: options.baseUrl,
      ...(options.failOnError === undefined
        ? {}
        : { LANGFUSE_CODEX_FAIL_ON_ERROR: String(options.failOnError) }),
    },
    input: JSON.stringify({
      hook_event_name: "Stop",
      turn_id: "turn-1",
      transcript_path: options.rollout,
    }),
  });
}

afterEach(() => {
  while (tmpDirs.length) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

describe("bundled Stop hook command", () => {
  it("exports the payload turn before Codex appends task_complete", async () => {
    const codexHome = makeTempDir("lf-codex-home-");
    const sessionCwd = makeTempDir("lf-codex-cwd-");
    const rollout = path.join(sessionCwd, "rollout.jsonl");
    const completed = fs.readFileSync(
      path.join(pluginRootDir, "test/fixtures/sessions/2026/06/03/rollout-basic-main.jsonl"),
      "utf-8",
    );
    const completedLines = completed.trimEnd().split("\n");
    const preTerminalLines = completedLines.slice(0, -1);
    const lastPersisted = JSON.parse(preTerminalLines.at(-1)!) as { timestamp: string };
    fs.writeFileSync(rollout, `${preTerminalLines.join("\n")}\n`);

    const exportBodies: Buffer[] = [];
    const server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        const body = Buffer.concat(chunks);
        exportBodies.push(request.headers["content-encoding"] === "gzip" ? gunzipSync(body) : body);
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected a TCP address");

    const baseUrl = `http://127.0.0.1:${address.port}`;
    const result = await runStopHook({
      rollout,
      baseUrl,
      codexHome,
      sessionCwd,
    });

    expect(result.code).toBe(0);
    expect(exportBodies).toHaveLength(1);
    const exported = exportBodies.flatMap(exportedSpans);
    const roots = exported.filter((span) => span.parentSpanId === "");
    expect(roots).toHaveLength(1);
    expect(roots[0].endTimeUnixNano).toBe(BigInt(Date.parse(lastPersisted.timestamp)) * 1_000_000n);
    const exportedPayload = Buffer.concat(exportBodies).toString("utf-8");
    expect(exportedPayload).toContain("turn-1");
    expect(exportedPayload).toContain("sess-basic");
    expect(exportedPayload).toContain("There are two files: file1.txt and file2.txt.");
    expect(fs.readFileSync(`${rollout}.langfuse`, "utf-8")).toBe("turn-1\n");

    // Codex persists this only after the Stop hook process has returned.
    fs.appendFileSync(rollout, `${completedLines.at(-1)}\n`);
    const requestsAfterFirstRun = exportBodies.length;
    const replay = await runStopHook({
      rollout,
      baseUrl,
      codexHome,
      sessionCwd,
    });
    expect(replay.code).toBe(0);
    expect(exportBodies).toHaveLength(requestsAfterFirstRun);
    expect(fs.readFileSync(`${rollout}.langfuse`, "utf-8")).toBe("turn-1\n");
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it.each([
    { failOnError: false, expectedCode: 0 },
    { failOnError: true, expectedCode: 1 },
  ])(
    "keeps a failed flush retryable when fail_on_error=$failOnError",
    async ({ failOnError, expectedCode }) => {
      const codexHome = makeTempDir("lf-codex-home-");
      const sessionCwd = makeTempDir("lf-codex-cwd-");
      const rollout = path.join(sessionCwd, "rollout.jsonl");
      const completed = fs.readFileSync(
        path.join(pluginRootDir, "test/fixtures/sessions/2026/06/03/rollout-basic-main.jsonl"),
        "utf-8",
      );
      fs.writeFileSync(rollout, `${completed.trimEnd().split("\n").slice(0, -1).join("\n")}\n`);

      const server = http.createServer((_request, response) => {
        response.writeHead(503, { "content-type": "application/json" });
        response.end('{"error":"unavailable"}');
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("expected a TCP address");

      const result = await runStopHook({
        rollout,
        baseUrl: `http://127.0.0.1:${address.port}`,
        codexHome,
        sessionCwd,
        failOnError,
      });

      expect(result.code).toBe(expectedCode);
      expect(result.stderr).toContain("telemetry export failed; turn remains retryable");
      expect(fs.existsSync(`${rollout}.langfuse`)).toBe(false);
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
    10_000,
  );

  it("runs from an arbitrary session cwd via PLUGIN_ROOT instead of a relative repo path", async () => {
    const codexHome = makeTempDir("lf-codex-home-");
    const sessionCwd = makeTempDir("lf-codex-cwd-");

    const { code, stderr, stdout } = await runShellCommand(readHookCommand(), {
      cwd: sessionCwd,
      env: {
        ...process.env,
        PLUGIN_ROOT: pluginRootDir,
        CODEX_HOME: codexHome,
        HOME: codexHome,
        TRACE_TO_LANGFUSE: "false",
      },
      input: JSON.stringify({
        hook_event_name: "Stop",
        transcript_path: path.join(sessionCwd, "rollout.jsonl"),
      }),
    });

    expect(code).toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toBe("");
  });

  it("does not depend on the old marketplace-root relative path", () => {
    expect(readHookCommand()).not.toContain("./plugins/tracing/dist/index.mjs");
  });

  it("uses no shell syntax beyond the placeholder Codex substitutes itself", () => {
    expect(readHookCommand().replaceAll("${PLUGIN_ROOT}", "")).not.toContain("$");
  });
});
