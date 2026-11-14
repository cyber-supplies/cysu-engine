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
6. **The objective moved from the workspace to the run (engine API 0.12).**
   A workspace is now a blank template; the user gives the objective each
   time they start a run. `create-workflow` / `edit-workflow` must not send
   `prompt` in the request (a non-empty one → 400 "A workspace has no
   objective; give it when you start a run"), and `run` must send it:
   `POST /api/workspaces/<id>/run {"objective": "…"}` (without one → 400
   "Give the run an objective"). Schedules carry their own `objective`. See
   *Starting a run* and *Scheduled runs* below.
7. The branch starts from `main` as of 2026-10-16 (`285392e`) and is 7
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
3. **Agent token** (optional, e.g. `/setup agent-token llm|user`):
   `PUT /api/settings {"agentToken": "llm" | "user"}`. `llm` (the default):
   agents get the user's restricted `llm_` token, which the engine fetches
   from Cyber Supplies when each worker starts; they can read profiles,
   accounts and emails but not change them. `user`: the full user token.
   Show the current value from `GET /api/settings` (`agentToken`). A stage
   whose lookup fails ends with an error saying to switch to `user`; each
   stage records which it got (`stages[].agentToken`).
4. **Engine linked** (optional, e.g. `/setup engine-linked on|off`):
   `PUT /api/settings {"engineLinked": true | false}` (default `false`).
   On: each stage's agent can read this engine's earlier runs of the same
   workspace (read-only; see INSTALL.md). A run or workspace request can
   override it with `"engineLinked": true | false`; each run records it
   (`engineLinked`) and each stage whether it actually got the link
   (`stages[].engineLinked`; false with a log line when the engine is not
   running as its container). Inside the worker the agent uses the normal
   commands with its stage key: `cysu engine list-runs --token
   "$CYSU_ENGINE_TOKEN"` (`CYSU_ENGINE_URL` is already set); linked workers
   get an `engine-history` skill (image/engine-history) that says so.
5. `GET /api/status` again; `configured` should now be `true`.

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
| `/run <id> [objective]` | `POST /api/workspaces/<id>/run {"objective"}` → the run | "started run `<first 8 of id>`", then `/watch` it. See *Starting a run* |
| `/rerun [run]` | `POST /api/runs/<run>/rerun` → a new run | Same setup **and the same objective** as that run |
| `/runs` | `GET /api/runs` | first 8 of `id`, `status`, `name`, `workspace.name`, `startedAt` (`createdAt` while queued), stage statuses and `error`s; mark `trigger.type: "schedule"` runs |
| `/watch [run]` | feed loop (below) | live progress; Ctrl-C stops watching, not the run |
| `/cancel [run]` | `POST /api/runs/<run>/cancel` | "cancelling" |
| `/download [run] [dir]` | `GET /api/runs/<run>/download` | saves `run-<id>.tar.gz` (run.json, per stage events/log/result) |

`[run]` can default to the last run started in the session.

**Dragged local profile folder (`/load <path>`):** if the argument is a
directory, upload it first with the CLI's existing profile save (today it
works for `~/cysu/profiles/<name>`, i.e. `reconcileEditedProfile(name)`), then
add `<name>`. The engine only loads profiles that exist in the account
(unknown ones → 400 `Not one of your profiles: …`).

### Starting a run

**A workspace is a blank template; the objective comes with the run.** The
workspace keeps the setup (stages, global profile, models, follow-ups). Each
`/run` asks for what this particular run should do:

- `/run <id> <objective…>`: the rest of the line is the objective.
- `/run <id>` with no text: open `$EDITOR` (objectives are often long, up to
  100 000 characters), or prompt for it. Refuse an empty one locally.
- Also handy: `/run <id> --file <path>` reads it from a file.

Send `POST /api/workspaces/<id>/run {"objective": "<text>"}`. The workspace
is not changed. The run shows the objective as `objective`, and `/rerun`
repeats it. Errors: 400 "Give the run an objective" (missing or blank), 400
with the plan's message if the workspace isn't runnable (e.g. no stages), 409
if another run is active.

### Workspace settings

Everything else about a workspace is set with these commands. A workspace
has **no objective** (see *Starting a run*), so there is no `/objective`
command any more.

All of them work the same way: `GET /api/workspaces/<id>`, change the one
field in its `request`, then `PATCH /api/workspaces/<id> {"request": <the whole
request>}`. PATCH **replaces** the request, so always send back every other
field unchanged. Then show the workspace that PATCH returns. Its `planError`
is where a bad value shows up: the engine saves drafts as they are and checks
them when it works out the plan (e.g. an invalid model name). The table
lists the request field each command changes.

