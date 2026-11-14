# Installing and running the Cyber Supplies Engine

## VPS with public HTTPS (v3)

Use a Debian 12 or Ubuntu VPS with a **stable public IPv4 address**. Allow
inbound TCP ports **80** and **443** in both the VPS firewall and the cloud
provider firewall. Port 80 is required for Let's Encrypt's certificate
challenge. Keep port 8787 closed to the internet; the installer binds the
engine to `127.0.0.1` and puts Caddy in front of it.

Once the 3.0.0 images have been published, run this one command on the VPS as
root, replacing the IP and token:

```sh
curl -fsSL https://raw.githubusercontent.com/cyber-supplies/cysu-engine/main/install.sh | sudo sh -s -- --ip 203.0.113.10 --token usr_YOUR_TOKEN
```

The installer installs Docker if needed, downloads the v3 engine and worker
images, checks the token with Cyber Supplies, writes it directly to the private
Docker data volume, starts Caddy, obtains a publicly trusted certificate for
the IP, and verifies `https://IP/api/health` from the host. It makes no engine
API calls to set or change the token. Caddy
renews the short lived certificate automatically. The engine and Caddy restart
after reboot; their data and certificates are kept in Docker volumes.

On your own computer, use the CLI with the address and your token:

```sh
cysu engine status --engine https://203.0.113.10 --token usr_YOUR_TOKEN
```

The `--token` argument is visible in shell history and process listings while
the command runs. Use a trusted VPS account and clear that shell history entry
if needed. The installer never writes the token into Caddy's configuration or
prints it. It is stored in `auth.json` with mode `0600` in the private Docker volume.
`--token` is mandatory on every installer run; `CYSU_TOKEN` is not a fallback.

The first setup only sets the user token. Set a passkey and complete the LLM
login with `cysu engine auth --engine https://IP --token usr_... --passphrase ...`
before starting runs. This login may ask you to finish a browser step.

To inspect the deployment on the VPS: `sudo docker logs cysu-engine`,
`sudo docker logs cysu-engine-proxy`, and `sudo docker ps`. Re-running the
same installer with the same IP and token is safe. To rotate or recover a
token, rerun it with `--token usr_NEW_TOKEN`; the old token is not needed.
An omitted `--ip` preserves an existing HTTPS installation. If the VPS IP changes,
reserve a new static address and remove the old `cysu-engine-proxy` container
before running the installer with the new IP; the engine data volume remains.

## Local machine

On x86_64 Linux, run the same installer without `--ip` for loopback-only
access. The installer requires root and Docker (or Debian/Ubuntu to install
Docker automatically). This installer does not support Docker Desktop on
macOS/Windows or ARM hosts.

## What you need

- **Docker Engine on Linux.** Check with `docker ps` (no error = good).
  Published engine and worker images target `linux/amd64`.
- **The `cysu` CLI** (`npm install -g @cyber-supplies/cysu`).
- Your **Cyber Supplies user token** (starts with `usr_`) and a **passkey**
  you choose (it encrypts your data; keep using the same one). The token
  also becomes the engine's login: only someone with it can use your engine.
- **Your own LLM:** a Codex or Claude subscription login, or an OpenRouter
  API key and model. The existing direct OpenAI API-key option is also supported.

## Start

```sh
sudo sh install.sh --token usr_YOUR_TOKEN
cysu engine status --engine http://127.0.0.1:8787 --token usr_YOUR_TOKEN
```

The installer downloads the engine and worker images and provisions the
token locally. Use `cysu engine auth --engine http://127.0.0.1:8787 --token
usr_YOUR_TOKEN --passphrase YOUR_PASSKEY` to finish the passkey and LLM login.

Or build the images yourself from a checkout of this repository:

```sh
npm run image:build          # the worker image (Node, Go, Python, ProjectDiscovery, cysu, Codex, Claude Code) — ~10 min
npm run engine:build         # the engine image
sudo env CYSU_ENGINE_IMAGE_REF=cysu-engine:dev sh install.sh --token usr_YOUR_TOKEN
```

## OpenRouter authentication

Codex is the harness for both subscription and OpenRouter access. A saved
Codex subscription login takes priority, followed by Claude. OpenRouter is selected only when no
subscription login is saved; failures do not cause provider switching.

