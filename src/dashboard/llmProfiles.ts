/**
 * @module dashboard/llmProfiles
 * Saved chat models ("connections") in svara.config.json: pure functions over the raw config object, used by the
 * dashboard's AI Provider page. Each profile is a name + model + provider/base URL + key (encrypted when saved) +
 * optional vision override, and one of them is the default the agent runs on.
 *
 * A config written before profiles existed keeps working: its top-level `model` / `llm` are shown as a single
 * "Default" profile and are migrated into `llmProfiles` the first time something is changed.
 */

export const PROVIDERS = ['openai', 'anthropic', 'ollama', 'groq'] as const;
type Raw = Record<string, unknown>;

export interface ProfileInput {
  name?: unknown; model?: unknown; provider?: unknown; baseURL?: unknown;
  apiKey?: unknown; apiKeyEnv?: unknown; vision?: unknown; clearKey?: unknown;
}

export interface ProfileView {
  id: string; name: string; model: string; provider?: string; baseURL?: string;
  hasKey: boolean; apiKeyEnv?: string; vision?: boolean; isDefault: boolean;
}

const isObj = (v: unknown): v is Raw => !!v && typeof v === 'object' && !Array.isArray(v);

export function profilesOf(raw: Raw): Raw[] {
  return Array.isArray(raw.llmProfiles) ? raw.llmProfiles.filter(isObj) : [];
}

/** Turns a legacy top-level `model` / `llm` into a "default" profile (once), and selects it. */
export function ensureProfiles(raw: Raw): Raw {
  if (profilesOf(raw).length) return raw;
  const llm = isObj(raw.llm) ? raw.llm : {};
  const profile: Raw = {
    id: 'default',
    name: 'Default',
    model: typeof raw.model === 'string' && raw.model ? raw.model : 'gpt-4o-mini',
    ...Object.fromEntries(Object.entries({ provider: llm.provider, baseURL: llm.baseURL, apiKey: llm.apiKey, apiKeyEnv: llm.apiKeyEnv, vision: llm.vision }).filter(([, v]) => v !== undefined && v !== '')),
  };
  return { ...raw, llmProfiles: [profile], defaultLlm: 'default' };
}

export function viewOf(raw: Raw): { profiles: ProfileView[]; defaultId: string | null; legacy: boolean } {
  const legacy = profilesOf(raw).length === 0;
  const source = legacy ? profilesOf(ensureProfiles(raw)) : profilesOf(raw);
  const defaultId = legacy ? 'default' : (source.some((p) => p.id === raw.defaultLlm) ? (raw.defaultLlm as string) : null);
  return {
    legacy,
    defaultId,
    profiles: source.map((p) => ({
      id: String(p.id), name: String(p.name), model: String(p.model),
      provider: typeof p.provider === 'string' ? p.provider : undefined,
      baseURL: typeof p.baseURL === 'string' ? p.baseURL : undefined,
      hasKey: typeof p.apiKey === 'string' && p.apiKey !== '',
      apiKeyEnv: typeof p.apiKeyEnv === 'string' && p.apiKeyEnv ? p.apiKeyEnv : undefined,
      vision: typeof p.vision === 'boolean' ? p.vision : undefined,
      isDefault: p.id === defaultId,
    })),
  };
}

export function slugify(name: string, taken: Set<string>): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'model';
  let id = base; let n = 2;
  while (taken.has(id)) id = `${base.slice(0, 36)}-${n++}`;
  return id;
}

type Checked = { ok: true; fields: Raw } | { ok: false; error: string };

function check(input: ProfileInput, creating: boolean): Checked {
  const out: Raw = {};
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v.trim() : undefined);

  const name = str(input.name);
  if (creating || name !== undefined) {
    if (!name) return { ok: false, error: 'Give this model a name.' };
    if (name.length > 80) return { ok: false, error: 'The name is too long (max 80 characters).' };
    out.name = name;
  }
  const model = str(input.model);
  if (creating || model !== undefined) {
    if (!model) return { ok: false, error: 'Enter the model name your provider expects.' };
    if (model.length > 200) return { ok: false, error: 'The model name is too long.' };
    out.model = model;
  }
  if (input.provider !== undefined) {
    const p = str(input.provider) ?? '';
    if (p && !(PROVIDERS as readonly string[]).includes(p)) return { ok: false, error: `Provider must be one of: ${PROVIDERS.join(', ')}.` };
    out.provider = p || undefined;
  }
  if (input.baseURL !== undefined) {
    const u = str(input.baseURL) ?? '';
    if (u) {
      try { if (!['http:', 'https:'].includes(new URL(u).protocol)) throw new Error('protocol'); }
      catch { return { ok: false, error: 'Base URL must be a valid http(s) address.' }; }
    }
    out.baseURL = u || undefined;
  }
  if (input.apiKey !== undefined) {
    const k = str(input.apiKey) ?? '';
    if (k.length > 500) return { ok: false, error: 'The API key is too long.' };
    if (k) out.apiKey = k;
  }
  if (input.apiKeyEnv !== undefined) {
    const e = str(input.apiKeyEnv) ?? '';
    if (e && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(e)) return { ok: false, error: 'The environment variable name looks like a key, not a name. Use the API key field for the key itself.' };
    out.apiKeyEnv = e || undefined;
  }
  if (input.vision !== undefined) out.vision = input.vision === true || input.vision === false ? input.vision : undefined; // null/'auto' = guess from the name
  return { ok: true, fields: out };
}

export function addProfile(raw: Raw, input: ProfileInput): { raw: Raw; id: string } | { error: string } {
  const c = check(input, true);
  if (!c.ok) return { error: c.error };
  const base = ensureProfiles(raw);
  const list = profilesOf(base);
  if (list.length >= 20) return { error: 'You can save up to 20 models.' };
  const id = slugify(String(c.fields.name), new Set(list.map((p) => String(p.id))));
  const profile = Object.fromEntries(Object.entries({ id, ...c.fields }).filter(([, v]) => v !== undefined));
  return { raw: { ...base, llmProfiles: [...list, profile] }, id };
}

export function updateProfile(raw: Raw, id: string, input: ProfileInput): { raw: Raw } | { error: string } {
  const base = ensureProfiles(raw);
  const list = profilesOf(base);
  const current = list.find((p) => p.id === id);
  if (!current) return { error: 'No such model.' };
  const c = check(input, false);
  if (!c.ok) return { error: c.error };
  const merged: Raw = { ...current, ...c.fields, id };
  if (input.clearKey === true) delete merged.apiKey;
  const cleaned = Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== undefined));
  return { raw: { ...base, llmProfiles: list.map((p) => (p.id === id ? cleaned : p)) } };
}

export function deleteProfile(raw: Raw, id: string): { raw: Raw } | { error: string } {
  const base = ensureProfiles(raw);
  const list = profilesOf(base);
  if (!list.some((p) => p.id === id)) return { error: 'No such model.' };
  if (base.defaultLlm === id) return { error: 'This is the default model. Choose another default first, then delete it.' };
  return { raw: { ...base, llmProfiles: list.filter((p) => p.id !== id) } };
}

export function setDefault(raw: Raw, id: string): { raw: Raw } | { error: string } {
  const base = ensureProfiles(raw);
  if (!profilesOf(base).some((p) => p.id === id)) return { error: 'No such model.' };
  return { raw: { ...base, defaultLlm: id } };
}
