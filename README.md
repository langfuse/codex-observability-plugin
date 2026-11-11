# Langfuse Codex Plugin

Codex plugin that sends OpenAI Codex session telemetry to Langfuse. It traces agent turns, model generations, reasoning summaries, system prompts, tool calls, images, subagent threads, skills, and token usage.

Langfuse also documents this integration on the [Codex integration page](https://langfuse.com/integrations/developer-tools/codex).

## Quick Start

Add the plugin marketplace:

```bash
codex plugin marketplace add langfuse/codex-observability-plugin
```

Then enable hooks and the plugin in `~/.codex/config.toml`, or only for one project in `<project>/.codex/config.toml`:

```toml
[features]
hooks = true

[plugins."tracing@codex-observability-plugin"]
enabled = true
```

Restart Codex after changing the config. When **Hooks need review** appears, review the Langfuse `Stop` hook in `/hooks` and trust it. An installed and enabled plugin is not yet a trusted hook, and no traces are uploaded before you trust it. Codex records trust against the current hook hash, so a plugin update can require another review.

## Supported Versions

- Codex `0.143` and newer
- Node.js `22` and newer
- The `npm` CLI on your `PATH`, which Codex uses to fetch the plugin from the npm registry
- Langfuse Cloud, or self-hosted Langfuse `3.95.0` and newer

## Langfuse Credentials

Create `~/.codex/langfuse.json` (global) or `<project>/.codex/langfuse.json` (per-project) with your Langfuse credentials.

```json
{
  "enabled": true,
  "public_key": "pk-lf-...",
  "secret_key": "sk-lf-...",
  "base_url": "https://cloud.langfuse.com"
}
```

Only `enabled`, `public_key` and `secret_key` are required. If `base_url` is not set, the plugin uses `https://cloud.langfuse.com` for the 🇪🇺 EU region. The other regions are `https://us.cloud.langfuse.com` (🇺🇸 US), `https://jp.cloud.langfuse.com` (🇯🇵 Japan) and `https://hipaa.cloud.langfuse.com` (⚕️ HIPAA).

You can also set credentials with environment variables:

```bash
export TRACE_TO_LANGFUSE="true"
export LANGFUSE_PUBLIC_KEY="pk-lf-..."
export LANGFUSE_SECRET_KEY="sk-lf-..."
export LANGFUSE_BASE_URL="https://cloud.langfuse.com"
```

Tracing stays off until `enabled` or `TRACE_TO_LANGFUSE` is true, so you opt in explicitly. Config is resolved as defaults, then `~/.codex/langfuse.json`, then `<project>/.codex/langfuse.json`, then environment variables, and the environment wins. `LANGFUSE_CODEX_*` variables take precedence over the matching `LANGFUSE_*` ones, so you can scope credentials to Codex without disturbing other Langfuse tooling on the same machine.

The remaining options are settable both ways, as a `langfuse.json` key or as the matching `LANGFUSE_CODEX_*` variable:

- `environment` labels the traces with an environment, for example `production`.
- `user_id` attaches a user to every trace. It defaults to the Codex auth email, if one is found.
- `tags` adds your own tags to every trace, either as a JSON array or as a comma-separated list.
- `metadata` attaches a JSON object to every trace.
- `skill_tags` tags traces with `skill:<name>` for every skill invoked in the turn, and defaults to `true`.
- `trace_seed` derives deterministic trace ids, so a headless caller knows a run's trace id up front. Use a unique seed per session.
- `max_history_chars` caps the conversation history attached to each model generation, keeping the most recent messages up to this many serialized characters and replacing older ones with a single "earlier message(s) omitted" marker. It defaults to `200000`, and `0` disables the cap. Tool spans always keep their full output. Raising it or disabling it can exhaust memory on long sessions.
- `debug` logs verbosely to stderr, and defaults to `false`.
- `fail_on_error` fails the hook on upload errors instead of failing open, and defaults to `false`.

Everything the plugin traces is uploaded to Langfuse, including prompts and tool inputs and outputs, so do not enable it for sessions containing data you do not want stored there.

## Incremental rollout reads

The Stop hook checkpoints acknowledged main-thread turns in a private
`<rollout>.langfuse.cursor` file. Subsequent hooks seek to that byte offset rather
than re-reading the acknowledged prefix. The checkpoint retains parser context
(instructions and discovered tools), original turn numbering, and only the
conversation suffix needed by `max_history_chars`. It contains conversation
content; protect it like the transcript. It is written atomically with mode `0600`
on POSIX systems; Windows inherits directory ACLs.

The existing `.langfuse` delivery receipts remain authoritative. A checkpoint is
committed only after the export callback has completed and its turn receipt is
present. A stopped turn without a completion record is still delivered, but its
bytes remain retryable until completion or the next turn starts. Partial trailing
lines are deferred until a newline is appended.

Missing/corrupt checkpoints, a replaced or truncated file, removed receipts, and
changes to `max_history_chars` rebuild from the transcript. Concurrent hooks may
replace the checkpoint with an older acknowledged position: this causes extra
reads, not lost turns. Subagent/ancestor traversal and unbounded history
(`max_history_chars: 0`) retain the existing full-read path for fidelity. This
optimization reduces repeated main-rollout reads; it does not claim constant
total I/O or eliminate the cost of converting a single large turn.

Subagent discovery still runs on every hook, but its scope is now bounded on all
platforms: the day-directory pruning previously compared a `path.relative`
result against a `/`-separated pattern, so on Windows it never matched and every
hook walked the entire session history. Separators are normalized before the
check. Within the remaining scope, timestamped rollouts that started before the
current session are skipped without opening them, since they cannot be its
subagents. Unannounced-subagent recovery still reads session headers in scope,
and child threads still scan earlier days. Windows behavior is verified by
source inspection and path-level tests, not yet on a Windows host.

## Hook diagnostics

Set `LANGFUSE_CODEX_DIAGNOSTICS=true` to retain structured hook progress in
`$CODEX_HOME/langfuse-diagnostics/hook.jsonl` (default `~/.codex`). The file rotates
at 1 MiB to `hook.jsonl.previous`. Records include skip reasons, parsing mode,
cursor position, memory counters, conversion/flush progress and safe error
categories, never transcript content, credentials, raw errors or full paths.
They are also written to stderr. Unlike verbose `debug` output, these files can
be used for failure reports. POSIX files are mode `0600`.

A missing final record can indicate termination or timeout; it does not by
itself prove an OOM. Diagnostics are best-effort and do not change failure-open
or upload behavior.

## Contributing

See the [contributing guide](./CONTRIBUTING.md).

## License

[MIT](./LICENSE)
