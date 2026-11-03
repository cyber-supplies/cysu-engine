# Hooking the engine into the `cysu` CLI

This is for whoever builds `cysu engine` in `cysu-cli`. The engine is a
background server on the user's machine; `cysu engine` is its only user
interface: first-run setup, then slash commands. Everything below is plain HTTP + JSON against the engine.

The full contract is [`openapi.yaml`](../openapi.yaml). The flow below is
exercised end to end by [`test/cli-journey.test.js`](../test/cli-journey.test.js):
if that test passes, the CLI only has to make the same calls.

## What changed for the `engine` branch of cysu-cli

The `engine` branch (commit `2f03bbb`, 2026-11-03: `cysu engine
get-workflows`, `create-workflow`, `run`, …) was written before the engine
got authentication. It already matches the rest of this document (workspaces
by full UUID only, no chat, PATCH sends back the whole request, short run
ids). These changes are needed for it to work with the engine now:

1. **Send the token on every request.** In `engineSend`, add the user token
   (the one `enginePreflight` already resolves from `--token` / `CYSU_TOKEN`):

   ```go
   req.Header.Set("Authorization", "Bearer "+token)
   ```

   Without it every request is `401` once the engine is set up. Keep the
   token out of `traceRequest` output (it is a header now).
2. **Set the engine up through the 401, not through `GET /api/settings`.**
   `GET /api/settings` needs the token too, and its `token` field is
   masked (`"••••a1b2"`), so "is the token empty?" can no longer be read from
   it. Instead:

   ```
   GET /api/status  (with the header)
     200                          → set up with this token; go on
     401 setupRequired: true      → PUT /api/settings {"token": "<token>"}   (first setup)
                                       200 → go on;  400 → token refused by Cyber Supplies;
                                       503 → Cyber Supplies unreachable;  401 → another setup won
     401 setupRequired: false     → the engine was set up with a DIFFERENT token:
                                       "use the token this engine was set up with, or reset it:
                                        sh scripts/engine.sh reset-auth"
     429                          → locked for retryAfter seconds (10 wrong tokens in a minute)
   ```

   The header may be sent on the first setup too (it is ignored then), so
   `engineSend` can always add it.
3. **Errors to show as they are:** `401` / `429` / `502` bodies have an
   `error` written for the user (see *Authentication*). In particular a
   `502` "Cyber Supplies did not accept your user token" means the token was
   revoked: the user needs a new one, set with `PUT /api/settings
   {"token": "<new>"}` sent with the OLD one in the header (`tokenChanged:
   true` comes back; use the new one from then on).
4. **`create-workflow` / `edit-workflow --profile`** send stages as
   `{"profile"}` without a tag. That works, but per-tag models and
   follow-ups (`modelOverrides`, `reprompts`) then skip those stages. To keep
   tags, either send `{"profile", "tag"}` (the tag from `GET /api/profiles`
   when the profile has exactly one tag `1`–`4`) or add the profiles with
   `POST /api/workspaces/<id>/profiles {"add": [...]}`, which fills the tags in.
5. Small: the `--name` usage says "creates and **selects** the workflow";
   there is no selection any more. `engine auth` only offers the Codex
   sign-in, and the preflight requires `llm.mode == "codex"`; the engine also
   accepts an OpenAI API key (`PUT /api/settings {"llm": {"mode":
   "openai-api-key", "apiKey": "sk-…"}}`), so `llm.ready` from
   `GET /api/status` is the better check.
6. The branch starts from `main` as of 2026-10-16 (`285392e`) and is 7
   commits behind it now; expect to rebase or merge before opening the PR.

## Basics

