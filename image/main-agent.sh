#!/bin/sh
# cysu-main-agent: one turn of the main agent (the engine's assistant chat).
# Runs as runner, started by the entrypoint with CYSU_ROLE=main-agent.
#
# Inputs (set by the entrypoint / engine):
#   CYSU_CHAT_MESSAGE         the user's message (from stdin, not docker env)
#   CYSU_CHAT_THREAD          Codex thread to continue ("" = new conversation)
#   CYSU_CHAT_MODEL           optional model
#   CYSU_ENGINE_SOCKET        the engine's agent socket (mounted)
#   CYSU_CODEX_CONFIG_APPEND  tests only: extra Codex config (stand-in LLM)
#
# The main agent can ONLY use the engine's tools: Codex's own tools (shell,
# command execution, web search, images, sub-agents, goals, browser…) are
# switched off, the sandbox is read-only, and the container has no Cyber
# Supplies token or passkey. stdout = Codex JSONL events; logs on stderr.
set -eu

log() { printf '[engine] %s\n' "$*" >&2; }

message=${CYSU_CHAT_MESSAGE:-}
unset CYSU_CHAT_MESSAGE
thread=${CYSU_CHAT_THREAD:-}
model=${CYSU_CHAT_MODEL:-}
if [ -n "$model" ] && ! printf '%s' "$model" | grep -Eq '^[A-Za-z0-9._:/-]{1,120}$'; then
  log "refusing to run: invalid model name"
  exit 5
fi
if [ -n "$thread" ] && ! printf '%s' "$thread" | grep -Eq '^[A-Za-z0-9-]{1,100}$'; then
  log "refusing to run: invalid thread id"
  exit 5
fi

mkdir -p "$HOME/.codex" /workspace
cp /opt/cysu/main-agent.md /workspace/AGENTS.md
{
  echo 'approval_policy = "never"'
  echo 'sandbox_mode = "read-only"'
  echo 'web_search = "disabled"'
  # Tests only. Placed before our [tables]: in TOML, keys after a [table]
  # header would belong to that table.
  if [ -n "${CYSU_CODEX_CONFIG_APPEND:-}" ]; then printf '%s\n' "$CYSU_CODEX_CONFIG_APPEND"; fi
  echo ''
  echo '[features]'
  # code_mode_host stays ON: real models call every tool through Code Mode's
  # `exec` (JavaScript in a V8 isolate with no fetch/require/process); without
  # it they get no tools at all. File writes (apply_patch) are blocked by the
  # read-only sandbox.
  for f in shell_tool unified_exec unified_exec_tty view_image multi_agent goals image_generation apps plugins \
           browser_use browser_use_external computer_use in_app_browser tool_suggest hooks memories; do
    echo "$f = false"
  done
  echo ''
  echo '[mcp_servers.cysu-engine]'
  echo 'command = "cysu-engine-mcp"'
  echo "env = { CYSU_ENGINE_SOCKET = \"${CYSU_ENGINE_SOCKET:-/run/cysu-engine.sock}\" }"
  # Our tools are safe to call without asking: runs and profile changes are
  # only proposals that the user approves in the engine.
  echo 'default_tools_approval_mode = "approve"'
  echo ''
  echo '[projects."/workspace"]'
  echo 'trust_level = "trusted"'
} > "$HOME/.codex/config.toml"

cd /workspace
# (resume takes no -s; sandbox_mode = "read-only" in the config covers both)
if [ -n "$thread" ]; then
  set -- codex exec resume --json --skip-git-repo-check
else
  set -- codex exec --json --skip-git-repo-check -s read-only -C /workspace
fi
[ -z "$model" ] || set -- "$@" --model "$model"
[ -z "$thread" ] || set -- "$@" "$thread"
if [ -n "$thread" ]; then what="continuing conversation $thread"; else what="new conversation"; fi
log "main agent: $what${model:+ (model $model)}"
printf '%s' "$message" | "$@" -
