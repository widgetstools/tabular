/**
 * Column group tree pipeline (plan §1.5): balanceTree → ProvidedColumnGroup →
 * visibility → per-region header spans.
 */
import type { ColDef, ColGroupDef, AnyColDef, ColumnGroupShow } from './types';
import type { InternalColumn, Region } from './columnModel';

export interface ProvidedColumnGroup<TData = unknown> {
  groupId: string;
  headerName: string;
  children: (ProvidedColumnGroup<TData> | InternalColumn<TData>)[];
  level: number;
  expandable: boolean;
  expanded: boolean;
  padding: boolean;
  marryChildren: boolean;
  /** Pivot key path at this group level (generated pivot groups only). */
  pivotKeys?: string[];
  def: ColGroupDef<TData> | null;
}

export interface HeaderGroupSpan<TData = unknown> {
  groupId: string;
  headerName: string;
  level: number;
  left: number;
  width: number;
  expandable: boolean;
  expanded: boolean;
  padding: boolean;
  provided: ProvidedColumnGroup<TData>;
}

export interface HeaderLayout<TData = unknown> {
  maxGroupDepth: number;
  headerRowCount: number;
  groupHeaderHeight: number;
  columnHeaderHeight: number;
  floatingFilterHeight: number;
  floatingFilters: boolean;
  totalHeaderHeight: number;
  left: HeaderGroupSpan<TData>[][];
  center: HeaderGroupSpan<TData>[][];
  right: HeaderGroupSpan<TData>[][];
}

export interface BuildResult<TData> {
  leaves: InternalColumn<TData>[];
  layout: HeaderLayout<TData>;
  providedRoots: ProvidedColumnGroup<TData>[];
}

let groupIdSeq = 0;

export function isColGroup<T>(d: AnyColDef<T>): d is ColGroupDef<T> {
  return Array.isArray((d as ColGroupDef<T>).children);
}

function gid<T>(def: ColGroupDef<T>): string {
  return def.groupId ?? `group-${groupIdSeq++}`;
}

function makeColumn<T>(
  raw: ColDef<T>,
  defaultColDef: ColDef<T> | undefined,
  sortSeq: { n: number },
): InternalColumn<T> {
  const def: ColDef<T> = { ...defaultColDef, ...raw };
  const colId = def.colId ?? def.field ?? `col-${sortSeq.n}`;
  // Row-group / pivot columns are hidden by default (AG Grid parity) unless hide: false.
  const hide = def.hide != null ? !!def.hide : !!def.rowGroup || !!def.pivot;
  return {
    colId,
    def,
    width: def.width ?? 120,
    flex: def.flex ?? 0,
    pinned: def.pinned === 'left' || def.pinned === 'right' ? def.pinned : null,
    sort: def.sort ?? null,
    sortIndex: def.sort ? sortSeq.n++ : -1,
    hide,
    groupHidden: false,
    ancestorGroups: [],
  };
}

function childVisible(show: ColumnGroupShow | undefined, parentExpanded: boolean): boolean {
  if (show === 'open') return parentExpanded;
  if (show === 'closed') return !parentExpanded;
  // undefined/null: always shown regardless of group state (AG parity).
  return true;
}

function buildProvided<T>(
  def: ColGroupDef<T>,
  level: number,
  groupState: Map<string, boolean>,
  defaultColDef: ColDef<T> | undefined,
  sortSeq: { n: number },
): ProvidedColumnGroup<T> {
  const groupId = gid(def);
  const children: (ProvidedColumnGroup<T> | InternalColumn<T>)[] = [];
  let expandable = false;

  for (const child of def.children) {
    if (isColGroup(child)) {
      if (child.columnGroupShow !== undefined) expandable = true;
      children.push(buildProvided(child, level + 1, groupState, defaultColDef, sortSeq));
    } else {
      if (child.columnGroupShow !== undefined) expandable = true;
      children.push(makeColumn(child, defaultColDef, sortSeq));
    }
  }

  return {
    groupId,
    headerName: def.headerName ?? groupId,
    children,
    level,
    expandable,
    expanded: groupState.has(groupId) ? groupState.get(groupId)! : def.openByDefault !== false,
    padding: false,
    marryChildren: !!def.marryChildren,
    def,
  };
}

