/**
 * Format picker — preset catalog + custom Excel code with live preview.
 */
import { listPresets, resolveFormat, type FormatPresetName } from '@tabular/format';
import type { ResolvedTheme } from '@tabular/core';
import { applyThemeVars, injectExtStyles } from './styles';

export interface FormatPickerResult {
  code: string;
}

export function openFormatPicker(
  theme: ResolvedTheme,
  initial: string,
  onPick: (result: FormatPickerResult) => void,
): () => void {
  injectExtStyles();
  const overlay = document.createElement('div');
  overlay.className = 'tx-modal-backdrop';
  applyThemeVars(overlay, theme);

  const panel = document.createElement('div');
  panel.className = 'tx-modal';

  const title = document.createElement('div');
  title.className = 'tx-modal-title';
  title.textContent = 'Number format';
  panel.appendChild(title);

  const preview = document.createElement('div');
  preview.className = 'tx-modal-preview';
  panel.appendChild(preview);

  const input = document.createElement('input');
  input.value = initial;
  input.className = 'tx-rb-input';
  input.style.width = '100%';
  input.style.height = '32px';
  input.style.marginBottom = '12px';
  input.style.font = `var(--tx-fs) var(--tx-font-mono)`;
  panel.appendChild(input);

  const samples = [1234.5, -98.7, 0, new Date()];
  const refresh = () => {
    try {
      const compiled = resolveFormat(input.value.trim() || 'number');
      preview.textContent = samples.map((s) => compiled.format(s)).join('  ·  ');
    } catch {
      preview.textContent = '(invalid format)';
    }
  };
  input.oninput = refresh;
  refresh();

  const presets = document.createElement('div');
  presets.style.display = 'flex';
  presets.style.flexWrap = 'wrap';
  presets.style.gap = '6px';
  presets.style.marginBottom = '4px';
  for (const name of listPresets()) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tx-btn';
    b.textContent = name;
    b.onclick = () => {
      input.value = name as FormatPresetName;
      refresh();
    };
    presets.appendChild(b);
  }
  panel.appendChild(presets);

  const actions = document.createElement('div');
  actions.className = 'tx-modal-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'tx-btn';
  cancel.textContent = 'Cancel';
  cancel.onclick = () => overlay.remove();
  const apply = document.createElement('button');
  apply.type = 'button';
  apply.className = 'tx-btn tx-btn-primary';
  apply.textContent = 'Apply';
  apply.onclick = () => {
    onPick({ code: input.value.trim() });
    overlay.remove();
  };
  actions.append(cancel, apply);
  panel.appendChild(actions);

  overlay.appendChild(panel);
  overlay.onclick = (e) => {
    if (e.target === overlay) overlay.remove();
  };
  document.body.appendChild(overlay);
  input.focus();
  input.select();
  return () => overlay.remove();
}
