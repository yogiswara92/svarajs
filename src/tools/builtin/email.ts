/**
 * @module tools/builtin/email
 * The agent's own mailbox over IMAP (read) and SMTP (send): Gmail, Outlook, Yahoo, Zoho or any company mail server,
 * signed in with the mailbox address and a password or app password.
 *
 * Sending is confirmed in the conversation by default (sendMode "confirm"): the first email_send call only returns
 * the draft, the agent shows it to the user, and only a second call with confirmed: true sends it. That works on
 * every channel (Telegram included), unlike a dashboard approval button. sendMode "direct" sends at once.
 */

import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { simpleParser } from 'mailparser';
import path from 'path';
import type { Tool } from '../../types.js';
import { readAgentFile, type SendFileToolOptions } from './sendFile.js';

export interface EmailConfig {
  address: string;
  password: string;
  /** Login name when it differs from the address. */
  username?: string;
  imapHost: string;
  imapPort?: number;
  smtpHost: string;
  smtpPort?: number;
  /** Name shown as the sender. */
  fromName?: string;
  /** "confirm" (default): the user approves every email in the chat first. "direct": send without asking. */
  sendMode?: 'confirm' | 'direct';
}

const MAX_TEXT = 15000;
const MAX_ATTACH = 15_000_000;

function imapClient(cfg: EmailConfig): ImapFlow {
  const port = cfg.imapPort ?? 993;
  return new ImapFlow({
    host: cfg.imapHost, port, secure: port === 993,
    auth: { user: cfg.username || cfg.address, pass: cfg.password },
    logger: false,
    socketTimeout: 30000,
  });
}

function smtpTransport(cfg: EmailConfig) {
  const port = cfg.smtpPort ?? 465;
  return nodemailer.createTransport({
    host: cfg.smtpHost, port, secure: port === 465,
    auth: { user: cfg.username || cfg.address, pass: cfg.password },
    connectionTimeout: 20000,
  });
}

async function withMailbox<T>(cfg: EmailConfig, folder: string, fn: (c: ImapFlow) => Promise<T>): Promise<T> {
  const client = imapClient(cfg);
  await client.connect();
  const lock = await client.getMailboxLock(folder || 'INBOX');
  try {
    return await fn(client);
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }
}

const addr = (a: unknown): string => {
  const list = (a as { value?: Array<{ name?: string; address?: string }> } | undefined)?.value ?? [];
  return list.map((x) => (x.name ? `${x.name} <${x.address}>` : x.address)).filter(Boolean).join(', ');
};

const envAddr = (list?: Array<{ name?: string; address?: string }>) => (list ?? []).map((x) => (x.name ? `${x.name} <${x.address}>` : x.address)).join(', ');

/** Checks that both the IMAP login and the SMTP login work. Throws a readable message otherwise. */
export async function testEmailConfig(cfg: EmailConfig): Promise<string> {
  try {
    const client = imapClient(cfg);
    await client.connect();
    await client.logout().catch(() => {});
  } catch (err) {
    throw new Error(`Reading mail failed (IMAP ${cfg.imapHost}): ${(err as Error).message}. Check the address and password; Gmail and Yahoo need an app password.`);
  }
  try {
    await smtpTransport(cfg).verify();
  } catch (err) {
    throw new Error(`Sending mail failed (SMTP ${cfg.smtpHost}): ${(err as Error).message}.`);
  }
  return `Connected to ${cfg.address}`;
}