export function attachAncestors<T>(group: ProvidedColumnGroup<T>, ancestors: ProvidedColumnGroup<T>[]): void {
  for (const ch of group.children) {
    if ('colId' in ch) ch.ancestorGroups = [...ancestors, group];
    else attachAncestors(ch, [...ancestors, group]);
  }
}

function maxLeafDepth<T>(roots: ProvidedColumnGroup<T>[]): number {
  let max = 0;
  const walk = (g: ProvidedColumnGroup<T>): void => {
    for (const ch of g.children) {
      if ('colId' in ch) max = Math.max(max, ch.ancestorGroups.length);
      else walk(ch);
    }
  };
  for (const r of roots) walk(r);
  return max;
}

/** Pad shallow leaves to maxDepth with synthetic groups (§1.5.4). */
export function balanceTree<T>(group: ProvidedColumnGroup<T>, maxDepth: number): void {
  const ensure = (node: ProvidedColumnGroup<T>, depth: number): void => {
    for (let i = 0; i < node.children.length; i++) {
      const ch = node.children[i];
      if ('colId' in ch) {
        // A leaf under a group at `depth` already has depth + 1 ancestors;
        // wrap it in padding groups until it sits at maxDepth. Innermost pad
        // first so the outermost pad has the shallowest level.
        let leaf: ProvidedColumnGroup<T> | InternalColumn<T> = ch;
        for (let d = maxDepth - 1; d > depth; d--) {
          const pad: ProvidedColumnGroup<T> = {
            groupId: `pad-${node.groupId}-${i}-${d}`,
            headerName: '',
            children: [leaf],
            level: d,
            expandable: false,
            expanded: true,
            padding: true,
            marryChildren: true,
            def: null,
          };
          leaf = pad;
        }
        node.children[i] = leaf;
      } else {
        ensure(ch, depth + 1);
      }
    }
  };
  ensure(group, group.level);
}

/**
 * Collect every leaf column in document order — visibility is *not* applied
 * here. Columns stay in the model regardless of columnGroupShow state so
 * widths / sort / filter / rowGroup survive group toggles; regions honor the
 * `groupHidden` flag set by {@link applyGroupVisibility}.
 */
function collectFromGroup<T>(
  group: ProvidedColumnGroup<T>,
  out: InternalColumn<T>[],
): void {
  const walk = (nodes: (ProvidedColumnGroup<T> | InternalColumn<T>)[]): void => {
    for (const node of nodes) {
      if ('colId' in node) out.push(node);
      else walk(node.children);
    }
  };
  walk(group.children);
}

/**
 * Recompute `groupHidden` for every leaf from the current expanded state:
 * columnGroupShow `'open'` → visible only while the parent group is expanded,
 * `'closed'` → only while collapsed, undefined → always visible.
 */
export function applyGroupVisibility<T>(roots: ProvidedColumnGroup<T>[]): void {
  // Padding groups are structural fillers — children evaluate against the
  // nearest real ancestor's expanded state, not the padding's.
  const walk = (g: ProvidedColumnGroup<T>, parentVisible: boolean, inherited: boolean): void => {
    const expanded = g.padding ? inherited : g.expanded;
    for (const ch of g.children) {
      if ('colId' in ch) {
        const vis = parentVisible && childVisible(ch.def.columnGroupShow, expanded);
        ch.groupHidden = !vis;
      } else {
        const vis = parentVisible && childVisible(ch.def?.columnGroupShow, expanded);
        walk(ch, vis, expanded);
      }
    }
  };
  for (const r of roots) walk(r, true, r.expanded);
}

