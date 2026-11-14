# CLI migration for engine v3

Audited against `cyber-supplies/cysu-cli` main at `c99724f` on 2026-11-14.
The engine contract is [openapi.yaml](../openapi.yaml), API 0.16.0. The engine
release includes the v0.4 CLI cache, restricted worker tokens, engine-linked
history, compact run responses and user secrets, as well as the new providers.
This is a migration report; the CLI repository has not been changed.

## Required for v3

| Priority | Gap and consequence | Required migration |
| --- | --- | --- |
| P1 | `enginePreflight` still responds to `401 setupRequired:true` by sending `PUT /api/settings {token}`. V3 deliberately refuses this; the CLI cannot provision an engine. | Remove HTTP enrollment and rotation. Return the installer instruction from the error: on the engine host, run `install.sh --token usr_...`, optionally with `--ip`. Keep token resolution and the Authorization header. Distinguish unprovisioned, wrong-token and rate-limit responses. |
| P1 | `engine auth` always saves a passkey and starts Codex login. There is no Claude or OpenRouter authentication command, or independent passkey update. | Separate passkey configuration from provider authentication. Keep Codex as the default auth choice; add the flows below and provider-specific status/cancel/forget actions. Never submit the installer token in a settings body. |
| P1 | The transcript renderer handles Codex `item.*`, `error` and `turn.failed`, then silently drops other types. A Claude run exports an empty Markdown file while reporting a nonzero event count. | Render Claude `assistant` content, `user` tool results and `result` failures. Match tool calls/results by ID, distinguish nested agent messages, preserve event paging, and avoid duplicating final text. Keep Codex/OpenRouter rendering unchanged. |
| P2 | Workflow YAML passes `provider` through, but the templates, local validation and help do not expose it. | Add optional `request.provider: codex\|claude\|openrouter` to both templates. Omission means Codex → Claude → OpenRouter by saved credentials; a UI choice named Auto must remove the field. Reject invalid values, including `"auto"`, empty string and null. Provider belongs on the workflow, not a stage. |
| P2 | Readiness errors instruct every user to complete Codex sign-in. | Keep the existing `llm.ready` check, but make guidance provider-aware. Show the default provider from status and the actual provider from a workflow plan or run. Explicit missing credentials fail; account errors never switch providers. |

Source: [preflight and auth](https://github.com/cyber-supplies/cysu-cli/blob/c99724f/cmd/cysu/engine.go#L19),
[command registration](https://github.com/cyber-supplies/cysu-cli/blob/c99724f/cmd/cysu/engine.go#L190),
[workflow validation](https://github.com/cyber-supplies/cysu-cli/blob/c99724f/cmd/cysu/engine_workflows.go#L108),
[transcript renderer](https://github.com/cyber-supplies/cysu-cli/blob/c99724f/cmd/cysu/engine_transcript.go#L75).

### Provider authentication contracts

- **Codex:** retain `POST/GET/DELETE /api/llm/codex-login` and add access to
  `DELETE /api/llm/codex-auth`. A waiting Codex login returns both `url` and
  a device `code`.
- **Claude:** start `POST /api/llm/claude-login` with an empty body and poll
  GET. `waiting` returns a URL, not a device code. Collect the browser's
  one-time code with hidden input and send
  `POST /api/llm/claude-login/code {"id":"...","code":"..."}`. Preserve any
  `#state` suffix. Handle `exchanging`, `succeeded`, `failed`, `cancelled` and
  `expired`; the login expires after 15 minutes. DELETE the login on cancel.
  GET/DELETE `/api/llm/claude-auth` inspect/forget the saved login. Forgetting
  returns 409 while a Claude run owns the volume.
- **OpenRouter:** `PUT /api/llm/openrouter-auth` initially needs an API key
  and a default `provider/model` ID. Later updates can omit a field to retain
  it. GET returns masked status; DELETE removes it. Collect keys securely,
  never reuse a masked value as an update. This flow needs no browser login.

Use the engine's validation messages for models and effort. OpenRouter needs
namespaced model IDs; Claude uses native aliases/IDs and supports omitted
effort or `low`, `medium`, `high`, `xhigh`, `max`, subject to model support.
Daybreak blue/red is unavailable through Claude or OpenRouter. The legacy
direct OpenAI API-key mode remains available to the Codex harness.

Before adding these commands, extend debug redaction for submitted Claude
`code` and `/api/secrets/{name}` bodies containing `value`. The current
[redactor](https://github.com/cyber-supplies/cysu-cli/blob/c99724f/cmd/cysu/trace.go#L38)
masks key/token/password-like names, but neither of those names. Do not log
one-time codes, secret values or raw credential-bearing input on failures.

## Existing engine functionality without CLI commands

These are completeness gaps in the audited command registry, separate from
the provider migration:

- Settings management for `agentToken`, `engineLinked`, global profile and
  LLM mode, plus independent passkey updates.
- User-secret list/set/delete through `/api/secrets`; values are write-only.
- Daybreak access checks and their status. POST can take minutes and makes
  model requests, so the normal 30-second CLI HTTP timeout is insufficient;
  make the check an explicit action with an appropriate timeout.
- Run plan/preview, watch, raw log, rerun, server archive download and server
  run deletion. `get-run` currently exports transcripts locally; `clear-runs`
  deletes local exports, not engine runs.
- Schedule list/get/edit/pause/resume. The CLI currently exposes create and
  delete (`schedule`/`unschedule`) only.

Preserve the compact run contract: optional/default fields may be absent,
`trigger` is an object, failures use `stage.error`, and `eventCount` bounds
transcript snapshots. Provider is returned at run level; additional attempts
also report their credential provider.

## Already compatible

- Bearer authentication is sent on every engine request; redirects are refused.
- `--engine` and `CYSU_ENGINE_URL` accept HTTPS, including an IP URL. Keep
  normal TLS certificate verification; no insecure mode is needed.
- Workflow get/save preserves arbitrary request fields, including provider.
- Objectives belong to runs and schedules, not saved workflows.
- Readiness uses `llm.ready`, not a hard-coded `llm.mode == codex` check.
- Run IDs, stage indices and event pagination remain usable by the current
  downloader; the missing piece for Claude is rendering its event types.

The earlier CLI integration notes described an older branch. Their missing
Authorization header, objective placement and hard-coded readiness issues
are already fixed in the audited CLI main and should not be reimplemented.

## Verification and acceptance tests

Built the audited CLI and exercised it against a local HTTP fixture using
throwaway tokens and a temporary home directory. Confirmed:

1. An unprovisioned status response triggers the obsolete HTTP token write.
2. `save-workflow` forwards `request.provider: claude` unchanged.
3. A successful Claude run with three native events exports a zero-byte file.
4. `engine auth --provider claude` is rejected as an unknown flag.

Migration tests should cover installer-only setup, wrong tokens and 429;
independent passkey updates; all three auth flows and cancellation; code/key
redaction in debug and error output; provider round-trips and Auto omission;
explicit missing credentials; Claude tool/error transcripts across pages;
and unchanged Codex/OpenRouter transcript rendering. Include an HTTPS IP
connection with a trusted IP-SAN certificate and failed certificate validation.
