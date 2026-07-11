/**
 * Editing strip — HISTORY · SMART EDIT · BULK (above the formatting ribbon).
 * Mirrors cgrid-ext-demo layout; wires @tabular/edit + undo/redo.
 */
import {
  previewSmartEdit,
  smartEditToUpdates,
  type SmartEditOp,
} from '@tabular/edit';
import { parseMagnitude } from '@tabular/edit';
import type { ExtContext } from './context';
import { ICON, svg } from './ui';

function h(cls: string): HTMLDivElement {
  const d = document.createElement('div');
  d.className = cls;
  return d;
}

function iconBtn(icon: string, title: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'tx-rb-btn';
  b.title = title;
  b.setAttribute('aria-label', title);
  b.innerHTML = svg(icon, 14);
  return b;
}

function collectRangeCells(api: ExtContext['api']): Array<{
  rowId: string;
  colId: string;
  value: unknown;
  row: Record<string, unknown>;
}> {
  const order = api.getColumnState().map((c) => c.colId);
  let ranges = api.getCellRanges();
  if (!ranges.length) {
    const focused = api.getFocusedCell();
    if (focused) ranges = [{ start: focused, end: focused }];
  }
  const cells: Array<{ rowId: string; colId: string; value: unknown; row: Record<string, unknown> }> = [];
  const seen = new Set<string>();
  for (const range of ranges) {
    const r0 = Math.min(range.start.rowIndex, range.end.rowIndex);
    const r1 = Math.max(range.start.rowIndex, range.end.rowIndex);
    const i0 = order.indexOf(range.start.colId);
    const i1 = order.indexOf(range.end.colId);
    const colIds =
      i0 >= 0 && i1 >= 0
        ? order.slice(Math.min(i0, i1), Math.max(i0, i1) + 1)
        : [...new Set([range.start.colId, range.end.colId])];
    for (let r = r0; r <= r1; r++) {
      const row = api.getDisplayedRowAtIndex(r) as Record<string, unknown> | undefined;
      if (!row) continue;
      const rowId =
        typeof (row as { id?: unknown }).id === 'string'
          ? String((row as { id: string }).id)
          : `row-${r}`;
      try {
        // Prefer getRowId if the grid exposes it via options — fall back above.
        const gid = (api as { getRowNode?: (id: string) => unknown }).getRowNode;
        void gid;
      } catch {
        /* ignore */
      }
      for (const colId of colIds) {
        const key = `${rowId}\0${colId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        cells.push({
          rowId,
          colId,
          value: api.getDisplayedCellValue(r, colId),
          row,
        });
      }
    }
  }
  // Re-derive rowIds via getRowId when available
  const getRowId = api.getGridOption('getRowId') as
    | ((p: { data: Record<string, unknown> }) => string)
    | undefined;
  if (getRowId) {
    for (const c of cells) {
      try {
        c.rowId = getRowId({ data: c.row });
      } catch {
        /* keep fallback */
      }
    }
  }
  return cells;
}

export function mountEditStrip(
  host: HTMLElement,
  ctx: ExtContext<any>,
): { destroy: () => void; refresh: () => void } {
  host.className = 'tx-edit-strip';
  host.dataset.toolbar = 'editing';
  host.replaceChildren();

  const undo = iconBtn(ICON.undo, 'Undo');
  const redo = iconBtn(ICON.redo, 'Redo');
  const histCount = document.createElement('span');
  histCount.className = 'tx-es-stat';
  histCount.textContent = '0 entries';

  const operand = document.createElement('input');
  operand.type = 'text';
  operand.className = 'tx-rb-input';
  operand.value = '1';
  operand.style.width = '44px';
  operand.title = 'Smart-edit operand (k/M/B ok)';

  const opMul = iconBtn('M6 6l12 12M18 6L6 18', 'Multiply');
  const opDiv = iconBtn('M5 12h14M12 6h.01M12 18h.01', 'Divide');
  const opAdd = iconBtn('M12 5v14M5 12h14', 'Add');
  const opSub = iconBtn('M5 12h14', 'Subtract');
  const setBtn = document.createElement('button');
  setBtn.type = 'button';
  setBtn.className = 'tx-rb-pill';
  setBtn.textContent = 'Set…';
  const smartCount = document.createElement('span');
  smartCount.className = 'tx-es-stat';
  smartCount.textContent = '0 cells';

  const bulkValue = document.createElement('input');
  bulkValue.type = 'text';
  bulkValue.className = 'tx-rb-input';
  bulkValue.placeholder = 'New value';
  bulkValue.style.width = '96px';
  const bulkApply = iconBtn(ICON.check, 'Apply bulk value');
  const bulkCount = document.createElement('span');
  bulkCount.className = 'tx-es-stat';
  bulkCount.textContent = '0 selected';

  const seg = (label: string, ...controls: HTMLElement[]): HTMLElement => {
    const s = h('tx-es-seg');
    const l = document.createElement('span');
    l.className = 'tx-es-label';
    l.textContent = label;
    s.append(l, ...controls);
    return s;
  };

  host.append(
    seg('History', undo, redo, histCount),
    seg('Smart edit', operand, opMul, opDiv, opAdd, opSub, setBtn, smartCount),
    seg('Bulk', bulkValue, bulkApply, bulkCount),
  );

  const runSmart = (op: SmartEditOp) => {
    const cells = collectRangeCells(ctx.api);
    const n = parseMagnitude(operand.value);
    if (!cells.length || !Number.isFinite(n)) return;
    const preview = previewSmartEdit({
      op,
      operand: n,
      cells: cells.map((c) => ({ rowId: c.rowId, colId: c.colId, value: c.value })),
    });
    const byId = new Map(cells.map((c) => [c.rowId, c.row]));
    const updates = smartEditToUpdates(
      preview,
      (id) => byId.get(id),
      (colId) => colId,
    );
    if (updates.length) {
      ctx.api.applyTransaction({ update: updates as never[] });
      ctx.markDirty(true);
    }
    refresh();
  };

  const runSet = () => {
    const raw = window.prompt('Set selected cells to', operand.value);
    if (raw == null) return;
    const cells = collectRangeCells(ctx.api);
    if (!cells.length) return;
    const num = parseMagnitude(raw);
    const value: unknown = Number.isFinite(num) && raw.trim() !== '' && /^-?[\d.kKmMbB]+$/.test(raw.trim())
      ? num
      : raw;
    const byId = new Map<string, Record<string, unknown>>();
    for (const c of cells) {
      let row = byId.get(c.rowId);
      if (!row) {
        row = { ...c.row };
        byId.set(c.rowId, row);
      }
      row[c.colId] = value;
    }
    ctx.api.applyTransaction({ update: [...byId.values()] as never[] });
    ctx.markDirty(true);
    refresh();
  };

  const runBulk = () => {
    const cells = collectRangeCells(ctx.api);
    if (!cells.length) return;
    const raw = bulkValue.value;
    const num = parseMagnitude(raw);
    const value: unknown =
      raw.trim() === ''
        ? ''
        : Number.isFinite(num) && /^-?[\d.kKmMbB]+$/.test(raw.trim())
          ? num
          : raw;
    const byId = new Map<string, Record<string, unknown>>();
    for (const c of cells) {
      let row = byId.get(c.rowId);
      if (!row) {
        row = { ...c.row };
        byId.set(c.rowId, row);
      }
      row[c.colId] = value;
    }
    ctx.api.applyTransaction({ update: [...byId.values()] as never[] });
    ctx.markDirty(true);
    refresh();
  };

  undo.addEventListener('click', () => {
    try {
      ctx.api.undoCellEditing();
    } catch {
      /* ignore */
    }
    refresh();
  });
  redo.addEventListener('click', () => {
    try {
      ctx.api.redoCellEditing();
    } catch {
      /* ignore */
    }
    refresh();
  });
  opMul.addEventListener('click', () => runSmart('mul'));
  opDiv.addEventListener('click', () => runSmart('div'));
  opAdd.addEventListener('click', () => runSmart('add'));
  opSub.addEventListener('click', () => runSmart('sub'));
  setBtn.addEventListener('click', runSet);
  bulkApply.addEventListener('click', runBulk);
  bulkValue.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runBulk();
  });

  const smartOps = [opMul, opDiv, opAdd, opSub, setBtn, bulkApply];

  function refresh(): void {
    const cells = collectRangeCells(ctx.api);
    const n = cells.length;
    const has = n > 0;
    for (const b of smartOps) b.disabled = !has;
    smartCount.textContent = `${n} cell${n === 1 ? '' : 's'}`;
    bulkCount.textContent = `${n} selected`;
    let undoSize = 0;
    let redoSize = 0;
    try {
      undoSize = ctx.api.getCurrentUndoSize?.() ?? 0;
      redoSize = ctx.api.getCurrentRedoSize?.() ?? 0;
    } catch {
      /* ignore */
    }
    undo.disabled = undoSize <= 0;
    redo.disabled = redoSize <= 0;
    histCount.textContent = `${undoSize} entr${undoSize === 1 ? 'y' : 'ies'}`;
  }

  const cleanups = [
    ctx.api.on('cellSelectionChanged', refresh),
    ctx.api.on('cellClicked', refresh),
    ctx.api.on('cellValueChanged', refresh),
  ];

  refresh();

  return {
    destroy: () => {
      for (const fn of cleanups) fn();
      host.replaceChildren();
    },
    refresh,
  };
}
