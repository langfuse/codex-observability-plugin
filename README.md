# Langfuse Tracing Plugin for OpenAI Codex

A [Codex](https://developers.openai.com/codex) plugin that traces agent turns, model calls, tool executions, token usage, and subagent threads to [Langfuse](https://langfuse.com).

Once enabled, every Codex turn shows up in Langfuse as a trace you can inspect, debug, evaluate, and monitor for cost — turning Codex from a black box into an observable agent.

## What gets traced

After each Codex turn, the plugin reads the session's rollout transcript and uploads it to Langfuse as a [trace](https://langfuse.com/docs/observability/data-model). The structure mirrors how Codex actually works:

- **Turn** (`Codex Turn`, an [agent observation](https://langfuse.com/docs/observability/features/observation-types)) — one trace per turn, from your prompt to the final answer.
- **Generations** — one per model response within the turn, named `LLM` (or `LLM Subagent` inside subagent threads), with the model recorded on the observation plus reasoning, assistant text, the tool calls it requested, token usage, and the active Codex service tier.
- **Tool calls** — shell commands, `apply_patch`, `spawn_agent`, MCP tools, web searches, etc., each with its input, output, and error status. MCP calls are named `server.tool`, and failed commands are flagged as errors.
- **Subagents** — subagent threads are resolved from their own rollout files and nested under the spawning turn as `Codex Subagent Turn`.
- **Sessions** — all turns from one Codex session are grouped via the Codex thread id, so you can replay the whole session in Langfuse's [Sessions](https://langfuse.com/docs/observability/features/sessions) view.

Interrupted turns (where you cancel mid-response) are still uploaded and flagged as interrupted.

## Prerequisites

- Node.js >= 22
- Codex >= 0.128
- A [Langfuse Cloud](https://cloud.langfuse.com) account (or a [self-hosted](https://langfuse.com/self-hosting) instance) and API keys

## Installation

### 1. Add the plugin marketplace

```bash
codex plugin marketplace add langfuse/codex-observability-plugin
```

### 2. Enable the plugin

Enable plugin hooks and the tracing plugin globally in `~/.codex/config.toml`, or only for a specific project in `<project>/.codex/config.toml`:

```toml
[features]
plugin_hooks = true

[plugins."tracing@codex-observability-plugin"]
enabled = true
```

### 3. Set your Langfuse credentials

Tracing stays off until `TRACE_TO_LANGFUSE` is `true`, so you opt in explicitly.

**Option 1: Shell environment (recommended)**

Add to your `~/.zshrc`, `~/.bashrc`, or `~/.bash_profile`:

```bash
export TRACE_TO_LANGFUSE="true"
export LANGFUSE_PUBLIC_KEY="pk-lf-..."
export LANGFUSE_SECRET_KEY="sk-lf-..."
export LANGFUSE_BASE_URL="https://cloud.langfuse.com" # 🇪🇺 EU (default)
```

**Option 2: JSON config file**

Create `~/.codex/langfuse.json` (global) or `<project>/.codex/langfuse.json` (per-project):

```json
{
  "enabled": true,
  "public_key": "pk-lf-...",
  "secret_key": "sk-lf-...",
  "base_url": "https://cloud.langfuse.com"
}
```

Config is resolved as **defaults → `~/.codex/langfuse.json` → `<project>/.codex/langfuse.json` → environment variables** (environment wins). `LANGFUSE_CODEX_*` variables take precedence over the matching standard `LANGFUSE_*` variables, so you can scope credentials to Codex without disturbing other Langfuse tooling.

### 4. Get your Langfuse API keys

1. Go to [cloud.langfuse.com](https://cloud.langfuse.com) (or your self-hosted instance).
2. Create a project (or open an existing one).
3. Go to **Settings → API Keys → Create new API keys**.
4. Copy the **public** key (`pk-lf-...`) and **secret** key (`sk-lf-...`).

Run a Codex turn, then open your Langfuse project to see the trace.

## Environment variables

| Variable                                                      | Required | Default                      | Description                                                          |
| ------------------------------------------------------------- | -------- | ---------------------------- | -------------------------------------------------------------------- |
| `TRACE_TO_LANGFUSE`                                           | Yes      | `false`                      | Set to `"true"` to enable tracing                                    |
| `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_CODEX_PUBLIC_KEY`           | Yes      | —                            | Langfuse public key (`pk-lf-...`)                                    |
| `LANGFUSE_SECRET_KEY` / `LANGFUSE_CODEX_SECRET_KEY`           | Yes      | —                            | Langfuse secret key (`sk-lf-...`)                                    |
| `LANGFUSE_BASE_URL` / `LANGFUSE_CODEX_BASE_URL`               | No       | `https://cloud.langfuse.com` | Langfuse host / data region                                          |
| `LANGFUSE_TRACING_ENVIRONMENT` / `LANGFUSE_CODEX_ENVIRONMENT` | No       | —                            | Environment label for the traces (e.g. `production`)                 |
| `LANGFUSE_CODEX_USER_ID`                                      | No       | Codex auth email, if found   | Attach a user id to all traces                                       |
| `LANGFUSE_CODEX_TAGS`                                         | No       | —                            | Tags for all traces (JSON array or comma-separated)                  |
| `LANGFUSE_CODEX_METADATA`                                     | No       | —                            | JSON object of metadata to attach to all traces                      |
| `LANGFUSE_CODEX_TRACE_SEED`                                   | No       | —                            | Derive deterministic trace ids ([details](#deterministic-trace-ids)) |
| `LANGFUSE_CODEX_SERVICE_TIER`                                 | No       | Codex configuration          | Override the service-tier fallback when the rollout omits it         |
| `LANGFUSE_CODEX_MAX_CHARS`                                    | No       | `20000`                      | Truncate inputs/outputs longer than this many characters             |
| `LANGFUSE_CODEX_DEBUG`                                        | No       | `false`                      | Set to `"true"` for verbose logging to stderr                        |
| `LANGFUSE_CODEX_FAIL_ON_ERROR`                                | No       | `false`                      | Set to `"true"` to make hook upload errors fail the hook             |

### Data regions

| Region   | `LANGFUSE_BASE_URL`                |
| -------- | ---------------------------------- |
| 🇪🇺 EU    | `https://cloud.langfuse.com`       |
| 🇺🇸 US    | `https://us.cloud.langfuse.com`    |
| 🇯🇵 Japan | `https://jp.cloud.langfuse.com`    |
| ⚕️ HIPAA | `https://hipaa.cloud.langfuse.com` |

## Service-tier pricing

Codex service tiers can change model pricing. The plugin reads the active tier from each turn's rollout and records it as `codex.service_tier` generation metadata. For an initial turn whose rollout does not yet contain the tier, it falls back to `service_tier` in Codex's global or project `config.toml`. `LANGFUSE_CODEX_SERVICE_TIER` or `service_tier` in `langfuse.json` can override that fallback.

Non-default tiers also add a numeric usage-detail selector. For example, a `priority` tier emits:

```json
{
  "codex_service_tier_priority": 1
}
```

This lets a Langfuse custom model select a conditional pricing tier with a rule such as `^codex_service_tier_(fast|priority)$ > 0`. Other Codex tiers use the same `codex_service_tier_<normalized-tier>` convention. The selector has no price itself; the matching Langfuse tier supplies the applicable input, cache-read, and output prices. The plugin does not hard-code provider rates or organization-specific discounts.

## Deterministic trace ids

By default, trace ids are auto-generated, and an external system (a CI harness, benchmark runner, or dataset-experiment service) that runs `codex exec` headlessly has to poll the Langfuse API to discover the trace a run produced. Set `LANGFUSE_CODEX_TRACE_SEED` (or `trace_seed` in `langfuse.json`) to make trace ids predictable instead:

- **Turn N of the main thread** (1-based, in rollout order) gets the trace id `hex(sha256("<seed>:<N>")).slice(0, 32)`.
- **Turn N of a subagent thread** gets `hex(sha256("<seed>:<childThreadId>:<N>")).slice(0, 32)`, scoped by the subagent's thread id so it cannot collide with main-thread ids. (Subagent turns spawned _within_ a main-thread turn are nested inside that turn's trace as usual and don't get their own trace id.)

The main-thread formula deliberately excludes the Codex thread id, so you can compute the trace id **before** the run starts — no thread id, no polling. The derivation matches the Langfuse SDKs' `createTraceId(seed)` helper and always yields a valid W3C trace id.

**Use a unique seed per session** (e.g. a UUID or your job/run id). Reusing a seed across sessions produces colliding trace ids, and the second upload would merge into (and overwrite parts of) the first trace.

If derivation ever fails, the hook falls back to auto-generated ids and still uploads — it never blocks the session (set `LANGFUSE_CODEX_FAIL_ON_ERROR=true` while testing to surface such errors).

### Example: link a Codex run to a dataset run item

A harness can compute the trace id up front and register it with a [dataset run](https://langfuse.com/docs/evaluation/dataset-runs/native-run) — without ever fetching traces:

```bash
SEED="$(uuidgen)" # unique per codex exec invocation

# Trace id of the first main-thread turn: hex(sha256("<seed>:1")).slice(0, 32)
TRACE_ID=$(printf '%s:1' "$SEED" | shasum -a 256 | cut -c1-32)

# Link the precomputed trace id to a dataset run item before (or after) the run.
curl -s -X POST "$LANGFUSE_BASE_URL/api/public/dataset-run-items" \
  -u "$LANGFUSE_PUBLIC_KEY:$LANGFUSE_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"runName\": \"codex-benchmark-2026-07-13\",
    \"datasetItemId\": \"$DATASET_ITEM_ID\",
    \"traceId\": \"$TRACE_ID\"
  }"

# Run Codex; the Stop hook uploads the turn with exactly $TRACE_ID.
LANGFUSE_CODEX_TRACE_SEED="$SEED" codex exec "your prompt"
```

The same works from JavaScript with the Langfuse SDK: `await createTraceId(`${seed}:1`)` (from `@langfuse/tracing`) returns the identical id.

## JSON config reference

| Config key      | Environment variable                                          | Default                      | Description                       |
| --------------- | ------------------------------------------------------------- | ---------------------------- | --------------------------------- |
| `enabled`       | `TRACE_TO_LANGFUSE`                                           | `false`                      | Enable tracing                    |
| `public_key`    | `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_CODEX_PUBLIC_KEY`           | —                            | Langfuse public key               |
| `secret_key`    | `LANGFUSE_SECRET_KEY` / `LANGFUSE_CODEX_SECRET_KEY`           | —                            | Langfuse secret key               |
| `base_url`      | `LANGFUSE_BASE_URL` / `LANGFUSE_CODEX_BASE_URL`               | `https://cloud.langfuse.com` | Langfuse host                     |
| `environment`   | `LANGFUSE_TRACING_ENVIRONMENT` / `LANGFUSE_CODEX_ENVIRONMENT` | —                            | Environment label                 |
| `user_id`       | `LANGFUSE_CODEX_USER_ID`                                      | Codex auth email, if found   | User id for all traces            |
| `tags`          | `LANGFUSE_CODEX_TAGS`                                         | —                            | Tags for all traces               |
| `metadata`      | `LANGFUSE_CODEX_METADATA`                                     | —                            | Metadata object for all traces    |
| `trace_seed`    | `LANGFUSE_CODEX_TRACE_SEED`                                   | —                            | Deterministic trace-id seed       |
| `service_tier`  | `LANGFUSE_CODEX_SERVICE_TIER`                                 | Codex configuration          | Service-tier fallback override    |
| `max_chars`     | `LANGFUSE_CODEX_MAX_CHARS`                                    | `20000`                      | Input/output truncation threshold |
| `debug`         | `LANGFUSE_CODEX_DEBUG`                                        | `false`                      | Verbose logging                   |
| `fail_on_error` | `LANGFUSE_CODEX_FAIL_ON_ERROR`                                | `false`                      | Fail the hook on upload errors    |

## Troubleshooting

- **No traces appear** — confirm `plugin_hooks = true`, the plugin is enabled in `config.toml`, and `TRACE_TO_LANGFUSE=true` is visible to the Codex process. Run with `LANGFUSE_CODEX_DEBUG=true` to log to stderr.
- **Authentication fails** — check that the public/secret keys are valid and that `LANGFUSE_BASE_URL` matches the region the keys belong to.
- **Traces land in the wrong project** — API keys are project-scoped in Langfuse; use the keys for the project you want.
- **Testing hook failures** — set `LANGFUSE_CODEX_FAIL_ON_ERROR=true` together with `LANGFUSE_CODEX_DEBUG=true` to make Codex report upload or flush errors instead of failing open.
- **Checking dedup sidecars** — successful uploads of completed turns are recorded next to the rollout as `<rollout>.jsonl.langfuse`. If a Stop hook reads the rollout before Codex has written the turn-completed marker, the trace may upload without a sidecar entry; the next Stop hook will finalize and mark it.
- **Verifying in Langfuse** — use `npx langfuse-cli api traces list --from-timestamp <recent ISO> --limit 10 --order-by timestamp.desc --fields core,metrics,observations --json` with credentials for the same project.
- **Sandboxed/network-restricted runs** — Codex sandbox or network policy can prevent exports from reaching Langfuse. Debug logging and fail-on-error mode are the quickest way to distinguish hook execution from network failure.
- **Self-hosting** — the TypeScript SDK requires Langfuse platform version >= 3.95.0.

## Data sent to Langfuse

When enabled, the plugin uploads completed Codex transcript data to Langfuse: prompts, assistant messages, reasoning summaries, tool-call inputs and outputs, model metadata, and token usage. Do not enable tracing for sessions containing data you do not want stored in Langfuse. Use `LANGFUSE_CODEX_MAX_CHARS` to cap how much of large inputs/outputs is captured.

## How it works

Codex emits a [`Stop` hook](https://developers.openai.com/codex) after each turn, passing the path to the session's rollout transcript on stdin. The plugin:

1. Reads the rollout JSONL and reconstructs each turn (model steps, tool calls, usage, subagents).
2. Converts them into Langfuse observations with the original timestamps, using the [Langfuse TypeScript SDK](https://langfuse.com/docs/observability/sdk/overview) on top of OpenTelemetry.
3. Records uploaded turn ids in a sidecar file (`<rollout>.langfuse`) so resuming a session does not re-upload completed turns.

The hook fails open: any tracing error is logged and swallowed so it never blocks your Codex session.

## Development

```bash
pnpm install
pnpm test        # run the test suite
pnpm run lint    # prettier + tsc + verify the committed bundle is current
pnpm run build   # bundle the hook to plugins/tracing/dist/index.mjs
```

The hook ships as a single self-contained `plugins/tracing/dist/index.mjs` (no install step runs when Codex loads the plugin), so the bundle is committed to the repo. After changing anything under `src/`, run `pnpm run build` and commit the updated bundle — CI enforces this via `pnpm run lint`.

## License

[MIT](./LICENSE)
