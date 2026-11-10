#!/bin/sh
# Entrypoint of every engine container: one stage of a run. It installs the
# global profile as the user and the stage profile in /workspace, then runs
# Codex (see the stage section below, CYSU_STAGE_JSON).
#
# Secrets arrive over stdin, so they do not appear in `docker inspect`.
# With CYSU_SECRETS=stdin the engine writes ONE JSON line to the
# container's stdin and closes it:
#   {"token": "...", "passphrase": "...", "openaiApiKey": "..." | "codexAuth": {...}, "engineKey": "..."}
# engineKey (engine linked only) becomes CYSU_ENGINE_TOKEN: a read-only key for
# this stage's engine access, revoked by the engine when the stage ends.
# The passphrase is used once, by `cysu key init` as runner, to create
# ~/.config/cysu/master.key; no long-lived process ever holds it. The LLM
# login (an OpenAI API key, or a saved Codex/ChatGPT auth.json) is written to
# ~/.codex/auth.json and is NOT left in the agent's environment. The agent
# gets CYSU_TOKEN (the CLI only reads it from env), the key file and auth.json.
# The proxy installer also writes the token to /etc/environment inside this
# ephemeral container; the entrypoint limits that file to root and runner.
#
# Other inputs (env, set by the engine, not secret):
#   CYSU_STAGE_JSON     {profile, globalProfile, prompt, model, reasoningEffort, fallbackModel, reprompts}
#   CYSU_ENGINE_URL     engine linked: the engine's agent address (read by `cysu engine`)
#   CYSU_ENGINE_ALLOW   engine linked: <ip>:<port> the firewall lets through
#   CYSU_EGRESS_GUARD   0 disables the outbound firewall (local debugging and tests only)
#   CYSU_WORKER_TEST_BOOTSTRAP=0  skips CLI refresh and proxy install in tests
#
# Started as root with only NET_ADMIN/CHOWN/SETUID/SETGID/KILL: installs the egress
# firewall, reads the secrets, then permanently drops to `runner` (uid 10001,
# no capabilities) before any profile or agent code runs. With arguments, runs
# that command as `runner` instead (tests, engine tooling).
set -eu

log() { printf '[engine] %s\n' "$*" >&2; }

# as_runner runs a command as runner with no capabilities. Secrets are passed
# through the environment by the caller, never as arguments (argv is visible
# in `ps`, including from the host).
as_runner() {
  HOME=/home/runner USER=runner LOGNAME=runner \
    setpriv --reuid=10001 --regid=10001 --init-groups --inh-caps=-all "$@"
}

