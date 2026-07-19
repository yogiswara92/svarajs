/**
 * @module security/approvalQueue
 * SvaraJS - pending approval queue
 *
 * Bridges `ApprovalGate`'s `onApprovalNeeded` callback (which blocks a tool
 * call until it resolves) to a UI that can only respond asynchronously -
 * the standalone runtime's dashboard. A tool call parks itself here and
 * waits; the dashboard lists pending entries and calls `respond()`.
 */

export interface PendingApproval {
  id: string;
  command: string;
  reason: string;
  createdAt: string;
}

interface QueueEntry extends PendingApproval {
  resolve: (approved: boolean) => void;
}

export class ApprovalQueue {
  private pending: Map<string, QueueEntry> = new Map();

  /** Called by an ApprovalGate as its `onApprovalNeeded` - resolves once `respond()` is called. */
  request(command: string, reason: string): Promise<boolean> {
    return new Promise((resolve) => {
      const id = crypto.randomUUID();
      this.pending.set(id, {
        id,
        command,
        reason,
        createdAt: new Date().toISOString(),
        resolve: (approved: boolean) => {
          this.pending.delete(id);
          resolve(approved);
        },
      });
    });
  }

  list(): PendingApproval[] {
    return [...this.pending.values()].map(({ resolve: _resolve, ...entry }) => entry);
  }

  /** Resolve a pending request. Returns false if the id is unknown (already resolved or never existed). */
  respond(id: string, approved: boolean): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    entry.resolve(approved);
    return true;
  }
}
