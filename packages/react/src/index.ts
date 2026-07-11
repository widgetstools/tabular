/**
 * @tabular/react — a thin mount/prop-diff shim over the vanilla core.
 * The core never depends on React; this wrapper is deliberately minimal
 * (no JSX so it needs no transform when consumed as workspace source).
 */
import {
  createElement,
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  type CSSProperties,
  type ForwardedRef,
} from 'react';
import { Tabular, type GridOptions } from '@tabular/core';

export interface TabularGridProps<TData = unknown> extends GridOptions<TData> {
  className?: string;
  style?: CSSProperties;
  /** Called once with the live grid api after mount. */
  onReady?: (api: Tabular<TData>) => void;
}

export interface TabularGridHandle<TData = unknown> {
  api: Tabular<TData> | null;
}

function TabularGridInner<TData>(
  props: TabularGridProps<TData>,
  ref: ForwardedRef<TabularGridHandle<TData>>,
) {
  const elRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<Tabular<TData> | null>(null);
  // Latest props for the mount effect without re-mounting.
  const propsRef = useRef(props);
  propsRef.current = props;

  useEffect(() => {
    const { className: _c, style: _s, onReady, ...options } = propsRef.current;
    const grid = new Tabular<TData>(elRef.current!, options as GridOptions<TData>);
    gridRef.current = grid;
    onReady?.(grid);
    return () => {
      gridRef.current = null;
      grid.destroy();
    };
    // Mount once — structural options (columnDefs etc.) go through the api.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reactive prop syncs.
  const { rowData, quickFilterText, theme, density, columnDefs, isExternalFilterPresent, doesExternalFilterPass } =
    props;
  const first = useRef(true);

  useEffect(() => {
    if (first.current) return;
    if (rowData && gridRef.current) gridRef.current.setRowData(rowData);
  }, [rowData]);

  useEffect(() => {
    if (first.current) return;
    if (gridRef.current && quickFilterText !== undefined) {
      gridRef.current.setQuickFilter(quickFilterText);
    }
  }, [quickFilterText]);

  useEffect(() => {
    if (first.current) return;
    if (gridRef.current && theme) gridRef.current.setTheme(theme);
  }, [theme]);

  useEffect(() => {
    if (first.current) return;
    if (gridRef.current && density) gridRef.current.setDensity(density);
  }, [density]);

  useEffect(() => {
    if (first.current) return;
    if (gridRef.current) gridRef.current.setColumnDefs(columnDefs);
  }, [columnDefs]);

  useEffect(() => {
    if (first.current) return;
    gridRef.current?.updateOptions({ isExternalFilterPresent, doesExternalFilterPass });
    gridRef.current?.onFilterChanged();
  }, [isExternalFilterPresent, doesExternalFilterPass]);

  useEffect(() => {
    first.current = false;
  }, []);

  useImperativeHandle(ref, () => ({
    get api() {
      return gridRef.current;
    },
  }));

  return createElement('div', {
    ref: elRef,
    className: props.className,
    style: { width: '100%', height: '100%', ...props.style },
  });
}

export const TabularGrid = forwardRef(TabularGridInner) as unknown as <TData = unknown>(
  props: TabularGridProps<TData> & { ref?: ForwardedRef<TabularGridHandle<TData>> },
) => ReturnType<typeof TabularGridInner>;

export { Tabular } from '@tabular/core';
export type * from '@tabular/core';
