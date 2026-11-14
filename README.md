# cysu-engine

Self-hosted, open-source engine for Cyber Supplies. It runs in the background
on your machine; you use it from the `cysu` CLI: you build workspaces from
your profiles, start runs, and see the results.
Every stage runs in a hardened Docker container that comes with everything
set up. There is no web UI.

Version 3 adds a single-command VPS installer with a publicly trusted HTTPS
endpoint at the server's IP address.

## Install and run

For a VPS, see **[docs/INSTALL.md](docs/INSTALL.md)**. The standalone
[`install.sh`](install.sh) script requires `--token`, accepts `--ip` for HTTPS, installs Docker,
and deploys the engine and its HTTPS reverse proxy. For a local checkout:

```sh
npm run image:build          # worker image
npm run engine:build         # engine image
sudo env CYSU_ENGINE_IMAGE_REF=cysu-engine:dev sh install.sh --token usr_YOUR_TOKEN
```

The installer provisions the token locally; API requests cannot enroll or
rotate it. Rerun the installer with `--token` to change it. See the
[v3 upgrade notes](docs/INSTALL.md#upgrading-to-v3) for client compatibility.
Your token, passkey and LLM login stay on this machine.

Workflows accept `provider: "codex"`, `"claude"`, or `"openrouter"` in their
request. When omitted, the engine selects saved credentials in this order:
**Codex → Claude → OpenRouter**. Selection stays fixed throughout the run;
failures never switch providers. An explicit choice requires its credentials.
For a workflow's `settings.yaml`, set it under `request`:

```yaml
request:
  provider: claude # codex, claude, or openrouter; omit for automatic selection
  stages:
    - profile: recon
```

Add an OpenRouter key and model through the authenticated
`PUT /api/llm/openrouter-auth` endpoint. See [LLM configuration](docs/INSTALL.md#openrouter-authentication).

Claude Code can sign in through `POST /api/llm/claude-login`, keeping its own
credentials in a persistent Docker volume. See [Claude login](docs/INSTALL.md#claude-code-subscription-login).
Claude workflows run the official Claude Code CLI with that volume. Codex and
OpenRouter workflows use Codex.

For development, `npm start` runs the engine straight from the checkout
(Node.js 20+); protected routes remain locked without provisioned auth data.

## Tests

```sh
npm test                     # quick checks, no Docker
npm run image:build:test     # once: test layer (stand-in Codex and Claude)
npm run test:image           # everything with Docker (~5 min)
```

## Layout

| Path        | What                                                              |
|-------------|-------------------------------------------------------------------|
| `Dockerfile` | The engine image (runs the engine itself) |
| `install.sh` | Standalone Debian/Ubuntu VPS installer for HTTPS on a public IPv4 address |
| `scripts/engine.sh` | Start/stop/status/logs/update the engine container |
| `docs/RELEASING.md` | Publishing the images (GitHub Actions, ghcr.io) |
| `.github/workflows/release.yml` | The release workflow (tag `v*` or Run workflow) |
| `docs/INSTALL.md` | Install and run (for testers) |
| `docs/CLI.md` | How the `cysu` CLI talks to the engine (setup, slash commands) |
| `server/`   | Node server (no dependencies): JSON API, settings, Docker runs, schedules (`schedules.js` rules + storage, `scheduler.js` the timer) |
| `image/`    | Workspace image: Node, Go, Python, ProjectDiscovery, cysu, Codex, Claude Code |

## Environment

| Variable            | Default                         |
|---------------------|---------------------------------|
| `PORT`              | `8787`                          |
| `HOST`              | `127.0.0.1`                     |
| `CYSU_API_URL`      | the Cyber Supplies gateway      |
| `CYSU_ENGINE_DATA`  | `./data`                        |
| `CYSU_ENGINE_IMAGE` | `cysu-engine-workspace:dev`     |
