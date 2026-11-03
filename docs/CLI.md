# Hooking the engine into the `cysu` CLI

This is for whoever builds `cysu engine` in `cysu-cli`. The engine is a
background server on the user's machine; `cysu engine` is its only user
interface: first-run setup, then a chat with the AI assistant plus slash
commands. Everything below is plain HTTP + JSON against the engine.

The full contract is [`openapi.yaml`](../openapi.yaml). The flow below is
exercised end to end by [`test/cli-journey.test.js`](../test/cli-journey.test.js):
if that test passes, the CLI only has to make the same calls.

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
    -v cysu-engine-data:/data -v cysu-engine-agent:/run/cysu-engine \
    <engine image>
  ```

  then wait until `GET /api/status` answers. Publish on `127.0.0.1` only.
  (The images still need a public home, e.g. ghcr.io/cyber-supplies.)
- **No login on the engine API** (same machine only). The engine refuses
  requests that look like they come from a web page, so:
  - use a loopback host (`127.0.0.1` / `localhost`),
  - send **no `Origin` header** (Go's `net/http` sends none by default),
  - send `Content-Type: application/json` with every request body.
- **Errors** are `{"error": "<message for the user>"}` with a 4xx/5xx status.
  The messages are written to be shown to the user as they are.
- **Tokens:** the engine only works with a **user token** (`usr_…`). An LLM
  token (`llm_…`) is refused with a clear 400.
- **Text from agents is untrusted.** The engine already strips terminal
  control characters (escape sequences) from chat messages and the run feed;
  print the text as plain text, never interpret it.

## 1. Start: `cysu engine`

```
GET /api/status
→ { "docker": "29.9.2" | null, "cysu": bool, "llm": { "mode", "ready", "model" },
    "configured": bool, "workspace": "<current workspace name>" | null }
```

- `docker == null` → warn: Docker is needed to run workspaces.
- `configured == false` → run **setup** (below) before the chat.
- `workspace` → show it in the prompt, e.g. `cysu[My recon]> `.

## 2. Setup (first run, and `/setup`)

Ask for secrets with **hidden input** (`golang.org/x/term` ReadPassword), never
as flags (shell history, `ps`). `CYSU_TOKEN` / `CYSU_PASSPHRASE` may be offered
as defaults since the CLI already uses them.

1. **Cyber Supplies:** token + passkey →
   `PUT /api/settings {"token": "usr_…", "passkey": "…"}`.
   Empty fields mean "keep what is stored" (good for `/setup` re-runs).
   `GET /api/settings` shows what is set (masked: `"token": "••••a1b2"`,
   `"passkey": "set"`).
2. **LLM login**, the user's own (Kimi / Claude come later):
   - **Codex (ChatGPT) sign-in:** `POST /api/llm/codex-login`, then poll
     `GET /api/llm/codex-login` every ~2 s.
     `status: "waiting"` → print `url` and `code` ("open … and enter …");
     `succeeded` → done (the engine switches `llm.mode` to `codex`);
     `failed` / `cancelled` → show `error`. Ctrl-C → `DELETE /api/llm/codex-login`.
   - **OpenAI API key:** hidden input →
     `PUT /api/settings {"llm": {"mode": "openai-api-key", "apiKey": "sk-…"}}`.
3. **Model (optional):** `PUT /api/settings {"agentModel": "<model>"}`
   (`""` = Codex's default). This is the model the assistant uses.
4. `GET /api/status` again; `configured` should now be `true`.

## 3. The chat

```
POST /api/chats {}                         → { "id": "<chatId>", … }   (also /new)
POST /api/chats/<chatId>/messages {"text"} → 202   (the assistant starts answering)
GET  /api/chats/<chatId>/messages?after=<n>&wait=20000
     → { "messages": [ { "index", "role", "text", "tool", "status", "result" } ],
         "next": <n>, "status": "thinking" | "idle" }
