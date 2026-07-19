import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ApprovalGate } from '../security/approval.js';

describe('ApprovalGate', () => {
  const tmpAllowlist = path.join(os.tmpdir(), `svara-allowlist-${Date.now()}.json`);

  afterEach(() => {
    if (fs.existsSync(tmpAllowlist)) fs.unlinkSync(tmpAllowlist);
  });

  it('allows a safe command by default', async () => {
    const gate = new ApprovalGate({ allowlistPath: tmpAllowlist });
    const result = await gate.check('ls -la');
    expect(result.allowed).toBe(true);
  });

  it('blocks a dangerous command by default (no approval callback)', async () => {
    const gate = new ApprovalGate({ allowlistPath: tmpAllowlist });
    const result = await gate.check('rm -rf /');
    expect(result.allowed).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it('blocks sudo commands', async () => {
    const gate = new ApprovalGate({ allowlistPath: tmpAllowlist });
    const result = await gate.check('sudo apt-get update');
    expect(result.allowed).toBe(false);
  });

  it('allows a dangerous command once persisted to the allowlist', async () => {
    const gate = new ApprovalGate({ allowlistPath: tmpAllowlist });
    gate.allow('rm -rf /tmp/scratch');
    const result = await gate.check('rm -rf /tmp/scratch');
    expect(result.allowed).toBe(true);
  });

  it('persists the allowlist across instances', async () => {
    const gate1 = new ApprovalGate({ allowlistPath: tmpAllowlist });
    gate1.allow('rm -rf /tmp/scratch');

    const gate2 = new ApprovalGate({ allowlistPath: tmpAllowlist });
    expect(gate2.isAllowlisted('rm -rf /tmp/scratch')).toBe(true);
  });

  it('delegates to onApprovalNeeded for dangerous+unlisted commands', async () => {
    const gate = new ApprovalGate({
      allowlistPath: tmpAllowlist,
      onApprovalNeeded: async () => true,
    });
    const result = await gate.check('rm -rf /tmp/whatever');
    expect(result.allowed).toBe(true);
  });

  it('respects a rejecting onApprovalNeeded callback', async () => {
    const gate = new ApprovalGate({
      allowlistPath: tmpAllowlist,
      onApprovalNeeded: async () => false,
    });
    const result = await gate.check('rm -rf /tmp/whatever');
    expect(result.allowed).toBe(false);
  });

  it('catches ${IFS} obfuscation used to smuggle a dangerous command past naive filters', async () => {
    const gate = new ApprovalGate({ allowlistPath: tmpAllowlist });
    const result = await gate.check('rm${IFS}-rf${IFS}/tmp/whatever');
    expect(result.allowed).toBe(false);
  });

  it('catches $IFS$9 obfuscation', async () => {
    const gate = new ApprovalGate({ allowlistPath: tmpAllowlist });
    const result = await gate.check('sudo$IFS$9apt-get update');
    expect(result.allowed).toBe(false);
  });
});
