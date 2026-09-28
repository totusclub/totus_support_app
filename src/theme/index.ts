// Токены дизайн-системы TOTUS — те же значения, что в calling_v2/app/globals.css
// (светлая тема по умолчанию, тёмная — по системной настройке устройства).
import {useColorScheme} from 'react-native';

export interface Palette {
  bg: string;
  surface: string;
  surfaceInset: string;
  surfaceHover: string;
  border: string;
  borderStrong: string;
  textPrimary: string;
  textSecondary: string;
  textTertiary: string;
  textDisabled: string;
  textOnAccent: string;
  accent: string;
  accentHover: string;
  accentSoft: string;
  accentBorder: string;
  success: string;
  successSoft: string;
  info: string;
  infoSoft: string;
  warning: string;
  warningSoft: string;
  error: string;
  errorSoft: string;
  bubbleUser: string;
  bubbleStaff: string;
  overlay: string;
}

export const light: Palette = {
  bg: '#ffffff',
  surface: '#ffffff',
  surfaceInset: '#f5f5f5',
  surfaceHover: '#f5f5f5',
  border: '#e0e0e0',
  borderStrong: '#b8b8b8',
  textPrimary: '#1f1f1f',
  textSecondary: '#3d3d3d',
  textTertiary: '#7a7a7a',
  textDisabled: '#b8b8b8',
  textOnAccent: '#ffffff',
  accent: '#fe732e',
  accentHover: '#e8631f',
  accentSoft: 'rgba(254, 115, 46, 0.10)',
  accentBorder: 'rgba(254, 115, 46, 0.35)',
  success: '#288556',
  successSoft: 'rgba(57, 191, 135, 0.12)',
  info: '#0d77d3',
  infoSoft: 'rgba(13, 119, 211, 0.10)',
  warning: '#ce8508',
  warningSoft: 'rgba(206, 133, 8, 0.12)',
  error: '#cf3030',
  errorSoft: 'rgba(207, 48, 48, 0.10)',
  bubbleUser: '#f5f5f5',
  bubbleStaff: '#fe732e',
  overlay: 'rgba(0,0,0,0.45)',
};

export const dark: Palette = {
  bg: '#141414',
  surface: '#1f1f1f',
  surfaceInset: '#141414',
  surfaceHover: '#2a2a2a',
  border: '#2a2a2a',
  borderStrong: '#3d3d3d',
  textPrimary: '#ffffff',
  textSecondary: '#b8b8b8',
  textTertiary: '#a3a3a3',
  textDisabled: '#7a7a7a',
  textOnAccent: '#ffffff',
  accent: '#fe732e',
  accentHover: '#fa8842',
  accentSoft: 'rgba(254, 115, 46, 0.14)',
  accentBorder: 'rgba(254, 115, 46, 0.40)',
  success: '#0dd6a4',
  successSoft: 'rgba(13, 214, 164, 0.14)',
  info: '#61aaf2',
  infoSoft: 'rgba(97, 170, 242, 0.14)',
  warning: '#facd64',
  warningSoft: 'rgba(250, 205, 100, 0.14)',
  error: '#f26161',
  errorSoft: 'rgba(242, 97, 97, 0.14)',
  bubbleUser: '#2a2a2a',
  bubbleStaff: '#fe732e',
  overlay: 'rgba(0,0,0,0.6)',
};

/** Радиусы дизайн-системы: Firm, Firm 2, Smooth, Circular. */
export const radius = {sm: 8, md: 12, lg: 16, pill: 200} as const;

export const font = {
  pageTitle: {fontSize: 28, lineHeight: 34, fontWeight: '600' as const},
  sectionTitle: {fontSize: 20, lineHeight: 28, fontWeight: '600' as const},
  cardTitle: {fontSize: 16, lineHeight: 22, fontWeight: '600' as const},
  body: {fontSize: 15, lineHeight: 21, fontWeight: '400' as const},
  caption: {fontSize: 13, lineHeight: 18, fontWeight: '400' as const},
  small: {fontSize: 12, lineHeight: 16, fontWeight: '600' as const},
};

export type Tone = 'neutral' | 'success' | 'info' | 'warning' | 'error' | 'accent';

export function toneColors(p: Palette, tone: Tone): {bg: string; fg: string} {
  switch (tone) {
    case 'success':
      return {bg: p.successSoft, fg: p.success};
    case 'info':
      return {bg: p.infoSoft, fg: p.info};
    case 'warning':
      return {bg: p.warningSoft, fg: p.warning};
    case 'error':
      return {bg: p.errorSoft, fg: p.error};
    case 'accent':
      return {bg: p.accentSoft, fg: p.accent};
    default:
      return {bg: p.surfaceInset, fg: p.textSecondary};
  }
}

export function useTheme(): {p: Palette; isDark: boolean} {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  return {p: isDark ? dark : light, isDark};
}
