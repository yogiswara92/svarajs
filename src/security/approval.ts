/**
 * @module security/approval
 * SvaraJS - approval gate for dangerous shell commands
 *
 * Heuristic, not a sandbox: this only pattern-matches known-dangerous shapes
 * of a command string and gates them behind an allowlist or an approval
 * callback. Real isolation needs an OS-level boundary (see docs/SECURITY.md
 * and the terminal tool's `backend: 'docker'` option).
 *
 * Commands are normalized (unfolds `${IFS}` and similar shell tricks used
 * to smuggle spaces/characters past naive filters) before pattern matching,
 * so a lightly obfuscated dangerous command still gets caught. This raises
 * the bar, it doesn't remove it - a determined adversary can still get past
 * regex-based detection.
 */

import fs from 'fs';
import path from 'path';

const DANGEROUS_PATTERNS: RegExp[] = [
  /\brm\s+(-\w*r\w*f\w*|-\w*f\w*r\w*|--recursive.*--force|--force.*--recursive)\b/i, // rm -rf variants
  /\bsudo\b/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /\b(shutdown|reboot|halt|poweroff)\b/i,
  />\s*\/dev\/sd[a-z]/i,
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&?\s*\}\s*;/, // fork bomb
  /\bchmod\s+-R\s+777\s+\//i,
  /\bcurl\b[^|]*\|\s*(sh|bash|zsh)\b/i, // curl | sh
  /\bwget\b[^|]*\|\s*(sh|bash|zsh)\b/i,
  /\b(kill|pkill|killall)\s+-9\s+-?1\b/i, // kill everything
  />\s*\/etc\//i,
];

/**
 * Unfold common shell obfuscation tricks before pattern matching -
 * `${IFS}`/`$IFS` are frequently used in place of a literal space to sneak
 * a dangerous command past naive substring/space-based filters.
 */
function normalizeCommand(command: string): string {
  return command
    .replace(/\$\{IFS\}/g, ' ')
    .replace(/\$IFS\$?\d*/g, ' ')
    .replace(/\\\n/g, '')
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface ApprovalGateOptions {
  /** Where the permanent allowlist is persisted. @default '.svara/allowlist.json' */
  allowlistPath?: string;
  /**
   * Called when a command matches a dangerous pattern and isn't already
   * allowlisted. Return `true` to allow this one execution, `false` to
   * block it. If omitted, dangerous+unlisted commands are always blocked
   * (safe default for unattended/standalone runs).
   */
  onApprovalNeeded?: (command: string, reason: string) => Promise<boolean>;
}

export interface ApprovalResult {
  allowed: boolean;
  reason?: string;
}

export class ApprovalGate {
  private allowlistPath: string;
  private allowlist: Set<string>;
  private onApprovalNeeded?: (command: string, reason: string) => Promise<boolean>;

  constructor(opts: ApprovalGateOptions = {}) {
    this.allowlistPath = opts.allowlistPath ?? path.join('.svara', 'allowlist.json');
    this.onApprovalNeeded = opts.onApprovalNeeded;
    this.allowlist = new Set(this.loadAllowlist());
  }

  /** Check whether `command` may run. Prompts via `onApprovalNeeded` if dangerous and not allowlisted. */
  async check(command: string): Promise<ApprovalResult> {
    const normalized = normalizeCommand(command);
    const matched = DANGEROUS_PATTERNS.find((pattern) => pattern.test(command) || pattern.test(normalized));

    if (!matched) {
      return { allowed: true };
    }

    if (this.allowlist.has(command)) {
      return { allowed: true };
    }

    const reason = `Command matches a dangerous pattern (${matched.source}).`;

    if (this.onApprovalNeeded) {
      const approved = await this.onApprovalNeeded(command, reason);
      return approved ? { allowed: true } : { allowed: false, reason };
    }

    return { allowed: false, reason };
  }

  /** Permanently allow an exact command string (persisted to disk). */
  allow(command: string): void {
    this.allowlist.add(command);
    this.saveAllowlist();
  }

  isAllowlisted(command: string): boolean {
    return this.allowlist.has(command);
  }

  private loadAllowlist(): string[] {
    try {
      const raw = fs.readFileSync(this.allowlistPath, 'utf-8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private saveAllowlist(): void {
    fs.mkdirSync(path.dirname(this.allowlistPath), { recursive: true });
    fs.writeFileSync(this.allowlistPath, JSON.stringify([...this.allowlist], null, 2), 'utf-8');
  }
}
