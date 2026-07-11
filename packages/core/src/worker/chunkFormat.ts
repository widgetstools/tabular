/**
 * Packed text encoding for viewport chunks (W5). Offset-encoded UTF-8
 * strings ride as transferables alongside Float64 numeric columns.
 */
import type { ViewportChunk } from './protocol';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeText(strings: string[]): { offsets: Uint32Array; bytes: Uint8Array } {
  const encoded = strings.map((s) => encoder.encode(s ?? ''));
  let total = 0;
  for (const e of encoded) total += e.byteLength;
  const offsets = new Uint32Array(strings.length + 1);
  const bytes = new Uint8Array(total);
  let pos = 0;
  for (let i = 0; i < encoded.length; i++) {
    offsets[i] = pos;
    bytes.set(encoded[i]!, pos);
    pos += encoded[i]!.byteLength;
  }
  offsets[strings.length] = pos;
  return { offsets, bytes };
}

export function decodeText(offsets: Uint32Array, bytes: Uint8Array): string[] {
  const out: string[] = [];
  for (let i = 0; i < offsets.length - 1; i++) {
    const start = offsets[i]!;
    const end = offsets[i + 1]!;
    out.push(decoder.decode(bytes.subarray(start, end)));
  }
  return out;
}

/** Build the transfer list for a viewport response. */
export function collectViewportTransferables(chunk: ViewportChunk): ArrayBufferLike[] {
  const out: ArrayBufferLike[] = [
    chunk.rowKinds.buffer,
    chunk.levels.buffer,
    chunk.heights.buffer,
  ];
  for (const arr of Object.values(chunk.numericCols)) out.push(arr.buffer);
  for (const tc of Object.values(chunk.textCols)) {
    out.push(tc.offsets.buffer, tc.bytes.buffer);
  }
  if (chunk.groupChildCount) out.push(chunk.groupChildCount.buffer);
  if (chunk.isExpanded) out.push(chunk.isExpanded.buffer);
  return out;
}
