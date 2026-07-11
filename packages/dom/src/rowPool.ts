/**
 * Fixed pool of row divs bound from a `RenderView`. Rows are recycled via
 * `poolSlot` (stable slot assignment, DOM analog of the canvas scroll blit)
 * so advancing the window by one row rebinds exactly one element instead of
 * churning the whole pool.
 */

import type { InternalColumn } from '@tabular/core';
import { CLS } from './styles';
import { poolSlot } from './window';
import type { RenderView } from './renderView';

/** Column layout the pool needs to position and size cells; recomputed by the caller on resize/column changes. */
export interface PoolGeometry<TData> {
  /** Columns in display order. */
  cols: InternalColumn<TData>[];
  /** Accumulated left offset (px) for the column at display index `i`. */
  colLeft: (i: number) => number;
  /** Row height in px (matches `--td-row-h`). */
  rowHeight: number;
  /** Px added to the first cell's left padding per group nesting level. */
  groupIndent: number;
  /** Sum of all column widths, used to size each row div. */
  totalWidth: number;
}

/** A single recycled row element plus its bound cells and current row binding. */
interface Slot {
  el: HTMLDivElement;
  cells: HTMLDivElement[];
  /** Row index currently bound to this slot; -1 = unbound. */
  boundRow: number;
  /** Content is untrusted after a model refresh; forces a full re-stamp. */
  dirty: boolean;
}

/**
 * Fixed-size pool of row elements recycled across scroll positions. Bind a
 * viewport window with `bindWindow`; patch a single cell (e.g. on a
 * worker-pushed update) with `rebindCell`.
 */
export class RowPool<TData> {
  private slots: Slot[] = [];
  private size = 0;
  constructor(private readonly layer: HTMLElement) {}

  /** (Re)allocates the pool to `size` row elements, each with `colCount` cells. Discards any existing pool. */
  setSize(size: number, colCount: number): void {
    this.clear();
    this.size = size;
    for (let s = 0; s < size; s++) {
      const el = document.createElement('div');
      el.className = CLS.row;
      const cells: HTMLDivElement[] = [];
      for (let c = 0; c < colCount; c++) {
        const cell = document.createElement('div');
        cell.className = CLS.cell;
        el.appendChild(cell);
        cells.push(cell);
      }
      this.layer.appendChild(el);
      this.slots.push({ el, cells, boundRow: -1, dirty: false });
    }
  }

  /**
   * Binds the pool to display rows `[firstRow, lastRow]` from `view`. Rows
   * whose data is not yet available keep their previous pixels if still in
   * window, or are hidden otherwise; slots that fall outside the window are
   * hidden and unbound.
   */
  bindWindow(
    firstRow: number, lastRow: number,
    view: RenderView<TData>, geo: PoolGeometry<TData>,
    selected: ReadonlySet<string>, focused: { rowIndex: number; colId: string } | null,
  ): void {
    view.requestWindow(firstRow, lastRow);
    for (let r = firstRow; r <= lastRow; r++) {
      const slot = this.slots[poolSlot(r, this.size)];
      if (!slot) continue;
      const meta = view.rowMeta(r);
      if (!meta) {
        // Data in flight: keep previous pixels only if this slot still shows
        // a row inside the window AND that content is trusted; after a model
        // refresh (dirty) stale pixels are untrusted, so hide instead.
        if (slot.boundRow < firstRow || slot.boundRow > lastRow || slot.dirty) {
          slot.el.style.display = 'none';
          slot.boundRow = -1;
          slot.dirty = false;
        }
        continue;
      }
      slot.el.style.display = '';
      slot.el.style.transform = `translate3d(0, ${r * geo.rowHeight}px, 0)`;
      slot.el.style.width = `${geo.totalWidth}px`;
      slot.el.dataset.row = String(r);
      slot.el.dataset.odd = r % 2 === 1 ? '1' : '0';
      slot.el.classList.toggle(CLS.group, meta.kind === 'group');
      slot.el.classList.toggle(CLS.footer, meta.kind === 'footer');
      slot.el.classList.toggle(CLS.selected, selected.has(meta.id));
      const rebindAll = slot.boundRow !== r || slot.dirty;
      for (let c = 0; c < geo.cols.length; c++) {
        this.stampCell(slot, r, c, view, geo, focused, rebindAll);
      }
      slot.boundRow = r;
      slot.dirty = false;
    }
    for (const slot of this.slots) {
      if (slot.boundRow !== -1 && (slot.boundRow < firstRow || slot.boundRow > lastRow)) {
        slot.el.style.display = 'none';
        slot.boundRow = -1;
      }
    }
  }

