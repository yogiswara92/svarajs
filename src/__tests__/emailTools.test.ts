import { describe, it, expect } from 'vitest';
import { createEmailTools, testEmailConfig } from '../tools/builtin/email.js';
import { mergeConfigUpdates } from '../dashboard/serve.js';

const cfg = { address: 'me@example.com', password: 'x', imapHost: '127.0.0.1', imapPort: 1, smtpHost: '127.0.0.1', smtpPort: 1 };
const ctx = {} as never;

describe('email tools', () => {
  it('asks for confirmation before sending by default and returns the draft', async () => {
    const send = createEmailTools(cfg).find((t) => t.name === 'email_send')!;
    const r = await send.run({ to: 'boss@example.com', subject: 'Report', body: 'Hi' }, ctx) as { needs_confirmation: boolean; draft: { to: string; subject: string } };
    expect(r.needs_confirmation).toBe(true);
    expect(r.draft).toMatchObject({ to: 'boss@example.com', subject: 'Report' });
  });

  it('explains a failing login in plain words', async () => {
    await expect(testEmailConfig(cfg)).rejects.toThrow(/Reading mail failed \(IMAP 127\.0\.0\.1\)/);
  });

  it('describes direct mode without the confirmation step', () => {
    const send = createEmailTools({ ...cfg, sendMode: 'direct' }).find((t) => t.name === 'email_send')!;
    expect(send.description).toMatch(/sent at once/);
  });
});

describe('mergeConfigUpdates email', () => {
  it('keeps a saved password when the form sends the [set] placeholder, and removes the mailbox when switched off', () => {
    const current = { tools: { email: { ...cfg, password: 'enc:secret' } } };
    const kept = mergeConfigUpdates(current, { tools: { email: { ...cfg, password: '[set]', fromName: 'Sari' } } }) as { tools: { email: Record<string, unknown> } };
    expect(kept.tools.email.password).toBe('enc:secret');
    expect(kept.tools.email.fromName).toBe('Sari');
    const off = mergeConfigUpdates(current, { tools: { email: false } }) as { tools: Record<string, unknown> };
    expect(off.tools.email).toBeUndefined();
  });
});
