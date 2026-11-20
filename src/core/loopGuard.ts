/**
 * @module core/loopGuard
 * SvaraJS - keeping a long tool-calling turn healthy
 *
 * A turn that browses the web or works through many files can make dozens of tool calls. Left alone, two things go
 * wrong: the conversation fills with old tool output (a page listing can be 60k characters) until the model's context
 * is gone long before the step limit, and a model that is stuck calls the same tool again and again. This module trims
 * what the model no longer needs and spots calls that go nowhere.
 */

import type { LLMMessage } from './types.js';

export interface PruneOptions {
  /** Newest tool results kept whole. @default 4 */
  keepRecent?: number;
  /** Older results longer than this are cut down. @default 2000 */
  maxOld?: number;
  /** What an old result is cut down to. @default 600 */
  keepChars?: number;
}

// A browser page listing is replaced by the next one: only the latest is worth keeping whole
const SUPERSEDED = /browser_(open|snapshot|click|type|select|press|scroll|back|wait)\b/;

const CUT_MARK = 'of this earlier tool result were dropped to save space';

function cut(text: string, keep: number): string {
  // a result already cut down in an earlier round stays as it is
  if (text.length <= keep || text.includes(CUT_MARK)) return text;
  return `${text.slice(0, keep)}\n[...${text.length - keep} more characters ${CUT_MARK}. Call the tool again if you still need them.]`;
}

/**
 * Cuts down tool results the model has already moved past. Returns the same array (changed in place) so the loop can
 * keep pushing to it; the caller's saved history is built elsewhere and is not affected.
 */
export function pruneToolResults(messages: LLMMessage[], opts: PruneOptions = {}): LLMMessage[] {
  const keepRecent = opts.keepRecent ?? 4;
  const maxOld = opts.maxOld ?? 2000;
  const keepChars = opts.keepChars ?? 600;

  let recent = 0;
  let lastPage = true;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'tool' || typeof m.content !== 'string') continue;
    const page = SUPERSEDED.test(m.name || '');
    if (page) {
      // the newest page listing stays whole, every older one is a stale picture of the site
      if (lastPage) { lastPage = false; recent++; continue; }
      if (m.content.length > 500) messages[i] = { ...m, content: cut(m.content, 400) };
      recent++;
      continue;
    }
    recent++;
    if (recent <= keepRecent) continue;
    if (m.content.length > maxOld) messages[i] = { ...m, content: cut(m.content, keepChars) };
  }
  return messages;
}

function fnv(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return `${text.length}:${(h >>> 0).toString(36)}`;
}

export type RepeatVerdict = 'ok' | 'warn' | 'stop';

/**
 * Watches for the same call returning the same result again and again. A tool called with the same arguments is fine
 * when the world changed in between (a page after a click); it is a loop when the answer never changes.
 */
export class RepeatGuard {
  private seen = new Map<string, { hash: string; same: number }>();

  constructor(
    /** Identical call + identical result this many times in a row: tell the model to do something else. @default 2 */
    private warnAfter = 2,
    /** ... and this many: end the turn. @default 4 */
    private stopAfter = 4,
  ) {}

  record(name: string, args: unknown, result: string): { verdict: RepeatVerdict; repeats: number } {
    const key = `${name}\n${typeof args === 'string' ? args : JSON.stringify(args ?? {})}`;
    const hash = fnv(result);
    const have = this.seen.get(key);
    if (have && have.hash === hash) have.same += 1;
    else this.seen.set(key, { hash, same: 0 });
    const same = this.seen.get(key)!.same;
    return { verdict: same >= this.stopAfter ? 'stop' : same >= this.warnAfter ? 'warn' : 'ok', repeats: same + 1 };
  }
}

export type StopReason = 'steps' | 'time' | 'loop';

/** The instruction for the last model call of a turn that had to stop early. */
export function wrapUpPrompt(reason: StopReason, steps: number): string {
  const why = reason === 'steps'
    ? `reached its limit of ${steps} steps`
    : reason === 'time'
      ? 'used up the time allowed for one request'
      : 'been calling the same tool over and over without getting anywhere new';
  return [
    `[System notice] This request has ${why}, so you cannot use any more tools now.`,
    'Write a short progress report for the user, in the language they wrote in:',
    '1. What you did and found so far. Be concrete and keep the useful details (names, numbers, links, file names) because they are the only thing you will remember.',
    '2. What is still left to do.',
    '3. End by asking whether they want you to continue from there.',
    'Do not apologise at length and do not call tools.',
  ].join('\n');
}

/** Used only if the wrap-up model call itself fails. */
export function fallbackStop(reason: StopReason, steps: number, tools: string[]): string {
  const used = [...new Set(tools)].slice(0, 8).join(', ');
  const why = reason === 'steps' ? `I reached the limit of ${steps} steps` : reason === 'time' ? 'I ran out of the time allowed for one request' : 'I got stuck repeating the same step';
  return `${why} before finishing${used ? ` (tools used: ${used})` : ''}. Tell me to continue and I will pick up from here.`;
}
