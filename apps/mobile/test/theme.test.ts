import { describe, expect, it } from '@jest/globals';
import { type Theme, dark, light } from '../src/ui/theme';

// Kontrast nach WCAG 2.1 (relative Leuchtdichte)
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}

const TEXT_PAIRS: [keyof Theme, keyof Theme][] = [
  ['text', 'bg'],
  ['text', 'surface'],
  ['muted', 'bg'],
  ['muted', 'surface'],
  ['primary', 'bg'],
  ['primary', 'surface'],
  ['onPrimary', 'primary'],
  ['onDanger', 'danger'],
  ['danger', 'bg'],
  ['warningText', 'warningBg'],
  ['errorText', 'errorBg'],
  ['successText', 'successBg'],
  ['infoText', 'infoBg'],
];

describe.each([
  ['hell', light],
  ['dunkel', dark],
])('Kontrast %s', (_name, theme) => {
  it.each(TEXT_PAIRS)('%s auf %s ≥ 4,5:1', (fg, bg) => {
    expect(contrast(String(theme[fg]), String(theme[bg]))).toBeGreaterThanOrEqual(4.5);
  });

  it('Rahmen von Eingabefeldern ≥ 3:1', () => {
    expect(contrast(theme.border, theme.bg)).toBeGreaterThanOrEqual(3);
    expect(contrast(theme.border, theme.surface)).toBeGreaterThanOrEqual(3);
  });
});
