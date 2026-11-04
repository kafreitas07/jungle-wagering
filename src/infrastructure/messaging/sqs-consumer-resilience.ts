/**
 * Time to hide a message after a transient failure: min(2^receiveCount · 2 s, 60 s).
 * First failure 4 s, then 8, 16, 32 and 60. The FIFO group of a failing message is blocked meanwhile, so the cap
 * keeps one bad message from holding a wallet's queue for long.
 */
export function visibilityBackoffSeconds(receiveCount: number): number {
  return Math.min(2 ** receiveCount * 2, 60);
}

/**
 * True when this was the last delivery the redrive policy allows: if processing fails again the queue moves the
 * message to the DLQ instead of delivering it a sixth time.
 */
export function isFinalReceive(receiveCount: number, maxReceiveCount: number): boolean {
  return receiveCount >= maxReceiveCount;
}

/** The messages being worked on right now, so a shutdown can wait for them and hand back the ones it cannot finish. */
export class InFlight<T extends { readonly receiptHandle: string }> {
  private readonly pending = new Map<string, T>();
  private idle: (() => void) | undefined;

  add(message: T): void {
    this.pending.set(message.receiptHandle, message);
  }

  remove(message: T): void {
    this.pending.delete(message.receiptHandle);
    if (this.pending.size === 0) {
      this.idle?.();
    }
  }

  get size(): number {
    return this.pending.size;
  }

  remaining(): T[] {
    return [...this.pending.values()];
  }

  /** Resolves `true` when nothing is left, `false` if `timeoutMs` passes first. */
  async drain(timeoutMs: number): Promise<boolean> {
    if (this.pending.size === 0) {
      return true;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const emptied = new Promise<boolean>((resolve) => {
      this.idle = () => resolve(true);
    });
    const timedOut = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    try {
      return await Promise.race([emptied, timedOut]);
    } finally {
      clearTimeout(timer);
      this.idle = undefined;
    }
  }
}