| Command | Changes | Notes |
|---|---|---|
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
| `/daybreak <id> default\|standard\|blue\|red` | `daybreak` | OpenAI Daybreak program for every stage (see *Daybreak* below). `default` → remove it |
| `/daybreak <id> --stage <1-4> <program>` | `daybreakOverrides` (`[{"stage": <int>, "daybreak"}]`) | Program for the stages with that tag, like `/model --stage`; `default` removes the entry |

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
- Never put `prompt` in a workspace request (top level or on a stage):
  the engine refuses a non-empty one. An empty `"prompt": ""` from an older
  client is accepted and dropped.
- Per-stage settings (`model`, `reasoningEffort`, `fallbackModel`,
  `reprompts`) exist in the API (see `WorkspaceRequest` in `openapi.yaml`)
  but have no command yet; add them later if testers ask.

### Daybreak (OpenAI Trusted Access for Cyber)

`daybreak` picks the access program Codex asks OpenAI for: `default` (OpenAI
decides), `standard` (off), `blue` (fewer refusals) or `red` (the cyber
models). `blue` and `red` need an approved OpenAI account. What testers will
hit (seen live):

- **Red needs a cyber model and an API key.** `red` with a regular model is
  refused with "You do not have Daybreak access", even for approved
  accounts, and a cyber model (`gpt-5.6-cyber`) is refused on a ChatGPT
  login. Red = `/model <id> gpt-5.6-cyber` + an OpenAI API key from a
  Red-approved project. On a ChatGPT login, use `blue`.
- The engine explains these errors: a failed stage has `hints` next to its
  `error` (in `/runs/<run>`), and a `/watch` error item gets a `hint`. Show
  the hint under the error.

Access check (a few tokens per program, so only when the user asks, e.g.
`/daybreak check [--model <m>]`):

```
POST /api/daybreak/check {"model": "gpt-5.6-cyber"}      (body optional)
→ { "checkedAt", "model", "results": [ { "program": "standard"|"blue"|"red", "ok", "error", "hint" } ] }
```

Takes up to a few minutes (show a spinner). 409 while a run is active, or
another check is running; runs started during a check also get 409 and
scheduled runs wait. The last result is in `GET /api/status` →
`daybreak.lastCheck` (`daybreak.checking` while one runs): show it in
`/status`, e.g. `Daybreak: standard ✓ blue ✓ red ✗ (checked 10 Nov 14:02)`.

### Showing a workspace

`GET /api/workspaces/<id>`:

```
{ "id", "name", "request": { "globalProfile", "stages" | "fromTags", … },
  "plan": { "globalProfile", "stages": [ { "order", "tag", "profile", "model" } ] } | null,
  "planError": "<why it cannot run yet>" | null }
```

Show the global profile, the
models (`model`, `modelOverrides`, `fallbackModel`, `reasoningEffort`), the
number of follow-ups, and the stages from `plan`. If `plan` is null, show
`planError` instead ("A run needs at least one stage", "Not one of your
profiles: …", …): it is exactly what still needs doing before `/run`. (The
objective is not part of a workspace, so it never appears here.)
Workspaces built from tags (`fromTags`) take their stages from the profile
tags; `/load`/`/unload` answer 409 on them (`/stages <id> picked` switches).

### Scheduled runs

New after engine 0.2.0 (not released yet). A schedule makes the engine start a workspace's run **by
itself** at set times, with nobody at the keyboard; the user comes back later
and checks on it. `<sched>` = a schedule's **exact id** (like workspaces). The
command names are suggestions; with the non-interactive `cysu engine
<subcommand>` style they map one to one (`get-schedules`, `create-schedule`, …).

| Command | Request | Show |
|---|---|---|
| `/schedule <id> <when…> [--name N] [--tz Z]` | `POST /api/schedules {"workspaceId", "objective", "when", "tz", "name"}` | its `id`, `summary`, `nextAt` in local time. Ask for the objective as `/run` does (`$EDITOR`, or `--objective <text>` / `--file <path>`) |
| `/schedules` | `GET /api/schedules` | one line each: first 8 of `id`, `name`, `workspace.name`, `summary`, on/paused, `nextAt`, `lastRun.status`, `waiting` |
| `/schedule <sched>` | `GET /api/schedules/<sched>` | everything (including its `objective`), plus `history` (below) |
| `/schedule pause <sched>` / `resume <sched>` | `POST /api/schedules/<sched>/pause` / `resume` | the schedule |
| `/schedule edit <sched> <when…>` / `--name` / `--tz` / `--workspace <id>` / `--objective` | `PATCH /api/schedules/<sched> {only the fields that change}` | the schedule |
| `/schedule delete <sched>` | `DELETE /api/schedules/<sched>` → 204 (ask to confirm) | "deleted" (its runs are kept) |
| `/runs --scheduled [sched]` | `GET /api/runs?trigger=schedule` / `?schedule=<sched>` | as `/runs` |

