/**
 * Cell / header tooltip resolution (plan §4.11).
 */
import type { ColDef } from './types';
import type { CellParams } from './types';

export function resolveCellTooltip<TData>(
  colDef: ColDef<TData>,
  params: CellParams<TData>,
): string | null {
  if (colDef.tooltipField) {
    const row = params.data as Record<string, unknown> | undefined;
    const v = row?.[colDef.tooltipField];
    return v == null ? null : String(v);
  }
  if (colDef.tooltipValueGetter) {
    const v = colDef.tooltipValueGetter(params);
    return v == null || v === '' ? null : String(v);
  }
  return null;
}

export function resolveHeaderTooltip<TData>(
  colDef: ColDef<TData>,
  headerName: string,
  api: CellParams<TData>['api'],
): string | null {
  if (colDef.headerTooltipValueGetter) {
    const v = colDef.headerTooltipValueGetter({
      value: headerName,
      data: undefined,
      rowIndex: -1,
      colDef,
      api,
    });
    return v == null || v === '' ? null : String(v);
  }
  if (colDef.headerTooltip) return colDef.headerTooltip;
  return null;
}

export function textOverflows(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  font: string,
): boolean {
  if (maxWidth <= 0 || !text) return false;
  ctx.font = font;
  return ctx.measureText(text).width > maxWidth - 2;
}
