/**
 * Recycled row pool — position-keyed slots bound from a RenderView (spec §6).
 * Stamping is textContent + class swaps + geometry inline styles only (Global
 * Constraints): no listeners here — the grid root delegates events.
 *
 * Rows position window-relatively (`translate3d` of `(r - firstRow) * rowH -
 * subCellPx`) inside a layer the grid places at the window top, so the 10M-px
 * spacer clamp never reaches element coordinates.
 */
import type { RenderView } from './materializer';
import { CLS } from './styles';
import { poolSlot } from './windowMath';
import type { Viewport } from './windowMath';

/** Px reserved for the expand/collapse chevron ahead of a group row's first cell. */
const CHEVRON_W = 20;

/** Column layout the pool needs to place cells; recomputed by the grid on resize/column changes. */
export interface PoolGeometry {
  /** Width per column, absolute display index. */
  colWidths: number[];
  /** Accumulated left edge per column, absolute display index. */
  colLefts: number[];
  /** Row height in px (matches `--pg-row-h`). */
  rowHeight: number;
  /** Px added per group nesting level to the first visible cell's indent. */
  groupIndent: number;
  /** Sum of all column widths — sizes each row element. */
  totalWidth: number;
  /** Visible column window (column virtualization): only these get cells. */
  firstCol: number;
  lastCol: number;
}

/** One recycled row element: cells for the visible columns plus a chevron for group rows. */
interface Slot {
  el: HTMLDivElement;
  chevron: HTMLDivElement;
  cells: HTMLDivElement[];
  /** Row index currently bound; -1 = unbound. */
  boundRow: number;
}

/**
 * Fixed-size pool of row elements recycled across scroll positions via
 * `poolSlot`. Resize with `setSize` whenever the pool size or the visible
 * column count changes; bind every frame with `bindWindow`.
 */
export class RowPool {
  private slots: Slot[] = [];
  private size = 0;

  constructor(private readonly layer: HTMLElement) {}

  /** (Re)allocates `size` row elements with `colCount` cells each. Discards the existing pool. */
  setSize(size: number, colCount: number): void {
    this.clear();
    this.size = size;
    for (let s = 0; s < size; s++) {
      const el = document.createElement('div');
      el.className = CLS.row;
      el.style.display = 'none';
      const chevron = document.createElement('div');
      chevron.className = CLS.chevron;
      el.appendChild(chevron);
      const cells: HTMLDivElement[] = [];
      for (let c = 0; c < colCount; c++) {
        const cell = document.createElement('div');
        cell.className = CLS.cell;
        el.appendChild(cell);
        cells.push(cell);
      }
      this.layer.appendChild(el);
      this.slots.push({ el, chevron, cells, boundRow: -1 });
    }
  }

  /**
   * Stamps every slot for the window in `v`. Rows whose data is still in
   * flight keep their previous pixels (repositioned) if they remain inside the
   * window, and hide otherwise; slots outside the window hide and unbind.
   */
  bindWindow(v: Viewport, view: RenderView, geo: PoolGeometry): void {
    for (let r = v.firstRow; r <= v.lastRow; r++) {
      const slot = this.slots[poolSlot(r, this.size)];
      if (!slot) continue;
      const meta = view.rowMeta(r);
      if (!meta) {
        if (slot.boundRow < v.firstRow || slot.boundRow > v.lastRow) {
          slot.el.style.display = 'none';
          slot.boundRow = -1;
        } else {
          // Keep stale pixels but at the row's current window-relative y.
          this.place(slot.el, slot.boundRow, v, geo);
        }
        continue;
      }
      const sameRow = slot.boundRow === r;
      slot.el.style.display = '';
      this.place(slot.el, r, v, geo);
      slot.el.style.width = `${geo.totalWidth}px`;
      slot.el.dataset.row = String(r);
      slot.el.dataset.odd = r % 2 === 1 ? '1' : '0';
      const isGroup = meta.kind === 'group';
      slot.el.classList.toggle(CLS.group, isGroup);
      if (isGroup) {
        slot.chevron.style.left = `${meta.level * geo.groupIndent}px`;
        slot.chevron.dataset.expanded = meta.expanded ? '1' : '0';
      }
      for (let c = geo.firstCol; c <= geo.lastCol; c++) {
        this.stampCell(slot, r, c, sameRow, view, geo);
      }
      slot.boundRow = r;
    }
    for (const slot of this.slots) {
      if (slot.boundRow !== -1 && (slot.boundRow < v.firstRow || slot.boundRow > v.lastRow)) {
        slot.el.style.display = 'none';
        slot.boundRow = -1;
      }
    }
  }

  /** Removes all row elements from the DOM and empties the pool. */
  clear(): void {
    for (const s of this.slots) s.el.remove();
    this.slots = [];
    this.size = 0;
  }

  private place(el: HTMLElement, rowIndex: number, v: Viewport, geo: PoolGeometry): void {
    el.style.transform = `translate3d(0, ${(rowIndex - v.firstRow) * geo.rowHeight - v.subCellPx}px, 0)`;
  }

  private stampCell(
    slot: Slot,
    r: number,
    absCol: number,
    sameRow: boolean,
    view: RenderView,
    geo: PoolGeometry,
  ): void {
    const cell = slot.cells[absCol - geo.firstCol];
    if (!cell) return;
    cell.style.left = `${geo.colLefts[absCol]}px`;
    cell.style.width = `${geo.colWidths[absCol]}px`;
    const meta = view.rowMeta(r);
    // First visible cell indents by tree depth; group rows also clear the chevron.
    cell.style.paddingLeft =
      absCol === geo.firstCol && meta && (meta.kind === 'group' || meta.level > 0)
        ? `${meta.level * geo.groupIndent + (meta.kind === 'group' ? CHEVRON_W : 0)}px`
        : '';
    const cr = view.cell(r, absCol);
    const text = cr?.text ?? '';
    const changed = cell.textContent !== text;
    if (changed) cell.textContent = text;
    // Retrigger the flash on real changes (or when the row moved slots); a
    // same-row re-stamp with unchanged text keeps the running animation.
    const flash = cr?.flash ?? 0;
    const retrigger = flash !== 0 && (changed || !sameRow);
    const keep =
      sameRow && !retrigger
        ? cell.classList.contains(CLS.flashUp)
          ? ` ${CLS.flashUp}`
          : cell.classList.contains(CLS.flashDown)
            ? ` ${CLS.flashDown}`
            : ''
        : '';
    const style = cr?.styleClass === 'num' ? ` ${CLS.num}` : cr?.styleClass ? ` ${cr.styleClass}` : '';
    cell.className = `${CLS.cell}${style}${keep}`;
    if (retrigger) {
      void cell.offsetWidth; // restart the CSS animation
      cell.classList.add(flash > 0 ? CLS.flashUp : CLS.flashDown);
    }
  }
}
