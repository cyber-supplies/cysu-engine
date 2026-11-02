# cysu-engine

Self-hosted, open-source engine for Cyber Supplies. Build workflows from your
profiles in a web UI and run them in Docker containers that come with
everything set up.

> Early base — work in progress.

## What you need

- Node.js 20+
- Docker (to run workflows)
- A Cyber Supplies user token and your passkey

## Run it

```sh
npm run image:build   # builds the workspace image (cysu-engine-workspace:dev)
npm start             # http://127.0.0.1:8787
```

Your token, passkey and LLM key are stored only on this machine, in `data/`.

## Layout

| Path        | What                                                              |
|-------------|-------------------------------------------------------------------|
| `server/`   | Node server (no dependencies): JSON API, settings, Docker runs    |
| `web/`      | Web UI: setup, drag profiles into a workflow, run, view logs      |
| `image/`    | Workspace image: Node, Go, Python, ProjectDiscovery, cysu, Codex  |

## Environment

| Variable            | Default                         |
|---------------------|---------------------------------|
| `PORT`              | `8787`                          |
| `HOST`              | `127.0.0.1`                     |
| `CYSU_API_URL`      | the Cyber Supplies gateway      |
| `CYSU_ENGINE_DATA`  | `./data`                        |
| `CYSU_ENGINE_IMAGE` | `cysu-engine-workspace:dev`     |
