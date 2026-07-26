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

A tag that fails the gate publishes nothing. Delete it (`git push --delete origin v0.2.0`), fix the problem, and tag again.

## One-time setup

The repository needs an `NPM_TOKEN` secret before the first release: an npm **automation** token (Access Tokens → Generate New Token → Granular Access or Classic Automation), stored under Settings → Secrets and variables → Actions. An automation token is the kind that bypasses 2FA, which is why an interactive token will not do.

Once the first version is live on npm, switch to [trusted publishing](https://docs.npmjs.com/trusted-publishers) — it needs no long-lived secret:

1. On the package's npmjs.com settings page, add `flolefebvre/prisma-factorio` with workflow `release.yml` as a trusted publisher.
2. Delete the `publish` job's `env:` block and the `guard` job's credential check from `release.yml`.
3. Delete the `NPM_TOKEN` repository secret.

Provenance survives the switch either way: it comes from the OIDC token GitHub mints for the job, not from how npm authenticated the publish.

## What ships

`files` in `package.json` limits the tarball to `dist/` and `LICENSE`; npm adds `README.md` and `package.json` on its own. `pnpm pack:check` asserts exactly that — nothing stray, no test files, both entry points present — and runs in `pnpm gates`, so a change that would publish the scratch client or the test helpers fails in the pull request rather than on npm.