if [ "$(id -u)" = "0" ]; then
  for name in CYSU_TOKEN CYSU_ENGINE_TOKEN CYSU_PASSPHRASE OPENAI_API_KEY CODEX_API_KEY CODEX_ACCESS_TOKEN; do
    if [ -n "$(printenv "$name" || true)" ]; then
      log "refusing to run: $name was passed as an env var (visible in docker inspect); send secrets on stdin with CYSU_SECRETS=stdin" >&2
      exit 4
    fi
  done

  if [ "${CYSU_EGRESS_GUARD:-1}" != "0" ]; then
    if ! cysu-egress-guard; then
      log "refusing to run: the egress firewall could not be installed (does the container have NET_ADMIN?)" >&2
      exit 3
    fi
  else
    log "WARNING: egress firewall disabled (CYSU_EGRESS_GUARD=0)" >&2
  fi

  # Resolve the npm latest tag at each worker start. A failed refresh must
  # never leave the stage running with a stale CLI.
  if [ "${CYSU_SECRETS:-}" = "stdin" ] && [ "${CYSU_WORKER_TEST_BOOTSTRAP:-1}" != "0" ]; then
    log "installing the latest Cyber Supplies CLI"
    if ! npm install -g --no-audit --no-fund --prefer-online @cyber-supplies/cysu@latest >/dev/null; then
      log "refusing to run: could not install the latest Cyber Supplies CLI"
      exit 4
    fi
  fi

  # The cysu skill, copied into the home dir at start (see Dockerfile: folders
  # from the image layer cannot be swapped by `cysu profiles install`).
  as_runner sh -c 'for d in "$HOME/.codex/skills" "$HOME/.agents/skills"; do mkdir -p "$d" && cp -R /opt/cysu/skill "$d/cysu"; done'

  if [ "${CYSU_SECRETS:-}" = "stdin" ]; then
    secrets=$(head -n 1)
    field() { printf '%s' "$secrets" | jq -r --arg k "$1" '.[$k] // empty | strings' 2>/dev/null; }
    token=$(field token)
    passphrase=$(field passphrase)
    openai_key=$(field openaiApiKey)
    engine_key=$(field engineKey)
    codex_auth=$(printf '%s' "$secrets" | jq -c '.codexAuth // empty | objects' 2>/dev/null || true)
    unset secrets
    if [ -z "$token" ] || [ -z "$passphrase" ]; then
      log "refusing to run: secrets on stdin must be a JSON line with token and passphrase" >&2
      exit 4
    fi
    if ! CYSU_PASSPHRASE="$passphrase" as_runner cysu key init >/dev/null 2>&1; then
      log "refusing to run: could not create the encryption key from the passkey" >&2
      exit 4
    fi
    unset passphrase

    # LLM login -> ~/.codex/auth.json (0600, owned by runner). Fed through
    # stdin so the key/tokens never appear in argv or env.
    if [ -n "$codex_auth" ]; then
      if ! printf '%s\n' "$codex_auth" | as_runner sh -c 'umask 077; mkdir -p ~/.codex && cat > ~/.codex/auth.json'; then
        log "refusing to run: could not install the Codex login" >&2
        exit 4
      fi
      log "LLM login: Codex (ChatGPT)"
    elif [ -n "$openai_key" ]; then
      if ! printf '%s' "$openai_key" | as_runner codex login --with-api-key >/dev/null 2>&1; then
        log "refusing to run: could not install the OpenAI API key" >&2
        exit 4
      fi
      log "LLM login: OpenAI API key"
    else
      log "LLM login: none"
    fi
    unset openai_key codex_auth

    export CYSU_TOKEN="$token"
    unset token
    # Engine linked: the stage's read-only engine key (for `cysu engine
    # --token "$CYSU_ENGINE_TOKEN"` against CYSU_ENGINE_URL). Only with a URL.
    if [ -n "$engine_key" ] && [ -n "${CYSU_ENGINE_URL:-}" ]; then
      export CYSU_ENGINE_TOKEN="$engine_key"
      log "engine linked: read-only access to earlier runs at $CYSU_ENGINE_URL"
    fi
    unset engine_key

    if [ "${CYSU_WORKER_TEST_BOOTSTRAP:-1}" != "0" ]; then
      # cysu installs the proxy CA and the managed /etc/environment block.
      # The CLI defaults to a world-readable file; limit it to the agent user.
      if ! cysu proxy install >/dev/null; then
        log "refusing to run: could not install the Cyber Supplies proxy"
        exit 4
      fi
      chown root:runner /etc/environment
      chmod 0640 /etc/environment
      proxy_url=$(sed -n 's/^https_proxy="\(.*\)"$/\1/p' /etc/environment)
      if [ -z "$proxy_url" ]; then
        log "refusing to run: the Cyber Supplies proxy has no URL"
        exit 4
      fi
      export http_proxy="$proxy_url" https_proxy="$proxy_url" HTTP_PROXY="$proxy_url" HTTPS_PROXY="$proxy_url"
      # Engine linked: the engine is on the local Docker network, never via the proxy.
      no_proxy=localhost,127.0.0.1,::1${CYSU_ENGINE_ALLOW:+,${CYSU_ENGINE_ALLOW%:*}}
      export no_proxy NO_PROXY="$no_proxy"
      unset proxy_url
      if ! as_runner cysu proxy status | jq -e '.installed == true and .active == true' >/dev/null; then
        log "refusing to run: the Cyber Supplies proxy is not active"
        exit 4
      fi
      log "Cyber Supplies proxy installed"
    fi
  fi
  unset CYSU_SECRETS

  exec env HOME=/home/runner USER=runner LOGNAME=runner \
    setpriv --reuid=10001 --regid=10001 --init-groups --inh-caps=-all "$0" "$@"