- **Where:** `http://127.0.0.1:8787` (the engine's `PORT`). Let
  `CYSU_ENGINE_URL` override it.
- **Not running?** A refused connection means the engine is not started.
  `cysu engine` should start it as a container — exactly what
  [`scripts/engine.sh`](../scripts/engine.sh) `start` does (see
  [INSTALL.md](INSTALL.md)): if the `cysu-engine` container exists, `docker
  start cysu-engine`; otherwise

  ```
  docker run -d --name cysu-engine --restart unless-stopped --init \
    -p 127.0.0.1:8787:8787 \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v cysu-engine-data:/data \
    <engine image>
  ```

  then wait until `GET /api/health` answers `{"ok": true}` (the one route
  that needs no token). Publish on `127.0.0.1` only.
  (The images still need a public home, e.g. ghcr.io/cyber-supplies.)
- **Same machine only.** The engine refuses requests that look like they
  come from a web page (403), so:
  - use a loopback host (`127.0.0.1` / `localhost`),
  - send **no `Origin` header** (Go's `net/http` sends none by default),
  - send `Content-Type: application/json` with every request body.
- **Every request needs the engine token** (see *Authentication* below):
  `Authorization: Bearer usr_…`, the user's Cyber Supplies user token.
- **Errors** are `{"error": "<message for the user>"}` with a 4xx/5xx status.
  The messages are written to be shown to the user as they are.
- **Tokens:** the engine only works with a **user token** (`usr_…`). An LLM
  token (`llm_…`) is refused with a clear 400.
- **Text from agents is untrusted.** The engine already strips terminal
  control characters (escape sequences) from the run feed;
  print the text as plain text, never interpret it.

## Authentication

The engine token **is** the user's Cyber Supplies user token (`usr_…`), the
same one the CLI already uses for Cyber Supplies. It is set once at setup;
from then on every request sends it:

```
Authorization: Bearer usr_…
```

- Only this header counts: never put the token in a URL, a cookie or a
  flag (shell history, `ps`). Never print or log it.
- `GET /api/health` is the only request that works without it.
- **`401`** always means the engine token is the problem. Look at
  `setupRequired` in the body:
  - `true`: the engine is not set up yet → run **setup** (section 2);
  - `false`: the header is missing or the token is not the engine's (e.g.
    the CLI's stored token changed since setup) → tell the user. Changing
    the engine token needs the current one, so a user who no longer has it
    runs `sh scripts/engine.sh reset-auth` (below) and then setup.
- **`429`** (`Retry-After`, `retryAfter` seconds): 10 wrong tokens within a
  minute locked the engine for a minute; **every** request is refused, the
  right token too. Show "Too many wrong tokens, try again in N s"; do not
  retry in a loop (only wrong tokens count, so a loop with the right token
  does not extend it, but it is pointless).
- **`502`** on routes that talk to Cyber Supplies (`/api/profiles`, `/load`,
  plans, runs): if `error` says Cyber Supplies "did not accept your user
  token", the token was revoked or rotated there. The engine still accepts
  the old token for itself, so `/setup` with a new token works (send the old
  one in the header, the new one in the body).
- **Lost token:** `sh scripts/engine.sh reset-auth` (asks for `yes`; needs
  Docker on the machine) forgets the engine token and nothing else
  (passkey, LLM login, workspaces and runs are kept). Then set up again. A
  `cysu engine reset-auth` can do the same: `docker exec cysu-engine node
  server/reset-auth.js`.

## 1. Start: `cysu engine`

```
GET /api/health   → 200 {"ok": true}                    (it is up)
GET /api/status   → 401 {"setupRequired": true, …}      → run setup (section 2)
                  → 401 {"setupRequired": false, …}     → wrong/missing token (see Authentication)
                  → 200 { "docker": "29.9.2" | null, "cysu": bool,
                          "llm": { "mode", "ready" }, "configured": bool }
```

- `docker == null` → warn: Docker is needed to run workspaces.
- `configured == false` → finish **setup** (the LLM login is still missing).

## 2. Setup (first run, and `/setup`)

Ask for secrets with **hidden input** (`golang.org/x/term` ReadPassword), never
as flags (shell history, `ps`). `CYSU_TOKEN` / `CYSU_PASSPHRASE` may be offered
as defaults since the CLI already uses them.

1. **Cyber Supplies:** token + passkey →
   `PUT /api/settings {"token": "usr_…", "passkey": "…"}`.
   - **First setup** (`setupRequired: true`): send it **without** the
     header; this is the only request the engine takes without one. The
     token becomes the engine token: send it on every request from now on.
   - The engine checks the token with Cyber Supplies first. `400` = refused
     (typo, revoked, or an `llm_…` token); `503` = Cyber Supplies could not
     be reached. Nothing is saved then; let the user try again.
   - If another setup won a race, the answer is `401` (`setupRequired:
     false`): the engine is set up with a token the CLI does not have.
   - **`/setup` later:** send the current token in the header. Empty fields
     mean "keep what is stored". A new `token` in the body replaces the
     engine token at once: the answer has `"tokenChanged": true`, and only
     the new one works from then on, so switch to it (and store it where
     the CLI keeps its user token).
   - `GET /api/settings` shows what is set (masked: `"token": "••••a1b2"`,
     `"passkey": "set"`).
2. **LLM login**, the user's own (Kimi / Claude come later):
   - **Codex (ChatGPT) sign-in:** `POST /api/llm/codex-login`, then poll
     `GET /api/llm/codex-login` every ~2 s.
     `status: "waiting"` → print `url` and `code` ("open … and enter …");
     `succeeded` → done (the engine switches `llm.mode` to `codex`);
     `failed` / `cancelled` → show `error`. Ctrl-C → `DELETE /api/llm/codex-login`.
   - **OpenAI API key:** hidden input →
     `PUT /api/settings {"llm": {"mode": "openai-api-key", "apiKey": "sk-…"}}`.
3. `GET /api/status` again; `configured` should now be `true`.

## 3. Slash commands

`<id>` = a workspace's **exact id** (the `id` from `POST /api/workspaces` or
`GET /api/workspaces`). Names are labels only: the engine never looks a
workspace up by name, prefix or any other spelling (→ 404), and there is no
"current" workspace. `<run>` = a run id or its first 8 characters (unique
prefix ≥ 4).

| Command | Request | Show |
|---|---|---|
| `/help` | — | this list |
| `/quit` | — | — |
| `/setup` | section 2 | |
| `/status` | `GET /api/status` | Docker, Cyber Supplies, LLM |
| `/profiles` | `GET /api/profiles` → `[{id, tag: []}]` | id + tags; a stage profile has exactly one tag `1`–`4`, the global one none |
| `/workspaces` | `GET /api/workspaces` | `id` and `name` of each |
| `/workspace <id>` | `GET /api/workspaces/<id>` | see *Showing a workspace* |
| `/workspace new <name>` | `POST /api/workspaces {"name"}` → empty draft | its `id`, then the workspace |
| `/workspace delete <id>` | `DELETE /api/workspaces/<id>` → 204 (ask to confirm first) | "deleted" |
| `/load <id> <profile…>` | `POST /api/workspaces/<id>/profiles {"add": [...]}` | `added`, `skipped` (already there), then the workspace |
| `/load <id> --global <profile>` | `… {"global": "<profile>"}` (`""` = none) | the workspace |
| `/unload <id> <profile…>` | `… {"remove": [...]}` | the workspace |
| `/run <id>` | `POST /api/workspaces/<id>/run` → the run | "started run `<first 8 of id>`", then `/watch` it |
| `/runs` | `GET /api/runs` | first 8 of `id`, `status`, `name`, `workspace.name`, `createdAt`, stage statuses |
| `/watch [run]` | feed loop (below) | live progress; Ctrl-C stops watching, not the run |
| `/cancel [run]` | `POST /api/runs/<run>/cancel` | "cancelling" |
| `/download [run] [dir]` | `GET /api/runs/<run>/download` | saves `run-<id>.tar.gz` (run.json, per stage events/log/result) |

`[run]` can default to the last run started in the session.

**Dragged local profile folder (`/load <path>`):** if the argument is a
directory, upload it first with the CLI's existing profile save (today it
works for `~/cysu/profiles/<name>`, i.e. `reconcileEditedProfile(name)`), then
add `<name>`. The engine only loads profiles that exist in the account
(unknown ones → 400 `Not one of your profiles: …`).

