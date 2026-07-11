/**
 * @tabular/edit — smart edit, bulk update, magnitude nudges, tool panels.
 */
export {
  applySmartOp,
  previewSmartEdit,
  smartEditToUpdates,
  type SmartEditOp,
  type SmartEditPreviewCell,
  type SmartEditRequest,
} from './smartEdit';
export { parseMagnitude, nudgeValue } from './nudge';
export {
  previewBulkUpdate,
  bulkUpdateToRows,
  type BulkUpdatePreviewCell,
  type BulkUpdateRequest,
} from './bulkUpdate';
export {
  registerEditToolPanels,
  smartEditPanel,
  bulkUpdatePanel,
  type RegisterToolPanelFn,
} from './panels/register';