fi

if [ "$#" -gt 0 ]; then
  exec "$@"
fi

if [ -z "${CYSU_TOKEN:-}" ] || [ ! -f "$HOME/.config/cysu/master.key" ]; then
  log "refusing to run: no token/key — start with CYSU_SECRETS=stdin and send the secrets JSON on stdin" >&2
  exit 4
fi
export CYSU_TOKEN

log "tools: node $(node -v), go $(go version | cut -d' ' -f3), python $(python3 -V | cut -d' ' -f2), cysu $(npm ls -g --depth=0 2>/dev/null | sed -n 's/.*@cyber-supplies\/cysu@//p'), codex $(codex --version 2>/dev/null | cut -d' ' -f2)"

# ---- one stage --------------------------------------------------------------
# CYSU_STAGE_JSON (not secret): {"profile": "...", "globalProfile": "...",
#   "prompt": "...", "model": "...", "reasoningEffort": "...",
#   "fallbackModel": "...", "reprompts": ["...", ...]}
# Installs the global profile (as the user) and the stage profile (in
# /workspace), then runs Codex (the "attempts", like the Windmill flow):
#   1. initial:  the prompt, with `model`
#   2. fallback: if 1 failed and fallbackModel is set, once more with the
#                fallback model, same prompt, same workspace
#   3. reprompt: after success, each follow-up prompt in order, resuming the
#                SAME Codex thread (codex exec resume <thread>)
# The stage fails if the initial (and fallback) attempt or any follow-up fails.
# stdout carries ONLY JSONL: Codex's events plus engine.attempt /
# engine.attempt.finished markers. [engine] lines, cysu output and Codex
# stderr go to stderr.
# ---- Daybreak access check ----------------------------------------------------
# CYSU_DAYBREAK_CHECK_JSON (not secret): {"programs": ["standard","blue","red"], "model": "..."}
# Asks Codex for a one-word reply once per access program (a few tokens each)
# and prints one JSON line per program on stdout:
#   {"type":"engine.daybreak.check","program":"red","ok":false,"exitCode":1,"error":"..."}
if [ -n "${CYSU_DAYBREAK_CHECK_JSON:-}" ]; then
  check_model=$(printf '%s' "$CYSU_DAYBREAK_CHECK_JSON" | jq -r '.model // empty | strings')
  if [ -n "$check_model" ] && ! printf '%s' "$check_model" | grep -Eq '^[A-Za-z0-9._:/-]{1,120}$'; then
    log "refusing to run: invalid model name" >&2
    exit 5
  fi
  mkdir -p /tmp/daybreak-check
  for program in $(printf '%s' "$CYSU_DAYBREAK_CHECK_JSON" | jq -r '.programs // [] | .[] | strings'); do
    case "$program" in
      standard) flag=standard ;;
      blue) flag=daybreak_blue ;;
      red) flag=daybreak_red ;;
      *) log "refusing to run: unknown Daybreak program" >&2; exit 5 ;;
    esac
    set -- codex exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check -C /tmp/daybreak-check --cyber-access-program "$flag"
    [ -z "$check_model" ] || set -- "$@" --model "$check_model"
    out=/tmp/daybreak-check/$program.jsonl
    log "checking Daybreak $program${check_model:+ (model $check_model)}" >&2
    rc=0
    printf 'Reply with the single word OK and nothing else. Do not run any commands.' | timeout 120 "$@" - > "$out" 2>/dev/null || rc=$?
    error=$(jq -Rrn '[inputs | fromjson? | select(.type? == "turn.failed" or .type? == "error") | (.error.message? // .message?) | strings] | last // empty' "$out")
    failed=$(jq -Rn '[inputs | fromjson? | select(.type? == "turn.failed")] | length' "$out")
    [ "$rc" = 0 ] && [ "$failed" = 0 ] && ok=true || ok=false
    [ "$rc" != 124 ] || error=${error:-"no answer within 120 seconds"}
    jq -cn --arg program "$program" --argjson ok "$ok" --argjson exitCode "$rc" --arg error "$error" \
      '{type: "engine.daybreak.check", program: $program, ok: $ok, exitCode: $exitCode, error: $error}'
  done
  exit 0
