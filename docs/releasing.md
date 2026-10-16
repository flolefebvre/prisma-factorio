# Releasing

The package is published to npm as [`@flefebvre/prisma-factorio`](https://www.npmjs.com/package/@flefebvre/prisma-factorio) by `.github/workflows/release.yml`, which runs on a version tag and on nothing else. Merging to `main` never publishes.

## Cutting a release

1. Land everything the release should carry on `main`.
2. Bump `version` in `package.json` on a branch, and land that too — the release workflow refuses a tag whose version disagrees with the manifest.
3. Tag the merge commit and push the tag:

   ```bash
   git checkout main && git pull
   git tag v0.2.0
   git push origin v0.2.0
   ```

The workflow then checks the tag against `package.json`, runs the full `ci.yml` gate, rebuilds `dist/` from that exact commit through `prepublishOnly`, publishes with npm [provenance](https://docs.npmjs.com/generating-provenance-statements), and cuts the GitHub release with generated notes.

The gate runs in full on Node 22, and its generate, typecheck and test steps again on Node 24 and Node 26: the Node 24 lane is required, the Node 26 lane advisory, so a failure there never holds back a release.

A tag that fails the gate publishes nothing. Delete it (`git push --delete origin v0.2.0`), fix the problem, and tag again.

## One-time setup

The repository needs an `NPM_TOKEN` secret before the first release: an npm **automation** token (Access Tokens → Generate New Token → Granular Access or Classic Automation), stored under Settings → Secrets and variables → Actions. An automation token is the kind that bypasses 2FA, which is why an interactive token will not do.

Once the first version is live on npm, switch to [trusted publishing](https://docs.npmjs.com/trusted-publishers) — it needs no long-lived secret:

1. On the package's npmjs.com settings page, add `flolefebvre/prisma-factorio` with workflow `release.yml` as a trusted publisher.
2. Delete the `publish` job's `env:` block and the `guard` job's credential check from `release.yml`.
3. Delete the `NPM_TOKEN` repository secret.

Provenance survives the switch either way: it comes from the OIDC token GitHub mints for the job, not from how npm authenticated the publish.

## Context7

[`context7.json`](../context7.json) claims the library on [Context7](https://context7.com/flolefebvre/prisma-factorio), which indexes the repository so coding assistants answer about this package from its current documentation rather than from training data.

It indexes `README.md`, `CONTEXT.md`, `docs/for-agents.md` and `docs/prisma-test-helper.md` — the four documents written for a consumer — and excludes everything written for whoever works on the library: `AGENTS.md` and `CLAUDE.md`, `docs/adr/`, `docs/agents/`, this file, the repository's own tooling config, and `src/` with its tests. `docs/laravel-factories.md` is excluded by name: it is Laravel's own PHP documentation, vendored as a reference, and indexing it would answer TypeScript questions with PHP.

Claiming is stricter than configuring: the claim modal's submission accepts a `context7.json` holding `url` and `public_key` and nothing else, and rejects the configured file with "context7.json format is incorrect for claiming". Claim with the bare pair, then restore the configuration in a second commit — the claim stays verified.

Two things to keep current:

- **`rules`** state the constraints an assistant most often gets wrong — ESM only, immutable factories, no transaction of its own. They are the Rules section of `docs/for-agents.md`, one entry per numbered rule in the same order, so a change to either belongs in both.
- **`previousVersions`** takes the outgoing version's tag when a new one goes out, so an assistant pinned to an older release still gets that release's documentation. Add `{ "tag": "v0.1.0" }` when 0.2.0 ships.

## What ships

`files` in `package.json` limits the tarball to `dist/`, `src/` without its test files, `LICENSE`, `docs/for-agents.md` and `docs/prisma-test-helper.md` — the source ships so the paths a source-mapped stack trace names resolve on disk; npm adds `README.md` and `package.json` on its own. `pnpm pack:check` asserts exactly that — nothing stray, no other `docs/` page, no test files, both entry points and both pages present, every relative link in a shipped markdown file resolving to a shipped file, and every source a shipped `dist/*.js.map` names resolving to a shipped file and embedded in its `sourcesContent` — and runs in `pnpm gates`, so a change that would publish the scratch client or the test helpers fails in the pull request rather than on npm.
