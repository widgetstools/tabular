import { useState } from 'react';
import { BasicPage } from './pages/Basic';
import { SortFilterPage } from './pages/SortFilter';
import { FloatingFiltersPage } from './pages/FloatingFilters';
import { EditingPage } from './pages/Editing';
import { SelectionPage } from './pages/Selection';
import { ColumnGroupsPage } from './pages/ColumnGroups';
import { GroupingPage } from './pages/Grouping';
import { RangeSelectionPage } from './pages/RangeSelection';
import { TreeDataPage } from './pages/TreeData';
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
import { PivotSidebarPage } from './pages/PivotSidebar';
import { StatusOverlaysPage } from './pages/StatusOverlays';

const PAGES = [
  { id: 'basic', label: 'Basic grid', component: BasicPage },
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
  { id: 'pivotsidebar', label: 'Pivot & Sidebar Ag-grid', component: PivotSidebarPage },
  { id: 'range', label: 'Range selection', component: RangeSelectionPage },
  { id: 'tree', label: 'Tree data', component: TreeDataPage },
  { id: 'status', label: 'Status bar & overlays', component: StatusOverlaysPage },
] as const;

export function App() {
  const [pageId, setPageId] = useState<string>('basic');
  const page = PAGES.find((p) => p.id === pageId) ?? PAGES[0];
  const Page = page.component;

  return (
    <div className="app">
      <nav className="sidebar">
        <h1>
          <span>ag-grid</span> reference
        </h1>
        <p className="tagline">AG Grid Enterprise v36 — parity benchmark</p>
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
