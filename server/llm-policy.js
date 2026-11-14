// Credential selection is shared by status, planning and worker startup.
export const MODEL_NAME = /^~?[A-Za-z0-9._:/-]{1,120}$/;
export const OPENROUTER_MODEL = /^~?[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
export const isOpenRouterModel = (model) => typeof model === 'string' && MODEL_NAME.test(model) && OPENROUTER_MODEL.test(model);
export const openRouterReady = (llm) => Boolean(llm?.openrouter?.apiKey && isOpenRouterModel(llm.openrouter.model));

export const PROVIDERS = ['codex', 'claude', 'openrouter'];
export function validateProvider(provider) {
  if (provider !== undefined && !PROVIDERS.includes(provider)) {
    throw Object.assign(new Error('provider must be one of codex, claude, openrouter (omit it for automatic selection)'), { status: 400 });
  }
}

export function llmProvider(llm, codexAuth, claudeAuth = false, requested) {
  validateProvider(requested);
  if (!llm || llm.mode === 'none') return null;
  if (requested === 'claude') return claudeAuth ? 'claude' : null;
  if (requested === 'openrouter') return openRouterReady(llm) ? 'openrouter' : null;
  // Retain the existing direct OpenAI API-key mode for the Codex harness.
  if (requested === 'codex') return codexAuth ? 'codex' : llm.mode === 'openai-api-key' && llm.apiKey ? 'openai' : null;
  if (codexAuth) return 'codex';
  if (claudeAuth) return 'claude';
  if (openRouterReady(llm)) return 'openrouter';
  if (llm?.mode === 'openai-api-key') return llm.apiKey ? 'openai' : null;
  return null;
}
