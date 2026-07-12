# STOMP FI View Server

TypeScript sibling service to `stomp-fixed-income-server`: **synthetic fixed-income positions/trades**, **same STOMP destinations and triggers**, snapshot → **Success:** completion line → live updates **only for rows delivered in that snapshot**.

Default listen: **8081** (so it can run beside the original on 8080).

### Connecting from existing Node clients

Use **`ws://localhost:8081`**, not `8080`. Options:

- **Environment:** `WS_URL=ws://localhost:8081` before running your client.
- **From repo root:** `npm run example:view` or `npm run test-enhanced:view` (scripts set `WS_URL` for you).

If nothing listens on `8081`, the TCP connection fails (`ECONNREFUSED`). Start the view server: `cd stomp-view-server && npm run build && npm start`.

### Troubleshooting

| Symptom | Likely cause |
|--------|----------------|
| Connection refused | View server not running, or wrong port (use **8081**). |
| TCP connects but STOMP hangs | Rare CRLF issue — fixed in server frame parsing; rebuild `stomp-view-server`. |
| Browser app still fails | Point `WebSocket` / stomp URL at **`ws://<host>:8081`** (same host as where the server runs). |
| Process exits with **code 130** or you see **`^C`** in the terminal | You pressed **Ctrl+C** — that stops the server on purpose. |
| Server disappears mid-run (no **^C**) | Often **out-of-memory**: default snapshot is **20k** wide rows. Lower **`DEFAULT_SNAPSHOT_ROWS`** / **`snapshot-rows`** header, or run Node with more heap: `NODE_OPTIONS=--max-old-space-size=8192 npm start`. |
| Error logged from **`[snapshot]`** / **`[live]`** | An exception during send/update — check the stack trace; the server should stay up after our handlers log it. |

## Protocol compatibility

Matches `stomp-server/protocolContract.js`:

- `CONNECT` / `STOMP` → `CONNECTED` (`version:1.2`, `server:stomp-fixed-income/1.0.0`, `heart-beat:0,0`)
- Subscribe: `/snapshot/positions`, `/snapshot/trades`, or `/snapshot/{type}/{clientId}`
- Trigger: `/snapshot/{type}/{rate}[/{batchSize}]` or `/snapshot/{type}/{clientId}/{rate}[/{batchSize}]`
- Snapshot batches: `content-type:application/json`, `message-type:snapshot` (legacy path includes these)
- Completion: body starts with `Success: All …`
- Live: JSON array of one row, `message-type:live-update`

## Extension (optional)

Clients **that want a configurable snapshot size** (1k–20k by default env bounds) may add a STOMP header on the **SEND** frame:

- `snapshot-rows: 15000`  
- Alias: `row-count`

Existing clients that omit this header keep prior behavior with server defaults.

Example (stompjs):

```javascript
client.send('/snapshot/positions/TRADER001/1000/50', { 'snapshot-rows': '4000' }, '');
```

## Configuration

| Variable | Default |
|----------|---------|
| `PORT` | `8081` |
| `DEFAULT_SNAPSHOT_ROWS` | `20000` |
| `MIN_SNAPSHOT_ROWS` | `1000` |
| `MAX_SNAPSHOT_ROWS` | `20000` |
| `DEBUG` | unset (`1` / `true` for verbose logs) |
| `LOG_OUTBOUND` | `1` by default; set to `0` or `false` to stop printing each outbound **MESSAGE** body |
| `LOG_LIVE_EVERY` | `1` = log every live-update message; use `50` or `100` at high msg/sec to reduce noise |
| `LOG_BODY_PREVIEW` | Max characters of each MESSAGE body to print (default `400`; large snapshots truncate) |

## Scripts

```bash
npm install
npm run dev      # tsx watch
npm run build
npm start        # node dist/main.js
```

## Data

Rows are **deterministic from a seed** (stable IDs and shapes per client/topic). Instrument coverage includes gov, credit, securitized, EM, derivatives overlay, money-market styles, with wide nested payloads for grid/view testing.
