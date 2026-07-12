/**
 * Group panel, pivot panel, and columns sidebar (spec §4). Chips are
 * removable (×) and pointer-drag reorderable within their strip; header cells
 * drag in as ghost chips (wired through Header.onDragStart → startHeaderDrag).
 * All interactions emit intents through the callbacks — the grid owns state.
 */
import { CLS } from './styles';
import type { ColDef, GridState } from './types';

export interface PanelCallbacks {
  onGroupChange(fields: string[]): void;
  onPivotChange(fields: string[]): void;
  onValueChange(cols: { field: string; aggFunc: string }[]): void;
  onPivotMode(on: boolean): void;
}

/** Which sections render; the grid maps GridOptions panel settings onto this. */
export interface PanelShow {
  groupPanel: boolean;
  pivotPanel: boolean;
  sideBar: boolean;
}

/** Px of pointer travel before a pointerdown becomes a drag (vs a click). */
const DRAG_THRESHOLD = 5;

export class Panels {
  private readonly groupStrip: HTMLDivElement;
  private readonly pivotStrip: HTMLDivElement;
  private state: GridState | null = null;

  constructor(
    strip: HTMLElement,
    private readonly sidebar: HTMLElement,
    private readonly cb: PanelCallbacks,
    private readonly show: PanelShow,
  ) {
    this.groupStrip = document.createElement('div');
    this.groupStrip.className = CLS.panel;
    this.pivotStrip = document.createElement('div');
    this.pivotStrip.className = CLS.panel;
    if (show.groupPanel) strip.appendChild(this.groupStrip);
    if (show.pivotPanel) strip.appendChild(this.pivotStrip);
    sidebar.classList.add(CLS.sidebar);
    if (!show.sideBar) sidebar.style.display = 'none';

    this.groupStrip.addEventListener('click', (ev) => this.handleStripClick(ev, 'group'));
    this.pivotStrip.addEventListener('click', (ev) => this.handleStripClick(ev, 'pivot'));
    this.groupStrip.addEventListener('pointerdown', (ev) => this.handleChipDrag(ev, 'group'));
    this.pivotStrip.addEventListener('pointerdown', (ev) => this.handleChipDrag(ev, 'pivot'));
    sidebar.addEventListener('click', (ev) => this.handleSidebarClick(ev));
  }

  /** Rebuild strips + sidebar from state (state changes are rare; wholesale rebuild). */
  render(state: GridState): void {
    this.state = state;
    if (this.show.groupPanel) {
      this.renderStrip(this.groupStrip, 'Row groups', state.rowGroupCols);
    }
    if (this.show.pivotPanel) {
      this.renderStrip(this.pivotStrip, 'Pivot', state.pivotCols);
      const toggle = document.createElement('button');
      toggle.className = CLS.toggle;
      toggle.style.width = 'auto';
      toggle.style.padding = '0 6px';
      toggle.style.height = '20px';
      toggle.dataset.pivotMode = '1';
      toggle.dataset.on = state.pivotMode ? '1' : '0';
      toggle.textContent = state.pivotMode ? 'Pivot mode: on' : 'Pivot mode: off';
      this.pivotStrip.appendChild(toggle);
    }
    if (this.show.sideBar) this.renderSidebar(state);
  }

