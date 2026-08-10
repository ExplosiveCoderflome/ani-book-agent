export type WorkbenchEventType =
  | "run.started"
  | "step.started"
  | "step.completed"
  | "artifact.proposed"
  | "approval.required"
  | "artifact.committed"
  | "run.failed"
  | "run.completed";

export interface WorkbenchEvent {
  id: number;
  type: WorkbenchEventType;
  at: string;
  data: Record<string, unknown>;
}

export class RunEventHub {
  private readonly history = new Map<string, WorkbenchEvent[]>();
  private readonly listeners = new Map<string, Set<(event: WorkbenchEvent) => void>>();

  constructor(private readonly heartbeatMs = 15_000) {}

  publish(runId: string, type: WorkbenchEventType, data: Record<string, unknown> = {}) {
    const events = this.history.get(runId) ?? [];
    const event = { id: (events.at(-1)?.id ?? 0) + 1, type, at: new Date().toISOString(), data };
    events.push(event);
    this.history.set(runId, events.slice(-100));
    this.listeners.get(runId)?.forEach((listener) => listener(event));
  }

  stream(runId: string, signal: AbortSignal): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    let cleanup = () => undefined;
    return new ReadableStream({
      start: (controller) => {
        let closed = false;
        let heartbeat: ReturnType<typeof setInterval> | undefined;
        const enqueue = (value: string) => {
          if (closed) return false;
          try { controller.enqueue(encoder.encode(value)); return true; }
          catch { cleanup(); return false; }
        };
        const send = (event: WorkbenchEvent) => { enqueue(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`); };
        enqueue("retry: 2000\n\n");
        this.history.get(runId)?.forEach(send);
        const listeners = this.listeners.get(runId) ?? new Set();
        listeners.add(send);
        this.listeners.set(runId, listeners);
        cleanup = () => {
          if (closed) return;
          closed = true;
          if (heartbeat) clearInterval(heartbeat);
          listeners.delete(send);
          try { controller.close(); } catch { /* already closed */ }
        };
        heartbeat = setInterval(() => { enqueue(": keep-alive\n\n"); }, this.heartbeatMs);
        signal.addEventListener("abort", cleanup, { once: true });
      },
      cancel: () => cleanup(),
    });
  }
}

export const runEvents = new RunEventHub();
