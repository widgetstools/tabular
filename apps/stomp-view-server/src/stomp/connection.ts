import type { WebSocket } from "ws";
import type { AppConfig } from "../config.js";
import { clampSnapshotRows } from "../config.js";
import type { PositionRecord, TradeRecord } from "../data/fiRecords.js";
import { buildSnapshot } from "../data/fiRecords.js";
import { mutatePosition, mutateTrade } from "../data/mutate.js";
import * as protocol from "../protocol/contract.js";
import { hashString } from "../util/hash.js";

export interface Subscription {
  destination: string;
  id: string;
  ack: string;
  updateInterval?: ReturnType<typeof setInterval>;
}

function headerCI(
  headers: Record<string, string>,
  name: string,
): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

export class StompConnection {
  readonly ws: WebSocket;
  readonly id: number;
  private readonly config: AppConfig;
  private readonly clients: Map<number, StompConnection>;
  readonly subscriptions = new Map<string, Subscription>();
  sessionId: string;
  connected = false;
  /** Count outbound live-update MESSAGE frames (for LOG_LIVE_EVERY sampling) */
  private outboundLiveCount = 0;
  readonly liveUpdateIntervals = new Map<string, ReturnType<typeof setInterval>>();

  constructor(
    ws: WebSocket,
    id: number,
    config: AppConfig,
    clients: Map<number, StompConnection>,
  ) {
    this.ws = ws;
    this.id = id;
    this.config = config;
    this.clients = clients;
    this.sessionId = `session-${id}`;
  }

  send(command: string, headers: Record<string, string> = {}, body = ""): void {
    let frame = `${command}\n`;
    for (const [key, value] of Object.entries(headers)) {
      frame += `${key}:${value}\n`;
    }
    frame += "\n";
    if (body) frame += body;
    frame += "\0";
    try {
      this.ws.send(frame);
      this.logOutboundSent(command, headers, body);
    } catch (e) {
      console.error(`Error sending frame to ${this.id}:`, e);
    }
  }

  private logOutboundSent(
    command: string,
    headers: Record<string, string>,
    body: string,
  ): void {
    if (!this.config.logOutbound || command !== "MESSAGE") return;

    const mt = headers[protocol.HEADER.MESSAGE_TYPE] ?? "";
    const dest = headers[protocol.HEADER.DESTINATION] ?? "";
    const batch = headers[protocol.HEADER.BATCH_NUMBER];
    const cid = headers[protocol.HEADER.CLIENT_ID];
    const upd = headers[protocol.HEADER.UPDATE_NUMBER];

    if (mt === protocol.MESSAGE_TYPE.LIVE_UPDATE) {
      this.outboundLiveCount++;
      const every = this.config.logLiveEvery;
      if (every > 1 && this.outboundLiveCount % every !== 0) return;
    }

    const max = this.config.logBodyPreviewChars;
    let preview: string;
    if (!body.length) preview = "(empty body)";
    else if (body.length <= max)
      preview = body;
    else
      preview =
        body.slice(0, max) +
        `\n    … truncated (${body.length} bytes total)`;

    const parts = [
      `[→ client ${this.id}] MESSAGE`,
      `type=${mt || "—"}`,
      `dest=${dest}`,
    ];
    if (batch) parts.push(`batch=${batch}`);
    if (cid) parts.push(`client-id=${cid}`);
    if (upd) parts.push(`update#=${upd}`);
    console.log(parts.join(" "));
    console.log(`    body:\n    ${preview.split("\n").join("\n    ")}`);
  }