Unlike workspaces, PATCH here takes **only the fields that change** (`name`,
`workspaceId`, `objective`, `when`, `tz`, `enabled`); anything else is 400.

**Each schedule has its own `objective`** (required): workspaces have none,
so the schedule says what its runs do. One workspace can back several
schedules with different objectives. Its runs show that objective.

**`when`** (no cron; times are wall-clock in `tz`). Suggested wording → body:

| User types | `when` |
|---|---|
| `once 2026-11-07 23:00` | `{"type":"once","at":"2026-11-07T23:00"}` |
| `daily 09:00` | `{"type":"daily","time":"09:00"}` |
| `weekdays 09:00` | `{"type":"weekdays","time":"09:00"}` (Mon–Fri) |
| `weekly mon,thu 18:30` | `{"type":"weekly","time":"18:30","days":["mon","thu"]}` |
| `every 6h [from 2026-11-08 08:00]` | `{"type":"every","hours":6}` (+ `"start":"2026-11-08T08:00"`: first run AT start; without it, first run 6h from now) |

Times are 24-hour `HH:MM`; `hours` is 1–168. The engine's 400 messages say
exactly what is wrong (`when.time must be HH:MM (24-hour), like "09:00"`,
`Unknown timezone "…"`, `… is in the past`), so show `error` as it is.

**`tz` is required**: send the user's own IANA timezone (e.g.
`Europe/London`), not an offset, so 09:00 stays 09:00 across clock changes.
Go's `time.Local.String()` is usually just `"Local"`, so:

```go
// localTZ: the machine's IANA timezone name, or "" if unknown.
func localTZ() string {
	if tz := os.Getenv("TZ"); tz != "" && !strings.HasPrefix(tz, ":") {
		return tz
	}
	if p, err := filepath.EvalSymlinks("/etc/localtime"); err == nil { // Linux, macOS
		if i := strings.Index(p, "zoneinfo/"); i >= 0 {
			return p[i+len("zoneinfo/"):]
		}
	}
	return "" // e.g. Windows: ask for --tz (or fall back to "UTC" and say so)
}
```

`--tz` overrides it. Show times back in the user's local time (`nextAt`,
`history[].due` are UTC ISO strings).

**Showing a schedule** (`GET /api/schedules/<sched>`):

```
{ "id", "name", "enabled", "summary": "every weekday at 09:00 (Europe/London)",
  "when", "tz", "workspaceId", "workspace": { "id", "name", "exists" },
  "objective": "<what its runs do>",
  "nextAt": "<UTC>" | null,
  "waiting": { "since", "due" } | null,
  "lastRun": { "runId", "startedAt", "status", "finishedAt", "error" } | null,
  "history": [ { "at", "kind", "due", "runId" | "count" | "reason" } ]   (newest first, last 20) }
```

- `lastRun.status` is the run's **live** status (`running`, `succeeded`, …;
  `deleted` if the run was deleted, `not started` if it could not start).
  Offer `/watch <runId>` / `/download <runId>` from there.
- `waiting` set → a run was due while another run was active; it starts the
  moment that run ends.
- `history[].kind`: `started` (→ `runId`), `waiting`, `skipped` (one was
  already waiting), `missed` (the engine was off or the computer asleep:
  `count` times; not run), `dropped` (the engine restarted while it waited),
  `failed` (could not start: `reason`, e.g. no LLM login), `paused` (its
  workspace was deleted, or, for an older schedule, it has no objective:
  set one with `--objective` and resume). Print `reason` when there is one.
- `enabled: false` with `nextAt: null` = paused, or a one-off that has run.
- `workspace.exists: false` → its workspace was deleted; the schedule is
  paused and can't be resumed until `--workspace <id>` points it elsewhere.

**Tell users once** (e.g. when they create their first schedule): schedules
only run while the engine is running. Times that pass while the computer is
off or asleep are skipped and noted, not run late.

Runs started by a schedule have `"trigger": {"type": "schedule", "id", "name"}`
(user runs: `"trigger": {"type": "user"}`). Mark them in `/runs`, e.g.
`⏱ <schedule name>`.

### Run JSON (after 0.3.2)

`GET /api/runs/<run>` (and create, rerun, cancel) shows each fact once and
leaves out empty and default values, so check for a field before using it:

```json
{ "id", "name", "status", "trigger": {"type": "user"}, "workspace": {"id", "name"},
  "model"?, "reasoningEffort"?, "startedAt", "finishedAt", "objective",
  "stages": [{ "index", "profile", "status", "error"?, "daybreak"?, "durationSec",
               "exitCode", "result", "threadId"?, "usage"?, "eventCount" }] }
```

