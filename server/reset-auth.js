// reset-auth.js: forget the engine token, for a user who lost it. Afterwards
// the engine is "not set up" again: the next setup (PUT /api/settings with a
// Cyber Supplies user token) sets a new one. Nothing else is touched: the
// passkey, LLM login, workspaces and runs are kept.
//
// Run it where the engine's data is, as someone who controls that machine:
//   sh scripts/engine.sh reset-auth                 (engine in its container)
//   CYSU_ENGINE_DATA=<dir> node server/reset-auth.js (engine from a checkout)
// There is no API for this on purpose: whoever can run it already controls
// Docker (or the data folder), and with that the whole engine.

import { load, save } from './store.js';

const settings = await load('settings', null);
if (!settings?.token) {
  console.log('No engine token is set: nothing to reset. Run setup with your Cyber Supplies user token.');
} else {
  delete settings.token;
  await save('settings', settings);
  console.log('Engine token removed. Run setup again now (cysu engine), with your Cyber Supplies user token.');
  console.log('Until you do, the engine is not set up: the next setup on this machine sets the token.');
}
