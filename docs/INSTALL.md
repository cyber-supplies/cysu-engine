# Installing and running the Cyber Supplies Engine

The engine runs on your own machine, inside Docker. You use it from the
`cysu` CLI: `cysu engine` starts it if needed, asks for your setup the first
time, and then takes your commands (`/help` lists them).

## What you need

- **Docker** — Docker Engine on Linux, or Docker Desktop on macOS/Windows.
  Check with `docker ps` (no error = good). Published engine and worker images
  target `linux/amd64`; ARM hosts require emulation and are not tested.
- **The `cysu` CLI** (`npm install -g @cyber-supplies/cysu`).
- Your **Cyber Supplies user token** (starts with `usr_`) and a **passkey**
  you choose (it encrypts your data; keep using the same one). The token
  also becomes the engine's login: only someone with it can use your engine.
- **Your own LLM:** a ChatGPT account (sign in through Codex) or an OpenAI API key.

## Start

```sh
cysu engine
```

The first time, this downloads the engine and its worker image, starts the
engine in the background, and walks you through setup (token, passkey, LLM
login). After that it goes straight to the command prompt. Type `/help` for commands.

Without the CLI, `sh scripts/engine.sh start` does the same with the
published images. Or build them yourself from a checkout of this repository:

```sh
npm run image:build          # the worker image (Node, Go, Python, ProjectDiscovery, cysu, Codex) — ~10 min
npm run engine:build         # the engine image
CYSU_ENGINE_IMAGE_REF=cysu-engine:dev sh scripts/engine.sh start   # → Engine ready on http://127.0.0.1:8787
```

## Everyday

| | |
|---|---|
| `sh scripts/engine.sh status` | is it running (with `CYSU_TOKEN` set to your user token: also whether it is set up) |
| `sh scripts/engine.sh stop` | stop it (a run in progress is cancelled) |
| `sh scripts/engine.sh start` | start it again — your settings, logins and runs are kept |
| `sh scripts/engine.sh logs` | follow its log |
| `sh scripts/engine.sh update` | use a newer engine image (data is kept) |
| `sh scripts/engine.sh reset-auth` | lost the token the engine was set up with? forget it, then run setup again (everything else is kept) |

It also restarts by itself after a reboot (`--restart unless-stopped`).

## Where your data is

Everything stays on this machine, in the Docker volume `cysu-engine-data`:
your token, passkey, LLM login, workspaces, schedules and runs. Your passkey is
never sent to Cyber Supplies; it is only used inside your own containers.

To remove the engine **and all its data**:

```sh
sh scripts/engine.sh stop
docker rm cysu-engine
docker volume rm cysu-engine-data
docker volume rm cysu-engine-agent   # only if an older engine version created it
```

## Good to know

- **Docker access.** To start the worker containers, the engine has access
  to Docker on this machine (the Docker socket). That is full control of
  Docker — install it only on a machine you use for this.
- **Only this machine can reach it,** and only with your token. It listens on
  `127.0.0.1` only and refuses requests from web pages. Every request must
  carry the Cyber Supplies user token you set it up with; after 10 wrong
  tokens in a minute it refuses everything for a minute.
- **Workers are locked down.** Each stage runs in a fresh container as an
  unprivileged user, with a firewall that blocks your machine, your local
  network and cloud metadata addresses (the internet stays reachable).
- **Worker tools refresh at startup.** Each worker resolves and installs the
  latest published `cysu` CLI before running a stage, then installs the Cyber
  Supplies proxy and its CA using the run token. Worker startup needs access
  to npm and the proxy's CA endpoint. The proxy token is stored only in that
  worker's ephemeral `/etc/environment`, readable by root and the worker user.
- **Scheduled runs need the engine running.** A schedule starts its run by
  itself, but only while the engine is up (it restarts with Docker after a
  reboot). If the computer is off or asleep at the time, that run is skipped
  and noted in the schedule's history, not run late. If another run is still
  going, the scheduled one waits and starts when it ends.
- **Only targets you are authorized to test.**

## Troubleshooting

| Problem | Fix |
|---|---|
| `Docker is not running, or this user cannot use it` | Start Docker; on Linux add yourself to the `docker` group (then log out and in) |
| `The engine did not answer` | `sh scripts/engine.sh logs` |
| Port 8787 is taken | `CYSU_ENGINE_PORT=8788 sh scripts/engine.sh start` (and set `CYSU_ENGINE_URL=http://127.0.0.1:8788` for the CLI) |
| Setup says the token is wrong | The engine needs your **user** token (`usr_…`), not an LLM token (`llm_…`), and Cyber Supplies must accept it (check it, or make a new one) |
| Setup says it could not check the token | Cyber Supplies could not be reached: check your network and try again |
| `Missing or wrong engine token` | The CLI is not using the token the engine was set up with. Use that one, or (if it is lost) `sh scripts/engine.sh reset-auth`, then setup |
| `Too many wrong engine tokens` | Wait a minute (something sent wrong tokens); then use the right one |
| `Cyber Supplies did not accept your user token` | Your token was revoked or replaced: run `/setup` with a new one |
| ProjectDiscovery tools (subfinder, dnsx, httpx…) find nothing or time out on a university/company network | See *Restrictive networks* below |

### Restrictive networks (DNS)

Some networks (many universities and companies) block DNS to public servers
such as `1.1.1.1` and `8.8.8.8`. ProjectDiscovery tools use those servers by
default, so on such a network they find nothing or time out, while normal
browsing still works. Normal tools (`curl`, `dig`) are not affected: they use
the network's own DNS server.

Check: `dig +short example.com @1.1.1.1` times out, but `dig +short example.com` works.

Workaround: point the tools at the DNS server a worker container uses — the
worker firewall allows DNS only to those servers. To see it:

```sh
docker run --rm --entrypoint cat cysu-engine-workspace:dev /etc/resolv.conf
```

Then use its `nameserver` address, e.g. `dnsx -r 10.0.0.2` or
`subfinder -r 10.0.0.2`: say so in a run's objective ("use resolver 10.0.0.2
for ProjectDiscovery tools") or put it in a profile. Making the engine do this
automatically is planned.