After installing the engine token, send an authenticated request:

```http
PUT /api/llm/openrouter-auth
Authorization: Bearer usr_YOUR_ENGINE_TOKEN
Content-Type: application/json

{"apiKey":"sk-or-YOUR_KEY","model":"anthropic/claude-sonnet-4.6"}
```

Choose a current model ID from OpenRouter with tool support. The example is a
model slug, not a guaranteed entitlement. `GET /api/llm/openrouter-auth` returns
masked key status; `DELETE` removes it. `GET /api/status` reports the selected
`llm.provider`. The endpoint stores credentials locally; it does not verify
credits or make a paid model request. Only the selected credential is sent to
the worker, over stdin; the OpenRouter key is held in a runner-owned `0600` file.

To use OpenRouter with a subscription login saved, set `"provider":"openrouter"`
in the workflow request. Without an explicit choice, saved credentials are
selected in order Codex → Claude → OpenRouter, even when the selected login
has expired or its quota is exhausted. Passkey configuration
still uses authenticated `PUT /api/settings`.

Omit the run's model to use the configured OpenRouter model, or provide a full
`provider/model` ID. Update older workspace models such as `gpt-...` before
using them with OpenRouter. Daybreak blue/red is not available through this
provider. The worker pins Codex 0.167.0, tested with command-backed provider auth;
custom older worker images need rebuilding for this feature.

## Claude Code subscription login

Rebuild or update the worker image for Claude Code 2.1.325. All requests below
require `Authorization: Bearer usr_YOUR_ENGINE_TOKEN`.

1. Send `POST /api/llm/claude-login` with an empty body. It returns `202` and a
   login `id`. Repeating this while login is active returns the same session.
2. Poll `GET /api/llm/claude-login` until `status` is `waiting`. Open its `url`:
   this is the authorization URL printed by the official Claude Code CLI.
3. Complete Anthropic's login page and submit its one-time code:

   ```http
   POST /api/llm/claude-login/code
   Authorization: Bearer usr_YOUR_ENGINE_TOKEN
   Content-Type: application/json

   {"id":"ID_FROM_LOGIN","code":"CODE_FROM_BROWSER#STATE_IF_PRESENT"}
   ```

4. Poll until `succeeded`, `failed`, `cancelled`, or `expired`. Each attempt has
   a 15-minute deadline. A failed attempt needs a fresh login URL and code.
   `GET /api/llm/claude-auth` returns `{ "saved": true, "savedAt": "..." }`
   after success; this records saved authentication, not current account access.

The engine passes the one-time code to `claude auth login` through stdin. Claude
Code performs the exchange, stores and verifies its own credentials. No access
or refresh tokens are returned by the API, read into engine settings, or copied
between containers. No additional callback port needs opening on the VPS.

The private named Docker volume survives removal of the login container and
engine restarts. The engine stores only its reference in `claude-auth.json`.
Include both that volume and engine data in backups. Claude workers mount it
at `/home/runner/.claude` with `CLAUDE_CONFIG_DIR` set to that path and run as
uid 10001. Native Claude Code manages token refresh in the volume. Saving a
login enables automatic selection; a saved Codex login still takes precedence.
Set `"provider":"claude"` in the workflow request to choose Claude explicitly.
The provider is fixed for the run, and stages execute serially with fresh
sessions; follow-up prompts resume the current stage's session.

`DELETE /api/llm/claude-login` cancels a pending attempt and preserves any
previous login. `DELETE /api/llm/claude-auth` also deletes the saved volume,
including its configuration and history. This returns 409 while a Claude run
owns a volume; finish or cancel that run first. A replacement login uses a new
volume, and the previous volume is removed after its active run finishes.
This forgets authentication locally;
it does not revoke the session at Anthropic. Failed or interrupted replacements
keep the existing login; a successful replacement retires the old volume.

## Upgrading to v3

Run the installer with `--token`, including on an already configured engine.
V3 ignores tokens stored in the old `settings.json`; it reads only the local
`auth.json` provisioned by the installer. Passkey, LLM login, workspaces,
schedules and runs are preserved. The installer refuses an existing engine
with a custom data mount to avoid provisioning the wrong volume.

