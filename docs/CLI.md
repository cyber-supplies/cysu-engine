# Hooking the engine into the `cysu` CLI

This is for whoever builds `cysu engine` in `cysu-cli`. The engine is a
background server on the user's machine; `cysu engine` is its only user
interface for passkey/LLM configuration and slash commands. The token must
first be provisioned on the engine host using `install.sh --token usr_...`.
After that, the CLI uses HTTP + JSON against the engine.

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
2. **Never enroll or rotate a token over HTTP (v3 / API 0.13).** Remove
   automatic `PUT /api/settings {"token": ...}` from `enginePreflight` and
   any setup/auth command. Instead:

   ```
   GET /api/status  (with the header)
     200                          → proceed with this token
     401 setupRequired: true      → tell the user to run install.sh --token on the engine host
     401 setupRequired: false     → missing/wrong token; use the installed token or rerun the installer
     429                          → locked for retryAfter seconds (10 wrong tokens in a minute)
   ```

   A `token` field in an authenticated settings update is now rejected with
   `400`, even if unchanged. Send only passkey, LLM and other editable fields.
3. **Errors to show as they are:** `401` / `429` / `502` bodies have an
   `error` written for the user (see *Authentication*). A `502` saying
   Cyber Supplies refused the token means the user needs a new one,
   provisioned locally with `sudo sh install.sh --token usr_NEW_TOKEN`.
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

- **Where:** `http://127.0.0.1:8787` for a local install, or
  `https://<public-ip>` after the v3 VPS installer. Set `CYSU_ENGINE_URL` or
  pass `--engine` for every CLI command.
- **Not running?** On the engine host, start an existing installation with
  `docker start cysu-engine`. For a new installation run
  `sudo sh install.sh --token usr_...` (add `--ip PUBLIC_IPV4` for HTTPS).
  See [INSTALL.md](INSTALL.md). Wait for `GET /api/health` to answer
  `{"ok": true}`; that route needs no token. Starting a bare container
  without provisioning leaves all protected routes locked.