  private stampCell(
    slot: Slot, r: number, c: number,
    view: RenderView<TData>, geo: PoolGeometry<TData>,
    focused: { rowIndex: number; colId: string } | null,
    rebindAll: boolean,
  ): void {
    const col = geo.cols[c];
    const cell = slot.cells[c];
    if (!col || !cell) return;
    const focusedHere = focused?.rowIndex === r && focused.colId === col.colId;
    if (!rebindAll) {
      cell.classList.toggle(CLS.focusCell, focusedHere);
      return;
    }
    cell.style.left = `${geo.colLeft(c)}px`;
    cell.style.width = `${col.width}px`;
    const meta = view.rowMeta(r);
    cell.style.paddingLeft = meta?.kind === 'group' && c === 0
      ? `${meta.level * geo.groupIndent + 20}px` : '';
    const cr = view.cell(r, c);
    const isNum = col.def.type === 'number';
    // Preserve an in-flight tick flash when re-stamping the SAME row (a dirty
    // re-stamp, e.g. an async worker window/aggregate refresh) so the animation
    // isn't cut short. `slot.boundRow` still holds the pre-bind value here, so
    // it equals `r` only for a same-row re-stamp — never for a fresh row bind.
    const keepFlash =
      slot.boundRow === r && cell.classList.contains(CLS.flashUp)
        ? ` ${CLS.flashUp}`
        : slot.boundRow === r && cell.classList.contains(CLS.flashDown)
          ? ` ${CLS.flashDown}`
          : '';
    cell.className = `${CLS.cell}${isNum ? ` ${CLS.num}` : ''}${cr?.styleClass ? ` ${cr.styleClass}` : ''}${keepFlash}`;
    cell.classList.toggle(CLS.focusCell, focusedHere);
    const text = cr?.text ?? '';
    if (cell.textContent !== text) cell.textContent = text;
  }

  /**
   * Re-stamps a single cell in-place (e.g. after a worker-pushed value
   * update) without touching the rest of the bound row. Returns false if
   * `rowIndex` is not currently bound to any slot. When `flashDir` is
   * nonzero, retriggers the up/down flash CSS animation on the cell.
   *
   * Note: this clears the cell's focus outline (stampCell is called with
   * `focused: null`); the grid re-applies focus on the next `bindWindow` —
   * acceptable for tick cells.
   */
  rebindCell(rowIndex: number, colIndex: number, view: RenderView<TData>, geo: PoolGeometry<TData>, flashDir: 1 | -1 | 0): boolean {
    const slot = this.slots[poolSlot(rowIndex, this.size)];
    if (!slot || slot.boundRow !== rowIndex) return false;
    this.stampCell(slot, rowIndex, colIndex, view, geo, null, true);
    if (flashDir !== 0) {
      const cell = slot.cells[colIndex];
      if (cell) {
        cell.classList.remove(CLS.flashUp, CLS.flashDown);
        void cell.offsetWidth; // retrigger the CSS animation
        cell.classList.add(flashDir > 0 ? CLS.flashUp : CLS.flashDown);
      }
    }
    return true;
  }

  /**
   * Marks every slot dirty without touching the DOM or `boundRow`, so the
   * next `bindWindow` re-stamps every cell (and its cleanup pass can still
   * hide slots that fell out of a shrunken window, which keys off real
   * `boundRow` values). The grid calls this after any model refresh
   * (sort/filter/group) or column-set change — where row content changes but
   * row indices largely don't — before the next `bindWindow`. Elements are
   * not hidden or cleared, so the repaint is flicker-free.
   */
  invalidate(): void {
    for (const s of this.slots) s.dirty = true;
  }

  /** Removes all row elements from the DOM and empties the pool. */
  clear(): void {
    for (const s of this.slots) s.el.remove();
    this.slots = [];
    this.size = 0;
  }
}
