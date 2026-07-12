/**
 * Minimal STOMP 1.2 client over a raw WebSocket, wire-compatible with
 * apps/stomp-view-server (LF-delimited headers, NUL-terminated frames,
 * heart-beat 0,0). Deliberately dependency-free: the server's frame
 * grammar is simple enough that stompjs would be dead weight.
 */

export interface StompFrame {
  command: string;
  headers: Record<string, string>;
  body: string;
}

export interface StompClientEvents {
  onMessage: (frame: StompFrame) => void;
  /** Connection-level failures and server ERROR frames. */
  onError?: (reason: string) => void;
  onClose?: () => void;
}

export class StompClient {
  private ws: WebSocket | null = null;
  private connected = false;

  constructor(
    private readonly url: string,
    private readonly events: StompClientEvents,
  ) {}

  /** Opens the socket and resolves once the server replies CONNECTED. */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.onopen = () => {
        ws.send(frame('CONNECT', { 'accept-version': '1.2', 'heart-beat': '0,0' }));
      };
      ws.onmessage = (ev) => {
        for (const f of parseFrames(String(ev.data))) {
          if (f.command === 'CONNECTED') {
            this.connected = true;
            resolve();
          } else if (f.command === 'ERROR') {
            this.events.onError?.(f.body || 'server ERROR frame');
          } else if (f.command === 'MESSAGE') {
            this.events.onMessage(f);
          }
        }
      };
      ws.onerror = () => {
        this.events.onError?.('websocket error');
        if (!this.connected) reject(new Error(`cannot connect to ${this.url}`));
      };
      ws.onclose = () => {
        this.connected = false;
        this.events.onClose?.();
      };
    });
  }

  subscribe(destination: string, id: string): void {
    this.ws?.send(frame('SUBSCRIBE', { id, destination }));
  }

  send(destination: string, headers: Record<string, string> = {}, body = ''): void {
    this.ws?.send(frame('SEND', { destination, ...headers }, body));
  }

  close(): void {
    this.connected = false;
    this.ws?.close();
    this.ws = null;
  }
}

function frame(command: string, headers: Record<string, string>, body = ''): string {
  let out = `${command}\n`;
  for (const [k, v] of Object.entries(headers)) out += `${k}:${v}\n`;
  out += `\n${body}\0`;
  return out;
}

/** A ws message normally carries one frame; tolerate several. */
function parseFrames(data: string): StompFrame[] {
  const frames: StompFrame[] = [];
  for (const chunk of data.split('\0')) {
    if (!chunk.trim()) continue;
    const text = chunk.replace(/\r\n/g, '\n');
    const headerEnd = text.indexOf('\n\n');
    const head = headerEnd === -1 ? text : text.slice(0, headerEnd);
    const body = headerEnd === -1 ? '' : text.slice(headerEnd + 2);
    const lines = head.split('\n');
    const command = (lines[0] ?? '').trim();
    if (!command) continue;
    const headers: Record<string, string> = {};
    for (let i = 1; i < lines.length; i++) {
      const idx = lines[i]!.indexOf(':');
      if (idx > 0) headers[lines[i]!.slice(0, idx)] = lines[i]!.slice(idx + 1);
    }
    frames.push({ command, headers, body });
  }
  return frames;
}
