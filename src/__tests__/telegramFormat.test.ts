import { describe, it, expect } from 'vitest';
import { toTelegramMarkdown, stripMarkdown } from '../channels/telegramFormat.js';

describe('toTelegramMarkdown', () => {
  it('converts a header into a bold line', () => {
    expect(toTelegramMarkdown('## Section title\nbody text')).toBe('*Section title*\nbody text');
  });

  it('converts GFM **bold** and __bold__ into Telegram single-star bold', () => {
    expect(toTelegramMarkdown('This is **important** and __also this__.'))
      .toBe('This is *important* and *also this*.');
  });

  it('drops GFM ~~strikethrough~~ markers, keeping the text', () => {
    expect(toTelegramMarkdown('~~old price~~ new price')).toBe('old price new price');
  });

  it('converts a two-column table into one bold-label line per row', () => {
    const table = [
      '| Paket | Harga |',
      '|---|---|',
      '| 1 Bulan | Rp 500.000 |',
      '| 6 Bulan | Rp 2.700.000 - Paling Populer |',
    ].join('\n');
    expect(toTelegramMarkdown(table)).toBe(
      '*1 Bulan:* Rp 500.000\n*6 Bulan:* Rp 2.700.000 - Paling Populer'
    );
  });

  it('converts a wider table into one header:value block per row', () => {
    const table = [
      '| Model | Provider | Env key |',
      '|---|---|---|',
      '| gpt-4o | OpenAI | OPENAI_API_KEY |',
    ].join('\n');
    expect(toTelegramMarkdown(table)).toBe('*Model:* gpt-4o\n*Provider:* OpenAI\n*Env key:* OPENAI_API_KEY\n');
  });

  it('leaves plain text and non-table pipes untouched', () => {
    expect(toTelegramMarkdown('a | b is not a table')).toBe('a | b is not a table');
  });

  it('handles the mixed header+table shape from a real broken reply', () => {
    const input = [
      '## LIBRA Club',
      '**3 Paket Langganan (full akses semua fitur):**',
      '',
      '| Paket | Harga |',
      '|---|---|',
      '| 1 Bulan | Rp 500.000 |',
      '| 1 Tahun | Rp 4.800.000 - Termurah/bulan |',
    ].join('\n');
    const result = toTelegramMarkdown(input);
    expect(result).toContain('*LIBRA Club*');
    expect(result).toContain('*3 Paket Langganan (full akses semua fitur):*');
    expect(result).toContain('*1 Bulan:* Rp 500.000');
    expect(result).toContain('*1 Tahun:* Rp 4.800.000 - Termurah/bulan');
    expect(result).not.toContain('|');
    expect(result).not.toContain('##');
  });
});

describe('stripMarkdown', () => {
  it('removes bold/italic/code/link-bracket markers', () => {
    expect(stripMarkdown('*bold* _italic_ `code` [text]')).toBe('bold italic code text');
  });
});