fi

if [ -z "${CYSU_STAGE_JSON:-}" ]; then
  log "workspace ready (no stage given)"
  exit 0
fi

stage() { printf '%s' "$CYSU_STAGE_JSON" | jq -r --arg k "$1" '.[$k] // empty | strings'; }
profile=$(stage profile)
global_profile=$(stage globalProfile)
prompt=$(stage prompt)
model=$(stage model)
effort=$(stage reasoningEffort)
fallback_model=$(stage fallbackModel)
daybreak=$(stage daybreak)
reprompt_count=$(printf '%s' "$CYSU_STAGE_JSON" | jq '[.reprompts // [] | .[] | strings] | length')
if [ -z "$profile" ] || [ -z "$prompt" ]; then
  log "refusing to run: CYSU_STAGE_JSON needs a profile and a prompt" >&2
  exit 5
fi
case "$effort" in
  ''|none|minimal|low|medium|high|xhigh|max|ultra) ;;
  *) log "refusing to run: unknown reasoning effort" >&2; exit 5 ;;
esac
# OpenAI Daybreak: the Codex access program for every attempt of this stage
# (initial, fallback, follow-ups). default = no flag (OpenAI decides).
case "${daybreak:-default}" in
  default) cyber_program='' ;;
  standard) cyber_program=standard ;;
  blue) cyber_program=daybreak_blue ;;
  red) cyber_program=daybreak_red ;;
  *) log "refusing to run: unknown daybreak setting" >&2; exit 5 ;;
esac
for m in "$model" "$fallback_model"; do
  if [ -n "$m" ] && ! printf '%s' "$m" | grep -Eq '^[A-Za-z0-9._:/-]{1,120}$'; then
    log "refusing to run: invalid model name" >&2
    exit 5
  fi
done

if [ -n "$global_profile" ]; then
  log "installing global profile: $global_profile" >&2
  if ! (cd "$HOME" && cysu profiles install --profile "$global_profile" --provider codex --scope global) >&2; then
    log "stage failed: could not install global profile $global_profile" >&2
    exit 5
  fi
fi

log "installing stage profile: $profile" >&2
if ! (cd /workspace && cysu profiles install --profile "$profile" --provider codex --scope project) >&2; then
  log "stage failed: could not install stage profile $profile" >&2
  exit 5
fi

