/**
 * @module channels/attachments
 * Shared handling of files a user sends to the agent (Telegram, the dashboard chat, ...): save them under the
 * agent's folder with a safe name, describe them to the agent in a stable text note (so tools can open them), and
 * pick out images small enough to show a vision model inline.
 */

import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import type { LLMImage } from '../core/types.js';

/** Largest file accepted from a user (also Telegram's bot download limit). */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
/** Images are shown to vision models inline; keep that part small (the file is still saved either way). */
export const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;
export const INLINE_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

export interface SavedAttachment {
  name: string;
  mimeType: string;
  size: number;
  /** Absolute path on the server. */
  path: string;
}

export const safeName = (name: string): string =>
  path.basename(name).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '').slice(-80) || 'file';

export const humanSize = (n: number): string =>
  n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

/** Saves `buffer` as `<dir>/<timestamp>-<random>-<safe name>` and describes it. The folder is created if needed. */
export async function saveAttachment(opts: { dir: string; name: string; mimeType: string; buffer: Buffer }): Promise<SavedAttachment> {
  if (opts.buffer.length > MAX_ATTACHMENT_BYTES) throw new Error(`"${opts.name}" is larger than ${humanSize(MAX_ATTACHMENT_BYTES)}.`);
  await fs.mkdir(opts.dir, { recursive: true });
  const file = path.join(opts.dir, `${Date.now()}-${crypto.randomBytes(3).toString('hex')}-${safeName(opts.name)}`);
  await fs.writeFile(file, opts.buffer, { mode: 0o600 });
  return { name: opts.name, mimeType: opts.mimeType, size: opts.buffer.length, path: file };
}

/** The image as an inline part for vision models, or undefined when it is not a small common image type. */
export function toInlineImage(att: SavedAttachment, buffer: Buffer): LLMImage | undefined {
  return INLINE_IMAGE_TYPES.has(att.mimeType) && buffer.length <= MAX_INLINE_IMAGE_BYTES
    ? { mimeType: att.mimeType, base64: buffer.toString('base64') }
    : undefined;
}

const NOTE_HEADER = '[Attachments from the user, saved on the server. If you cannot see them directly, use your tools (filesystem, terminal, skills) to open and read them.]';

/** The message the agent receives: the user's words (or a default) followed by a machine-readable attachment note. */
export function messageWithAttachments(text: string, files: SavedAttachment[]): string {
  if (!files.length) return text;
  const body = text.trim() || (files.every((f) => f.mimeType.startsWith('image/'))
    ? (files.length > 1 ? 'The user sent images without any message.' : 'The user sent an image without any message.')
    : (files.length > 1 ? 'The user sent attachments without any message.' : 'The user sent a file without any message.'));
  return [body, '', NOTE_HEADER, ...files.map((f) => `- ${f.name} (${f.mimeType}, ${humanSize(f.size)}): ${f.path}`)].join('\n');
}

/** Inverse of messageWithAttachments, for showing history: the user's text and the attached files, without the note. */
export function splitAttachmentNote(content: string): { text: string; files: Array<{ name: string; mimeType: string; size: string; path: string }> } {
  const i = content.indexOf(`\n\n${NOTE_HEADER}\n`);
  if (i < 0) return { text: content, files: [] };
  const files = content.slice(i + NOTE_HEADER.length + 3).split('\n').flatMap((line) => {
    const m = /^- (.+) \(([^,()]+), ([^)]+)\): (.+)$/.exec(line);
    return m ? [{ name: m[1], mimeType: m[2], size: m[3], path: m[4] }] : [];
  });
  return { text: content.slice(0, i), files };
}
