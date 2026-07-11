/**
 * AG Grid v33+ parameter-based theming (themeQuartz.withParams), tuned to the
 * same Cursor Dark / Cursor Light tokens the tabular showcase uses so the two
 * apps can be compared side by side.
 */
import { themeQuartz } from 'ag-grid-community';

const FONT_SANS = "'IBM Plex Sans', 'Inter', system-ui, -apple-system, sans-serif";
const FONT_MONO = "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace";

export const gridTheme = themeQuartz
  .withParams(
    {
      accentColor: '#3C7CAB',
      backgroundColor: '#FCFCFC',
      foregroundColor: '#141414',
      borderColor: '#C2C2C2',
      browserColorScheme: 'light',
      chromeBackgroundColor: '#F3F3F3',
      headerBackgroundColor: '#F3F3F3',
      headerTextColor: '#6E6E6E',
      oddRowBackgroundColor: '#F7F7F7',
      columnBorder: true,
      fontFamily: FONT_SANS,
      headerFontFamily: FONT_SANS,
      cellFontFamily: FONT_SANS,
      fontSize: 12,
      headerFontSize: 11,
      headerFontWeight: 500,
      rowHeight: 26,
      headerHeight: 34,
      rowVerticalPaddingScale: 0.7,
      spacing: 6,
      wrapperBorderRadius: 2,
      borderRadius: 2,
      iconSize: 12,
      inputBorderRadius: 2,
      checkboxBorderRadius: 2,
      cellHorizontalPadding: 6,
    },
    'light',
  )
  .withParams(
    {
      accentColor: '#81A1C1',
      backgroundColor: '#181818',
      foregroundColor: '#F0F0F0',
      borderColor: '#454545',
      browserColorScheme: 'dark',
      chromeBackgroundColor: '#141414',
      headerBackgroundColor: '#141414',
      headerTextColor: '#A8A8A8',
      oddRowBackgroundColor: '#1B1B1B',
      columnBorder: true,
      fontFamily: FONT_SANS,
      headerFontFamily: FONT_SANS,
      cellFontFamily: FONT_SANS,
      fontSize: 12,
      headerFontSize: 11,
      headerFontWeight: 500,
      rowHeight: 26,
      headerHeight: 34,
      rowVerticalPaddingScale: 0.7,
      spacing: 6,
      wrapperBorderRadius: 2,
      borderRadius: 2,
      iconSize: 12,
      inputBorderRadius: 2,
      checkboxBorderRadius: 2,
      cellHorizontalPadding: 6,
    },
    'dark',
  );

export { FONT_MONO };
