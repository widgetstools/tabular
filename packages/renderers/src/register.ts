/**
 * Register the full @tabular/renderers painter catalog.
 */
import type { CellRendererComp } from '@tabular/core';
import { registerActionRenderers } from './actions';
import { registerBadgeRenderers } from './badges';
import { registerBarRenderers } from './bars';
import { registerFinancialRenderers } from './financial';
import { registerSparklineRenderers } from './sparklines';

/** Register every named painter (financial + bars + badges + sparklines + actions). */
export function registerAllRenderers(
  register: (name: string, def: CellRendererComp) => void,
): void {
  registerFinancialRenderers(register);
  registerBarRenderers(register);
  registerBadgeRenderers(register);
  registerSparklineRenderers(register);
  registerActionRenderers(register);
}
