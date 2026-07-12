import http from "node:http";
import process from "node:process";
import { WebSocketServer } from "ws";
import type { AppConfig } from "./config.js";
import { StompConnection } from "./stomp/connection.js";

export async function startServer(config: AppConfig): Promise<void> {
  const clients = new Map<number, StompConnection>();

  const httpServer = http.createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(200);
      res.end();
      return;
    }

    if (req.url === "/health") {
      const body = {
        status: "healthy",
        service: "stomp-view-server",
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        environment: config.nodeEnv,
        snapshotRowsDefault: config.defaultSnapshotRows,
        snapshotRowsRange: [config.minSnapshotRows, config.maxSnapshotRows],
      };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body, null, 2));
      return;
    }

    if (req.url === "/" || req.url === "") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify(
          {
            name: "STOMP FI View Server",
            version: "1.0.0",
            protocol: "Same destinations & triggers as stomp-fixed-income-server",
            extensions: {
              optionalSendHeaders: [
                "snapshot-rows",
                "row-count (alias)",
              ],
              description:
                "Clamps requested snapshot size between MIN_SNAPSHOT_ROWS and MAX_SNAPSHOT_ROWS (default from DEFAULT_SNAPSHOT_ROWS).",
            },
            endpoints: {
              health: "/health",
              websocket: `ws://localhost:${config.port}`,
            },
          },
          null,
          2,
        ),
      );
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not Found" }));
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(config.port, () => resolve());
  });

  const wss = new WebSocketServer({ server: httpServer });

  wss.on("connection", (ws, req) => {
    const clientId = Date.now();
    console.log(
      `[stomp-view-server] WebSocket connected → client id ${clientId} from ${req.socket.remoteAddress ?? "?"}`,
    );
    const client = new StompConnection(ws, clientId, config, clients);
    clients.set(clientId, client);

    ws.on("message", (data) => {
      const message = data.toString();
      const frames = message.split("\0").filter((f) => f.trim());
      for (const frame of frames) {
        if (frame.trim()) client.handleFrame(frame);
      }
    });

    ws.on("close", () => {
      client.cleanup();
      clients.delete(clientId);
    });

    ws.on("error", (err) => {
      console.error(`WebSocket error client ${clientId}:`, err);
    });
  });

  console.log(`STOMP FI View Server — http://localhost:${config.port}/health`);
  console.log(`WebSocket ws://localhost:${config.port}`);
  console.log(
    `Snapshot rows: default ${config.defaultSnapshotRows} (range ${config.minSnapshotRows}–${config.maxSnapshotRows}); optional STOMP header snapshot-rows on SEND`,
  );
}