- **CLI access only.** The engine refuses requests that look like they
  come from a web page (403), so:
  - use a loopback host for local installs, or the v3 installer’s HTTPS IP,
  - send **no `Origin` header** (Go's `net/http` sends none by default),
  - send `Content-Type: application/json` with every request body.
- **Every request needs the engine token** (see *Authentication* below):
  `Authorization: Bearer usr_…`, the user's Cyber Supplies user token.
- **Errors** are `{"error": "<message for the user>"}` with a 4xx/5xx status.
  The messages are written to be shown to the user as they are.
- **Tokens:** the engine only works with a **user token** (`usr_…`). An LLM
  token (`llm_…`) is refused by the installer.
- **Text from agents is untrusted.** The engine already strips terminal
  control characters (escape sequences) from the run feed;
  print the text as plain text, never interpret it.

## Authentication

The engine token **is** the user's Cyber Supplies user token (`usr_…`), the
same one the CLI already uses for Cyber Supplies. The installer provisions
it locally from the mandatory `--token` flag; every protected request sends it:

```
Authorization: Bearer usr_…
```

- Only this header counts in the API: never put the token in a URL or cookie.
  The v3 installer accepts `--token` for a one-command setup; that flag is
  visible in shell history and process listings. Never print or log it.
- `GET /api/health` is the only request that works without it.
- **`401`** always means the engine token is the problem. Look at
  `setupRequired` in the body:
  - `true`: authentication is not provisioned → run
    `sudo sh install.sh --token usr_...` on the engine host;
  - `false`: the header is missing or the token differs from the installed
    one → use the installed token, or rerun the installer with a new one.
- **`429`** (`Retry-After`, `retryAfter` seconds): 10 wrong tokens within a
  minute locked the engine for a minute; **every** request is refused, the
  right token too. Show "Too many wrong tokens, try again in N s"; do not
  retry in a loop (only wrong tokens count, so a loop with the right token
  does not extend it, but it is pointless).
- **`502`** on routes that talk to Cyber Supplies (`/api/profiles`, `/load`,
  plans, runs): if `error` says Cyber Supplies "did not accept your user
  token", the token was revoked or rotated there. Rerun the installer
  with `--token` on the host; the old token is not required for this.
- **Lost token:** rerun the installer with `--token usr_NEW_TOKEN`.
  Passkey, LLM login, workspaces and runs are kept. `sh scripts/engine.sh
  reset-auth` removes the token and locks the API until local provisioning;
  it never re-enables HTTP enrollment.

## 1. Start: `cysu engine`

```
GET /api/health   → 200 {"ok": true}                    (it is up)
GET /api/status   → 401 {"setupRequired": true, …}      → run the installer on the engine host
                  → 401 {"setupRequired": false, …}     → wrong/missing token (see Authentication)
                  → 200 { "docker": "29.9.2" | null, "cysu": bool,
                          "llm": { "mode", "ready" }, "configured": bool }
```

- `docker == null` → warn: Docker is needed to run workspaces.
- `configured == false` → finish **setup** (the LLM login is still missing).

## 2. Setup (first run, and `/setup`)

Provision the user token first with `sudo sh install.sh --token usr_...`
on the engine host. `--token` is mandatory; there is no environment fallback
or API enrollment. Adding `--ip PUBLIC_IPV4` enables HTTPS. For rotation,
rerun the same installer with a new `--token`; HTTP clients then use that token.

1. **Passkey:** ask with hidden input, then send
   `PUT /api/settings {"passkey": "…"}` with the installed token in the
   Authorization header. Do not send a `token` property, even if masked,
   empty or unchanged: it produces `400` and nothing in the request is saved.
   `GET /api/settings` returns masked secrets (`"token": "••••a1b2"`,
   `"passkey": "set"`). Empty editable secret fields keep existing values.
2. **LLM login**, saved independently of the workflow's provider choice:
   - **Codex (ChatGPT) sign-in:** `POST /api/llm/codex-login`, then poll
     `GET /api/llm/codex-login` every ~2 s.
     `status: "waiting"` → print `url` and `code` ("open … and enter …");
     `succeeded` → done (the engine switches `llm.mode` to `codex`);
     `failed` / `cancelled` → show `error`. Ctrl-C → `DELETE /api/llm/codex-login`.
   - **OpenRouter API key:** hidden input plus a default model ID →
     `PUT /api/llm/openrouter-auth {"apiKey": "sk-or-...", "model": "provider/model"}`.
     `GET` on the same endpoint shows the masked key, model and `configured`;
     `DELETE` removes only OpenRouter credentials. Later `PUT` requests may
     omit either field to keep it. Empty, masked or invalid keys produce 400.
     Saving credentials does not make a live model request.
   - **OpenAI API key:** hidden input →
     `PUT /api/settings {"llm": {"mode": "openai-api-key", "apiKey": "sk-…"}}`.
   - **Claude subscription:** use the native Claude login flow below.
3. `GET /api/status` again; `configured` should now be `true`.

When configuring a workflow, offer Auto (default), Codex, Claude and OpenRouter.
Save the explicit choice in `workspace.request.provider` as `codex`, `claude`,
or `openrouter`; omit the field for Auto. Example request:
`{"name":"Review","request":{"provider":"claude","stages":[{"profile":"recon"}]}}`.
The field also works on `POST /api/runs` and `/api/runs/plan`. It applies to
the whole workflow, including scheduled runs and reruns, not individual stages.
Replacing a workspace request through PATCH must retain its other settings.

Auto selects saved credentials in order **Codex → Claude → OpenRouter**.
Status reports this default as `llm.provider`; plans and runs report the actual
selection in `provider`. An explicit choice with missing credentials fails
with 400. Provider selection stays fixed through every stage and attempt;
expired logins, quota limits and other failures never change it. Reruns with
Auto resolve the order again. Use an explicit choice to keep saved credentials
while selecting a lower-priority provider.

The legacy direct OpenAI key remains usable with the Codex harness when
`llm.mode` is `openai-api-key`; Auto selects it only after the three providers
above. `llm.mode: none` disables LLM use, including explicit choices.

With OpenRouter selected, omitted run/stage models use the configured model.
Explicit models, model overrides and fallback models must include the provider
prefix; the engine does not translate bare OpenAI model names. Fallback models
and follow-ups keep the same provider. Daybreak blue/red requires a subscription
login or the direct OpenAI provider and is rejected for OpenRouter and Claude. Each attempt
reports its actual `provider` and `model`.

Claude uses native model IDs/aliases (for example `sonnet`), and accepts omitted
effort or `low`, `medium`, `high`, `xhigh`, `max` (model availability still applies).
It runs the official Claude Code CLI; follow-ups resume its session. Its native
JSONL events (`system`, `assistant`, `user`, `result`) appear in the events API;
the watch API and saved result/usage summaries work for both harnesses.

`POST /api/llm/claude-login` with an empty body,
then poll `GET` until `waiting` and open `url`. Ask for the one-time code from
Anthropic's browser page with hidden input and send
`POST /api/llm/claude-login/code {"id":"...","code":"..."}`. Include any
`#state` suffix as displayed. The engine relays the code to native Claude Code;
it does not perform the OAuth exchange itself. Poll through `exchanging` until
`succeeded`, `failed`, `cancelled`, or `expired`. Start a fresh login after a
failure or the 15-minute deadline. Ctrl-C should send
`DELETE /api/llm/claude-login`. All these routes require the engine bearer token.

`GET /api/llm/claude-auth` and `GET /api/settings` → `llm.claude` expose only
`saved` and `savedAt`. Never request or print Claude access/refresh tokens.
`DELETE /api/llm/claude-auth` cancels login and removes the persistent Claude
volume (credentials, settings and history). Cancelling only the login attempt
preserves the previous saved volume.
Saving a Claude login enables automatic selection. Forgetting it returns 409
while a Claude run owns the volume; cancel or finish the run first. A new login
can complete during a run: the old volume is retired after the run releases it.

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
| `/runs` | `GET /api/runs` | first 8 of `id`, `status`, `name`, `workspace.name`, `createdAt`, stage statuses; mark `trigger: "schedule"` runs |
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
| `/provider <id> codex\|claude\|openrouter\|auto` | `provider` | `auto` removes the field; defaults to Codex → Claude → OpenRouter. Never send the literal value `auto` to the API. |
| `/model <id> <model>` | `model` | Every stage's model. `""` → remove it (selected provider's default) |
| `/model <id> --stage <1-4> <model>` | `modelOverrides` (`[{"stage": <int>, "model"}]`) | Model for the stages with that tag. Replace an existing entry for the same stage; `""` removes it |
| `/fallback <id> <model>` | `fallbackModel` | Retried once with this model if a stage's first attempt fails. `""` → remove it |
| `/effort <id> <level>` | `reasoningEffort` | `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`; `""` → the model's default |
| `/followup <id> add --stage <1-4> <text>` | `reprompts` (`[{"stage": "<tag>", "prompt"}]`) | Appended. After a stage succeeds, its follow-ups are sent in order, on the same agent session |
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
- Never put `prompt` in a workspace request (top level or on a stage):
  the engine refuses a non-empty one. An empty `"prompt": ""` from an older
  client is accepted and dropped.