### Workspace settings

Everything else about a workspace is set with these commands. **The objective
is required**: a new workspace cannot run until `/objective` is set.

All of them work the same way: `GET /api/workspaces/<id>`, change the one
field in its `request`, then `PATCH /api/workspaces/<id> {"request": <the whole
request>}`. PATCH **replaces** the request, so always send back every other
field unchanged. Then show the workspace that PATCH returns. Its `planError`
is where a bad value shows up: the engine saves drafts as they are and checks
them when it works out the plan (e.g. an invalid model name). The table
lists the request field each command changes.

| Command | Changes | Notes |
|---|---|---|
| `/objective <id> [text]` | `prompt` | No text → open `$EDITOR` (objectives are often long; up to 100 000 characters) |
| `/rename <id> <name>` | the name: `PATCH {"name": "<name>"}` | 409 if another workspace has that name |
| `/model <id> <model>` | `model` | Every stage's model. `""` → remove it (Codex's default) |
| `/model <id> --stage <1-4> <model>` | `modelOverrides` (`[{"stage": <int>, "model"}]`) | Model for the stages with that tag. Replace an existing entry for the same stage; `""` removes it |
| `/fallback <id> <model>` | `fallbackModel` | Retried once with this model if a stage's first attempt fails. `""` → remove it |
| `/effort <id> <level>` | `reasoningEffort` | `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`; `""` → the model's default |
| `/followup <id> add --stage <1-4> <text>` | `reprompts` (`[{"stage": "<tag>", "prompt"}]`) | Appended. After a stage succeeds, its follow-ups are sent in order, on the same Codex thread |
| `/followup <id>` | — | List them, numbered, with their stage |
| `/followup <id> remove <n>` / `clear` | `reprompts` | Remove one (by its number in the list) / all |
| `/stages <id> tags [--skip 3,4]` | sets `fromTags: {"skip": [...]}`, **deletes `stages`** | Stages come from the profile tags 1–4 (the global profile is left out). `/load` and `/unload` then answer 409 |
| `/stages <id> picked` | sets `stages`, **deletes `fromTags`** | Start from the stages the tags give now (`plan.stages` → `[{"profile", "tag"}]`), so nothing is lost; then `/load` / `/unload` |
| `/on-failure <id> continue\|stop` | `continueOnFailure` (`true` / `false`) | Default `continue`: a failed stage is recorded and the next stages still run |

