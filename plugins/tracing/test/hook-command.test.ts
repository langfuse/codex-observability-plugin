import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const hookConfigFile = path.join(repoRoot, "plugins/tracing/hooks/hooks.json");
const pluginRootDir = path.join(repoRoot, "plugins/tracing");

const tmpDirs: string[] = [];

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

afterEach(() => {
  while (tmpDirs.length) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

describe("bundled Stop hook command", () => {
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

  it("delivers and marks the final turn of a single-turn session", async () => {
    const codexHome = makeTempDir("lf-codex-home-");
    const sessionCwd = makeTempDir("lf-codex-cwd-");
    // Mirror the real `sessions/YYYY/MM/DD` layout: the hook derives the
    // sessions root from the rollout path to discover subagent threads.
    const sessionsDir = path.join(sessionCwd, "sessions", "2026", "06", "03");
    fs.mkdirSync(sessionsDir, { recursive: true });
    const rollout = path.join(sessionsDir, "rollout.jsonl");

    // A one-turn session as the Stop hook sees it: the turn is still open on
    // disk, and no later Stop hook will ever fire to finalize it.
    const event = (payload: Record<string, unknown>) =>
      JSON.stringify({ timestamp: "2026-06-03T12:00:00.000Z", type: "event_msg", payload });
    fs.writeFileSync(
      rollout,
      [
        JSON.stringify({
          timestamp: "2026-06-03T12:00:00.000Z",
          type: "session_meta",
          payload: { id: "sess-final", cli_version: "0.149.0" },
        }),
        event({ type: "task_started", turn_id: "turn-final" }),
        event({ type: "user_message", message: "What is 1 + 1?" }),
        event({ type: "agent_message", message: "1 + 1 = 2." }),
      ].join("\n") + "\n",
    );

    const received: string[] = [];
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk as Buffer));
      req.on("end", () => {
        received.push(Buffer.concat(chunks).toString("utf-8"));
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };

    try {
      const { code } = await runShellCommand(readHookCommand(), {
        cwd: sessionCwd,
        env: {
          ...process.env,
          PLUGIN_ROOT: pluginRootDir,
          CODEX_HOME: codexHome,
          HOME: codexHome,
          TRACE_TO_LANGFUSE: "true",
          LANGFUSE_PUBLIC_KEY: "pk-lf-test",
          LANGFUSE_SECRET_KEY: "sk-lf-test",
          LANGFUSE_BASE_URL: `http://127.0.0.1:${port}`,
        },
        input: JSON.stringify({
          hook_event_name: "Stop",
          session_id: "sess-final",
          turn_id: "turn-final",
          transcript_path: rollout,
        }),
      });

      expect(code).toBe(0);
      expect(received.join("")).toContain("turn-final");
      expect(fs.readFileSync(`${rollout}.langfuse`, "utf-8").trim()).toBe("turn-final");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("uses no shell syntax beyond the placeholder Codex substitutes itself", () => {
    expect(readHookCommand().replaceAll("${PLUGIN_ROOT}", "")).not.toContain("$");
  });
});