  handleFrame(rawFrame: string): void {
    // stompjs / browsers may use CRLF; normalize before parsing
    const frame = rawFrame.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const lines = frame.split("\n");
    const command = (lines[0] ?? "").trim();
    const headers: Record<string, string> = {};
    let bodyStart = 0;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i] === "") {
        bodyStart = i + 1;
        break;
      }
      const line = lines[i] ?? "";
      const idx = line.indexOf(":");
      if (idx === -1) continue;
      const key = line.slice(0, idx);
      const value = line.slice(idx + 1);
      if (key) headers[key] = value;
    }
    const body = lines
      .slice(bodyStart)
      .join("\n")
      .replace(/\0$/, "");

    if (this.config.debug) console.log(`Received ${command} from ${this.id}`);

    switch (command) {
      case "CONNECT":
      case "STOMP":
        this.handleConnect();
        break;
      case "SUBSCRIBE":
        this.handleSubscribe(headers);
        break;
      case "SEND":
        this.handleSend(headers, body);
        break;
      case "UNSUBSCRIBE":
        this.handleUnsubscribe(headers);
        break;
      case "DISCONNECT":
        this.handleDisconnect();
        break;
      default:
        break;
    }
  }

  private handleConnect(): void {
    this.connected = true;
    this.send("CONNECTED", protocol.connectedHeaders(this.sessionId));
    console.log(
      `[stomp-view-server] Client ${this.id} connected — STOMP session ${this.sessionId}`,
    );
  }

  private handleSubscribe(headers: Record<string, string>): void {
    const destination = headers.destination ?? "";
    const id = headers.id ?? `sub-${Date.now()}`;
    if (this.config.debug)
      console.log(`Client ${this.id} subscribing to ${destination}`);
    this.subscriptions.set(id, {
      destination,
      id,
      ack: headers.ack ?? "auto",
    });
  }

  private parseSnapshotRows(headers: Record<string, string>): number {
    const raw =
      headerCI(headers, protocol.HEADER_SNAPSHOT_ROWS) ??
      headerCI(headers, "row-count");
    if (raw === undefined) return clampSnapshotRows(this.config, undefined);
    const n = Number.parseInt(raw, 10);
    return clampSnapshotRows(this.config, Number.isFinite(n) ? n : undefined);
  }

  private handleSend(headers: Record<string, string>, body: string): void {
    const destination = headers.destination ?? "";
    const rowCount = this.parseSnapshotRows(headers);
    const requestString =
      body && body.startsWith("/snapshot/") ? body : destination;

    const match = requestString.match(protocol.TRIGGER_CLIENT_SPECIFIC);
    if (match) {
      const [, dataType, clientId, rateStr, batchStr] = match;
      const rate = Number.parseInt(rateStr!, 10);
      const batchSize = batchStr
        ? Number.parseInt(batchStr, 10)
        : protocol.defaultBatchSize(rate);
      // Optional `updates-per-tick` header: when supplied, the server
      // bundles N row mutations into each MESSAGE so apps can drive
      // throughput above the ~1ms setInterval floor (rate=200 +
      // updatesPerTick=50 → 10,000 updates/s).
      const updatesPerTickRaw = headerCI(headers, "updates-per-tick");
      const updatesPerTick = updatesPerTickRaw
        ? Math.max(1, Number.parseInt(updatesPerTickRaw, 10) || 1)
        : 1;
      const topic = protocol.clientSubscriptionDestination(
        dataType!,
        clientId!,
      );
      let subscription: Subscription | null = null;
      for (const sub of this.subscriptions.values()) {
        if (sub.destination === topic) {
          subscription = sub;
          break;
        }
      }
      if (subscription) {
        this.startClientSpecificDataDelivery(
          dataType as "positions" | "trades",
          clientId!,
          rate,
          batchSize,
          subscription,
          rowCount,
          updatesPerTick,
        );
      } else {
        if (this.config.debug)
          console.log(`No subscription for ${topic}`);
        this.send(
          "MESSAGE",
          {
            [protocol.HEADER.DESTINATION]: protocol.DESTINATION_ERRORS,
            [protocol.HEADER.MESSAGE_ID]: `error-${Date.now()}`,
          },
          `Error: No subscription found for ${topic}. Please subscribe first.`,
        );
      }
      return;
    }

    const legacyMatch = requestString.match(protocol.TRIGGER_LEGACY);
    if (legacyMatch) {
      const [, dataType, rateStr, batchStr] = legacyMatch;
      const rate = Number.parseInt(rateStr!, 10);
      const batchSize = batchStr
        ? Number.parseInt(batchStr, 10)
        : protocol.defaultBatchSize(rate);
      const generic = protocol.genericSubscriptionDestination(dataType!);
      let subscription: Subscription | null = null;
      for (const sub of this.subscriptions.values()) {
        if (sub.destination === generic) {
          subscription = sub;
          break;
        }
      }
      if (subscription) {
        const seedBase = hashString(`legacy-${this.id}-${dataType}`);
        this.startDataDelivery(
          dataType as "positions" | "trades",
          rate,
          batchSize,
          subscription,
          rowCount,
          seedBase,
        );
      } else if (this.config.debug) {
        console.log(`No subscription for ${generic}`);
      }
      return;
    }

    if (this.config.debug)
      console.log(`Unrecognized trigger pattern: ${requestString}`);
  }

  private startDataDelivery(
    dataType: "positions" | "trades",
    rate: number,
    batchSize: number,
    subscription: Subscription,
    rowCount: number,
    seedBase: number,
  ): void {
    const data = buildSnapshot(dataType, rowCount, seedBase);
    let index = 0;
    const snapshotBatchInterval = protocol.SNAPSHOT_BATCH_INTERVAL_MS;
    const delivered: (PositionRecord | TradeRecord)[] = [];

    const sendBatch = (): void => {
      try {
        if (index >= data.length) {
          this.send(
            "MESSAGE",
            {
              [protocol.HEADER.SUBSCRIPTION]: subscription.id,
              [protocol.HEADER.MESSAGE_ID]: `msg-${Date.now()}`,
              [protocol.HEADER.DESTINATION]: subscription.destination,
            },
            protocol.legacySnapshotCompleteText(data.length, dataType),
          );
          this.startLiveUpdates(dataType, rate, subscription, delivered);
          return;
        }

        const batch = data.slice(index, index + batchSize);
        delivered.push(...batch.map((r) => structuredClone(r)));

        this.send(
          "MESSAGE",
          {
            [protocol.HEADER.SUBSCRIPTION]: subscription.id,
            [protocol.HEADER.MESSAGE_ID]: `msg-${Date.now()}-${Math.random()}`,
            [protocol.HEADER.DESTINATION]: subscription.destination,
            [protocol.HEADER.CONTENT_TYPE]: "application/json",
            [protocol.HEADER.MESSAGE_TYPE]: protocol.MESSAGE_TYPE.SNAPSHOT,
          },
          JSON.stringify(batch),
        );

        index += batchSize;
        setTimeout(sendBatch, snapshotBatchInterval);
      } catch (err) {
        console.error(
          `[snapshot legacy] client ${this.id} ${dataType}:`,
          err,
        );
      }
    };

    sendBatch();
  }

  private startLiveUpdates(
    dataType: "positions" | "trades",
    rate: number,
    subscription: Subscription,
    deliveredRecords: (PositionRecord | TradeRecord)[],
  ): void {
    const intervalMs = 1000 / rate;
    let updateNumber = 1;

    const updateInterval = setInterval(() => {
      try {
        if (!this.connected || !this.subscriptions.has(subscription.id)) {
          clearInterval(updateInterval);
          return;
        }
        const idx = Math.floor(Math.random() * deliveredRecords.length);
        const base = deliveredRecords[idx];
        if (!base) return;

        const update =
          dataType === "positions"
            ? mutatePosition(base as PositionRecord)
            : mutateTrade(base as TradeRecord);

        this.send(
          "MESSAGE",
          {
            [protocol.HEADER.SUBSCRIPTION]: subscription.id,
            [protocol.HEADER.MESSAGE_ID]: `msg-${Date.now()}-${Math.random()}`,
            [protocol.HEADER.DESTINATION]: subscription.destination,
            [protocol.HEADER.CONTENT_TYPE]: "application/json",
            [protocol.HEADER.MESSAGE_TYPE]: protocol.MESSAGE_TYPE.LIVE_UPDATE,
          },
          JSON.stringify([update]),
        );

        if (this.config.debug && updateNumber <= 3) {
          const rid =
            dataType === "positions"
              ? (update as PositionRecord).positionId
              : (update as TradeRecord).tradeId;
          console.log(`live update #${updateNumber} ${dataType} ${rid}`);
        }
        updateNumber++;
      } catch (err) {
        console.error(`[live legacy] client ${this.id} ${dataType}:`, err);
      }
    }, intervalMs);

    subscription.updateInterval = updateInterval;
  }

  private startClientSpecificDataDelivery(
    dataType: "positions" | "trades",
    clientId: string,
    rate: number,
    batchSize: number,
    subscription: Subscription,
    rowCount: number,
    updatesPerTick: number = 1,
  ): void {
    const seedBase = hashString(`${clientId}-${dataType}`);
    const data = buildSnapshot(dataType, rowCount, seedBase);
    let index = 0;
    let batchNumber = 1;
    const snapshotBatchInterval = protocol.SNAPSHOT_BATCH_INTERVAL_MS;
    const deliveredRecords: (PositionRecord | TradeRecord)[] = [];

    const sendBatch = (): void => {
      try {
        if (index >= data.length) {
          this.send(
            "MESSAGE",
            {
              [protocol.HEADER.SUBSCRIPTION]: subscription.id,
              [protocol.HEADER.MESSAGE_ID]: `msg-${Date.now()}`,
              [protocol.HEADER.DESTINATION]: subscription.destination,
              [protocol.HEADER.CLIENT_ID]: clientId,
              [protocol.HEADER.MESSAGE_TYPE]:
                protocol.MESSAGE_TYPE.SNAPSHOT_COMPLETE,
            },
            protocol.clientSnapshotCompleteText(
              data.length,
              dataType,
              clientId,
            ),
          );
          this.startClientSpecificLiveUpdates(
            dataType,
            clientId,
            rate,
            subscription,
            deliveredRecords,
            updatesPerTick,
          );
          return;
        }

        const endIndex = Math.min(index + batchSize, data.length);
        const batch = data.slice(index, endIndex);
        deliveredRecords.push(...batch.map((r) => structuredClone(r)));

        this.send(
          "MESSAGE",
          {
            [protocol.HEADER.SUBSCRIPTION]: subscription.id,
            [protocol.HEADER.MESSAGE_ID]: `msg-${Date.now()}-batch-${batchNumber}`,
            [protocol.HEADER.DESTINATION]: subscription.destination,
            [protocol.HEADER.CONTENT_TYPE]: "application/json",
            [protocol.HEADER.BATCH_NUMBER]: String(batchNumber),
            [protocol.HEADER.CLIENT_ID]: clientId,
            [protocol.HEADER.MESSAGE_TYPE]: protocol.MESSAGE_TYPE.SNAPSHOT,
          },
          JSON.stringify(batch),
        );

        index = endIndex;
        batchNumber++;
        setTimeout(sendBatch, snapshotBatchInterval);
      } catch (err) {
        console.error(
          `[snapshot client] ${clientId} ${dataType}:`,
          err,
        );
      }
    };

    sendBatch();
  }

  private startClientSpecificLiveUpdates(
    dataType: "positions" | "trades",
    clientId: string,
    rate: number,
    subscription: Subscription,
    deliveredRecords: (PositionRecord | TradeRecord)[],
    updatesPerTick: number = 1,
  ): void {
    let updateNumber = 1;
    const streamKey = `${dataType}-${clientId}`;
    // `rate` = ticks/sec the server fires. `updatesPerTick` controls
    // how many mutations are bundled into each tick's MESSAGE. setInterval
    // has a real-world minimum around ~1ms in Node, so for rates beyond
    // ~1000 we clamp the interval and let `updatesPerTick` carry the
    // throughput. e.g. rate=200 + updatesPerTick=50 → 10,000 updates/s
    // delivered as 200 messages/s each carrying 50-record arrays.
    const intervalMs = Math.max(1, 1000 / rate);
    const perTick = Math.max(1, Math.floor(updatesPerTick));

    const updateInterval = setInterval(() => {
      try {
        if (!this.connected || !this.clients.has(this.id)) {
          clearInterval(updateInterval);
          return;
        }
        if (deliveredRecords.length === 0) return;

        // Build N mutations per tick. Each picks a random existing row
        // + emits a single-field delta (mutate{Position,Trade} already
        // does sparse delta semantics).
        const updates: (PositionRecord | TradeRecord)[] = new Array(perTick);
        for (let i = 0; i < perTick; i++) {
          const base = deliveredRecords[
            Math.floor(Math.random() * deliveredRecords.length)
          ]!;
          updates[i] = dataType === "positions"
            ? mutatePosition(base as PositionRecord)
            : mutateTrade(base as TradeRecord);
        }

        this.send(
          "MESSAGE",
          {
            [protocol.HEADER.SUBSCRIPTION]: subscription.id,
            [protocol.HEADER.MESSAGE_ID]: `msg-${Date.now()}-${Math.random()}`,
            [protocol.HEADER.DESTINATION]: subscription.destination,
            [protocol.HEADER.CONTENT_TYPE]: "application/json",
            [protocol.HEADER.MESSAGE_TYPE]: protocol.MESSAGE_TYPE.LIVE_UPDATE,
            [protocol.HEADER.CLIENT_ID]: clientId,
            [protocol.HEADER.UPDATE_NUMBER]: String(updateNumber),
          },
          JSON.stringify(updates),
        );

        updateNumber++;
      } catch (err) {
        console.error(`[live client] ${clientId} ${dataType}:`, err);
      }
    }, intervalMs);

    this.liveUpdateIntervals.set(streamKey, updateInterval);
  }

  private handleUnsubscribe(headers: Record<string, string>): void {
    const id = headers.id;
    const subscription = id ? this.subscriptions.get(id) : undefined;
    if (!subscription) return;

    if (subscription.updateInterval)
      clearInterval(subscription.updateInterval);

    const dest = subscription.destination;
    const match = dest.match(protocol.CLIENT_TOPIC_REGEX);
    if (match) {
      const parts = dest.split("/");
      const dataType = parts[2]!;
      const clientId = parts[3]!;
      const streamKey = `${dataType}-${clientId}`;
      const t = this.liveUpdateIntervals.get(streamKey);
      if (t) {
        clearInterval(t);
        this.liveUpdateIntervals.delete(streamKey);
      }
    }

    this.subscriptions.delete(id!);
  }

  private handleDisconnect(): void {
    this.cleanup();
    this.ws.close();
  }

  cleanup(): void {
    for (const sub of this.subscriptions.values()) {
      if (sub.updateInterval) clearInterval(sub.updateInterval);
    }
    for (const t of this.liveUpdateIntervals.values()) clearInterval(t);
    this.liveUpdateIntervals.clear();
    this.subscriptions.clear();
    this.connected = false;
  }
}
