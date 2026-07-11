/**
 * @tabular/format — Excel-style format codes, presets, Tier 1 style tags.
 *
 * Tier 0: section-aware parse, digit placeholders, thousands/scaling, percent,
 * bracket colors (theme tokens preferred), basic date tokens, preset registry.
 * Tier 1: `[color=]`, `[bg=]`, `[weight=]`, `[if=…]`, `{icon:name}`.
 *
 * // TODO(Tier 2): composite multi-fragment cells (see composite.ts)
 */
export type {
  CompiledFormat,
  DatePart,
  DigitPart,
  FormatCellStyle,
  FormatConfig,
  FormatContext,
  FormatPresetName,
  FormatSection,
  FormatToken,
  ParsedFormat,
} from './types';

export { parseFormat, parseSectionBody, splitSections, resolveColorToken } from './parse';
export { compileFormat } from './compile';
export {
  compilePreset,
  isPresetName,
  listPresets,
  presetCode,
  resolveFormat,
} from './presets';
export {
  compileStyleTags,
  resolveStyleTags,
  type CompiledStyleTags,
  type StyleTagIcon,
} from './styleTags';
export { buildHtmlClipboardTable, writeClipboardTsvAndHtml } from './clipboardHtml';
export type { HtmlClipboardCell } from './clipboardHtml';
