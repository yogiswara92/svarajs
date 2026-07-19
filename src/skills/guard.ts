/**
 * @module skills/guard
 * SvaraJS - trust-tiered content policy for skills.
 *
 * SvaraJS has no full skill marketplace with per-org trust records, so this
 * collapses to three tiers that map to the actual sources skills come from
 * here:
 *
 *   trust           safe    caution   dangerous
 *   human           allow   allow     allow      (skills placed on disk directly - implicitly trusted)
 *   agent-created    allow   allow     ask        (written by the agent itself via skill_manage)
 *   hub              allow   ask       block      (installed from an arbitrary GitHub repo via skill_install)
 *
 * "ask" means the caller must supply an approval callback - if none is
 * given, ask outcomes are treated as declined (blocked), not silently allowed.
 */

import { scanForThreats, type ThreatMatch } from '../security/threatPatterns.js';
import type { SkillTrust } from './types.js';

export type GuardVerdict = 'allow' | 'ask' | 'block';

export interface SkillGuardResult {
  verdict: GuardVerdict;
  findings: ThreatMatch[];
}

/** "dangerous" for the ask/block rows above. */
const DANGEROUS_CATEGORIES = new Set<ThreatMatch['category']>(['destructive', 'exfiltration']);
/** "caution" for the hub row's stricter middle ground. */
const CAUTION_CATEGORIES = new Set<ThreatMatch['category']>(['prompt-injection', 'obfuscation']);

export function guardSkillContent(body: string, trust: SkillTrust): SkillGuardResult {
  const findings = scanForThreats(body);
  if (findings.length === 0) return { verdict: 'allow', findings };

  if (trust === 'human') {
    // Implicitly trusted - allow, findings still surfaced for visibility.
    return { verdict: 'allow', findings };
  }

  const hasDangerous = findings.some((f) => DANGEROUS_CATEGORIES.has(f.category));

  if (trust === 'agent-created') {
    return { verdict: hasDangerous ? 'ask' : 'allow', findings };
  }

  // trust === 'hub' - least trusted: dangerous content is blocked outright,
  // even caution-level content needs approval.
  if (hasDangerous) return { verdict: 'block', findings };
  const hasCaution = findings.some((f) => CAUTION_CATEGORIES.has(f.category));
  return { verdict: hasCaution ? 'ask' : 'allow', findings };
}