CLI versions that automatically enroll a token over HTTP must be updated:
`PUT /api/settings` never accepts a `token` field (authenticated requests
return 400; unprovisioned engines return 401). Configure only the passkey and
LLM through that endpoint. After `reset-auth`, all protected routes remain
locked until the installer is run again.

## Everyday

| | |
|---|---|
| `sh scripts/engine.sh status` | is it running (with `CYSU_TOKEN` set to your user token: also whether it is set up) |
| `sh scripts/engine.sh stop` | stop it (a run in progress is cancelled) |
| `sh scripts/engine.sh start` | start it again — your settings, logins and runs are kept |
| `sh scripts/engine.sh logs` | follow its log |
| `sh scripts/engine.sh update` | download the newest engine image and switch to it (data is kept; if the download fails, the running engine is left as it is) |
| `sh scripts/engine.sh reset-auth` | remove the token and lock API access until `install.sh --token` is run again (other data is kept) |

It also restarts by itself after a reboot (`--restart unless-stopped`).

## The Cyber Supplies CLI inside runs

Each run's agents use the newest `cysu` CLI release. The engine checks npm at
most once an hour and downloads a new release **once** (a few seconds) into
the Docker volume `cysu-engine-cli`, with the skill of that same version;
every stage of a run uses the same version. No new worker image is needed for
a CLI release. If npm or GitHub cannot be reached, runs use the newest version
already downloaded, or else the copy inside the worker image. The run log
says which one (`[engine] Cyber Supplies CLI: …`).

To choose: `CYSU_CLI_VERSION=0.6.3 sh scripts/engine.sh update` (an exact
version) or `CYSU_CLI_VERSION=image` (only the worker image's copy).

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
- **Local install:** Only this machine can reach it. It listens on
  `127.0.0.1` and refuses requests from web pages. The VPS installer exposes
  it through HTTPS via Caddy while the engine itself stays on loopback. Every request must
  carry the Cyber Supplies user token you set it up with; after 10 wrong
  tokens in a minute it refuses everything for a minute.
- **Workers are locked down.** Each stage runs in a fresh container as an
  unprivileged user, with a firewall that blocks your machine, your local
  network and cloud metadata addresses (the internet stays reachable).
- **Agents get a restricted token by default.** Each worker gives its agent
  your Cyber Supplies **LLM token** (`llm_…`), which the engine fetches with
  your user token when the worker starts (it is never saved). The agent can
  read your profiles, accounts and emails but not change them. To give agents
  your full user token instead: `PUT /api/settings {"agentToken": "user"}`
  (`"llm"` switches back).
- **Engine linked (off by default) lets agents learn from earlier runs.**
  With `PUT /api/settings {"engineLinked": true}` (or `"engineLinked": true`
  on one run or workspace request), each stage's agent can **read** this
  engine's earlier runs of the **same workspace**: their results, transcripts
  and logs. It cannot start, change or delete anything, see other
  workspaces, or touch settings. How it works: the engine puts itself and
  the worker on a private Docker network (`cysu-engine-net`) and opens a
  second, read-only port (8788) there only; the worker's firewall lets
  through that one address and port. The agent gets `CYSU_ENGINE_URL` and a
  read-only key `CYSU_ENGINE_TOKEN` (`usr_engine_…`, not a Cyber Supplies
  token) that stops working when the stage ends:
  `cysu engine list-runs --token "$CYSU_ENGINE_TOKEN"`. Linked workers also
  get an `engine-history` skill that tells the agent this. It needs the engine
  running as its container (`scripts/engine.sh`); otherwise stages run
  without it and say so in their log. Keep in mind that earlier transcripts
  hold whatever earlier agents printed.
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
| `Missing or wrong engine token` | The CLI is not using the token the engine was set up with. Use that one, or rerun `sudo sh install.sh --token usr_NEW_TOKEN` on the engine host |
| `Too many wrong engine tokens` | Wait a minute (something sent wrong tokens); then use the right one |
| `Cyber Supplies did not accept your user token` | Your token was revoked or replaced: rerun `sudo sh install.sh --token usr_NEW_TOKEN` on the engine host |
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

