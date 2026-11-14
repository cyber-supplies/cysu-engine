---
name: engine-history
description: Read earlier runs of this engine workspace (results, transcripts, logs) to learn from them before and while you work. Read-only.
---

# Earlier runs (engine linked)

This worker can read the engine that started it: the earlier runs of the
same workspace, their results, full transcripts and logs. Use them to learn
what was already tried, what worked and what failed, and build on it instead
of repeating it.

Access is **read-only** and limited to this workspace. The engine address is
already set (`CYSU_ENGINE_URL`). Always pass the stage key with `--token`
(your `CYSU_TOKEN` is not accepted by the engine):

```
cysu engine status    --token "$CYSU_ENGINE_TOKEN"   # agent.workspace, agent.runId (this run)
cysu engine list-runs --token "$CYSU_ENGINE_TOKEN"   # runs of this workspace, newest first
cysu engine get-run   --token "$CYSU_ENGINE_TOKEN" --run <id>   # saves the run as readable transcripts
```

`get-run` writes each stage's transcript and result under
`~/cysu/engine/runs/<id>/` and prints that folder; read the files there.

The same with curl (`-H "Authorization: Bearer $CYSU_ENGINE_TOKEN"`):

- `GET $CYSU_ENGINE_URL/api/runs` and `/api/runs/<id>`: the run, with each stage's `result` (the agent's final message)
- `GET /api/runs/<id>/stages/<n>/events?after=0&limit=5000`: the full transcript of stage n
- `GET /api/runs/<id>/stages/<n>/log`: the stage log

Starting, cancelling or deleting runs and changing settings are not allowed
(403). The key only works while this stage runs.
