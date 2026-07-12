export interface AppConfig {
  port: number;
  nodeEnv: string;
  /** Rows delivered in snapshot unless overridden by STOMP header `snapshot-rows` */
  defaultSnapshotRows: number;
  minSnapshotRows: number;
  maxSnapshotRows: number;
  /** Verbose STOMP / per-tick logging */
  debug: boolean;
  /** Log outbound STOMP frames (CONNECTED + MESSAGE) to the terminal */
  logOutbound: boolean;
  /** Log every Nth live-update MESSAGE when logOutbound (1 = all) */
  logLiveEvery: number;
  /** Max characters of MESSAGE body to print before truncation */
  logBodyPreviewChars: number;
}

export function loadConfig(): AppConfig {
  const port = Number(process.env.PORT ?? 8081);
  const rawDefault = Number(process.env.DEFAULT_SNAPSHOT_ROWS ?? 20_000);
  const rawMin = Number(process.env.MIN_SNAPSHOT_ROWS ?? 1_000);
  const rawMax = Number(process.env.MAX_SNAPSHOT_ROWS ?? 20_000);

  const minSnapshotRows = Number.isFinite(rawMin) ? rawMin : 1_000;
  const maxSnapshotRows = Number.isFinite(rawMax)
    ? Math.max(minSnapshotRows, rawMax)
    : Math.max(minSnapshotRows, 20_000);
  const defaultSnapshotRows = clamp(
    Number.isFinite(rawDefault) ? rawDefault : 20_000,
    minSnapshotRows,
    maxSnapshotRows,
  );

  const logLiveRaw = Number.parseInt(process.env.LOG_LIVE_EVERY ?? "1", 10);
  const logPreviewRaw = Number.parseInt(
    process.env.LOG_BODY_PREVIEW ?? "400",
    10,
  );

  return {
    port: Number.isFinite(port) ? port : 8081,
    nodeEnv: process.env.NODE_ENV ?? "development",
    defaultSnapshotRows,
    minSnapshotRows,
    maxSnapshotRows,
    debug: process.env.DEBUG === "1" || process.env.DEBUG === "true",
    logOutbound:
      process.env.LOG_OUTBOUND !== "0" &&
      process.env.LOG_OUTBOUND !== "false",
    logLiveEvery: Number.isFinite(logLiveRaw) && logLiveRaw >= 1 ? logLiveRaw : 1,
    logBodyPreviewChars:
      Number.isFinite(logPreviewRaw) && logPreviewRaw >= 80
        ? Math.min(logPreviewRaw, 50_000)
        : 400,
  };
}

export function clampSnapshotRows(
  config: AppConfig,
  requested: number | undefined,
): number {
  const lo = Math.max(1, config.minSnapshotRows);
  const hi = Math.max(lo, config.maxSnapshotRows);
  const raw = requested ?? config.defaultSnapshotRows;
  if (!Number.isFinite(raw)) return clamp(config.defaultSnapshotRows, lo, hi);
  return clamp(Math.floor(raw), lo, hi);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}
