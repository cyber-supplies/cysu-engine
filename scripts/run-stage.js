#!/usr/bin/env node
// Run ONE stage from the terminal with the settings saved in the engine
// (token, passkey, LLM login), and watch it live. A developer/testing tool
// until the Runs UI exists.
//
//   npm run stage -- --profile <id> --prompt "..." [--global <id>] [--model <m>] [--effort <e>]

import { parseArgs } from 'node:util';
import { load } from '../server/store.js';
import { loadCodexAuth } from '../server/llm.js';
import { startStage, cancelStage } from '../server/stage.js';

const { values } = parseArgs({
  options: {
    profile: { type: 'string' },
    global: { type: 'string', default: '' },
    prompt: { type: 'string' },
    model: { type: 'string', default: '' },
    effort: { type: 'string', default: '' },
    raw: { type: 'boolean', default: false },
  },
});

const settings = await load('settings', null);
if (!settings?.token || !settings?.passkey) {
  console.error('Save your token and passkey in the engine first (npm start → Setup).');
  process.exit(2);
}
const codexAuth = settings.llm?.mode === 'codex' ? await loadCodexAuth() : null;

const gray = (s) => `\x1b[90m${s}\x1b[0m`;
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
const short = (s, n = 160) => (s.length > n ? `${s.slice(0, n)}…` : s);

let logShown = 0;
function show(run, event) {
  // new stderr lines ([engine] + cysu)
  const lines = run.log.split('\n');
  for (; logShown < lines.length - 1; logShown++) console.log(gray(lines[logShown]));
  if (!event) return;
  if (values.raw) return console.log(JSON.stringify(event));
  const item = event.item || {};
  if (event.type === 'thread.started') console.log(cyan(`thread ${event.thread_id}`));
  else if (event.type === 'item.completed' && item.type === 'agent_message') console.log(`\n${item.text}\n`);
  else if (event.type === 'item.completed' && item.type === 'command_execution') console.log(cyan(`$ ${short(item.command || '')}`) + gray(` → exit ${item.exit_code}`));
  else if (event.type === 'item.completed' && item.type === 'reasoning') console.log(gray(`(thinking) ${short(item.text || '')}`));
  else if (event.type === 'turn.completed') console.log(cyan(`turn done · tokens in ${event.usage?.input_tokens ?? '?'} / out ${event.usage?.output_tokens ?? '?'}`));
  else if (event.type === 'turn.failed' || event.type === 'error') console.log(`\x1b[31m${JSON.stringify(event.error || event.message)}\x1b[0m`);
}

let run;
try {
  run = startStage({
    stage: { profile: values.profile, globalProfile: values.global, prompt: values.prompt, model: values.model, reasoningEffort: values.effort },
    settings, codexAuth, onUpdate: show,
  });
} catch (error) {
  console.error(error.message);
  process.exit(2);
}
console.log(cyan(`stage ${run.id} · container ${run.container} · Ctrl-C cancels`));
process.on('SIGINT', () => { console.log('\ncancelling…'); cancelStage(run); });

const done = await run.done;
console.log(cyan(`\n${done.status.toUpperCase()} · exit ${done.exitCode} · turns ${done.turns} · events ${done.events.length}`));
if (done.errors.length) console.log(`errors: ${done.errors.join(' | ')}`);
process.exit(done.status === 'succeeded' ? 0 : 1);