- Never send both `stages` and `fromTags` (the plan says "Send either stages
  or fromTags, not both").
- `stage` is a **string** in `reprompts` (`"2"`) but an **integer** in
  `modelOverrides` (`2`).
- **`--stage` models and follow-ups go by stage tag.** `/load` saves each
  profile with its tag (`{"profile", "tag"}`) when it has exactly one tag
  `1`–`4`; a profile without one is saved as `{"profile"}` and gets only the
  all-stages settings (`/model <id> <model>`). If no stage has a tag, the plan
  says "modelOverrides and reprompts apply to tagged stages". (Stages loaded by an
  older engine have no tag: `/unload` + `/load` them again.)
- `/load <id> --global <profile>` (above) sets `globalProfile`.
- Per-stage settings (`stages[].prompt`, `model`, `reasoningEffort`,
  `fallbackModel`, `reprompts`) exist in the API (see `RunRequest` in
  `openapi.yaml`) but have no command yet; add them later if testers ask.

### Showing a workspace

`GET /api/workspaces/<id>`:

```
{ "id", "name", "request": { "prompt", "globalProfile", "stages" | "fromTags", … },
  "plan": { "globalProfile", "stages": [ { "order", "tag", "profile", "model" } ] } | null,
  "planError": "<why it cannot run yet>" | null }
```

Show the objective (`request.prompt`, first line), the global profile, the
models (`model`, `modelOverrides`, `fallbackModel`, `reasoningEffort`), the
number of follow-ups, and the stages from `plan`. If `plan` is null, show
`planError` instead ("A prompt is required", "Not one of your profiles: …",
…): it is exactly what still needs doing before `/run`.
Workspaces built from tags (`fromTags`) take their stages from the profile
tags; `/load`/`/unload` answer 409 on them (`/stages <id> picked` switches).

### `/watch` feed

```
GET /api/runs/<run>/feed?cursor=<c>&wait=20000      (start with cursor "")
→ { "run": { "status", "stages": [ { "index", "profile", "tag", "status" } ] },
    "items": [ { "stage", "profile", "kind", "text", "exitCode" } ],
    "cursor": "<c>", "done": bool }
```

Print items as they come (`kind`: `attempt` (first try / fallback / follow-up),
`command` (`text` + `exitCode`), `message` (the stage agent's words), `error`,
`turn`), print stage status changes from `run.stages`, continue with the new
`cursor`, stop when `done` and no items.

## 4. Status codes worth handling

| Code | Meaning |
|---|---|
| 400 | Bad input or setup missing (e.g. no LLM login), or a token Cyber Supplies refused at setup — show `error` |
| 401 | Engine token: `setupRequired: true` → run setup; `false` → missing/wrong token (see *Authentication*) |
| 403 | Request looked like it came from a web page (wrong Host/Origin/content type) — a CLI bug |
| 404 | No such workspace (not that exact id) / run |
| 409 | Busy or conflicting: a run is already active, a name is taken, a short run id matches several runs, a tag-built workspace can't `/load` |
| 429 | Too many wrong tokens: locked for `retryAfter` seconds, every request refused |
| 502 | Cyber Supplies refused the stored token (revoked? → `/setup` with a new one), was unreachable, or answered badly |
| 503 | Docker is not available, or (at setup) Cyber Supplies could not be reached to check the token |

## 5. Trying it without the CLI

```sh
npm start                      # engine on 127.0.0.1:8787
E=127.0.0.1:8787/api
read -rs T                     # paste your usr_ token (not echoed, not in history)
printf '{"token":"%s","passkey":"pick-one"}' "$T" | curl -s -X PUT $E/settings -H 'Content-Type: application/json' -d @-   # setup
H="Authorization: Bearer $T"   # then send it on every request; -H @- keeps it out of `ps`:
printf '%s\n' "$H" | curl -s -H @- $E/status
ID=$(printf '%s\n' "$H" | curl -s -H @- -X POST $E/workspaces -H 'Content-Type: application/json' -d '{"name":"Try"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).id')
printf '%s\n' "$H" | curl -s -H @- -X POST $E/workspaces/$ID/profiles -H 'Content-Type: application/json' -d '{"add":["recon"]}'
printf '%s\n' "$H" | curl -s -H @- $E/workspaces/$ID
```