- Per-stage settings (`model`, `reasoningEffort`, `fallbackModel`,
  `reprompts`) exist in the API (see `WorkspaceRequest` in `openapi.yaml`)
  but have no command yet; add them later if testers ask.

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

Runs started by a schedule have `"trigger": "schedule"` and `"schedule":
{"id", "name"}` (user runs: `"trigger": "user"`). Mark them in `/runs`, e.g.
`⏱ <schedule name>`.

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
| 400 | Bad input or setup missing (e.g. no LLM login), or a forbidden token field in a settings update — show `error` |
| 401 | Engine token: `setupRequired: true` → run the installer on the host; `false` → missing/wrong token (see *Authentication*) |
| 403 | Request looked like it came from a web page (wrong Host/Origin/content type) — a CLI bug |
| 404 | No such workspace / schedule (not that exact id) / run |
| 409 | Busy or conflicting: a run is already active, a name is taken, a short run id matches several runs, a tag-built workspace can't `/load`, 100 schedules already |
| 429 | Too many wrong tokens: locked for `retryAfter` seconds, every request refused |
| 502 | Cyber Supplies refused the stored token (revoked? → `install.sh --token` on the host), was unreachable, or answered badly |
| 503 | Docker is not available |

## 5. Trying it without the CLI

```sh
sudo sh install.sh --token usr_YOUR_TOKEN  # engine on 127.0.0.1:8787
E=127.0.0.1:8787/api
read -rs T                     # paste your usr_ token (not echoed, not in history)
H="Authorization: Bearer $T"   # send it on every request; -H @- keeps it out of ps:
printf '%s\n' "$H" | curl -s -H @- -X PUT $E/settings -H 'Content-Type: application/json' -d '{"passkey":"pick-one"}'
# Complete an LLM login before starting runs (section 2).
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
