/**
 * FI position flattening + union-schema inference, shared by the pages that
 * feed the FULL nested payload into Perspective (PerspectiveStress, PGrid).
 */
import type { FiPosition } from './fiPositionsSource';

export type FlatRow = Record<string, string | number | boolean | null>;

/** Flatten nested objects to dot-path columns; non-scalar leaves become null. */
export function flatten(row: FiPosition): FlatRow {
  const out: FlatRow = {};
  const walk = (obj: Record<string, unknown>, prefix: string): void => {
    for (const [k, v] of Object.entries(obj)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
        walk(v as Record<string, unknown>, key);
      } else if (
        typeof v === 'string' ||
        typeof v === 'number' ||
        typeof v === 'boolean'
      ) {
        out[key] = v;
      } else {
        out[key] = null;
      }
    }
  };
  walk(row, '');
  return out;
}

/** Union schema over all rows; type conflicts degrade to string. */
export function buildSchema(rows: FlatRow[]): Record<string, string> {
  const schema: Record<string, string> = {};
  for (const row of rows) {
    for (const [k, v] of Object.entries(row)) {
      if (v === null || schema[k] === 'string') continue;
      const t =
        typeof v === 'number' ? 'float' : typeof v === 'boolean' ? 'boolean' : 'string';
      if (!(k in schema)) schema[k] = t;
      else if (schema[k] !== t) schema[k] = 'string';
    }
  }
  return schema;
}
