import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { BackgroundReview } from '../memory/backgroundReview.js';
import { LearningMemory } from '../memory/learningFiles.js';
import { SkillRegistry } from '../skills/registry.js';
import type { LLMAdapter } from '../core/llm.js';
import type { LLMResponse } from '../core/types.js';

function textResponse(content: string): LLMResponse {
  return { content, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, model: 'fake', finishReason: 'stop' };
}

function toolCallResponse(name: string, args: Record<string, unknown>): LLMResponse {
  return {
    content: '',
    toolCalls: [{ id: 'call-1', name, arguments: args }],
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    model: 'fake',
    finishReason: 'tool_calls',
  };
}

function fakeAdapter(...responses: LLMResponse[]): LLMAdapter {
  const chat = vi.fn();
  responses.forEach((r) => chat.mockResolvedValueOnce(r));
  return { chat, countTokens: (t: string) => Math.ceil(t.length / 4) };
}

/**
 * `reviewAsync()` is genuinely fire-and-forget (no promise exposed), so
 * tests poll for the expected side effect instead of a fixed delay - a
 * fixed sleep is flaky under load (e.g. the full suite running in
 * parallel), where a background pass can take longer than a few ms.
 */
async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
}

describe('BackgroundReview', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'svara-review-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('does nothing (no LLM call) when neither memory nor skills are configured', async () => {
    const adapter = fakeAdapter(textResponse('should never be called'));
    const review = new BackgroundReview({ adapter });
    review.reviewAsync({ sessionId: 's1', userMessage: 'hi', assistantResponse: 'hello' });
    await new Promise((r) => setTimeout(r, 20));
    expect(adapter.chat).not.toHaveBeenCalled();
  });

  it('does nothing when the model calls no tools', async () => {
    const adapter = fakeAdapter(textResponse('nothing worth saving'));
    const memory = new LearningMemory({ dir });
    const review = new BackgroundReview({ adapter, memory });
    review.reviewAsync({ sessionId: 's1', userMessage: 'hi', assistantResponse: 'hello' });
    await waitFor(() => (adapter.chat as ReturnType<typeof vi.fn>).mock.calls.length >= 1);
    const snapshot = await memory.load();
    expect(snapshot.agent).toBe('');
    expect(adapter.chat).toHaveBeenCalledTimes(1);
  });

  it('writes a memory entry when the model decides to call the memory tool', async () => {
    const adapter = fakeAdapter(
      toolCallResponse('memory', { action: 'add', target: 'user', entry: 'prefers dark mode' }),
      textResponse('done')
    );
    const memory = new LearningMemory({ dir });
    const review = new BackgroundReview({ adapter, memory });
    review.reviewAsync({ sessionId: 's1', userMessage: 'I prefer dark mode', assistantResponse: 'Noted!' });
    await waitFor(async () => {
      memory.reload();
      return (await memory.load()).user.includes('prefers dark mode');
    });
  });

  it('creates a skill when the model decides to call skill_manage', async () => {
    const adapter = fakeAdapter(
      toolCallResponse('skill_manage', {
        action: 'create', id: 'deploy-flow', name: 'Deploy Flow',
        description: 'How to deploy', instructions: 'Run npm run deploy.',
      }),
      textResponse('done')
    );
    const skillRegistry = new SkillRegistry({ skillsDir: dir });
    const review = new BackgroundReview({ adapter, skillRegistry });
    review.reviewAsync({ sessionId: 's1', userMessage: 'how do I deploy?', assistantResponse: 'Run npm run deploy.' });
    await waitFor(async () => {
      await skillRegistry.scan();
      return (await skillRegistry.get('deploy-flow')) !== undefined;
    });
    const skill = await skillRegistry.get('deploy-flow');
    expect(skill?.name).toBe('Deploy Flow');
  });

  it('stops after maxIterations even if the model keeps calling tools', async () => {
    const adapter = fakeAdapter(
      toolCallResponse('memory', { action: 'add', target: 'agent', entry: 'entry one' }),
      toolCallResponse('memory', { action: 'add', target: 'agent', entry: 'entry two' }),
      toolCallResponse('memory', { action: 'add', target: 'agent', entry: 'entry three' }),
      toolCallResponse('memory', { action: 'add', target: 'agent', entry: 'entry four' })
    );
    const memory = new LearningMemory({ dir });
    const review = new BackgroundReview({ adapter, memory, maxIterations: 2 });
    review.reviewAsync({ sessionId: 's1', userMessage: 'x', assistantResponse: 'y' });
    await waitFor(() => (adapter.chat as ReturnType<typeof vi.fn>).mock.calls.length >= 2);
    await new Promise((r) => setTimeout(r, 20)); // give a would-be 3rd call a chance to happen before asserting it didn't
    expect(adapter.chat).toHaveBeenCalledTimes(2);
  });

  it('reviewAsync never throws, even if the adapter rejects', async () => {
    const adapter: LLMAdapter = {
      chat: vi.fn().mockRejectedValue(new Error('LLM unavailable')),
      countTokens: (t: string) => t.length,
    };
    const memory = new LearningMemory({ dir });
    const review = new BackgroundReview({ adapter, memory });
    expect(() => review.reviewAsync({ sessionId: 's1', userMessage: 'x', assistantResponse: 'y' })).not.toThrow();
    await waitFor(() => (adapter.chat as ReturnType<typeof vi.fn>).mock.calls.length >= 1);
  });
});
