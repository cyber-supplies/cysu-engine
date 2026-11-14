// Authentication is provisioned locally by the installer, never by the API.
// Separate storage prevents settings/LLM writes from restoring an old token.
import { load, save } from './store.js';

const defaults = { passkey: '', llm: { mode: 'none', apiKey: '' }, globalProfile: '', agentToken: 'llm', engineLinked: false };

export async function loadSettings() {
  const settings = await load('settings', defaults);
  const auth = await load('auth', {});
  // Legacy settings.token is deliberately ignored: v3 requires the installer.
  return { ...settings, token: auth.token || '' };
}

export async function saveSettings(settings) {
  const { token, ...editable } = settings;
  await save('settings', editable);
}
