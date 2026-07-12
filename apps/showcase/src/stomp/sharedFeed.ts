/**
 * Shared STOMP feed for showcase pages: one connection, one snapshot, one
 * update fan-out — pages mount/unmount without re-snapshotting. Falls back
 * to `offline` when the server isn't running (`npm run dev:stomp`) so every
 * page keeps working on its synthetic data.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { connectFiPositions, type FiPosition } from './fiPositionsSource';

export type FeedStatus = 'idle' | 'connecting' | 'ready' | 'offline';

interface FeedState {
  status: FeedStatus;
  rows: FiPosition[] | null;
}

let state: FeedState = { status: 'idle', rows: null };
let dispose: (() => void) | null = null;
let offlineTimer: ReturnType<typeof setTimeout> | null = null;
const stateSubs = new Set<() => void>();
const updateSubs = new Set<(batch: FiPosition[]) => void>();

function setState(next: Partial<FeedState>): void {
  state = { ...state, ...next };
  for (const cb of stateSubs) cb();
}

/** Connect once per session (idempotent). */
export function ensureFeed(): void {
  if (state.status !== 'idle') return;
  setState({ status: 'connecting' });
  // If the server is down the socket errors quickly, but guard with a
  // deadline so pages fall back to synthetic data instead of waiting.
  offlineTimer = setTimeout(() => {
    if (state.status === 'connecting') setState({ status: 'offline' });
  }, 2500);
  dispose = connectFiPositions(
    { rows: 5000, rate: 200, updatesPerTick: 50 },
    {
      onStatus: (text) => {
        if (text.startsWith('error') || text.startsWith('disconnected') || text.includes('is the server running')) {
          if (state.status !== 'ready') setState({ status: 'offline' });
        }
      },
      onSnapshotProgress: () => {},
      onReady: (rows) => {
        if (offlineTimer) clearTimeout(offlineTimer);
        setState({ status: 'ready', rows });
      },
      onUpdates: (batch) => {
        for (const cb of updateSubs) cb(batch);
      },
    },
  );
}

/** Tear down (tests / HMR); pages never call this. */
export function resetFeed(): void {
  dispose?.();
  dispose = null;
  if (offlineTimer) clearTimeout(offlineTimer);
  state = { status: 'idle', rows: null };
}

/** Live update batches (full-row replacements). Returns unsubscribe. */
export function subscribeFiUpdates(cb: (batch: FiPosition[]) => void): () => void {
  updateSubs.add(cb);
  return () => updateSubs.delete(cb);
}

function subscribeState(cb: () => void): () => void {
  stateSubs.add(cb);
  return () => stateSubs.delete(cb);
}

/**
 * Page hook: kicks the shared connection and returns `{ rows, status }`.
 * `rows` is null until the snapshot lands (or forever when offline) — pages
 * render their synthetic fallback in that case.
 */
export function useFiFeed(): FeedState {
  useEffect(ensureFeed, []);
  return useSyncExternalStore(subscribeState, () => state);
}

/**
 * Page hook: stream live updates into a grid api while mounted. `enabled`
 * lets pages pause application (e.g. while editing).
 */
export function useFiUpdates(
  apply: (batch: FiPosition[]) => void,
  enabled = true,
): void {
  useEffect(() => {
    if (!enabled) return;
    return subscribeFiUpdates(apply);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);
}
