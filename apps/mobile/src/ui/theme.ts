// Farben mit Kontrast nach WCAG 2.1 AA (Text ≥ 4,5:1, Bedienelemente ≥ 3:1), hell und dunkel.
import { useColorScheme } from 'react-native';

export interface Theme {
  dark: boolean;
  bg: string;
  surface: string;
  border: string;
  text: string;
  muted: string;
  primary: string;
  onPrimary: string;
  danger: string;
  onDanger: string;
  warningBg: string;
  warningText: string;
  errorBg: string;
  errorText: string;
  successBg: string;
  successText: string;
  infoBg: string;
  infoText: string;
}

export const light: Theme = {
  dark: false,
  bg: '#FFFFFF',
  surface: '#F2F4F7',
  border: '#6B7280', // 4,8:1 auf Weiß
  text: '#1A1A1A', // 17:1
  muted: '#4A5361', // 7,9:1
  primary: '#0B5CAD', // 6,6:1, Weiß darauf 6,6:1
  onPrimary: '#FFFFFF',
  danger: '#B3261E', // 6,1:1
  onDanger: '#FFFFFF',
  warningBg: '#FFF4D6',
  warningText: '#6B4500', // 7,9:1 auf warningBg
  errorBg: '#FDECEA',
  errorText: '#8C1D18', // 8,4:1
  successBg: '#E6F4EA',
  successText: '#1E5A2E', // 7,6:1
  infoBg: '#E8F1FB',
  infoText: '#0A4A8A', // 7,8:1
};

export const dark: Theme = {
  dark: true,
  bg: '#121212',
  surface: '#1E1F22',
  border: '#9AA3AF', // 6,6:1 auf bg
  text: '#F2F2F2', // 16:1
  muted: '#B8BEC8', // 9,5:1
  primary: '#7FB6F0', // 8,9:1, onPrimary darauf 8,7:1
  onPrimary: '#0B1A2B',
  danger: '#FF8A80', // 7,6:1
  onDanger: '#2B0A08',
  warningBg: '#3A2E10',
  warningText: '#FFDFA0', // 10:1
  errorBg: '#3B1513',
  errorText: '#FFB4AB', // 9,5:1
  successBg: '#11301A',
  successText: '#A6E3B4', // 10:1
  infoBg: '#10263D',
  infoText: '#B5D5F7', // 10:1
};

export function useTheme(): Theme {
  return useColorScheme() === 'dark' ? dark : light;
}

export const space = { xs: 4, sm: 8, md: 16, lg: 24 } as const;
/** Mindestgröße für Touch-Ziele (Android 48 dp, iOS 44 pt). */
export const TOUCH = 48;
