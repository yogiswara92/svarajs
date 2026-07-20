/**
 * @module channels/telegramFormat
 * SvaraJS - converts the GFM markdown an LLM naturally produces (headers,
 * tables, **bold**) into something Telegram's legacy `parse_mode: 'Markdown'`
 * can actually render.
 *
 * Telegram's Bot API formatting is a small, fixed set of inline entities -
 * bold, italic, code, links - with no equivalent for block-level headers or
 * grid tables in any parse mode. Left unconverted, `#`/`##` and `|...|`
 * aren't recognized as syntax at all and show up as literal characters.
 * GFM's `**bold**` is a separate problem: Telegram's legacy mode uses a
 * single `*bold*` (double-star just shows as literal asterisks).
 */

function isTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('|') && trimmed.endsWith('|') && trimmed.length > 1;
}

function isTableSeparator(line: string): boolean {
  const trimmed = line.trim();
  return isTableRow(trimmed) && /^\|[\s:|-]+\|$/.test(trimmed);
}

function parseTableRow(line: string): string[] {
  return line.trim().slice(1, -1).split('|').map((cell) => cell.trim());
}

/** Converts a GFM table into a monospace `pre` block with columns padded to equal width - Telegram has no native table syntax, but a fixed-width font is enough to read as an aligned grid. */
function renderTable(headers: string[], rows: string[][]): string[] {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length))
  );
  const renderRow = (cells: string[]): string =>
    cells.map((c, i) => (c ?? '').padEnd(widths[i])).join(' | ').trimEnd();

  const out: string[] = ['```'];
  out.push(renderRow(headers));
  out.push(widths.map((w) => '-'.repeat(w)).join('-+-'));
  for (const row of rows) out.push(renderRow(row));
  out.push('```');
  return out;
}

export function toTelegramMarkdown(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (isTableRow(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const headers = parseTableRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && isTableRow(lines[i])) {
        rows.push(parseTableRow(lines[i]));
        i++;
      }
      out.push(...renderTable(headers, rows));
      continue;
    }

    const headerMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headerMatch) {
      out.push(`*${headerMatch[2].trim()}*`);
      i++;
      continue;
    }

    out.push(line);
    i++;
  }

  return out.join('\n')
    // GFM **bold**/__bold__ -> Telegram's single-star *bold*. Leaves plain
    // single-star/underscore text alone - it already reads as Telegram
    // bold/italic, close enough without a full markdown tokenizer.
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/__(.+?)__/g, '*$1*')
    // GFM ~~strikethrough~~ has no legacy-Markdown equivalent - drop the
    // markers rather than leave them as literal tildes.
    .replace(/~~(.+?)~~/g, '$1');
}

/** Strips every character `parse_mode: 'Markdown'` treats as syntax - last-resort fallback when even the converted text still fails to parse (e.g. a stray unbalanced marker Telegram rejects), so the user gets a readable plain-text answer instead of a silent "something went wrong". */
export function stripMarkdown(text: string): string {
  return text.replace(/[*_`[\]]/g, '');
}
