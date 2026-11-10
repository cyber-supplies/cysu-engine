# cysu-engine

Self-hosted, open-source engine for Cyber Supplies. It runs in the background
on your machine; you use it from the `cysu` CLI: you build workspaces from
your profiles, start runs, and see the results.
Every stage runs in a hardened Docker container that comes with everything
set up. There is no web UI.

> Early base — work in progress.

## Install and run

See **[docs/INSTALL.md](docs/INSTALL.md)**: with Docker and the `cysu` CLI,
`cysu engine` is all you need. From a checkout:

```sh
npm run image:build          # worker image
npm run engine:build         # engine image
CYSU_ENGINE_IMAGE_REF=cysu-engine:dev sh scripts/engine.sh start   # API on 127.0.0.1:8787
```

For development, `npm start` runs the engine straight from the checkout
(Node.js 20+). Your token, passkey and LLM login stay on this machine.

## Tests

```sh
npm test                     # quick checks, no Docker
npm run image:build:test     # once: test layer (stand-in Codex)
npm run test:image           # everything with Docker (~5 min)
```

## Layout

| Path        | What                                                              |
|-------------|-------------------------------------------------------------------|
| `Dockerfile` | The engine image (runs the engine itself) |
| `scripts/engine.sh` | Start/stop/status/logs/update the engine container |
| `docs/RELEASING.md` | Publishing the images (GitHub Actions, ghcr.io) |
| `.github/workflows/release.yml` | The release workflow (tag `v*` or Run workflow) |
| `docs/INSTALL.md` | Install and run (for testers) |
| `docs/CLI.md` | How the `cysu` CLI talks to the engine (setup, slash commands) |
| `server/`   | Node server (no dependencies): JSON API, settings, Docker runs, schedules (`schedules.js` rules + storage, `scheduler.js` the timer) |
| `image/`    | Workspace image: Node, Go, Python, ProjectDiscovery, cysu, Codex  |

## Environment

| Variable            | Default                         |
|---------------------|---------------------------------|
| `PORT`              | `8787`                          |
| `HOST`              | `127.0.0.1`                     |
| `CYSU_API_URL`      | the Cyber Supplies gateway      |
| `CYSU_ENGINE_DATA`  | `./data`                        |
| `CYSU_ENGINE_IMAGE` | `cysu-engine-workspace:dev`     |
| `CYSU_ENGINE_NETWORK` | `cysu-engine-net` (engine linked: the private network shared with workers) |
| `CYSU_ENGINE_AGENT_PORT` | `8788` (engine linked: the read-only agent port, on that network only) |
| `CYSU_ENGINE_CONTAINER` | the engine container's own name, when its hostname is not its id (engine linked) |
