/**
 * Smart-edit tool panel — range-targeted × ÷ + − with preview / apply.
 * Registers as `toolPanel: 'smartEdit'`.
 */
import type { ToolPanelComp, ToolPanelFactory, ToolPanelParams } from '@tabular/core';
import {
  previewSmartEdit,
  smartEditToUpdates,
  type SmartEditOp,
  type SmartEditPreviewCell,
} from '../smartEdit';
import {
  btnStyle,
  buttonRow,
  displayedColIds,
  fieldWrap,
  fmtPreview,
  inputStyle,
  label,
  panelRoot,
  parseOperand,
  previewList,
  rowIdOf,
  statusLine,
  themeOf,
} from './panelChrome';

const OP_OPTIONS: Array<{ value: SmartEditOp; label: string }> = [
  { value: 'mul', label: '×' },
  { value: 'div', label: '÷' },
  { value: 'add', label: '+' },
  { value: 'sub', label: '−' },
];

interface RangeCell {
  rowId: string;
  colId: string;
  value: unknown;
  row: Record<string, unknown>;
}

function collectRangeCells<TData>(api: ToolPanelParams<TData>['api']): RangeCell[] {
  const cols = displayedColIds(api);
  let ranges = api.getCellRanges();
  if (!ranges.length) {
    const focused = api.getFocusedCell();
    if (focused) ranges = [{ start: focused, end: focused }];
  }
  const cells: RangeCell[] = [];
  const seen = new Set<string>();

  for (const range of ranges) {
    const r0 = Math.min(range.start.rowIndex, range.end.rowIndex);
    const r1 = Math.max(range.start.rowIndex, range.end.rowIndex);
    const i0 = cols.indexOf(range.start.colId);
    const i1 = cols.indexOf(range.end.colId);
    const colIds =
      i0 >= 0 && i1 >= 0
        ? cols.slice(Math.min(i0, i1), Math.max(i0, i1) + 1)
        : [...new Set([range.start.colId, range.end.colId])];

    for (let r = r0; r <= r1; r++) {
      const row = api.getDisplayedRowAtIndex(r) as Record<string, unknown> | undefined;
      if (!row) continue; // group / footer / detail
      const rowId = rowIdOf(row, r);
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
  return cells;
}

export const smartEditPanel: ToolPanelFactory = (
  params: ToolPanelParams,
): ToolPanelComp => {
  const { api, container } = params;
  const t = themeOf(api);

  let op: SmartEditOp = 'mul';
  let operandRaw = '1';
  let lastPreview: SmartEditPreviewCell[] = [];
  const rowById = new Map<string, Record<string, unknown>>();

  const root = panelRoot(t);

  const opField = fieldWrap();
  opField.appendChild(label(t, 'Operation'));
  const opSelect = document.createElement('select');
  Object.assign(opSelect.style, inputStyle(t));
  for (const o of OP_OPTIONS) {
    const opt = document.createElement('option');
    opt.value = o.value;
    opt.textContent = o.label;
    opSelect.appendChild(opt);
  }
  opSelect.value = op;
  opSelect.onchange = () => {
    op = opSelect.value as SmartEditOp;
  };
  opSelect.onkeydown = (e) => e.stopPropagation();
  opField.appendChild(opSelect);
  root.appendChild(opField);

  const operandField = fieldWrap();
  operandField.appendChild(label(t, 'Operand'));
  const operandInput = document.createElement('input');
  operandInput.type = 'text';
  operandInput.inputMode = 'decimal';
  operandInput.placeholder = 'e.g. 1.5k, 2M';
  operandInput.value = operandRaw;
  Object.assign(operandInput.style, inputStyle(t));
  operandInput.oninput = () => {
    operandRaw = operandInput.value;
  };
  operandInput.onkeydown = (e) => e.stopPropagation();
  operandField.appendChild(operandInput);
  root.appendChild(operandField);

  const hint = document.createElement('div');
  Object.assign(hint.style, {
    fontSize: `${t.fontSize - 1}px`,
    color: t.textSecondary,
    lineHeight: '1.35',
  } satisfies Partial<CSSStyleDeclaration>);
  hint.textContent =
    'Select a cell range, then Preview / Apply. Operand accepts k/M/B suffixes.';
  root.appendChild(hint);

  const buttons = buttonRow();
  const previewBtn = document.createElement('button');
  previewBtn.type = 'button';
  previewBtn.textContent = 'Preview';
  Object.assign(previewBtn.style, btnStyle(t));
  const applyBtn = document.createElement('button');
  applyBtn.type = 'button';
  applyBtn.textContent = 'Apply';
  Object.assign(applyBtn.style, btnStyle(t, true));
  buttons.appendChild(previewBtn);
  buttons.appendChild(applyBtn);
  root.appendChild(buttons);

  const status = statusLine(t);
  root.appendChild(status);

  const list = previewList(t);
  list.textContent = 'No preview yet.';
  root.appendChild(list);

  const runPreview = (): boolean => {
    const operand = parseOperand(operandRaw);
    if (!Number.isFinite(operand)) {
      status.textContent = 'Invalid operand.';
      list.textContent = '';
      lastPreview = [];
      return false;
    }
    const cells = collectRangeCells(api);
    if (!cells.length) {
      status.textContent = 'No cell range selected.';
      list.textContent = '';
      lastPreview = [];
      return false;
    }
    rowById.clear();
    for (const c of cells) rowById.set(c.rowId, c.row);

    lastPreview = previewSmartEdit({
      op,
      operand,
      cells: cells.map((c) => ({ rowId: c.rowId, colId: c.colId, value: c.value })),
    });

    const lines = lastPreview.slice(0, 80).map((c) => {
      return `${c.rowId}.${c.colId}: ${fmtPreview(c.before)} → ${fmtPreview(c.after)}`;
    });
    if (lastPreview.length > 80) lines.push(`… +${lastPreview.length - 80} more`);
    list.textContent = lines.join('\n') || '(empty)';
    status.textContent = `${lastPreview.length} cell${lastPreview.length === 1 ? '' : 's'}`;
    return true;
  };

  previewBtn.onclick = () => {
    runPreview();
  };

  applyBtn.onclick = () => {
    if (!lastPreview.length && !runPreview()) return;
    if (!lastPreview.length) return;

    const updates = smartEditToUpdates(
      lastPreview,
      (id) => rowById.get(id),
      (colId) => colId, // gap: no public field-for-colId; colId ≡ field for typical defs
    );
    if (!updates.length) {
      status.textContent = 'Nothing to apply.';
      return;
    }
    api.applyTransaction({ update: updates as never[] });
    status.textContent = `Applied ${updates.length} row update${updates.length === 1 ? '' : 's'}.`;
    lastPreview = [];
  };

  container.appendChild(root);
  return {
    refresh() {
      /* selection-driven; user re-previews */
    },
    destroy() {
      root.remove();
    },
  };
};
