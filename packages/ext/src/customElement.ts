/**
 * <tabular-ext> custom element — declarative host for TabularExt.
 * The element only owns layout; the consumer assigns `createGrid`.
 */
import { TabularExt, type TabularExtOptions } from './TabularExt';

export class TabularExtElement extends HTMLElement {
  private ext: TabularExt | null = null;

  connectedCallback(): void {
    // Consumer must call mount() after setting createGrid via property.
  }

  mount<TData>(
    opts: Omit<TabularExtOptions<TData>, 'container'>,
  ): TabularExt<TData> {
    this.ext?.destroy();
    this.ext = new TabularExt({
      ...opts,
      container: this,
    }) as TabularExt;
    return this.ext as TabularExt<TData>;
  }

  disconnectedCallback(): void {
    this.ext?.destroy();
    this.ext = null;
  }

  get instance(): TabularExt | null {
    return this.ext;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'tabular-ext': TabularExtElement;
  }
}

export function defineTabularExtElement(): void {
  if (typeof customElements === 'undefined') return;
  if (!customElements.get('tabular-ext')) {
    customElements.define('tabular-ext', TabularExtElement);
  }
}

// Auto-define when loaded in a browser.
if (typeof customElements !== 'undefined') {
  defineTabularExtElement();
}