```

Loop: print each message, continue with `after = next`; stop when
`status == "idle"` and `messages` is empty. `wait` makes the engine hold the
request until there is something new (max 25 s), so no busy polling.

| `role` | Print |
|---|---|
| `user` | skip (the user just typed it) |
| `agent` | the assistant's answer: `text` |
| `tool` | one quiet line: what it did (`tool`, e.g. `list_workspaces`) + ✓/✗; `result` holds details if wanted |
| `error` | `text`, as an error |
| `notice` | `text`, dimmed (e.g. "Stopped.") |

A tool step is only sent once it has finished, so each message prints once.

- **Ctrl-C while it answers:** `POST /api/chats/<chatId>/stop`.
- One answer at a time per chat (a second send → 409).
- Every answer runs in a fresh, short-lived container, so expect a few
  seconds before the first words; showing "thinking…" helps.

**What the assistant can do (today):** check the setup, read the user's
profiles, build and change **workspaces**, try a setup (`plan_run`), and show
run results (runs, a run's answers, stage activity, logs). It **cannot** start
runs (the user does, with `/run`), change profiles, or see secrets. Workspaces
it creates become the **current** one, so a plain `/run` starts them.

## 4. Slash commands

`<ref>` = a workspace name (URL-escape it: `url.PathEscape`), its id, or
`current`. `<run>` = a run id or its first 8 characters (unique prefix ≥ 4).

| Command | Request | Show |
|---|---|---|
| `/help` | — | this list |
| `/quit` | — | — |
| `/new` | `POST /api/chats {}` | "new chat" |
| `/setup` | section 2 | |
| `/status` | `GET /api/status` | Docker, Cyber Supplies, LLM, current workspace |
| `/profiles` | `GET /api/profiles` → `[{id, tag: []}]` | id + tags; a stage profile has exactly one tag `1`–`4`, the global one none |
| `/workspaces` | `GET /api/workspaces` | names; `current: true` marked |
| `/workspace` | `GET /api/workspaces/current` | see *Showing a workspace* |
| `/workspace <name>` | `POST /api/workspaces/<ref>/select` (404 → offer to create) | the workspace |
| `/workspace new <name>` | `POST /api/workspaces {"name"}` → empty draft, becomes current | the workspace |
| `/load <profile…>` | `POST /api/workspaces/current/profiles {"add": [...]}` | `added`, `skipped` (already there), then the workspace |
| `/load --global <profile>` | `… {"global": "<profile>"}` (`""` = none) | the workspace |
| `/unload <profile…>` | `… {"remove": [...]}` | the workspace |
| `/run [ref]` | `POST /api/workspaces/<ref or current>/run` → the run | "started run `<first 8 of id>`", then `/watch` it |
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

**Showing a workspace** (`GET /api/workspaces/<ref>`):

```
{ "name", "current", "request": { "prompt", "globalProfile", "stages" | "fromTags", … },
  "plan": { "globalProfile", "stages": [ { "order", "tag", "profile", "model" } ] } | null,
  "planError": "<why it cannot run yet>" | null }
```

Show the objective (`request.prompt`, first line), the global profile, and
the stages from `plan` — or `planError` ("A prompt is required", "Not one of
your profiles: …", …), which is exactly what still needs doing before `/run`.
Workspaces built from tags (`fromTags`) take their stages from the profile
tags; `/load`/`/unload` answer 409 on them (the assistant can switch them).

**`/watch` feed:**

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

## 5. Status codes worth handling

| Code | Meaning |
|---|---|
| 400 | Bad input or not set up yet — show `error` |
| 403 | Request looked like it came from a web page (wrong Host/Origin/content type) — a CLI bug |
| 404 | No such workspace / run / chat |
| 409 | Busy or conflicting: a run is already active, the assistant is answering, a name is taken, a short run id matches several runs, a tag-built workspace can't `/load` |
| 503 | Docker is not available |

## 6. Trying it without the CLI

```sh
npm start                      # engine on 127.0.0.1:8787
E=127.0.0.1:8787/api
curl -s $E/status
curl -s -X POST $E/workspaces -H 'Content-Type: application/json' -d '{"name":"Try"}'
curl -s -X POST $E/workspaces/current/profiles -H 'Content-Type: application/json' -d '{"add":["recon"]}'
curl -s $E/workspaces/current
```
