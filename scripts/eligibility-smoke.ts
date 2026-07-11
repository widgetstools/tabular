/**
 * Behavioral smoke test: workerDataPlaneConfig fail-closed eligibility.
 * Run: npx tsx scripts/eligibility-smoke.ts
 */
import { Tabular } from '../packages/core/src/grid';
import type { ColDef, FilterModel } from '../packages/core/src/types';

type Row = { id: string; name: string; label: string };

function bootstrapHeadlessDom(): void {
  const g = globalThis as typeof globalThis & {
    document?: Document;
    window?: Window & typeof globalThis;
    HTMLElement?: typeof HTMLElement;
    HTMLCanvasElement?: typeof HTMLCanvasElement;
    ResizeObserver?: typeof ResizeObserver;
    requestAnimationFrame?: typeof requestAnimationFrame;
  };

  if (g.document) return;

  class El {
    style = new Proxy({} as Record<string, string>, {
      get(target, prop) {
        if (prop === 'setProperty') {
          return (name: string, value: string) => {
            target[name] = value;
          };
        }
        return target[prop as string];
      },
      set(target, prop, value) {
        target[prop as string] = value as string;
        return true;
      },
    });
    tabIndex = 0;
    id = '';
    textContent = '';
    className = '';
    clientWidth = 800;
    clientHeight = 600;
    children: El[] = [];
    classList = {
      add: (..._tokens: string[]) => {},
      remove: (..._tokens: string[]) => {},
      contains: (_token: string) => false,
    };
    appendChild(child: El) {
      this.children.push(child);
      return child;
    }
    removeChild(child: El) {
      const i = this.children.indexOf(child);
      if (i >= 0) this.children.splice(i, 1);
      return child;
    }
    addEventListener() {}
    removeEventListener() {}
    setAttribute() {}
    getAttribute() {
      return null;
    }
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 };
    }
    focus() {}
    contains() {
      return false;
    }
    remove() {}
  }

  class CanvasEl extends El {
    width = 800;
    height = 600;
    getContext() {
      const noop = () => {};
      return {
        scale: noop,
        clearRect: noop,
        fillRect: noop,
        strokeRect: noop,
        fillText: noop,
        measureText: (s: string) => ({ width: s.length * 8 }),
        save: noop,
        restore: noop,
        beginPath: noop,
        moveTo: noop,
        lineTo: noop,
        stroke: noop,
        fill: noop,
        rect: noop,
        clip: noop,
        setTransform: noop,
        drawImage: noop,
        createLinearGradient: () => ({ addColorStop: noop }),
        font: '',
        fillStyle: '',
        strokeStyle: '',
        textAlign: 'left' as CanvasTextAlign,
        textBaseline: 'alphabetic' as CanvasTextBaseline,
        lineWidth: 1,
        globalAlpha: 1,
      };
    }
  }

  const byId = new Map<string, El>();
  const head = new El();
  const body = new El();

  g.HTMLElement = El as unknown as typeof HTMLElement;
  g.HTMLCanvasElement = CanvasEl as unknown as typeof HTMLCanvasElement;

  g.document = {
    createElement: (tag: string) => {
      const el = tag === 'canvas' ? new CanvasEl() : new El();
      return el as unknown as HTMLElement;
    },
    getElementById: (id: string) => (byId.get(id) ?? null) as HTMLElement | null,
    head: head as unknown as HTMLHeadElement,
    body: body as unknown as HTMLBodyElement,
  } as Document;

  g.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;

  g.requestAnimationFrame = (cb: FrameRequestCallback) => {
    setTimeout(() => cb(performance.now()), 0);
    return 1;
  };
  g.cancelAnimationFrame = () => {};

  // Node has no Web Worker global; eligibility gates after this check need a stub.
  g.Worker = class Worker {
    onmessage: ((ev: MessageEvent) => void) | null = null;
    onerror: ((ev: ErrorEvent) => void) | null = null;
    postMessage() {}
    terminate() {}
    addEventListener() {}
    removeEventListener() {}
  } as unknown as typeof Worker;

  const windowStub = {
    addEventListener: () => {},
    removeEventListener: () => {},
    devicePixelRatio: 1,
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
  };
  g.window = Object.assign(g, windowStub) as Window & typeof globalThis;
}

function seedRows(): Row[] {
  return [
    { id: '1', name: 'alpha', label: 'A' },
    { id: '2', name: 'beta', label: 'B' },
  ];
}

const fieldCols: ColDef<Row>[] = [
  { field: 'name', colId: 'name' },
  { field: 'label', colId: 'label' },
];

const getterCols: ColDef<Row>[] = [
  { field: 'name', colId: 'name' },
  {
    colId: 'label',
    valueGetter: (p) => String(p.data?.label ?? ''),
  },
];

let failures = 0;

function fail(msg: string): void {
  failures++;
  console.error(`FAIL: ${msg}`);
}

function assertEligible(grid: Tabular<Row>, expect: boolean, label: string): void {
  const got = grid.workerDataPlaneEligible();
  if (got !== expect) {
    fail(`${label}: expected eligible=${expect}, got ${got}`);
  }
}

function makeGrid(columnDefs: ColDef<Row>[]): Tabular<Row> {
  const container = document.createElement('div') as unknown as HTMLElement;
  return new Tabular<Row>(container, {
    columnDefs,
    rowData: seedRows(),
    getRowId: (p) => p.data.id,
  });
}

// ── setup ───────────────────────────────────────────────────────────

bootstrapHeadlessDom();

// Baseline: field-only columns, no active filters → worker eligible
{
  const grid = makeGrid(fieldCols);
  assertEligible(grid, true, 'baseline field cols');
  grid.destroy();
}

// Active column filter on valueGetter-only col → main fallback
{
  const grid = makeGrid(getterCols);
  const model: FilterModel = {
    label: { filterType: 'text', type: 'contains', filter: 'A' },
  };
  grid.setFilterModel(model);
  assertEligible(grid, false, 'active filter on valueGetter col');
  grid.destroy();
}

// Active quick filter with valueGetter displayed col → main fallback (Task 8)
{
  const grid = makeGrid(getterCols);
  grid.setQuickFilter('alpha');
  assertEligible(grid, false, 'quick filter with valueGetter displayed col');
  grid.destroy();
}

// Quick filter with field-only cols → still eligible
{
  const grid = makeGrid(fieldCols);
  grid.setQuickFilter('alpha');
  assertEligible(grid, true, 'quick filter field-only cols');
  grid.destroy();
}

// ── result ──────────────────────────────────────────────────────────

if (failures > 0) {
  console.error(`FAILED: ${failures} assertion(s)`);
  process.exit(1);
}

console.log('OK: worker eligibility fail-closed (filter + quick filter + getters)');
process.exit(0);
