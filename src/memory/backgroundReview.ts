/**
 * @module memory/backgroundReview
 * SvaraJS - autonomous "should I remember this?" pass.
 *
 * After a turn finishes and the response has already gone back to the user,
 * a fire-and-forget background pass replays the exchange through a
 * (typically cheaper) model with only the `memory` and skill tools
 * available, and lets it decide on its own whether anything is worth
 * persisting. This is what makes memory/skill-writing feel automatic
 * instead of requiring the user to explicitly ask "remember this."
 *
 * Deliberately lean: no separate thread/process isolation (Node is
 * single-threaded anyway), no prompt-cache-preserving fork - just an
 * un-awaited async call that logs its own errors instead of throwing them
 * into the main conversation flow. Off by default.
 */

import type { LLMAdapter } from '../core/llm.js';
import type { InternalAgentContext, InternalTool, LLMMessage } from '../core/types.js';
import type { Tool } from '../types.js';
import { createMemoryTool } from './learningTools.js';
import { createSkillTools, type SkillToolsOptions } from '../skills/tools.js';
import { selectRelevantNotes, type LearningMemory } from './learningFiles.js';
import type { SkillRegistry } from '../skills/registry.js';

export interface BackgroundReviewOptions {
  adapter: LLMAdapter;
  memory?: LearningMemory | null;
  skillRegistry?: SkillRegistry | null;
  skillsGuard?: SkillToolsOptions;
  /** Cap on tool-calling rounds for a single review pass. @default 3 */
  maxIterations?: number;
}

export interface ReviewExchange {
  sessionId: string;
  userMessage: string;
  assistantResponse: string;
}

const REVIEW_SYSTEM_PROMPT = [
  'You just finished responding to a user in a live conversation. This is a silent background',
  'pass, not part of that conversation - the user will not see anything you do here.',
  '',
  'Decide whether anything from the exchange below is worth persisting:',
  '- A fact about the user, their preferences, or how they like to work -> memory tool, target "user".',
  '- A fact about the environment/project/conventions you\'ll want to remember later -> memory tool, target "agent".',
  '- A reusable step-by-step approach that worked and would help with similar future requests -> skill_manage (create).',
  '',
  'Most exchanges have nothing worth saving - in that case, call no tools at all. Do not save',
  'transient details (the specific question asked, one-off facts) or anything already obviously',
  'covered by an existing skill. Be selective; a memory/skill file that accumulates noise stops being useful.',
  '',
  'If "Possibly-related existing notes" is shown below, check it first - if the fact is already',
  'captured there (even worded differently), do not add it again. Use the memory tool\'s "replace"',
  'action instead of "add" if this exchange refines or corrects one of those existing notes.',
].join('\n');

function toInternalTool(tool: Tool): InternalTool {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters ?? {},
    run: tool.run,
    category: tool.category,
    timeout: tool.timeout,
  };
}

export class BackgroundReview {
  constructor(private opts: BackgroundReviewOptions) {}

  /** Fire-and-forget entry point - never throws, logs failures instead. */
  reviewAsync(exchange: ReviewExchange): void {
    void this.review(exchange).catch((err) => {
      console.error(`[@yesvara/svara] background review failed: ${(err as Error).message}`);
    });
  }

  private async review(exchange: ReviewExchange): Promise<void> {
    const tools = this.buildTools();
    if (tools.length === 0) return; // nothing to save to (no memory, no skills)

    const ctx: InternalAgentContext = {
      sessionId: exchange.sessionId,
      userId: 'background-review',
      agentName: 'background-review',
      history: [],
      metadata: {},
    };

    const existingNotesBlock = await this.describeExistingNotes(exchange);
    const messages: LLMMessage[] = [
      { role: 'system', content: REVIEW_SYSTEM_PROMPT },
      {
        role: 'user',
        content: existingNotesBlock
          ? `${existingNotesBlock}\n\n---\n\nUser: ${exchange.userMessage}\n\nAssistant: ${exchange.assistantResponse}`
          : `User: ${exchange.userMessage}\n\nAssistant: ${exchange.assistantResponse}`,
      },
    ];

    const maxIterations = this.opts.maxIterations ?? 3;
    for (let i = 0; i < maxIterations; i++) {
      const response = await this.opts.adapter.chat(messages, tools, 0.3);
      if (!response.toolCalls?.length) return;

      messages.push({ role: 'assistant', content: response.content, toolCalls: response.toolCalls });

      for (const call of response.toolCalls) {
        const tool = tools.find((t) => t.name === call.name);
        const content = tool
          ? await tool.run(call.arguments, ctx).then((r) => JSON.stringify(r)).catch((err) => `Error: ${(err as Error).message}`)
          : `Error: unknown tool "${call.name}"`;
        messages.push({ role: 'tool', content, toolCallId: call.id, name: call.name });
      }
    }
  }

  /**
   * Without this, the review pass decides whether to save purely from the
   * current exchange - it has no way to know a near-identical fact was
   * already saved last turn, so a recurring topic (the same project, the
   * same recurring instruction) gets re-saved as a fresh near-duplicate
   * entry every single time. Showing it the entries most relevant to this
   * exchange lets it skip re-saving (or use "replace" instead of "add")
   * when appropriate - see the dedup note in learningFiles.ts's add() for
   * the storage-layer half of this fix.
   */
  private async describeExistingNotes(exchange: ReviewExchange): Promise<string> {
    if (!this.opts.memory) return '';
    const { agent, user } = await this.opts.memory.load();
    const query = `${exchange.userMessage} ${exchange.assistantResponse}`;
    const parts = [
      agent && `Agent notes (MEMORY.md):\n${selectRelevantNotes(agent, query)}`,
      user && `User notes (USER.md):\n${selectRelevantNotes(user, query)}`,
    ].filter(Boolean);
    return parts.length === 0 ? '' : `Possibly-related existing notes:\n\n${parts.join('\n\n')}`;
  }

  private buildTools(): InternalTool[] {
    const tools: InternalTool[] = [];
    if (this.opts.memory) {
      tools.push(toInternalTool(createMemoryTool(this.opts.memory)));
    }
    if (this.opts.skillRegistry) {
      // skills_list/skill_view are read-only noise for a write-only review pass - only offer skill_manage.
      const [, , skillManage] = createSkillTools(this.opts.skillRegistry, this.opts.skillsGuard);
      tools.push(toInternalTool(skillManage));
    }
    return tools;
  }
}
