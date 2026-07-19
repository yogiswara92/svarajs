/**
 * @module security/threatPatterns
 * SvaraJS - shared content threat scanner
 *
 * Lean, regex-based scanner used to gate MEMORY.md/USER.md writes and
 * agent-created skill content: flag prompt-injection, exfiltration,
 * destructive, and obfuscation shapes in text before it's persisted
 * somewhere that gets re-injected into a future system prompt (memory) or
 * executed later (agent-created skills).
 *
 * Heuristic, not a sandbox - see docs/SECURITY.md.
 */

export type ThreatCategory = 'prompt-injection' | 'exfiltration' | 'destructive' | 'obfuscation';

export interface ThreatMatch {
  category: ThreatCategory;
  description: string;
}

const PATTERNS: Array<{ category: ThreatCategory; description: string; regex: RegExp }> = [
  // Prompt injection - content trying to override future instructions
  { category: 'prompt-injection', description: 'instructs ignoring prior instructions', regex: /ignore\s+(all\s+|the\s+|any\s+|previous\s+|prior\s+)+instructions?/i },
  { category: 'prompt-injection', description: 'instructs disregarding the system prompt', regex: /disregard\s+(the\s+)?(system\s+prompt|previous\s+(instructions?|context))/i },
  { category: 'prompt-injection', description: 'role-override phrasing ("you are now ...")', regex: /\byou\s+are\s+now\s+(a|an|no\s+longer)\b/i },
  { category: 'prompt-injection', description: 'jailbreak-style persona switch', regex: /\b(DAN|do anything now)\b.{0,30}\bjailbreak\b/i },

  // Exfiltration - moving data somewhere it shouldn't go
  { category: 'exfiltration', description: 'pipes a remote script into a shell', regex: /curl\s+[^\n]*\|\s*(sh|bash|zsh)\b/i },
  { category: 'exfiltration', description: 'instructs sending data/secrets externally', regex: /send\s+(this|the\s+following|all|these)\s+(data|content|secrets?|keys?|credentials?)\s+to\b/i },
  { category: 'exfiltration', description: 'URL path suggesting a collection/exfil endpoint', regex: /https?:\/\/\S+\/(collect|exfil|leak|beacon)\b/i },

  // Destructive - content describing a destructive action to take later
  { category: 'destructive', description: 'recursive force-delete', regex: /\brm\s+-\w*r\w*f\w*\b/i },
  { category: 'destructive', description: 'SQL DROP TABLE', regex: /\bDROP\s+TABLE\b/i },

  // Obfuscation - encoded/obscured payloads
  { category: 'obfuscation', description: 'long run of hex byte escapes', regex: /(\\x[0-9a-fA-F]{2}){4,}/ },
  { category: 'obfuscation', description: 'base64 decode pipeline', regex: /base64\s+(-d|--decode)\b/i },
];

/** Scan `text` and return every matched threat pattern (empty array = clean). */
export function scanForThreats(text: string): ThreatMatch[] {
  const matches: ThreatMatch[] = [];
  for (const { category, description, regex } of PATTERNS) {
    if (regex.test(text)) {
      matches.push({ category, description });
    }
  }
  return matches;
}