async function summaries(c: ImapFlow, uids: number[], limit: number) {
  const pick = uids.slice(-limit).reverse();
  if (!pick.length) return [];
  const out: Array<Record<string, unknown>> = [];
  for await (const m of c.fetch(pick, { uid: true, envelope: true, flags: true, bodyParts: ['TEXT'] }, { uid: true })) {
    const raw = m.bodyParts?.get('TEXT')?.toString('utf8') ?? '';
    out.push({
      uid: m.uid,
      from: envAddr(m.envelope?.from),
      subject: m.envelope?.subject ?? '',
      date: m.envelope?.date?.toISOString(),
      unread: !m.flags?.has('\\Seen'),
      snippet: raw.replace(/<[^>]+>/g, ' ').replace(/=\r?\n/g, '').replace(/\s+/g, ' ').trim().slice(0, 200),
    });
  }
  return out.sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

export function createEmailTools(cfg: EmailConfig, fileOpts?: Pick<SendFileToolOptions, 'rootDir' | 'backend' | 'dockerContainer'>): Tool[] {
  const confirm = (cfg.sendMode ?? 'confirm') !== 'direct';
  return [
    {
      name: 'email_list',
      description: `List recent emails in the mailbox ${cfg.address} (newest first): sender, subject, date, unread flag and a snippet. Use email_read for the full text.`,
      parameters: {
        folder: { type: 'string', description: 'Mailbox folder (default INBOX; Gmail sent mail is "[Gmail]/Sent Mail")' },
        unread_only: { type: 'boolean', description: 'Only unread emails' },
        limit: { type: 'number', description: 'How many (default 10, max 30)' },
      },
      async run(args) {
        const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 30);
        return withMailbox(cfg, String(args.folder || 'INBOX'), async (c) => {
          const uids = (await c.search(args.unread_only ? { seen: false } : { all: true }, { uid: true })) || [];
          return { mailbox: cfg.address, emails: await summaries(c, uids, limit) };
        });
      },
    },
    {
      name: 'email_search',
      description: `Search the mailbox ${cfg.address}: by words, sender, or date range. Returns matching emails, newest first.`,
      parameters: {
        query: { type: 'string', description: 'Words to find in subject or body' },
        from: { type: 'string', description: 'Sender address or name' },
        since: { type: 'string', description: 'YYYY-MM-DD, only emails on or after this day' },
        before: { type: 'string', description: 'YYYY-MM-DD, only emails before this day' },
        folder: { type: 'string', description: 'Mailbox folder (default INBOX)' },
        limit: { type: 'number', description: 'How many (default 10, max 30)' },
      },
      async run(args) {
        const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 30);
        const q: Record<string, unknown> = {};
        if (args.query) q.or = [{ subject: String(args.query) }, { body: String(args.query) }];
        if (args.from) q.from = String(args.from);
        if (args.since) q.since = new Date(String(args.since));
        if (args.before) q.before = new Date(String(args.before));
        if (!Object.keys(q).length) q.all = true;
        return withMailbox(cfg, String(args.folder || 'INBOX'), async (c) => {
          const uids = (await c.search(q, { uid: true })) || [];
          return { found: uids.length, emails: await summaries(c, uids, limit) };
        });
      },
    },
    {
      name: 'email_read',
      description: 'Read one email in full (by uid from email_list or email_search): sender, recipients, subject, date, text and attachment names. Marks it as read.',
      parameters: {
        uid: { type: 'number', required: true, description: 'Email uid' },
        folder: { type: 'string', description: 'Mailbox folder (default INBOX)' },
      },
      async run(args) {
        return withMailbox(cfg, String(args.folder || 'INBOX'), async (c) => {
          const msg = await c.fetchOne(String(args.uid), { source: true }, { uid: true });
          if (!msg || !msg.source) return { error: `Email ${args.uid} not found.` };
          const mail = await simpleParser(msg.source);
          await c.messageFlagsAdd(String(args.uid), ['\\Seen'], { uid: true }).catch(() => {});
          const text = (mail.text || String(mail.html || '').replace(/<[^>]+>/g, ' ')).replace(/\n{3,}/g, '\n\n').trim();
          return {
            uid: Number(args.uid),
            from: addr(mail.from), to: addr(mail.to), cc: addr(mail.cc),
            subject: mail.subject, date: mail.date?.toISOString(), message_id: mail.messageId,
            text: text.slice(0, MAX_TEXT), truncated: text.length > MAX_TEXT,
            attachments: (mail.attachments || []).map((a) => ({ name: a.filename, size: a.size, type: a.contentType })),
          };
        });
      },
    },
    {
      name: 'email_send',
      description: `Send an email from ${cfg.address}, or reply to one (reply_to_uid keeps the thread). ` + (confirm
        ? 'Sending is confirmed in the chat: call it once WITHOUT confirmed to get the draft, show the draft to the user (to, subject, body, attachments) and ask whether to send. Only after the user clearly says yes, call it again with the same fields and confirmed: true. Never set confirmed on your own.'
        : 'It is sent at once, so double-check recipients and content first.'),
      parameters: {
        to: { type: 'string', required: true, description: 'Recipient address(es), comma separated' },
        subject: { type: 'string', description: 'Subject (for a reply, defaults to "Re: <original subject>")' },
        body: { type: 'string', required: true, description: 'Plain text body' },
        cc: { type: 'string', description: 'Cc address(es)' },
        reply_to_uid: { type: 'number', description: 'uid of the email being answered (INBOX)' },
        attachments: { type: 'array', description: 'Paths of files you made in your working directory to attach' },
        confirmed: { type: 'boolean', description: 'true only after the user approved this exact draft' },
      },
      async run(args) {
        const to = String(args.to || '').trim();
        if (!to || !String(args.body || '').trim()) return { error: 'to and body are required.' };
        let subject = String(args.subject || '').trim();
        let inReplyTo: string | undefined;
        let references: string[] | undefined;
        if (args.reply_to_uid) {
          const orig = await withMailbox(cfg, 'INBOX', async (c) => {
            const msg = await c.fetchOne(String(args.reply_to_uid), { source: true }, { uid: true });
            return msg && msg.source ? simpleParser(msg.source) : null;
          }).catch(() => null);
          if (orig) {
            inReplyTo = orig.messageId;
            references = [...(Array.isArray(orig.references) ? orig.references : orig.references ? [orig.references] : []), ...(orig.messageId ? [orig.messageId] : [])];
            if (!subject) subject = /^re:/i.test(orig.subject || '') ? orig.subject! : `Re: ${orig.subject || ''}`;
          }
        }
        const files = Array.isArray(args.attachments) ? args.attachments.map(String).slice(0, 10) : [];
        const draft = { from: cfg.address, to, cc: args.cc ? String(args.cc) : undefined, subject, body: String(args.body), attachments: files.map((f) => path.posix.basename(f)), in_reply_to: inReplyTo ? true : undefined };
        if (confirm && args.confirmed !== true) {
          return { needs_confirmation: true, draft, instruction: 'Show this draft to the user and ask whether to send it. Send only after a clear yes, with confirmed: true.' };
        }
        const attachments = [];
        for (const f of files) {
          if (!fileOpts) return { error: 'Attaching files needs the file abilities to be switched on.' };
          try {
            attachments.push({ filename: path.posix.basename(f), content: await readAgentFile(fileOpts, f, MAX_ATTACH) });
          } catch (err) {
            return { error: `Could not attach ${f}: ${(err as Error).message}` };
          }
        }
        const info = await smtpTransport(cfg).sendMail({
          from: cfg.fromName ? `"${cfg.fromName.replace(/"/g, '')}" <${cfg.address}>` : cfg.address,
          to, cc: draft.cc, subject, text: draft.body, inReplyTo, references, attachments,
        });
        return { sent: true, to, subject, message_id: info.messageId };
      },
    },
    {
      name: 'email_mark',
      description: 'Mark an email as read or unread, or move it to another folder (e.g. archive it).',
      parameters: {
        uid: { type: 'number', required: true, description: 'Email uid' },
        read: { type: 'boolean', description: 'true = read, false = unread' },
        move_to: { type: 'string', description: 'Folder to move it to (e.g. "Archive", "[Gmail]/All Mail")' },
        folder: { type: 'string', description: 'Folder it is in now (default INBOX)' },
      },
      async run(args) {
        return withMailbox(cfg, String(args.folder || 'INBOX'), async (c) => {
          const uid = String(args.uid);
          if (args.read === true) await c.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
          if (args.read === false) await c.messageFlagsRemove(uid, ['\\Seen'], { uid: true });
          if (args.move_to) await c.messageMove(uid, String(args.move_to), { uid: true });
          return { ok: true };
        });
      },
    },
  ];
}
