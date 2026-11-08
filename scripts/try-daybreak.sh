#!/usr/bin/env bash
# try-daybreak.sh: test OpenAI Daybreak on the `daybreak` branch, without the CLI.
# A testing helper for this branch; not part of a release.
#
#   git fetch && git switch daybreak
#   npm run image:build                 # worker image with the new entrypoint (~10 min, once)
#   npm start                           # engine on 127.0.0.1:8787 (keep it running)
#
# then, in another terminal (from the repo folder):
#   bash scripts/try-daybreak.sh setup                    # usr_ token, passkey, OpenAI API key (hidden)
#   bash scripts/try-daybreak.sh red gpt-5.6-cyber        # Daybreak Red + the cyber model
#   bash scripts/try-daybreak.sh red                      # Daybreak Red, Codex's default model
#   bash scripts/try-daybreak.sh blue                     # Daybreak Blue, Codex's default model
#   bash scripts/try-daybreak.sh check <run-id>           # result, attempts and errors of a run
#
# Each run is one stage with one of YOUR profiles (PROFILE=<id>, default
# "recon") and a harmless objective: no scanning, one sentence back.
set -euo pipefail
cd "$(dirname "$0")/.."
E=${CYSU_ENGINE_URL:-http://127.0.0.1:8787}/api
PROFILE=${PROFILE:-recon}
json() { node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const r=JSON.parse(d||"{}");const f=new Function("r",`return (${process.argv[1]})`);console.log(f(r))})' "$1"; }

if [ "${1:-}" = setup ]; then
  read -rsp 'Cyber Supplies user token (usr_…): ' T; echo
  # First setup (the engine is not set up yet); answers 401 if it already is.
  printf '{"token":"%s","passkey":"daybreak-test"}' "$T" | curl -sS -X PUT "$E/settings" -H 'Content-Type: application/json' -d @- -o /dev/null -w 'token setup: HTTP %{http_code}\n'
  read -rsp 'OpenAI API key from the Daybreak-enabled project (sk-…): ' K; echo
  printf 'Authorization: Bearer %s\n' "$T" | curl -sS -H @- -X PUT "$E/settings" -H 'Content-Type: application/json' \
    --data-binary @<(printf '{"llm":{"mode":"openai-api-key","apiKey":"%s"}}' "$K") | json 'r.error || ("LLM login: " + r.llm.mode)'
  unset K
  printf 'Authorization: Bearer %s\n' "$T" | curl -sS -H @- "$E/status" | json 'r.error || ("ready: " + r.configured + ", llm ready: " + r.llm.ready + ", docker: " + r.docker)'
  exit
fi

T=$(node -pe 'require("./data/settings.json").token||""' 2>/dev/null || true)
[ -n "$T" ] || { echo "Run: bash scripts/try-daybreak.sh setup  (first)"; exit 1; }
api() { printf 'Authorization: Bearer %s\n' "$T" | curl -sS -H @- -H 'Content-Type: application/json' "$@"; }

if [ "${1:-}" = check ]; then
  api "$E/runs/${2:?run id}" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const r=JSON.parse(d);if(r.error){console.log(r.error);return}
    console.log("run", r.id.slice(0,8), r.status, "| daybreak:", r.daybreak);
    for (const s of r.stages) { console.log(" stage", s.profile, s.status, "| daybreak:", s.daybreak);
      for (const a of s.attempts) console.log("   attempt", a.kind, a.model||"(default model)", "| daybreak:", a.daybreak, "|", a.status);
      for (const e of [...new Set(s.errors)]) console.log("   error:", e);
      if (s.result) console.log("   result:", s.result.slice(0,300)); }})'
  exit
fi

TIER=${1:?usage: setup | red [model] | blue [model] | standard | check <run-id>}; MODEL=${2:-}
NAME="Daybreak $TIER${MODEL:+ $MODEL} $(date +%H%M%S)"
REQ="{\"stages\":[{\"profile\":\"$PROFILE\"}],\"daybreak\":\"$TIER\"${MODEL:+,\"model\":\"$MODEL\"}}"
ID=$(api -X POST "$E/workspaces" -d "{\"name\":\"$NAME\",\"request\":$REQ}" | json 'r.id || (console.error(r.error), process.exit(1))')
OBJ='This is a test of OpenAI Daybreak access. Do not scan or contact any host. Reply with one short sentence naming the model you are, then finish.'
RUN=$(api -X POST "$E/workspaces/$ID/run" -d "{\"objective\":\"$OBJ\"}" | json 'r.id || (console.error(r.error), process.exit(1))')
echo "started run $RUN (daybreak $TIER${MODEL:+, model $MODEL}, profile $PROFILE)"
echo "in ~1 min: bash scripts/try-daybreak.sh check $RUN"
