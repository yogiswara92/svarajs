/**
 * @module security/secretFields
 * SvaraJS - single source of truth for "which config keys hold a secret".
 *
 * Shared by the dashboard's redaction (never send a raw secret back to the
 * browser) and the runtime's at-rest encryption (never write a raw secret
 * to svara.config.json) - one list instead of two that can drift apart.
 */

export const SECRET_KEYS = new Set([
  'token', 'apiKey', 'verifyToken', 'searchApiKey', 'password', 'secret',
  'botToken', 'signingSecret', 'refreshToken',
]);

/**
 * `llm.apiKeyEnv` is supposed to hold an environment variable *name*
 * (e.g. "OPENROUTER_API_KEY") - not sensitive on its own. But it's a plain
 * text field, and a real API key pasted there by mistake looks nothing like
 * a valid env var name (those are `[A-Za-z_][A-Za-z0-9_]*` - no hyphens, no
 * long random-looking tokens). Treat anything that fails that shape as an
 * accidental secret rather than trusting the field's intended meaning.
 */
function looksLikeEnvVarName(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function isSecretField(key: string, value: string): boolean {
  if (SECRET_KEYS.has(key)) return true;
  if (key === 'apiKeyEnv') return !looksLikeEnvVarName(value);
  return false;
}

/**
 * An MCP server's `transport.headers` (remote) or `transport.env` (stdio)
 * is inherently credential-bearing - a bearer token, an API key env var
 * value, etc. - and header/variable *names* are arbitrary (Authorization,
 * X-Api-Key, GITHUB_TOKEN, ...), so they can't be enumerated in SECRET_KEYS.
 * Treat every value inside one of these blocks as a secret, rather than
 * matching by key name.
 */
const OPAQUE_SECRET_CONTAINERS = new Set(['headers', 'env']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Recursively walks an object, replacing the string value of any secret-holding key (or any value inside a headers/env block) with `transform(value)`. */
export function mapSecretFields(value: unknown, transform: (v: string) => string): unknown {
  if (Array.isArray(value)) return value.map((v) => mapSecretFields(v, transform));
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => {
        if (OPAQUE_SECRET_CONTAINERS.has(k) && isPlainObject(v)) {
          return [k, Object.fromEntries(
            Object.entries(v).map(([hk, hv]) => [hk, typeof hv === 'string' && hv ? transform(hv) : hv])
          )];
        }
        if (typeof v === 'string' && v && isSecretField(k, v)) return [k, transform(v)];
        return [k, mapSecretFields(v, transform)];
      })
    );
  }
  return value;
}