# Installing a global profile replaces the user's skill folders, which drops
# the built-in cysu skill (it teaches the agent the cysu CLI, e.g. storage for
# handing work to the next stage). Put it back unless a profile brought its own.
has_cysu_skill() {
  for d in "$HOME/.agents/skills" "$HOME/.codex/skills" /workspace/.agents/skills /workspace/.codex/skills; do
    [ -d "$d/cysu" ] && return 0
    for f in "$d"/*/SKILL.md; do
      [ -f "$f" ] && grep -Eq '^name:[[:space:]]*cysu[[:space:]]*$' "$f" && return 0
    done
  done
  return 1
}
if has_cysu_skill; then
  log "cysu skill: provided by the installed profiles" >&2
else
  mkdir -p "$HOME/.agents/skills" && cp -R /opt/cysu/skill "$HOME/.agents/skills/cysu"
  log "cysu skill: added the built-in one (the profiles did not include it)" >&2
fi

# Engine linked: the engine-history skill tells the agent how to read earlier
# runs. Added after the profiles (a global profile replaces skill folders).
if [ -n "${CYSU_ENGINE_TOKEN:-}" ] && [ -n "${CYSU_ENGINE_URL:-}" ]; then
  mkdir -p "$HOME/.agents/skills" && rm -rf "$HOME/.agents/skills/engine-history" &&
    cp -R /opt/cysu/engine-history-skill "$HOME/.agents/skills/engine-history"
  log "engine-history skill: added (engine linked)" >&2
fi

# Codex ignores /workspace/.codex/config.toml (the stage profile's MCP
# servers etc.) unless the project is trusted.
printf '\n[projects."/workspace"]\ntrust_level = "trusted"\n' >> "$HOME/.codex/config.toml"

# The container is the sandbox (firewall, no capabilities), so Codex's own
# sandbox and approval prompts are off, as in the dojo harness.
ATTEMPT_EVENTS=/tmp/cysu-attempt.jsonl
rc=0

# attempt KIND MODEL PROMPT [THREAD]: one Codex run, its events streamed to
# stdout between engine.attempt markers. Sets rc; returns 0 only when Codex
# exited 0 and no turn failed. The prompt goes in on stdin (no argv length
# limit, not visible in ps). With THREAD it resumes that conversation.
attempt() {
  a_kind=$1 a_model=$2 a_prompt=$3 a_thread=${4:-}
  jq -cn --arg kind "$a_kind" --arg model "$a_model" --arg daybreak "${daybreak:-default}" '{type: "engine.attempt", kind: $kind, model: $model, daybreak: $daybreak}'
  if [ -n "$a_thread" ]; then
    set -- codex exec resume --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check
  else
    set -- codex exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check -C /workspace
  fi
  [ -z "$a_model" ] || set -- "$@" --model "$a_model"
  [ -z "$effort" ] || set -- "$@" -c "model_reasoning_effort=\"$effort\""
  [ -z "$cyber_program" ] || set -- "$@" --cyber-access-program "$cyber_program"
  [ -z "$a_thread" ] || set -- "$@" "$a_thread"
  : > "$ATTEMPT_EVENTS"
  { printf '%s' "$a_prompt" | "$@" -; echo $? > /tmp/cysu-rc; } | tee "$ATTEMPT_EVENTS"
  rc=$(cat /tmp/cysu-rc)
  if [ "$rc" = 0 ] && [ "$(jq -Rn '[inputs | fromjson? | select(.type? == "turn.failed")] | length' "$ATTEMPT_EVENTS")" != 0 ]; then
    rc=1
  fi
  jq -cn --arg kind "$a_kind" --argjson exitCode "$rc" '{type: "engine.attempt.finished", kind: $kind, exitCode: $exitCode}'
  [ "$rc" = 0 ]
}

cd /workspace
log "running Codex${model:+ (model $model)}${effort:+ (effort $effort)}${cyber_program:+ (Daybreak: $cyber_program)}" >&2
if attempt initial "$model" "$prompt"; then
  :
elif [ -n "$fallback_model" ] && [ "$rc" -lt 128 ]; then
  # rc >= 128 means Codex was killed (e.g. the run was cancelled): no retry.
  log "first attempt failed (exit $rc); retrying once with fallback model $fallback_model" >&2
  if attempt fallback "$fallback_model" "$prompt"; then
    model=$fallback_model # follow-ups continue with the model that worked
  else
    log "fallback attempt failed (exit $rc)" >&2
    exit "$rc"
  fi
else
  exit "$rc"
fi

if [ "$reprompt_count" -gt 0 ]; then
  thread=$(jq -Rrn '[inputs | fromjson? | select(.type? == "thread.started") | .thread_id | strings] | last // empty' "$ATTEMPT_EVENTS")
  if [ -z "$thread" ]; then
    log "stage failed: Codex reported no thread ID, so the follow-up prompts cannot resume it" >&2
    exit 6
  fi
  i=0
  while [ "$i" -lt "$reprompt_count" ]; do
    follow_up=$(printf '%s' "$CYSU_STAGE_JSON" | jq -r --argjson i "$i" '[.reprompts[] | strings][$i]')
    log "follow-up prompt $((i + 1))/$reprompt_count (resuming thread $thread)" >&2
    if ! attempt reprompt "$model" "$follow_up" "$thread"; then
      log "stage failed: follow-up prompt $((i + 1)) failed (exit $rc)" >&2
      exit "$rc"
    fi
    i=$((i + 1))
  done
fi
exit 0
