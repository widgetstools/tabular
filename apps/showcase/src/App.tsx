import { useState } from 'react';
import { CalcPage } from './pages/Calc';
import { FormatPage } from './pages/Format';
import { RulesPage } from './pages/Rules';
import { RenderersPage } from './pages/RenderersCatalog';
import { BasicPage } from './pages/Basic';
import { BigDataPage } from './pages/BigData';
import { ExtremePage } from './pages/Extreme';
import { LiveTicksPage } from './pages/LiveTicks';
import { RealtimeAggPage } from './pages/RealtimeAgg';
import { SortFilterPage } from './pages/SortFilter';
import { EditingPage } from './pages/Editing';
import { SelectionPage } from './pages/Selection';
import { ColumnGroupsPage } from './pages/ColumnGroups';
import { FloatingFiltersPage } from './pages/FloatingFilters';
import { RangeSelectionPage } from './pages/RangeSelection';
import { GroupingPage } from './pages/Grouping';
import { TreeDataPage } from './pages/TreeData';
import { StatusOverlaysPage } from './pages/StatusOverlays';
import { PaginationPage } from './pages/Pagination';
import { ClipboardExportPage } from './pages/ClipboardExport';
import { InteractionPage } from './pages/Interaction';
import { RenderingPage } from './pages/Rendering';
import { SpanningPage } from './pages/Spanning';
import { RowHeightPage } from './pages/RowHeight';
import { PinnedRowsPage } from './pages/PinnedRows';
import { MasterDetailPage } from './pages/MasterDetail';
import { MiscPage } from './pages/Misc';
import { PivotPage } from './pages/Pivot';
import { ThemingPage } from './pages/Theming';
import { ExtShellPage } from './pages/ExtShell';
import { EditOpsPage } from './pages/EditOps';

const PAGES = [
  { id: 'rules', label: 'Rules & alerts', component: RulesPage },
  { id: 'calc', label: 'Calc columns', component: CalcPage },
  { id: 'format', label: 'Format DSL', component: FormatPage },
  { id: 'renderers', label: 'Renderer catalog', component: RenderersPage },
  { id: 'editops', label: 'Edit ops', component: EditOpsPage },
  { id: 'ext', label: 'Ext shell', component: ExtShellPage },
  { id: 'basic', label: 'Basic grid', component: BasicPage },
  { id: 'big', label: '100k rows', component: BigDataPage },
  { id: 'extreme', label: '1M × 500 bench', component: ExtremePage },
  { id: 'ticks', label: 'Live ticks & flash', component: LiveTicksPage },
  { id: 'rtagg', label: 'Realtime agg (worker)', component: RealtimeAggPage },
  { id: 'sortfilter', label: 'Sorting & filtering', component: SortFilterPage },
  { id: 'floating', label: 'Floating filters', component: FloatingFiltersPage },
  { id: 'editing', label: 'Editing', component: EditingPage },
  { id: 'selection', label: 'Selection', component: SelectionPage },
  { id: 'groups', label: 'Column groups', component: ColumnGroupsPage },
  { id: 'grouping', label: 'Row grouping', component: GroupingPage },
  { id: 'pivot', label: 'Pivot mode', component: PivotPage },
  { id: 'pagination', label: 'Pagination', component: PaginationPage },
  { id: 'clipboard', label: 'Clipboard & export', component: ClipboardExportPage },
  { id: 'interaction', label: 'Interaction & nav', component: InteractionPage },
  { id: 'rendering', label: 'Rendering', component: RenderingPage },
  { id: 'spanning', label: 'Cell spanning', component: SpanningPage },
  { id: 'rowheight', label: 'Row height', component: RowHeightPage },
  { id: 'pinnedrows', label: 'Row pinning', component: PinnedRowsPage },
  { id: 'masterdetail', label: 'Master / Detail', component: MasterDetailPage },
  { id: 'misc', label: 'Misc (status & sidebar)', component: MiscPage },
  { id: 'tree', label: 'Tree data', component: TreeDataPage },
  { id: 'range', label: 'Range selection', component: RangeSelectionPage },
  { id: 'statusbar', label: 'Status bar & overlays', component: StatusOverlaysPage },
  { id: 'theming', label: 'Theming & density', component: ThemingPage },
] as const;

export function App() {
  const [pageId, setPageId] = useState<string>('basic');
  const page = PAGES.find((p) => p.id === pageId) ?? PAGES[0];
  const Page = page.component;

  return (
    <div className="app">
      <nav className="sidebar">
        <h1>
          <span>tabular</span> showcase
        </h1>
        <p className="tagline">canvas-first data grid engine</p>
        {PAGES.map((p) => (
          <button
            key={p.id}
            className={`nav-item${p.id === pageId ? ' active' : ''}`}
            onClick={() => setPageId(p.id)}
          >
            {p.label}
          </button>
        ))}
      </nav>
      <Page key={page.id} />
    </div>
  );
}
