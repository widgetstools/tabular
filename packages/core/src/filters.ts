/**
 * Filter model parsing, display formatting, and row pass logic (plan §4.4).
 */
import type { ColumnFilter, ColDef, FilterModel } from './types';
import type { InternalColumn } from './columnModel';

export type FilterKind = 'text' | 'number' | 'set' | 'date' | false;

export function resolveFilterKind<TData>(
  col: InternalColumn<TData>,
  defaultColDef?: ColDef<TData>,
): FilterKind {
  const inferred = (): FilterKind =>
    col.def.type === 'number' ? 'number' : col.def.type === 'date' ? 'date' : 'text';
  const own = col.def.filter;
  if (own === false) return false;
  if (own === true) return inferred(); // AG `filter: true` — infer from type
  if (own === 'text' || own === 'number' || own === 'set' || own === 'date') return own;
  const def = defaultColDef?.filter;
  if (def === false) return false;
  if (def === true) return inferred();
  if (def === 'text' || def === 'number' || def === 'set' || def === 'date') return def;
  return inferred();
}

export function columnShowsFloatingFilter<TData>(
  col: InternalColumn<TData>,
  globalEnabled: boolean,
  defaultColDef?: ColDef<TData>,
): boolean {
  if (!globalEnabled) return false;
  if (resolveFilterKind(col, defaultColDef) === false) return false;
  if (col.def.floatingFilter === false) return false;
  if (col.def.floatingFilter === true) return true;
  if (defaultColDef?.floatingFilter === false) return false;
  if (defaultColDef?.floatingFilter === true) return true;
  return globalEnabled;
}

/** Date-only key (`YYYY-MM-DD`) from a cell value, or null when unparseable. */
export function dateFilterKey(value: unknown): string | null {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const pad = (n: number): string => String(n).padStart(2, '0');
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(value));
  return m ? m[1] : null;
}

/** Is this model entry the AG date-filter shape? */
export function isDateFilter(f: ColumnFilter): f is import('./types').DateColumnFilter {
  return (f as { filterType?: string }).filterType === 'date';
}

function passesDateFilter(value: unknown, f: import('./types').DateColumnFilter): boolean {
  if (f.type === 'blank') return value == null || value === '';
  if (f.type === 'notBlank') return value != null && value !== '';
  const key = dateFilterKey(value);
  const from = f.dateFrom ? f.dateFrom.slice(0, 10) : null;
  if (!from) return true; // incomplete model — no-op (AG behaviour)
  if (key == null) return false;
  switch (f.type) {
    case 'equals':
      return key === from;
    case 'notEqual':
      return key !== from;
    case 'lessThan':
      return key < from;
    case 'greaterThan':
      return key > from;
    case 'inRange': {
      const to = f.dateTo ? f.dateTo.slice(0, 10) : null;
      return to ? key >= from && key <= to : key >= from;
    }
  }
}

export function formatFilterDisplay(filter: ColumnFilter | undefined): string {
  if (!filter) return '';
  if (isDateFilter(filter)) {
    const from = filter.dateFrom?.slice(0, 10) ?? '';
    switch (filter.type) {
      case 'equals':
        return `= ${from}`;
      case 'notEqual':
        return `≠ ${from}`;
      case 'lessThan':
        return `< ${from}`;
      case 'greaterThan':
        return `> ${from}`;
      case 'inRange':
        return `${from}–${filter.dateTo?.slice(0, 10) ?? ''}`;
      case 'blank':
        return '(blank)';
      case 'notBlank':
        return '(not blank)';
    }
  }
  switch (filter.type) {
    case 'contains':
      return filter.filter;
    case 'notContains':
      return `!${filter.filter}`;
    case 'equals':
      return `= ${filter.filter}`;
    case 'notEqual':
      return `≠ ${filter.filter}`;
    case 'startsWith':
      return `${filter.filter}…`;
    case 'endsWith':
      return `…${filter.filter}`;
    case 'greaterThan':
      return `> ${filter.filter}`;
    case 'greaterThanOrEqual':
      return `>= ${filter.filter}`;
    case 'lessThan':
      return `< ${filter.filter}`;
    case 'lessThanOrEqual':
      return `<= ${filter.filter}`;
    case 'inRange':
      return `${filter.filter}–${filter.filterTo}`;
    case 'blank':
      return '(blank)';
    case 'notBlank':
      return '(not blank)';
    case 'set':
      return `(${filter.values.length}) ${filter.values.join(', ')}`;
  }
}

export const SET_FILTER_BLANKS = '(Blanks)';

/** Stable string key a raw cell value contributes to a set filter. */
export function setFilterKey(value: unknown): string {
  return value == null || value === '' ? SET_FILTER_BLANKS : String(value);
}

