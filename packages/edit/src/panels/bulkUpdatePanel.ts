/**
 * Bulk-update tool panel — set a column over filtered/displayed leaf rows.
 * Registers as `toolPanel: 'bulkUpdate'`.
 */
import type { ToolPanelComp, ToolPanelFactory, ToolPanelParams } from '@tabular/core';
import {
  bulkUpdateToRows,
  previewBulkUpdate,
  type BulkUpdatePreviewCell,
} from '../bulkUpdate';
import { parseMagnitude } from '../nudge';
import {
  btnStyle,
  buttonRow,
  displayedColIds,
  displayedLeafRows,
  fieldWrap,
  fmtPreview,
  inputStyle,
  label,
  panelRoot,
  previewList,
  rowIdOf,
  statusLine,
  themeOf,
} from './panelChrome';

function coerceNewValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === '') return '';
  const n = parseMagnitude(trimmed);
  if (Number.isFinite(n) && /[0-9]/.test(trimmed)) return n;
  return raw;
}

export const bulkUpdatePanel: ToolPanelFactory = (
  params: ToolPanelParams,
): ToolPanelComp => {
  const { api, container } = params;
  const t = themeOf(api);

  let colId = '';
  let newValueRaw = '';
  let lastPreview: BulkUpdatePreviewCell[] = [];
  const rowById = new Map<string, Record<string, unknown>>();

  const root = panelRoot(t);

  const colField = fieldWrap();
  colField.appendChild(label(t, 'Column'));
  const colSelect = document.createElement('select');
  Object.assign(colSelect.style, inputStyle(t));
  colSelect.onkeydown = (e) => e.stopPropagation();
  colField.appendChild(colSelect);
  root.appendChild(colField);

  const distinctField = fieldWrap();
  distinctField.appendChild(label(t, 'Distinct values'));
  const distinctBox = document.createElement('div');
  Object.assign(distinctBox.style, {
    ...inputStyle(t),
    maxHeight: '100px',
    overflow: 'auto',
    whiteSpace: 'pre-wrap',
    font: `${t.fontSize - 1}px ${t.fontMono}`,
    color: t.textSecondary,
  });
  distinctBox.textContent = '—';
  distinctField.appendChild(distinctBox);
  root.appendChild(distinctField);

  const valueField = fieldWrap();
  valueField.appendChild(label(t, 'New value'));
  const valueInput = document.createElement('input');
  valueInput.type = 'text';
  valueInput.placeholder = 'value or 1.5k / 2M';
  Object.assign(valueInput.style, inputStyle(t));
  valueInput.oninput = () => {
    newValueRaw = valueInput.value;
  };
  valueInput.onkeydown = (e) => e.stopPropagation();
  valueField.appendChild(valueInput);
  root.appendChild(valueField);

  const hint = document.createElement('div');
  Object.assign(hint.style, {
    fontSize: `${t.fontSize - 1}px`,
    color: t.textSecondary,
    lineHeight: '1.35',
  } satisfies Partial<CSSStyleDeclaration>);
  hint.textContent =
    'Applies to all filtered/displayed leaf rows for the selected column.';
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

  const refreshColumns = (): void => {
    const ids = displayedColIds(api);
    const prev = colId;
    colSelect.replaceChildren();
    for (const id of ids) {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = id;
      colSelect.appendChild(opt);
    }
    colId = ids.includes(prev) ? prev : (ids[0] ?? '');
    colSelect.value = colId;
    refreshDistinct();
  };

  const refreshDistinct = (): void => {
    if (!colId) {
      distinctBox.textContent = '—';
      return;
    }
    const values = api.getDistinctValues(colId);
    const shown = values.slice(0, 40);
    distinctBox.textContent =
      shown.join(', ') + (values.length > 40 ? ` … (+${values.length - 40})` : '') || '(none)';
  };

  colSelect.onchange = () => {
    colId = colSelect.value;
    lastPreview = [];
    refreshDistinct();
  };

  const runPreview = (): boolean => {
    if (!colId) {
      status.textContent = 'Pick a column.';
      return false;
    }
    const rows = displayedLeafRows(api) as Record<string, unknown>[];
    if (!rows.length) {
      status.textContent = 'No displayed rows.';
      list.textContent = '';
      lastPreview = [];
      return false;
    }

    const field = colId; // gap: colId ≡ field for typical column defs
    const value = coerceNewValue(newValueRaw);
    rowById.clear();
    for (let i = 0; i < rows.length; i++) {
      rowById.set(rowIdOf(rows[i], i), rows[i]);
    }

    lastPreview = previewBulkUpdate(
      { field, value, rows },
      (row) => {
        // Prefer data.id; fall back to map scan
        if (typeof row.id === 'string' || typeof row.id === 'number') return String(row.id);
        for (const [id, r] of rowById) {
          if (r === row) return id;
        }
        return String(rowById.size);
      },
    );

    const lines = lastPreview.slice(0, 80).map((c) => {
      return `${c.rowId}.${c.field}: ${fmtPreview(c.before)} → ${fmtPreview(c.after)}`;
    });
    if (lastPreview.length > 80) lines.push(`… +${lastPreview.length - 80} more`);
    list.textContent = lines.join('\n') || '(empty)';
    status.textContent = `${lastPreview.length} row${lastPreview.length === 1 ? '' : 's'}`;
    return true;
  };

  previewBtn.onclick = () => {
    runPreview();
  };

  applyBtn.onclick = () => {
    if (!lastPreview.length && !runPreview()) return;
    if (!lastPreview.length) return;

    const updates = bulkUpdateToRows(lastPreview, (id) => rowById.get(id));
    if (!updates.length) {
      status.textContent = 'Nothing to apply.';
      return;
    }
    api.applyTransaction({ update: updates as never[] });
    status.textContent = `Applied ${updates.length} row update${updates.length === 1 ? '' : 's'}.`;
    lastPreview = [];
    refreshDistinct();
  };

  refreshColumns();
  container.appendChild(root);

  return {
    refresh() {
      refreshColumns();
    },
    destroy() {
      root.remove();
    },
  };
};
