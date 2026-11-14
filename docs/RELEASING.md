# Releasing the engine images

Testers do not build images; they download them from GitHub Container
Registry. A release builds both images on GitHub's servers and publishes them:

- `ghcr.io/cyber-supplies/cysu-engine:<version>` (and `:latest`)
- `ghcr.io/cyber-supplies/cysu-engine-workspace:<version>` (and `:latest`)

each for `linux/amd64` only. The engine image of a
version starts the worker image of the same version.

Nothing is published until a person triggers it.

## Steps

1. Make sure the tests pass (`npm test`, `npm run test:image`).
2. Set the new version in `package.json` (for v3: `"version": "3.0.0"`), commit,
   and push.
3. Trigger the release, either way:
   - **Tag:** `git tag v3.0.0 && git push origin v3.0.0`
   - **Button:** GitHub → the `cysu-engine` repository → **Actions** →
     **Release images** → **Run workflow** → enter `3.0.0`.
4. Watch it under **Actions**. It stops early if the version does not match
   `package.json`.
5. **First release only:** new packages start private. An organization admin
   opens each package (Organization → Packages → `cysu-engine`, then
   `cysu-engine-workspace`) → **Package settings** → **Change visibility** →
   **Public**, so testers can download them without logging in.

## Check it

```sh
docker pull ghcr.io/cyber-supplies/cysu-engine:3.0.0
sh scripts/engine.sh update     # restarts the engine on :latest
sh scripts/engine.sh status     # "version":"3.0.0"
```

The workflow is `.github/workflows/release.yml`. It uses the repository's
built-in `GITHUB_TOKEN` (permission `packages: write`); no secrets are needed.