/** Parse floating-filter input into a column filter model entry. */
export function parseFloatingFilterInput(
  raw: string,
  kind: FilterKind,
): ColumnFilter | null {
  const text = raw.trim();
  if (!text) return null;
  if (kind === 'date') {
    const date = (s: string): string | null => (/^\d{4}-\d{2}-\d{2}$/.test(s.trim()) ? s.trim() : null);
    const mk = (
      type: 'equals' | 'notEqual' | 'lessThan' | 'greaterThan',
      s: string,
    ): ColumnFilter | null => {
      const d = date(s);
      return d ? { filterType: 'date', type, dateFrom: d } : null;
    };
    if (text.startsWith('!=') || text.startsWith('<>')) return mk('notEqual', text.slice(2));
    if (text.startsWith('>=') || text.startsWith('<=')) return mk(text[0] === '>' ? 'greaterThan' : 'lessThan', text.slice(2));
    if (text.startsWith('>')) return mk('greaterThan', text.slice(1));
    if (text.startsWith('<')) return mk('lessThan', text.slice(1));
    if (text.startsWith('=')) return mk('equals', text.slice(1));
    const range = text.split(/\s*(?:–|\.\.|to)\s*/i);
    if (range.length === 2) {
      const a = date(range[0]);
      const b = date(range[1]);
      if (a && b) return { filterType: 'date', type: 'inRange', dateFrom: a, dateTo: b };
    }
    return mk('equals', text);
  }
  if (kind === 'number') {
    if (text.startsWith('>=')) {
      const n = Number(text.slice(2).trim());
      return Number.isNaN(n) ? null : { type: 'greaterThanOrEqual', filter: n };
    }
    if (text.startsWith('<=')) {
      const n = Number(text.slice(2).trim());
      return Number.isNaN(n) ? null : { type: 'lessThanOrEqual', filter: n };
    }
    if (text.startsWith('!=') || text.startsWith('<>')) {
      const n = Number(text.slice(2).trim());
      return Number.isNaN(n) ? null : { type: 'notEqual', filter: n };
    }
    if (text.startsWith('>')) {
      const n = Number(text.slice(1).trim());
      return Number.isNaN(n) ? null : { type: 'greaterThan', filter: n };
    }
    if (text.startsWith('<')) {
      const n = Number(text.slice(1).trim());
      return Number.isNaN(n) ? null : { type: 'lessThan', filter: n };
    }
    const range = text.split(/[-–]/).map((s) => Number(s.trim()));
    if (range.length === 2 && !Number.isNaN(range[0]) && !Number.isNaN(range[1])) {
      const [a, b] = range[0] <= range[1] ? range : [range[1], range[0]];
      return { type: 'inRange', filter: a, filterTo: b };
    }
    const n = Number(text.replace(/,/g, ''));
    return Number.isNaN(n) ? null : { type: 'equals', filter: n };
  }
  if (text.startsWith('!=')) {
    return { type: 'notEqual', filter: text.slice(2).trim() };
  }
  if (text.startsWith('=')) {
    return { type: 'equals', filter: text.slice(1).trim() };
  }
  if (text.startsWith('!')) {
    const stem = text.slice(1).trim();
    return stem ? { type: 'notContains', filter: stem } : null;
  }
  if (text.endsWith('…') || text.endsWith('...')) {
    const stem = text.replace(/\.{2,3}$/, '').replace(/…$/, '');
    return stem ? { type: 'startsWith', filter: stem } : null;
  }
  if (text.startsWith('…') || text.startsWith('...')) {
    const stem = text.replace(/^\.{2,3}/, '').replace(/^…/, '');
    return stem ? { type: 'endsWith', filter: stem } : null;
  }
  return { type: 'contains', filter: text };
}

export function passesFilter(value: unknown, f: ColumnFilter): boolean {
  if (isDateFilter(f)) return passesDateFilter(value, f);
  const eq = (filter: string | number): boolean => {
    if (typeof filter === 'number') return typeof value === 'number' && value === filter;
    return value != null && String(value).toLowerCase() === filter.toLowerCase();
  };
  switch (f.type) {
    case 'contains':
      return value != null && String(value).toLowerCase().includes(f.filter.toLowerCase());
    case 'notContains':
      return value == null || !String(value).toLowerCase().includes(f.filter.toLowerCase());
    case 'equals':
      return eq(f.filter);
    case 'notEqual':
      return !eq(f.filter);
    case 'startsWith':
      return value != null && String(value).toLowerCase().startsWith(f.filter.toLowerCase());
    case 'endsWith':
      return value != null && String(value).toLowerCase().endsWith(f.filter.toLowerCase());
    case 'greaterThan':
      return typeof value === 'number' && value > f.filter;
    case 'greaterThanOrEqual':
      return typeof value === 'number' && value >= f.filter;
    case 'lessThan':
      return typeof value === 'number' && value < f.filter;
    case 'lessThanOrEqual':
      return typeof value === 'number' && value <= f.filter;
    case 'inRange':
      return typeof value === 'number' && value >= f.filter && value <= f.filterTo;
    case 'blank':
      return value == null || value === '';
    case 'notBlank':
      return value != null && value !== '';
    case 'set':
      return f.values.includes(setFilterKey(value));
  }
}

export function tokenizeQuickFilter(text: string): string[] {
  return text.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

export function rowPassesQuickFilter<TData>(
  row: TData,
  rowIndex: number,
  tokens: string[],
  cols: InternalColumn<TData>[],
  valueOf: (row: TData, col: InternalColumn<TData>, rowIndex: number) => unknown,
): boolean {
  if (!tokens.length) return true;
  for (const token of tokens) {
    let hit = false;
    for (const col of cols) {
      const v = valueOf(row, col, rowIndex);
      if (v != null && String(v).toLowerCase().includes(token)) {
        hit = true;
        break;
      }
    }
    if (!hit) return false;
  }
  return true;
}

export function activeFilterColIds(model: FilterModel): Set<string> {
  return new Set(Object.keys(model));
}
