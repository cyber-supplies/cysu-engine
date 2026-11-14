// profiles.js: the user's profiles from Cyber Supplies, and the stage order
// the Windmill "Ordered Profile Security Workflow" used:
//   - the global profile is installed in every stage and is not a stage;
//   - every other profile needs exactly ONE tag "1".."4" (its stage number);
//   - tags listed in `skip` are left out;
//   - stages run by tag, then by profile ID.

export const API_URL = process.env.CYSU_API_URL || 'https://cysu-gateway-670100724771.europe-west1.run.app';
export const STAGE_TAGS = ['1', '2', '3', '4'];

export class ProfileError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// fetchProfiles lists the user's profiles ([{ id, tag: [...] , ...}]).
export async function fetchProfiles(token, { apiUrl = API_URL, fetchImpl = fetch } = {}) {
  if (!token) throw new ProfileError(400, 'Add your Cyber Supplies token first');
  let response;
  try {
    response = await fetchImpl(new URL('/api/profiles', apiUrl), {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new ProfileError(502, `Could not reach Cyber Supplies: ${error.message}`);
  }
  const data = await response.json().catch(() => null);
  // Never answered as 401: to the engine's client a 401 means "wrong ENGINE
  // token". Cyber Supplies refusing the stored token is a 502 that says so.
  if (response.status === 401 || response.status === 403) {
    throw Object.assign(new ProfileError(502, `Cyber Supplies did not accept your user token (${response.status}); it may have been revoked: set a new one on the engine host with install.sh --token`), { upstreamStatus: response.status });
  }
  if (!response.ok) throw Object.assign(new ProfileError(502, `Cyber Supplies profile lookup failed (${response.status})`), { upstreamStatus: response.status });
  if (!Array.isArray(data)) throw new ProfileError(502, 'Cyber Supplies profiles response must be an array');
  return data;
}

// orderProfiles turns the profile list into ordered stages: [{ profile, tag }].
export function orderProfiles(rows, { globalProfile = '', skip = [] } = {}) {
  if (!Array.isArray(skip) || !skip.every((v) => STAGE_TAGS.includes(v))) {
    throw new ProfileError(400, 'skip must be a list of stage tags "1" to "4"');
  }
  // Checked first: a mistyped global profile would otherwise surface as the
  // real global profile "having no stage tag", which is confusing.
  if (globalProfile && Array.isArray(rows) && !rows.some((row) => row?.id === globalProfile)) {
    throw new ProfileError(400, `Global profile ${globalProfile} is not one of your profiles`);
  }
  const skipped = new Set(skip);
  const seen = new Set();
  const stages = [];
  let foundGlobal = false;
  let tagged = 0;
  for (const row of rows) {
    if (typeof row?.id !== 'string' || !row.id.trim() || row.id !== row.id.trim() ||
        !Array.isArray(row.tag) || !row.tag.every((v) => typeof v === 'string')) {
      throw new ProfileError(502, 'Cyber Supplies returned a profile without a valid ID or tag list');
    }
    if (seen.has(row.id)) throw new ProfileError(502, `Cyber Supplies returned duplicate profile ID ${row.id}`);
    seen.add(row.id);
    if (globalProfile && row.id === globalProfile) { foundGlobal = true; continue; }
    if (row.tag.length !== 1 || !STAGE_TAGS.includes(row.tag[0])) {
      throw new ProfileError(400, `Profile ${row.id} must have exactly one stage tag from 1 to 4 (it has ${row.tag.length ? row.tag.map((t) => `"${t}"`).join(', ') : 'none'})`);
    }
    tagged += 1;
    if (!skipped.has(row.tag[0])) stages.push({ profile: row.id, tag: row.tag[0] });
  }
  if (globalProfile && !foundGlobal) throw new ProfileError(400, `Global profile ${globalProfile} is not one of your profiles`);
  if (!tagged) throw new ProfileError(400, 'You have no stage profiles (profiles tagged 1 to 4)');
  if (!stages.length) throw new ProfileError(400, 'Every stage was skipped');
  stages.sort((a, b) => Number(a.tag) - Number(b.tag) || a.profile.localeCompare(b.profile));
  return stages;
}

// fetchLlmToken gets the user's own llm_ token (GET /api/tokens/llm, which
// only a usr_ token may call). Workers get it instead of the usr_ token unless
// the user chose agentToken "user". Fetched fresh for every worker and never
// stored by the engine. Failures are 502s that say what to do.
export async function fetchLlmToken(token, { apiUrl = API_URL, fetchImpl = fetch } = {}) {
  if (!token) throw new ProfileError(400, 'Add your Cyber Supplies token first');
  let response;
  try {
    response = await fetchImpl(new URL('/api/tokens/llm', apiUrl), {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new ProfileError(502, `Could not reach Cyber Supplies to get your LLM token: ${error.message}`);
  }
  const data = await response.json().catch(() => null);
  if (response.status === 401 || response.status === 403) {
    throw Object.assign(new ProfileError(502, `Cyber Supplies did not accept your user token (${response.status}); it may have been revoked: set a new one with /setup`), { upstreamStatus: response.status });
  }
  if (response.status === 404) {
    throw Object.assign(new ProfileError(502, 'Cyber Supplies has no LLM token for your account (or this API does not offer it yet). Set the agent token to "user" to run with your user token'), { upstreamStatus: 404 });
  }
  if (!response.ok) throw Object.assign(new ProfileError(502, `Cyber Supplies LLM token lookup failed (${response.status})`), { upstreamStatus: response.status });
  const llm = typeof data?.token === 'string' ? data.token.trim() : '';
  if (!llm.startsWith('llm_')) throw new ProfileError(502, 'Cyber Supplies returned an invalid LLM token');
  return llm;
}
