import type { FeedStatus } from './sharedFeed';

/**
 * One-line datasource indicator for STOMP-fed pages: green when live,
 * amber while connecting, grey when the page fell back to synthetic data.
 */
export function FeedBadge({ status }: { status: FeedStatus }) {
  const label =
    status === 'ready'
      ? 'STOMP live (:8081)'
      : status === 'connecting' || status === 'idle'
        ? 'STOMP connecting…'
        : 'STOMP offline — synthetic data (npm run dev:stomp)';
  const color = status === 'ready' ? '#7CB88C' : status === 'offline' ? '#8E8E8E' : '#C9A86A';
  return (
    <span style={{ color, whiteSpace: 'nowrap' }} title="Shared STOMP feed: apps/stomp-view-server">
      ● {label}
    </span>
  );
}
