/**
 * Register smart-edit and bulk-update tool panels on a registry.
 *
 * @example
 * ```ts
 * import { registerToolPanel } from '@tabular/core';
 * import { registerEditToolPanels } from '@tabular/edit';
 * registerEditToolPanels(registerToolPanel);
 * ```
 */
import type { ToolPanelFactory } from '@tabular/core';
import { bulkUpdatePanel } from './bulkUpdatePanel';
import { smartEditPanel } from './smartEditPanel';

export type RegisterToolPanelFn = (
  name: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- registry erases TData
  factory: ToolPanelFactory<any>,
) => void;

export function registerEditToolPanels(register: RegisterToolPanelFn): void {
  register('smartEdit', smartEditPanel);
  register('bulkUpdate', bulkUpdatePanel);
}

export { smartEditPanel } from './smartEditPanel';
export { bulkUpdatePanel } from './bulkUpdatePanel';
