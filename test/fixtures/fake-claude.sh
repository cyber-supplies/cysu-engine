#!/bin/sh
# Test only: exercises the native CLI's URL/stdin/status contract without an
# Anthropic account. Production workers install the unmodified official CLI.
set -eu
case "${1:-} ${2:-}" in
  'auth login')
    printf 'Opening browser to sign in…\nIf the browser did not open, visit: https://claude.com/cai/oauth/'
    sleep 0.1
    printf 'authorize?code=true&client_id=fake-client&response_type=code&redirect_uri=https%%3A%%2F%%2Fplatform.claude.com%%2Foauth%%2Fcode%%2Fcallback&scope=user&code_challenge=fake-challenge&state=fake-state\nPaste code here if prompted > '
    IFS= read -r code
    case "$code" in
      fail*) printf 'Sensitive rejected input: %s\n' "$code" >&2; exit 1 ;;
      unverified*) exit 0 ;;
      slow*) printf 'Sensitive echoed input: %s\n' "$code"; sleep 2 ;;
    esac
    umask 077
    mkdir -p "$CLAUDE_CONFIG_DIR"
    printf '%s\n' '{"accessToken":"fake-claude-private-access","refreshToken":"fake-claude-private-refresh"}' > "$CLAUDE_CONFIG_DIR/.credentials.json"
    printf 'Login successful\n'
    ;;
  'auth status')
    if [ -f "$CLAUDE_CONFIG_DIR/.credentials.json" ]; then
      printf '%s\n' '{"loggedIn":true,"authMethod":"claude.ai"}'
    else
      printf '%s\n' '{"loggedIn":false,"authMethod":"none"}'
      exit 1
    fi
    ;;
  '-p --output-format')
    [ -f "$CLAUDE_CONFIG_DIR/.credentials.json" ] || { echo 'Missing native Claude login' >&2; exit 1; }
    args="$*"
    model='' thread='fake-claude-session' resumed=false
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --model) model=$2; shift 2 ;;
        --resume) thread=$2; resumed=true; shift 2 ;;
        *) shift ;;
      esac
    done
    prompt=$(cat)
    jq -cn --arg session "$thread" '{type:"system",subtype:"init",session_id:$session}'
    case "$prompt" in *SLEEP*) sleep 120 ;; esac
    case "$prompt $model" in
      *FAIL-TURN*|*bad-model*)
        jq -cn --arg session "$thread" '{type:"result",subtype:"error_during_execution",is_error:true,session_id:$session,errors:["fake Claude failure"]}'
        exit 0 ;; # Engines must inspect is_error even when the process exits 0.
      *NO-RESULT*) exit 0 ;;
    esac
    result=$(jq -cn --arg prompt "$prompt" --arg args "$args" --arg user "$(id -un)" --arg thread "$thread" --argjson resumed "$resumed" \
      --arg global "$(cat "$HOME/.claude/CLAUDE.md" 2>/dev/null || true)" \
      --arg project "$(cat /workspace/CLAUDE.md 2>/dev/null || true)" \
      --arg mcp "$(cat /workspace/.mcp.json 2>/dev/null || true)" \
      --arg files "$(find "$HOME/.claude/skills" /workspace/.claude/skills -type f 2>/dev/null || true)" \
      --arg otherAuth "$(find "$HOME/.codex" "$HOME/.config/cysu" -name auth.json -o -name openrouter.key 2>/dev/null || true)" \
      '{prompt:$prompt,args:$args,user:$user,thread:$thread,resumed:$resumed,globalAgents:$global,workspaceAgents:$project,mcp:$mcp,files:$files,otherAuth:$otherAuth}')
    jq -cn --arg text "$result" '{type:"assistant",parent_tool_use_id:null,message:{content:[{type:"text",text:$text}]}}'
    jq -cn --arg session "$thread" --arg result "$result" '{type:"result",subtype:"success",is_error:false,session_id:$session,result:$result,usage:{input_tokens:111,output_tokens:22}}'
    ;;
  *) exec claude-real "$@" ;;
esac
