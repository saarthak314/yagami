// A counting semaphore: bound how many async tasks run at once across
// independent callers (e.g. browser pages shared by every demo being verified).
// Waiters are served by priority (lower first), then in arrival order — e.g. the first
// chapter's demos go before later chapters' so the reader is useful early.

export class Limit {
  private active = 0;
  private queue: { priority: number; seq: number; go: () => void }[] = [];
  private seq = 0;
  constructor(private readonly max: number) {}

  async run<T>(fn: () => Promise<T>, priority = 0): Promise<T> {
    if (this.active >= this.max) {
      await new Promise<void>((go) => {
        this.queue.push({ priority, seq: this.seq++, go });
        this.queue.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
      });
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.go();
    }
  }
}