function buildGroupSpans<T>(region: Region<T>, maxGroupDepth: number): HeaderGroupSpan<T>[][] {
  const levels: HeaderGroupSpan<T>[][] = Array.from({ length: maxGroupDepth }, () => []);
  if (!maxGroupDepth || !region.cols.length) return levels;

  for (let level = 0; level < maxGroupDepth; level++) {
    let runStart = 0;
    let runGroup: ProvidedColumnGroup<T> | null = null;

    const flush = (end: number): void => {
      if (!runGroup || runGroup.padding) {
        runStart = end;
        runGroup = null;
        return;
      }
      levels[level].push({
        groupId: runGroup.groupId,
        headerName: runGroup.headerName,
        level,
        left: region.offsets[runStart],
        width: region.offsets[end] - region.offsets[runStart],
        expandable: runGroup.expandable,
        expanded: runGroup.expanded,
        padding: runGroup.padding,
        provided: runGroup,
      });
      runStart = end;
      runGroup = null;
    };

    for (let i = 0; i < region.cols.length; i++) {
      const g = region.cols[i].ancestorGroups[level] ?? null;
      const id = g?.groupId ?? '';
      if (runGroup && runGroup.groupId === id) continue;
      flush(i);
      runStart = i;
      runGroup = g;
    }
    flush(region.cols.length);
  }
  return levels;
}

export function buildFromDefs<TData>(
  defs: AnyColDef<TData>[],
  defaultColDef: ColDef<TData> | undefined,
  groupState: Map<string, boolean>,
  columnHeaderHeight: number,
): BuildResult<TData> {
  groupIdSeq = 0;
  const sortSeq = { n: 0 };
  const providedRoots: ProvidedColumnGroup<TData>[] = [];
  const topLevelLeaves: InternalColumn<TData>[] = [];

  for (const def of defs) {
    if (isColGroup(def)) {
      providedRoots.push(buildProvided(def, 0, groupState, defaultColDef, sortSeq));
    } else {
      // Hidden columns stay in the model (rowGroup/agg/state need them);
      // regions filter `hide` at rebuild().
      topLevelLeaves.push(makeColumn(def, defaultColDef, sortSeq));
    }
  }

  for (const r of providedRoots) attachAncestors(r, []);
  const maxGroupDepth = providedRoots.length ? maxLeafDepth(providedRoots) : 0;
  for (const r of providedRoots) {
    balanceTree(r, maxGroupDepth);
    attachAncestors(r, []);
  }

  const leaves = [...topLevelLeaves];
  for (const r of providedRoots) collectFromGroup(r, leaves);

  const groupHeaderHeight = columnHeaderHeight;
  const layout: HeaderLayout<TData> = {
    maxGroupDepth,
    headerRowCount: maxGroupDepth + 1,
    groupHeaderHeight,
    columnHeaderHeight,
    floatingFilterHeight: 0,
    floatingFilters: false,
    totalHeaderHeight: maxGroupDepth * groupHeaderHeight + columnHeaderHeight,
    left: [],
    center: [],
    right: [],
  };

  return { leaves, layout, providedRoots };
}

export function fillHeaderSpans<T>(
  layout: HeaderLayout<T>,
  left: Region<T>,
  center: Region<T>,
  right: Region<T>,
): void {
  layout.left = buildGroupSpans(left, layout.maxGroupDepth);
  layout.center = buildGroupSpans(center, layout.maxGroupDepth);
  layout.right = buildGroupSpans(right, layout.maxGroupDepth);
}

export function findProvidedGroup<T>(
  roots: ProvidedColumnGroup<T>[],
  groupId: string,
): ProvidedColumnGroup<T> | null {
  const walk = (g: ProvidedColumnGroup<T>): ProvidedColumnGroup<T> | null => {
    if (g.groupId === groupId) return g;
    for (const ch of g.children) {
      if ('colId' in ch) continue;
      const f = walk(ch);
      if (f) return f;
    }
    return null;
  };
  for (const r of roots) {
    const f = walk(r);
    if (f) return f;
  }
  return null;
}

export function columnGroupState<T>(roots: ProvidedColumnGroup<T>[]): { groupId: string; open: boolean }[] {
  const out: { groupId: string; open: boolean }[] = [];
  const visit = (g: ProvidedColumnGroup<T>): void => {
    if (!g.padding && g.expandable) out.push({ groupId: g.groupId, open: g.expanded });
    for (const ch of g.children) {
      if ('colId' in ch) continue;
      visit(ch);
    }
  };
  for (const r of roots) visit(r);
  return out;
}