  /**
   * Header→panel drag: a ghost chip follows the pointer once it travels past
   * the threshold; releasing over a strip adds the field there. Below the
   * threshold nothing happens and the header's own click (sort) proceeds.
   */
  startHeaderDrag(field: string, ev: PointerEvent): void {
    const state = this.state;
    if (!state || (!this.show.groupPanel && !this.show.pivotPanel)) return;
    const def = this.defFor(field);
    const start = { x: ev.clientX, y: ev.clientY };
    let ghost: HTMLDivElement | null = null;
    const onMove = (mv: PointerEvent): void => {
      if (!ghost) {
        if (Math.hypot(mv.clientX - start.x, mv.clientY - start.y) < DRAG_THRESHOLD) return;
        ghost = document.createElement('div');
        ghost.className = CLS.chip;
        ghost.dataset.ghost = '1';
        ghost.textContent = def?.headerName ?? field;
        document.body.appendChild(ghost);
      }
      ghost.style.left = `${mv.clientX + 10}px`;
      ghost.style.top = `${mv.clientY + 6}px`;
      this.groupStrip.dataset.drop = this.hits(this.groupStrip, mv) ? '1' : '0';
      this.pivotStrip.dataset.drop = this.hits(this.pivotStrip, mv) ? '1' : '0';
    };
    const onUp = (up: PointerEvent): void => {
      window.removeEventListener('pointermove', onMove);
      this.groupStrip.dataset.drop = '0';
      this.pivotStrip.dataset.drop = '0';
      if (!ghost) return;
      ghost.remove();
      if (
        this.show.groupPanel &&
        this.hits(this.groupStrip, up) &&
        def?.enableRowGroup !== false &&
        !state.rowGroupCols.includes(field)
      ) {
        this.cb.onGroupChange([...state.rowGroupCols, field]);
      } else if (
        this.show.pivotPanel &&
        this.hits(this.pivotStrip, up) &&
        def?.enablePivot !== false &&
        !state.pivotCols.includes(field)
      ) {
        this.cb.onPivotChange([...state.pivotCols, field]);
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
  }

  private renderStrip(strip: HTMLDivElement, label: string, fields: string[]): void {
    strip.replaceChildren();
    const lab = document.createElement('span');
    lab.textContent = label;
    strip.appendChild(lab);
    for (const field of fields) {
      const chip = document.createElement('div');
      chip.className = CLS.chip;
      chip.dataset.field = field;
      chip.appendChild(document.createTextNode(this.defFor(field)?.headerName ?? field));
      const close = document.createElement('button');
      close.dataset.remove = field;
      close.textContent = '×';
      chip.appendChild(close);
      strip.appendChild(chip);
    }
  }

  private renderSidebar(state: GridState): void {
    this.sidebar.replaceChildren();
    for (const def of state.columnDefs) {
      const row = document.createElement('div');
      row.className = CLS.sidebarRow;
      const name = document.createElement('span');
      name.textContent = def.headerName ?? def.field;
      row.appendChild(name);
      row.appendChild(
        this.toggleButton('G', def.field, 'group', state.rowGroupCols.includes(def.field), def.enableRowGroup === false),
      );
      row.appendChild(
        this.toggleButton('P', def.field, 'pivot', state.pivotCols.includes(def.field), def.enablePivot === false),
      );
      row.appendChild(
        this.toggleButton(
          'Σ',
          def.field,
          'value',
          state.valueCols.some((v) => v.field === def.field),
          def.enableValue === false,
        ),
      );
      this.sidebar.appendChild(row);
    }
  }

  private toggleButton(
    label: string,
    field: string,
    kind: string,
    on: boolean,
    disabled: boolean,
  ): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = CLS.toggle;
    btn.textContent = label;
    btn.dataset.field = field;
    btn.dataset.kind = kind;
    btn.dataset.on = on ? '1' : '0';
    btn.disabled = disabled;
    btn.title = kind;
    return btn;
  }

  private handleStripClick(ev: MouseEvent, which: 'group' | 'pivot'): void {
    const state = this.state;
    if (!state) return;
    const target = ev.target as HTMLElement;
    if (target.dataset.pivotMode) {
      this.cb.onPivotMode(!state.pivotMode);
      return;
    }
    const remove = target.dataset.remove;
    if (!remove) return;
    if (which === 'group') this.cb.onGroupChange(state.rowGroupCols.filter((f) => f !== remove));
    else this.cb.onPivotChange(state.pivotCols.filter((f) => f !== remove));
  }

  /** Chip reorder: the chip element moves live between siblings; drop emits the new order. */
  private handleChipDrag(ev: PointerEvent, which: 'group' | 'pivot'): void {
    const target = ev.target as HTMLElement;
    if (target.dataset.remove) return; // let × clicks through
    const chip = target.closest<HTMLElement>(`.${CLS.chip}`);
    if (!chip?.dataset.field) return;
    const strip = which === 'group' ? this.groupStrip : this.pivotStrip;
    const start = ev.clientX;
    let moved = false;
    try {
      chip.setPointerCapture(ev.pointerId);
    } catch {
      // Pointer already lifted (touch race / synthetic events): move events
      // still bubble through the chip, so the drag degrades gracefully.
    }
    const onMove = (mv: PointerEvent): void => {
      if (!moved && Math.abs(mv.clientX - start) < DRAG_THRESHOLD) return;
      moved = true;
      const chips = [...strip.querySelectorAll<HTMLElement>(`.${CLS.chip}`)].filter((c) => c !== chip);
      const after = chips.find((c) => {
        const r = c.getBoundingClientRect();
        return mv.clientX < r.left + r.width / 2;
      });
      if (after) strip.insertBefore(chip, after);
      else strip.appendChild(chip);
    };
    const onUp = (): void => {
      chip.removeEventListener('pointermove', onMove);
      if (!moved) return;
      const order = [...strip.querySelectorAll<HTMLElement>(`.${CLS.chip}`)]
        .map((c) => c.dataset.field)
        .filter((f): f is string => !!f);
      if (which === 'group') this.cb.onGroupChange(order);
      else this.cb.onPivotChange(order);
    };
    chip.addEventListener('pointermove', onMove);
    chip.addEventListener('pointerup', onUp, { once: true });
  }

  private handleSidebarClick(ev: MouseEvent): void {
    const state = this.state;
    const target = ev.target as HTMLElement;
    const field = target.dataset.field;
    const kind = target.dataset.kind;
    if (!state || !field || !kind) return;
    if (kind === 'group') {
      this.cb.onGroupChange(
        state.rowGroupCols.includes(field)
          ? state.rowGroupCols.filter((f) => f !== field)
          : [...state.rowGroupCols, field],
      );
    } else if (kind === 'pivot') {
      this.cb.onPivotChange(
        state.pivotCols.includes(field)
          ? state.pivotCols.filter((f) => f !== field)
          : [...state.pivotCols, field],
      );
    } else if (kind === 'value') {
      const def = this.defFor(field);
      this.cb.onValueChange(
        state.valueCols.some((v) => v.field === field)
          ? state.valueCols.filter((v) => v.field !== field)
          : [...state.valueCols, { field, aggFunc: def?.aggFunc ?? 'sum' }],
      );
    }
  }

  private defFor(field: string): ColDef | undefined {
    return this.state?.columnDefs.find((d) => d.field === field);
  }

  private hits(el: HTMLElement, ev: { clientX: number; clientY: number }): boolean {
    const r = el.getBoundingClientRect();
    return ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom;
  }
}
