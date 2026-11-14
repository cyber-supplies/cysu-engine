import { test } from 'node:test';
import assert from 'node:assert/strict';
import { llmProvider, isOpenRouterModel, openRouterReady } from '../server/llm-policy.js';
import { secretsLine } from '../server/docker.js';
import { validateStage, validateProviderStage } from '../server/stage.js';

const openrouter = { apiKey: 'sk-or-test', model: 'anthropic/test-model' };
const subscription = { tokens: { access_token: 'subscription-test' } };

test('saved subscription takes priority; OpenRouter is selected only without it', () => {
  assert.equal(llmProvider({ mode: 'codex', openrouter }, subscription), 'codex');
  assert.equal(llmProvider({ mode: 'codex', openrouter }, null), 'openrouter');
  assert.equal(llmProvider({ mode: 'codex' }, null), null);
  assert.equal(llmProvider({ mode: 'none', openrouter }, subscription), null);
  assert.equal(llmProvider({ mode: 'openai-api-key', apiKey: 'sk-openai', openrouter }, subscription), 'codex');
  assert.equal(llmProvider({ mode: 'openai-api-key', apiKey: 'sk-openai' }, null), 'openai');
  assert.equal(openRouterReady({ openrouter: { apiKey: 'sk-or-test' } }), false);
});

test('automatic order is Codex, Claude, OpenRouter; explicit selection never falls through', () => {
  const llm = { mode: 'codex', openrouter };
  assert.equal(llmProvider(llm, subscription, true), 'codex');
  assert.equal(llmProvider(llm, null, true), 'claude');
  assert.equal(llmProvider(llm, null, false), 'openrouter');
  for (const provider of ['codex', 'claude', 'openrouter']) assert.equal(llmProvider(llm, subscription, true, provider), provider);
  assert.equal(llmProvider(llm, null, true, 'codex'), null);
  assert.equal(llmProvider(llm, subscription, false, 'claude'), null);
  assert.equal(llmProvider({ mode: 'codex' }, subscription, true, 'openrouter'), null);
  for (const provider of ['', null, false, 'auto', 'OR', 'openai', {}]) assert.throws(() => llmProvider(llm, subscription, true, provider), /provider must be/);
  assert.equal(llmProvider({ mode: 'none', openrouter }, subscription, true, 'claude'), null);
});

test('explicit credential isolation and Claude option validation', () => {
  const settings = { token: 'usr_test', passkey: 'pk', llm: { mode: 'codex', openrouter } };
  assert.deepEqual(JSON.parse(secretsLine(settings, subscription, '', {}, 'claude')), { token: 'usr_test', passphrase: 'pk' });
  assert.deepEqual(JSON.parse(secretsLine(settings, subscription, '', {}, 'openrouter')), { token: 'usr_test', passphrase: 'pk', openrouterApiKey: openrouter.apiKey });
  const stage = (input) => validateStage({ provider: 'claude', profile: 'attack', prompt: 'x', ...input });
  assert.throws(() => validateProviderStage(stage({}), settings.llm, subscription, false), /claude is not configured/);
  for (const daybreak of ['blue', 'red']) assert.throws(() => validateProviderStage(stage({ daybreak }), settings.llm, subscription, true), /Daybreak/);
  for (const reasoningEffort of ['none', 'minimal', 'ultra']) assert.throws(() => validateProviderStage(stage({ reasoningEffort }), settings.llm, subscription, true), /Claude reasoningEffort/);
  assert.doesNotThrow(() => validateProviderStage(stage({ reasoningEffort: 'high' }), settings.llm, subscription, true));
});

test('OpenRouter model IDs support namespaces, aliases and variants; refuse invalid input', () => {
  for (const value of ['anthropic/test-model', '~openai/gpt-test', 'meta-llama/test:free']) assert.ok(isOpenRouterModel(value));
  for (const value of ['', 'gpt-test', 'a/x"', 'a/$(env)', 'a/b c', 'a/\nb', null]) assert.equal(isOpenRouterModel(value), false);
});

test('only the selected credential is sent to a worker, never both subscription and OpenRouter', () => {
  const settings = { token: 'usr_test', passkey: 'pk', llm: { mode: 'codex', apiKey: 'sk-openai', openrouter } };
  assert.deepEqual(JSON.parse(secretsLine(settings, subscription)), { token: 'usr_test', passphrase: 'pk', codexAuth: subscription });
  assert.deepEqual(JSON.parse(secretsLine(settings)), { token: 'usr_test', passphrase: 'pk', openrouterApiKey: openrouter.apiKey });
  settings.llm = { mode: 'openai-api-key', apiKey: 'sk-openai' };
  assert.deepEqual(JSON.parse(secretsLine(settings)), { token: 'usr_test', passphrase: 'pk', openaiApiKey: 'sk-openai' });
});

test('OpenRouter defaults and explicit model overrides are resolved before starting a worker', () => {
  const llm = { mode: 'codex', openrouter };
  const stage = (input) => validateStage({ profile: 'attack', prompt: 'x', ...input });
  assert.equal(validateProviderStage(stage({}), llm, null).model, openrouter.model);
  assert.equal(validateProviderStage(stage({ model: 'google/test-model' }), llm, null).model, 'google/test-model');
  assert.equal(validateProviderStage(stage({}), llm, subscription).model, '');
  assert.throws(() => validateProviderStage(stage({ model: 'gpt-test' }), llm, null), /provider\/model/);
  assert.throws(() => validateProviderStage(stage({ fallbackModel: 'gpt-test' }), llm, null), /provider\/model/);
  for (const daybreak of ['blue', 'red']) {
    assert.throws(() => validateProviderStage(stage({ daybreak }), llm, null), /Daybreak/);
    assert.doesNotThrow(() => validateProviderStage(stage({ daybreak }), llm, subscription));
  }
});
