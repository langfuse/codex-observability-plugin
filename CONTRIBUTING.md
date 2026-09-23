# Development and Maintenance

See the [main CONTRIBUTING.md](https://github.com/langfuse/langfuse/blob/main/CONTRIBUTING.md) to learn how to contribute to Langfuse and its integrations.

## Local Development

Install dependencies:

```bash
pnpm install
```

Build the plugin:

```bash
pnpm run build
```

Run the test suite:

```bash
pnpm test
```

Format files:

```bash
pnpm run format
```

Check formatting:

```bash
pnpm run format:check
```

Check formatting, types and the build together:

```bash
pnpm run lint
```

tsdown bundles the hook and its runtime dependencies into `plugins/tracing/dist/index.mjs`. Codex runs the plugin without an install step and never installs its dependencies, so the bundle has to be self contained. It is a build output and is not committed, and `prepack` builds it when the npm package is published, so it travels in the tarball instead of in Git. `pnpm test` builds before it runs, because the hook-command test executes the bundled hook. Do not edit generated files in `dist/` by hand.

## Releasing

1. From a clean, up-to-date `main` branch, bump the version in **both** `plugins/tracing/package.json` and `plugins/tracing/.codex-plugin/plugin.json`, then push the resulting commit and tag:

   ```bash
   git commit -am "Release v1.2.3"
   git tag v1.2.3
   git push origin main --follow-tags
   ```

   The release workflow refuses a tag that does not match the `package.json` version, and it refuses a `plugin.json` version that disagrees with it. It then lints, tests, stages the package on npm with provenance, and creates a draft GitHub release. A tag containing a hyphen, such as `v1.2.3-rc.1`, is staged under the `next` dist-tag rather than `latest`.

2. Review the staged package on npmjs.com or with the npm CLI:

   ```bash
   npm stage list @langfuse/codex-observability-plugin
   npm stage view <stage-id>
   npm stage download <stage-id>
   ```

3. Approve the staged package using an npm account with publish access and 2FA enabled:

   ```bash
   npm stage approve <stage-id>
   ```

4. Review and publish the draft GitHub release created by the workflow.

5. Point `.agents/plugins/marketplace.json` at the new version, because that pin is what users install.

Do not approve the npm package or publish the GitHub draft until both staged artifacts have been reviewed. If the workflow fails before staging, fix the problem and move the tag to the corrected release commit. If staging succeeded, do not rerun the workflow with the same version, because staged and published versions cannot be staged again.

The two versions you bump matter for different things. The one in `package.json` only decides which tarball npm hands out. The one in `plugin.json` is the version Codex installs under, so it names the cache directory `~/.codex/plugins/cache/<marketplace>/<plugin>/<version>/` and therefore decides whether an existing install is refreshed at all. Never leave `version` out of `plugin.json`, because Codex then installs under the literal name `local`, and since that name always matches itself, no automatic refresh will ever replace the install.
