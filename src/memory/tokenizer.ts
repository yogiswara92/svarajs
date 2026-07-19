/**
 * @internal
 * Shared token counting - replaces the old `Math.ceil(text.length / 4)`
 * heuristic used by every LLM adapter with a real BPE tokenizer.
 *
 * `gpt-tokenizer` implements OpenAI's cl100k_base encoding. It's an exact
 * match for OpenAI/Groq (OpenAI-compatible) models and a reasonable
 * approximation for Anthropic/Ollama, which don't ship a public JS tokenizer.
 */

import { encode } from 'gpt-tokenizer';

export function countTokens(text: string): number {
  if (!text) return 0;
  try {
    return encode(text).length;
  } catch {
    // Never let a tokenizer edge case (unusual unicode, etc.) break the agent loop.
    return Math.ceil(text.length / 4);
  }
}
