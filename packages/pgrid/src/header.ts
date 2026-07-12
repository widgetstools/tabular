/**
 * Multi-row header (spec §4). With split_by active, pivot column paths render
 * as merged group rows (adjacent equal prefixes share one cell) above a
 * measure row; otherwise a single row of column captions. Sort click rotates
 * desc → asc → none (spec §5.7). Rebuilt wholesale on state changes (rare);
 * horizontal scroll is a transform on the inner container (per frame, cheap).
 */
import { CLS } from './styles';
import type { GridState, ColDef } from './types';
import { measureIndex, splitPath } from './viewCompiler';
import type { PspViewConfig } from './viewCompiler';

export interface HeaderCallbacks {
  onSortClick(colId: string, additive: boolean): void;
  /** Live during the drag; pure geometry — no view rebuild. */
  onResize(colId: string, w: number): void;
  /** Header→panel chip drag (wired by Task 8's panels). */
  onDragStart(colId: string, ev: PointerEvent): void;
}

/** One display column as the header sees it. */
export interface HeaderCol {
  /** Sort/resize identity: field name, measure name, or the group column id. */
  colId: string;
  /** Engine column path ('' for the group column); split paths render as group rows. */
  path: string;
  title: string;
  width: number;
  numeric: boolean;
  sortable: boolean;
}

const MIN_COL_W = 40;

export class Header {
  private readonly inner: HTMLDivElement;
  /** Nonzero while a resize drag is active — suppresses the click that follows pointerup. */
  private resizing = false;

  constructor(el: HTMLElement, private readonly cb: HeaderCallbacks) {
    el.classList.add(CLS.header);
    this.inner = document.createElement('div');
    el.appendChild(this.inner);
    el.addEventListener('click', (ev) => this.handleClick(ev));
    el.addEventListener('pointerdown', (ev) => this.handlePointerDown(ev));
  }

  /** Rebuilds the header rows for the given display columns. */
  render(state: GridState, cols: HeaderCol[], cfg: PspViewConfig): void {
    this.inner.replaceChildren();
    const totalWidth = cols.reduce((a, c) => a + c.width, 0);
    if (cfg.split_by.length > 0) {
      for (let level = 0; level < measureIndex(cfg); level++) {
        this.inner.appendChild(this.groupRow(cols, cfg, level, totalWidth));
      }
    }
    this.inner.appendChild(this.captionRow(state, cols, totalWidth));
  }

  /** Header scrolls horizontally in lockstep with the body. */
  setScrollLeft(x: number): void {
    this.inner.style.transform = `translateX(${-x}px)`;
  }

  /** Total header height in px — rows × --pg-header-h (grid subtracts it from the clip). */
  rowCount(cfg: PspViewConfig): number {
    return cfg.split_by.length > 0 ? measureIndex(cfg) + 1 : 1;
  }

  /** One split_by level: adjacent columns sharing the level's path part merge into one cell. */
  private groupRow(
    cols: HeaderCol[],
    cfg: PspViewConfig,
    level: number,
    totalWidth: number,
  ): HTMLDivElement {
    const row = document.createElement('div');
    row.style.display = 'flex';
    row.style.width = `${totalWidth}px`;
    let i = 0;
    while (i < cols.length) {
      const part = cols[i].path ? splitPath(cols[i].path, cfg).groups[level] ?? '' : '';
      let width = cols[i].width;
      let j = i + 1;
      while (
        j < cols.length &&
        part !== '' &&
        (cols[j].path ? splitPath(cols[j].path, cfg).groups[level] ?? '' : '') === part
      ) {
        width += cols[j].width;
        j++;
      }
      const cell = document.createElement('div');
      cell.className = CLS.hgroup;
      cell.style.width = `${width}px`;
      cell.textContent = part;
      row.appendChild(cell);
      i = j;
    }
    return row;
  }

  private captionRow(state: GridState, cols: HeaderCol[], totalWidth: number): HTMLDivElement {
    const row = document.createElement('div');
    row.style.display = 'flex';
    row.style.width = `${totalWidth}px`;
    for (const col of cols) {
      const cell = document.createElement('div');
      cell.className = CLS.hcell;
      cell.style.width = `${col.width}px`;
      cell.dataset.colId = col.colId;
      if (col.numeric) cell.classList.add(CLS.num);
      const sort = state.sortModel.find((s) => s.colId === col.colId);
      if (sort) cell.classList.add(sort.sort === 'asc' ? CLS.sortAsc : CLS.sortDesc);
      cell.appendChild(document.createTextNode(col.title));
      const handle = document.createElement('div');
      handle.dataset.resize = col.colId;
      handle.style.cssText =
        'position:absolute;top:0;right:0;width:5px;height:100%;cursor:col-resize;';
      cell.appendChild(handle);
      row.appendChild(cell);
    }
    return row;
  }

  private handleClick(ev: MouseEvent): void {
    if (this.resizing) return;
    const target = ev.target as HTMLElement;
    if (target.dataset.resize) return;
    const cell = target.closest<HTMLElement>(`.${CLS.hcell}`);
    const colId = cell?.dataset.colId;
    if (colId) this.cb.onSortClick(colId, ev.shiftKey || ev.ctrlKey || ev.metaKey);
  }

  private handlePointerDown(ev: PointerEvent): void {
    const target = ev.target as HTMLElement;
    const resizeId = target.dataset.resize;
    if (resizeId) {
      ev.preventDefault();
      const cell = target.parentElement as HTMLElement;
      const startX = ev.clientX;
      const startW = cell.offsetWidth;
      this.resizing = true;
      try {
        target.setPointerCapture(ev.pointerId);
      } catch {
        // Pointer already lifted (touch race / synthetic events): move events
        // still reach the handle unmoved under the pointer, so resize degrades
        // gracefully instead of aborting.
      }
      const onMove = (mv: PointerEvent): void => {
        const w = Math.max(MIN_COL_W, startW + (mv.clientX - startX));
        // Update this cell in place: the grid deliberately does not re-render
        // the header mid-drag (a rebuild would destroy the captured handle),
        // so without this the header drifts out of alignment with the body.
        cell.style.width = `${w}px`;
        this.cb.onResize(resizeId, w);
      };
      const onUp = (): void => {
        target.removeEventListener('pointermove', onMove);
        target.removeEventListener('pointerup', onUp);
        // Let the trailing click land first, then re-enable sort clicks.
        setTimeout(() => {
          this.resizing = false;
        }, 0);
      };
      target.addEventListener('pointermove', onMove);
      target.addEventListener('pointerup', onUp);
      return;
    }
    const cell = target.closest<HTMLElement>(`.${CLS.hcell}`);
    if (cell?.dataset.colId) this.cb.onDragStart(cell.dataset.colId, ev);
  }
}

/** Resolve a display column's caption from its ColDef. */
export function colTitle(def: ColDef | undefined, fallback: string): string {
  return def?.headerName ?? def?.field ?? fallback;
}
