/**
 * Alert firing with per-rule debounce and global token-bucket rate limit.
 */
import type { AlertEvent, AlertRateLimit, AlertSeverity } from './types';

export interface AlertFireRequest<TData = unknown> {
  ruleId: string;
  rowId: string;
  data: TData;
  message: string;
  severity: AlertSeverity;
  debounceMs: number;
}

export class AlertManager<TData = unknown> {
  private tokens: number;
  private readonly maxTokens: number;
  private readonly perMs: number;
  private lastRefill = performance.now();
  private readonly lastFired = new Map<string, number>();
  private readonly history: AlertEvent<TData>[] = [];
  readonly maxHistory: number;

  constructor(limit?: AlertRateLimit, maxHistory = 100) {
    this.maxTokens = limit?.tokens ?? 20;
    this.tokens = this.maxTokens;
    this.perMs = limit?.perMs ?? 1000;
    this.maxHistory = maxHistory;
  }

  getHistory(): readonly AlertEvent<TData>[] {
    return this.history;
  }

  /** Returns the event if fired, else undefined (debounced or rate-limited). */
  tryFire(req: AlertFireRequest<TData>): AlertEvent<TData> | undefined {
    const now = performance.now();
    this.refill(now);
    const debounceKey = `${req.ruleId}\u0000${req.rowId}`;
    const last = this.lastFired.get(debounceKey) ?? 0;
    if (req.debounceMs > 0 && now - last < req.debounceMs) return undefined;
    if (this.tokens < 1) return undefined;
    this.tokens -= 1;
    this.lastFired.set(debounceKey, now);
    const event: AlertEvent<TData> = {
      ruleId: req.ruleId,
      rowId: req.rowId,
      data: req.data,
      message: req.message,
      severity: req.severity,
      at: now,
    };
    this.history.push(event);
    if (this.history.length > this.maxHistory) {
      this.history.splice(0, this.history.length - this.maxHistory);
    }
    return event;
  }

  private refill(now: number): void {
    const elapsed = now - this.lastRefill;
    if (elapsed < this.perMs) return;
    const windows = Math.floor(elapsed / this.perMs);
    if (windows < 1) return;
    this.tokens = Math.min(this.maxTokens, this.tokens + windows * this.maxTokens);
    this.lastRefill = now;
  }
}
