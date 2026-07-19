import { describe, it, expect, vi } from 'vitest';
import { ContextCompressor } from '../memory/compressor.js';
import type { LLMAdapter } from '../core/llm.js';
import type { LLMMessage } from '../core/types.js';

function fakeAdapter(summaryText = 'Summary of earlier turns.'): LLMAdapter {
  return {
    chat: vi.fn(async () => ({
      content: summaryText,
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      model: 'fake',
      finishReason: 'stop' as const,
    })),
    countTokens: (text: string) => Math.ceil(text.length / 4),
  };
}

function msg(role: LLMMessage['role'], content: string): LLMMessage {
  return { role, content };
}

describe('ContextCompressor', () => {
  it('returns messages unchanged when under budget', async () => {
    const llm = fakeAdapter();
    const compressor = new ContextCompressor(llm, undefined, { contextWindow: 10_000 });
    const messages = [msg('system', 'sys'), msg('user', 'hi'), msg('assistant', 'hello')];
    const result = await compressor.maybeCompress(messages);
    expect(result).toBe(messages);
    expect(llm.chat).not.toHaveBeenCalled();
  });

  it('summarizes the middle once the budget is exceeded, protecting head and tail', async () => {
    const llm = fakeAdapter('COMPACTED');
    const compressor = new ContextCompressor(llm, undefined, {
      contextWindow: 50,
      thresholdPercent: 0.5,
      protectFirstN: 1,
      protectLastN: 1,
    });

    const messages = [
      msg('system', 'sys'),
      msg('user', 'first user turn, kept verbatim'),
      msg('assistant', 'middle turn one '.repeat(20)),
      msg('user', 'middle turn two '.repeat(20)),
      msg('assistant', 'last turn, kept verbatim'),
    ];

    const result = await compressor.maybeCompress(messages);
    expect(llm.chat).toHaveBeenCalledOnce();
    expect(result[0]).toEqual(messages[0]); // system preserved
    expect(result[1]).toEqual(messages[1]); // protectFirstN=1
    expect(result[result.length - 1]).toEqual(messages[messages.length - 1]); // protectLastN=1
    const summaryMsg = result.find((m) => m.content.includes('COMPACTED'));
    expect(summaryMsg).toBeDefined();
    expect(summaryMsg!.content).toMatch(/REFERENCE ONLY/);
  });

  it('prefers the auxiliary model over the main model for summarization', async () => {
    const main = fakeAdapter('from-main');
    const aux = fakeAdapter('from-aux');
    const compressor = new ContextCompressor(main, aux, {
      contextWindow: 10,
      thresholdPercent: 0.5,
      protectFirstN: 0,
      protectLastN: 0,
    });
    const messages = [msg('user', 'x'.repeat(200))];
    const result = await compressor.maybeCompress(messages);
    expect(aux.chat).toHaveBeenCalledOnce();
    expect(main.chat).not.toHaveBeenCalled();
    expect(result.some((m) => m.content.includes('from-aux'))).toBe(true);
  });
});
