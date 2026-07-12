/**
 * Wire-compatible with stomp-fixed-income-server `protocolContract.js`.
 * Extensions (optional STOMP headers) are documented below — omitting them preserves client behavior.
 */

export const STOMP_VERSION = "1.2";
export const SERVER_NAME = "stomp-fixed-income/1.0.0";
export const HEART_BEAT = "0,0";

export const DESTINATION_ERRORS = "/errors";

/** Client-specific trigger: /snapshot/{positions|trades}/{clientId}/{rate}[/{batchSize}] */
export const TRIGGER_CLIENT_SPECIFIC =
  /^\/snapshot\/(positions|trades)\/([^/]+)\/(\d+)(?:\/(\d+))?$/;

/** Legacy trigger: /snapshot/{positions|trades}/{rate}[/{batchSize}] */
export const TRIGGER_LEGACY =
  /^\/snapshot\/(positions|trades)\/(\d+)(?:\/(\d+))?$/;

/** Subscription path /snapshot/{positions|trades}/{clientId} */
export const CLIENT_TOPIC_REGEX = /^\/snapshot\/(positions|trades)\/[^/]+$/;

export const SNAPSHOT_BATCH_INTERVAL_MS = 10;

/** Optional extension — existing clients do not send this; server uses env defaults. */
export const HEADER_SNAPSHOT_ROWS = "snapshot-rows";

export const HEADER = {
  MESSAGE_TYPE: "message-type",
  CONTENT_TYPE: "content-type",
  BATCH_NUMBER: "batch-number",
  CLIENT_ID: "client-id",
  UPDATE_NUMBER: "update-number",
  SUBSCRIPTION: "subscription",
  MESSAGE_ID: "message-id",
  DESTINATION: "destination",
} as const;

export const MESSAGE_TYPE = {
  SNAPSHOT: "snapshot",
  SNAPSHOT_COMPLETE: "snapshot-complete",
  LIVE_UPDATE: "live-update",
} as const;

export function connectedHeaders(sessionId: string): Record<string, string> {
  return {
    version: STOMP_VERSION,
    session: sessionId,
    server: SERVER_NAME,
    "heart-beat": HEART_BEAT,
  };
}

export function genericSubscriptionDestination(dataType: string): string {
  return `/snapshot/${dataType}`;
}

export function clientSubscriptionDestination(
  dataType: string,
  clientId: string,
): string {
  return `/snapshot/${dataType}/${clientId}`;
}

export function defaultBatchSize(rate: number): number {
  return Math.max(1, Math.floor(rate / 10));
}

export function legacySnapshotCompleteText(
  totalRecords: number,
  dataType: string,
): string {
  return `Success: All ${totalRecords} ${dataType} snapshot records delivered. Starting live updates...`;
}

export function clientSnapshotCompleteText(
  totalRecords: number,
  dataType: string,
  clientId: string,
): string {
  return `Success: All ${totalRecords} ${dataType} records delivered to client '${clientId}'. Starting live updates...`;
}