`GET /api/runs` has the same top fields without `objective`, and each stage
only as `{index, profile, status, error?}`. A stage's `model` /
`reasoningEffort` appear only when it used something other than the run's.
Gone from the API (still kept by the engine): `request`, `prompt` (use
`objective`), `stageCount` (use `stages.length`), `schedule` (now in
`trigger`), `source`, `skip`, `modelOverrides`, `daybreakOverrides`, the
run-level `daybreak`, and per stage `tag`, `prompt`, `errors` (now one
`error`), `turns`, `container`. The full plan is still `POST /api/runs/plan`.

### Secrets (for skills)

New after engine 0.3.2 (not released yet). The user's own secrets, e.g. an
API key a profile's skill needs. Each one reaches **every stage's agent as an
environment variable** of that name, so the skill says `$BROWSERBASE_API_KEY`
instead of carrying the key in its text (where the agent reads it and it ends
up in run events, downloads and engine-linked reads). The engine keeps the
values on the user's machine and **never returns them**; anywhere a value
shows up in a stage's events, log or result, the engine saves
`[secret:NAME]` instead (values under 6 characters are not masked).

| Command | Request | Show |
|---|---|---|
| `/secrets` | `GET /api/secrets` | one line each: `name`, `updatedAt` (there are no values to show) |
| `/secret set <NAME>` | `PUT /api/secrets/<NAME> {"value": "..."}` | "saved" + `updatedAt`. **Read the value without echo** (like a password prompt), or from `--file <path>` / stdin; never take it as a command-line argument (shell history, `ps`) |
| `/secret delete <NAME>` | `DELETE /api/secrets/<NAME>` → 200 / 404 | "deleted" |

Names are environment variable names: `A-Z`, `0-9`, `_`, starting with a
letter, at most 64. Reserved (400): `PATH`, `HOME`, proxy variables and
anything starting with `CYSU_`, `OPENAI_`, `CODEX_`, `NODE_`, `NPM_`, `LD_`,
`GIT_`, `PYTHON`, `PERL`, `RUBY`, `BASH_`, `LC_`. At most 50 secrets, 16 KiB
each. A change applies from the next stage that starts. With the
non-interactive style: `get-secrets`, `set-secret`, `delete-secret`.

**Moving a key out of a skill** (e.g. the Browserbase skill): set it with
`/secret set BROWSERBASE_API_KEY`, then change the skill's text from the key
itself to the variable, e.g. `X-BB-API-Key: $BROWSERBASE_API_KEY` or
`"apiKey": process.env.BROWSERBASE_API_KEY`, and add a line such as "the key
is in the environment variable BROWSERBASE_API_KEY; never print it".

### `/watch` feed

```
GET /api/runs/<run>/feed?cursor=<c>&wait=20000      (start with cursor "")
→ { "run": { "status", "stages": [ { "index", "profile", "tag", "status" } ] },
    "items": [ { "stage", "profile", "kind", "text", "exitCode", "hint" } ],
    "cursor": "<c>", "done": bool }
```

Print items as they come (`kind`: `attempt` (first try / fallback / follow-up),
`command` (`text` + `exitCode`), `message` (the stage agent's words), `error`
(with `hint` for a Daybreak access error: print it under the error),
`turn`), print stage status changes from `run.stages`, continue with the new
`cursor`, stop when `done` and no items.

## 4. Status codes worth handling

| Code | Meaning |
|---|---|
| 400 | Bad input or setup missing (e.g. no LLM login), or a token Cyber Supplies refused at setup — show `error` |
| 401 | Engine token: `setupRequired: true` → run setup; `false` → missing/wrong token (see *Authentication*) |
| 403 | Request looked like it came from a web page (wrong Host/Origin/content type) — a CLI bug |
| 404 | No such workspace / schedule (not that exact id) / run |
| 409 | Busy or conflicting: a run or a Daybreak check is already active, a name is taken, a short run id matches several runs, a tag-built workspace can't `/load`, 100 schedules already |
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
# start a run: the objective goes with the run, not the workspace
printf '%s\n' "$H" | curl -s -H @- -X POST $E/workspaces/$ID/run -H 'Content-Type: application/json' -d '{"objective":"Say hello and list your tools. Do not scan anything."}'
# a schedule: every weekday at 09:00 in your timezone, then check on it
printf '%s\n' "$H" | curl -s -H @- -X POST $E/schedules -H 'Content-Type: application/json' -d '{"workspaceId":"'$ID'","objective":"Say hello. Do not scan anything.","when":{"type":"weekdays","time":"09:00"},"tz":"Europe/London"}'
printf '%s\n' "$H" | curl -s -H @- $E/schedules
```
