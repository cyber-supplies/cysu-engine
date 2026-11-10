#!/bin/sh
# Test stand-in for `codex exec` / `codex exec resume`: no LLM call. Reports
# what the stage set up (prompt, flags, installed profile files, MCP servers
# Codex would load) as Codex-shaped JSONL events. Every other codex command
# (login, mcp list, ...) runs the real binary.
#
# Behaviour switches (in the prompt, or in the stage profile's AGENTS.md):
#   SLEEP            hang (until cancelled)        PAUSE  sleep 4s
#   FAIL-TURN        emit turn.failed, exit 1      REFRESH-LOGIN  rewrite ~/.codex/auth.json
#   FAIL-THIS-STAGE  (AGENTS.md) fail              HANG-THIS-STAGE (AGENTS.md) hang
#   --model bad-model  fail (to exercise the fallback model)
#   Daybreak check prompt ("Reply with the single word OK"): answers OK, except
#     --cyber-access-program daybreak_red with a non-cyber model → OpenAI's real denial
#   --model daybreak-denied  fail with OpenAI's real "no Daybreak access" error (2026-11-08)
[ "${1:-}" = "exec" ] || exec codex-real "$@"
shift
mode=new
if [ "${1:-}" = "resume" ]; then mode=resume; shift; fi

# Parse the flags the engine uses; the thread ID (resume) is the last
# argument before "-".
model='' thread='' prev='' program=''
for arg in "$@"; do
  [ "$prev" = "--model" ] && model=$arg
  [ "$prev" = "--cyber-access-program" ] && program=$arg
  [ "$arg" = "-" ] && thread=$prev
  prev=$arg
done
[ "$mode" = resume ] || thread="fake-thread-0001"

prompt=$(cat)   # the engine passes the prompt on stdin ("-")
emit() { printf '%s\n' "$1"; }
emit "{\"type\":\"thread.started\",\"thread_id\":\"$thread\"}"
emit '{"type":"turn.started"}'
case "$prompt" in *SLEEP*) sleep 300 ;; esac
case "$prompt" in *PAUSE*) sleep 4 ;; esac
# Simulates Codex refreshing a ChatGPT login during the stage.
case "$prompt" in *REFRESH-LOGIN*)
  jq -c '.tokens.refresh_token = "refreshed-by-stage" | .last_refresh = "now"' ~/.codex/auth.json > ~/.codex/auth.json.new &&
    mv ~/.codex/auth.json.new ~/.codex/auth.json ;;
esac
if [ "$mode" = new ] && grep -q FAIL-THIS-STAGE /workspace/AGENTS.md 2>/dev/null; then prompt="$prompt FAIL-TURN"; fi
if [ "$mode" = new ] && grep -q HANG-THIS-STAGE /workspace/AGENTS.md 2>/dev/null; then sleep 300; fi
if [ "$model" = "bad-model" ]; then
  echo "bad-model" >> /workspace/.attempts
  emit '{"type":"turn.failed","error":{"message":"model bad-model is not available"}}'
  exit 1
fi
case "$prompt" in "Reply with the single word OK"*)
  case "$program:$model" in daybreak_red:*cyber*) ;; daybreak_red:*) model=daybreak-denied ;; esac
  if [ "$model" != daybreak-denied ]; then
    emit "$(jq -cn --arg p "$program" --arg m "$model" '{type: "item.completed", item: {type: "agent_message", text: "OK", program: $p, model: $m}}')"
    emit '{"type":"turn.completed","usage":{"input_tokens":12,"output_tokens":1}}'
    exit 0
  fi ;;
esac
if [ "$model" = "daybreak-denied" ]; then
  err='{"type":"error","error":{"message":"You do not have Daybreak access. If you’re doing authorized security work, apply for Daybreak access via https://platform.openai.com/settings/organization/status-and-access before retrying.","type":"invalid_request_error","param":"access_programs.cyber","code":"invalid_access_program"},"status":400}'
  emit "$(jq -cn --arg m "$err" '{type: "error", message: $m}')"
  emit "$(jq -cn --arg m "$err" '{type: "turn.failed", error: {message: $m}}')"
  exit 1
fi
case "$prompt" in *FAIL-TURN*)
  emit '{"type":"turn.failed","error":{"message":"fake failure requested"}}'
  exit 1 ;;
esac

if [ "$mode" = resume ]; then
  report=$(jq -n --arg prompt "$prompt" --arg thread "$thread" --arg model "$model" --arg args "$*" \
    '{resumed: true, thread: $thread, prompt: $prompt, model: $model, args: $args}')
else
  report=$(jq -n \
    --arg prompt "$prompt" --arg args "$*" --arg model "$model" --arg cwd "$(pwd)" --arg user "$(id -un)" \
    --arg workspaceAgents "$(cat /workspace/AGENTS.md 2>/dev/null)" \
    --arg globalAgents "$(cat ~/.codex/AGENTS.md 2>/dev/null)" \
    --arg mcp "$(cd /workspace && codex-real mcp list 2>&1)" \
    --arg earlierAttempts "$(cat /workspace/.attempts 2>/dev/null)" \
    --arg cysuSkill "$(head -10 ~/.agents/skills/cysu/SKILL.md 2>/dev/null)" \
    --arg files "$(cd / && find /workspace ~/.codex ~/.agents -path '*/log' -prune -o -path '*/tmp' -prune -o -path '*/sessions' -prune -o -name .attempts -prune -o -type f -print 2>/dev/null | sort)" \
    '{prompt:$prompt,args:$args,model:$model,cwd:$cwd,user:$user,workspaceAgents:$workspaceAgents,globalAgents:$globalAgents,mcp:$mcp,earlierAttempts:$earlierAttempts,cysuSkill:$cysuSkill,files:$files}')
fi
emit '{"type":"item.completed","item":{"id":"item_0","type":"command_execution","command":"echo hi","exit_code":0}}'
jq -cn --arg text "$report" '{type:"item.completed",item:{id:"item_1",type:"agent_message",text:$text}}'
emit '{"type":"turn.completed","usage":{"input_tokens":111,"cached_input_tokens":0,"output_tokens":22}}'
