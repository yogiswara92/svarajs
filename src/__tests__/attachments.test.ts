import { describe, it, expect, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { saveAttachment, safeName, toInlineImage, messageWithAttachments, splitAttachmentNote, MAX_ATTACHMENT_BYTES } from '../channels/attachments.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'svara-att-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('attachments', () => {
  it('sanitises names so they cannot escape the folder', () => {
    expect(safeName('../../etc/passwd')).toBe('passwd');
    expect(safeName('Laporan Q3 (final).pdf')).toBe('Laporan_Q3_final_.pdf');
    expect(safeName('...')).toBe('file');
    expect(safeName('x'.repeat(200)).length).toBe(80);
  });

  it('saves privately under the given folder with unique names', async () => {
    const a = await saveAttachment({ dir: path.join(tmp, 'c1'), name: 'a.txt', mimeType: 'text/plain', buffer: Buffer.from('one') });
    const b = await saveAttachment({ dir: path.join(tmp, 'c1'), name: 'a.txt', mimeType: 'text/plain', buffer: Buffer.from('two') });
    expect(a.path).not.toBe(b.path);
    expect(fs.readFileSync(a.path, 'utf-8')).toBe('one');
    expect(fs.statSync(a.path).mode & 0o077).toBe(0);
    expect(path.dirname(a.path)).toBe(path.join(tmp, 'c1'));
  });

  it('rejects files over the limit', async () => {
    await expect(saveAttachment({ dir: tmp, name: 'big.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(MAX_ATTACHMENT_BYTES + 1) })).rejects.toThrow(/larger than/);
  });

  it('inlines only small common image types', () => {
    const png = { name: 'a.png', mimeType: 'image/png', size: 3, path: '/x' };
    expect(toInlineImage(png, Buffer.from('abc'))).toEqual({ mimeType: 'image/png', base64: Buffer.from('abc').toString('base64') });
    expect(toInlineImage({ ...png, mimeType: 'image/tiff' }, Buffer.from('abc'))).toBeUndefined();
    expect(toInlineImage({ ...png, mimeType: 'application/pdf' }, Buffer.from('abc'))).toBeUndefined();
    expect(toInlineImage(png, Buffer.alloc(6 * 1024 * 1024))).toBeUndefined();
  });

  it('builds the note and reads it back for display', () => {
    const files = [
      { name: 'foto kedai.png', mimeType: 'image/png', size: 2048, path: '/srv/uploads/web/s1/1-ab-foto_kedai.png' },
      { name: 'laporan.pdf', mimeType: 'application/pdf', size: 3 * 1024 * 1024, path: '/srv/uploads/web/s1/2-cd-laporan.pdf' },
    ];
    const msg = messageWithAttachments('tolong cek', files);
    expect(msg).toMatch(/^tolong cek\n\n\[Attachments from the user/);
    expect(msg).toContain('- foto kedai.png (image/png, 2 KB): /srv/uploads/web/s1/1-ab-foto_kedai.png');
    const back = splitAttachmentNote(msg);
    expect(back.text).toBe('tolong cek');
    expect(back.files.map((f) => [f.name, f.mimeType, f.size, f.path])).toEqual([
      ['foto kedai.png', 'image/png', '2 KB', '/srv/uploads/web/s1/1-ab-foto_kedai.png'],
      ['laporan.pdf', 'application/pdf', '3.0 MB', '/srv/uploads/web/s1/2-cd-laporan.pdf'],
    ]);
  });

  it('has sensible default text and leaves plain messages alone', () => {
    const img = [{ name: 'a.png', mimeType: 'image/png', size: 1, path: '/p' }];
    expect(messageWithAttachments('', img)).toMatch(/^The user sent an image without any message\./);
    expect(messageWithAttachments('  ', [...img, ...img])).toMatch(/^The user sent images without any message\./);
    expect(messageWithAttachments('', [{ ...img[0], mimeType: 'application/pdf' }])).toMatch(/^The user sent a file without any message\./);
    expect(messageWithAttachments('halo', [])).toBe('halo');
    expect(splitAttachmentNote('halo biasa')).toEqual({ text: 'halo biasa', files: [] });
  });
});
