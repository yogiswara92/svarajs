/**
 * @module core/trace
 * What happened in one agent turn, step by step: context lookups, every model call (with the text the model wrote
 * before calling tools, and its reasoning when the provider returns it), every tool call with its arguments, result
 * and duration. Streamed while the turn runs and saved with the reply, so a person can audit how an answer came about.
 *
 * Only what actually happened is recorded; nothing is reconstructed. Long values are clipped.
 */

const PREVIEW = 700;
const MAX_STEPS = 60;

export function clip(value: unknown, n = PREVIEW): string {
  let s: string;
  if (typeof value === 'string') s = value;
  else {
    try { s = JSON.stringify(value) ?? ''; } catch { s = String(value); }
  }
  return s.length > n ? `${s.slice(0, n)} ... (+${s.length - n} chars)` : s;
}

export type TraceStepType = 'context' | 'llm' | 'tool';

export interface TraceStep {
  id: number;
  type: TraceStepType;
  name: string;
  iteration?: number;
  /** Milliseconds from the start of the turn. */
  offsetMs: number;
  ms?: number;
  status: 'running' | 'done' | 'error';
  error?: string;
  /** llm: text the model wrote alongside its tool calls (its plan), and provider reasoning if any. */
  thinking?: string;
  reasoning?: string;
  tools?: string[];
  usage?: { promptTokens: number; completionTokens: number };
  /** tool: arguments and result preview. */
  args?: string;
  result?: string;
  /** context: what was found. */
  items?: Array<{ title: string; excerpt?: string; score?: number; link?: string }>;
  note?: string;
}

export interface TurnTrace {
  model: string;
  origin?: string;
  question: string;
  startedAt: string;
  totalMs: number;
  steps: TraceStep[];
  summary: { llmCalls: number; toolCalls: number; promptTokens: number; completionTokens: number; errors: number };
}

type Listener = (phase: 'start' | 'end' | 'remove', step: TraceStep) => void;

export class TraceRecorder {
  private readonly started = Date.now();
  private seq = 0;
  readonly steps: TraceStep[] = [];

  constructor(private readonly meta: { model: string; origin?: string; question: string }, private readonly listener?: Listener) {}

  start(type: TraceStepType, name: string, data: Partial<TraceStep> = {}): TraceStep {
    const step: TraceStep = { id: ++this.seq, type, name, offsetMs: Date.now() - this.started, status: 'running', ...data };
    if (this.steps.length < MAX_STEPS) this.steps.push(step);
    this.emit('start', step);
    return step;
  }

  end(step: TraceStep, extra: Partial<TraceStep> = {}): void {
    Object.assign(step, extra);
    step.ms = Date.now() - this.started - step.offsetMs;
    if (step.status === 'running') step.status = step.error ? 'error' : 'done';
    this.emit('end', step);
  }

  /** Drops a step that turned out not to matter (e.g. a lookup that was skipped). */
  remove(step: TraceStep): void {
    const i = this.steps.indexOf(step);
    if (i !== -1) this.steps.splice(i, 1);
    this.emit('remove', step);
  }

  private emit(phase: 'start' | 'end' | 'remove', step: TraceStep): void {
    try { this.listener?.(phase, { ...step }); } catch { /* a listener must never break the turn */ }
  }

  finish(): TurnTrace {
    const s = { llmCalls: 0, toolCalls: 0, promptTokens: 0, completionTokens: 0, errors: 0 };
    for (const st of this.steps) {
      if (st.type === 'llm') {
        s.llmCalls++;
        s.promptTokens += st.usage?.promptTokens ?? 0;
        s.completionTokens += st.usage?.completionTokens ?? 0;
      }
      if (st.type === 'tool') s.toolCalls++;
      if (st.status === 'error') s.errors++;
    }
    return {
      model: this.meta.model,
      origin: this.meta.origin,
      question: clip(this.meta.question, 500),
      startedAt: new Date(this.started).toISOString(),
      totalMs: Date.now() - this.started,
      steps: this.steps,
      summary: s,
    };
  }
}
