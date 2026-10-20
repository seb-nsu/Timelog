// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAsync, useNow, useTranslator } from '../src/index.js';

describe('Hooks', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('useNow tickt im Takt', () => {
    let ms = Date.parse('2026-10-15T07:00:00Z');
    const clock = () => ms;
    const { result } = renderHook(() => useNow(1000, clock));
    expect(result.current).toBe('2026-10-15T07:00:00.000Z');
    ms += 60_000;
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current).toBe('2026-10-15T07:01:00.000Z');
  });

  it('useTranslator liefert stabile Texte', () => {
    const { result, rerender } = renderHook(() => useTranslator('de'));
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
    expect(first.t('nav.review')).toBe('Zu prüfen');
  });
});

describe('useAsync', () => {
  it('liefert Wert und Fehler', async () => {
    const ok = renderHook(() => useAsync(() => Promise.resolve(42), []));
    expect(ok.result.current.status).toBe('loading');
    await waitFor(() => {
      expect(ok.result.current).toEqual({ status: 'ready', value: 42 });
    });
    const failing = renderHook(() => useAsync(() => Promise.reject(new Error('x')), []));
    await waitFor(() => {
      expect(failing.result.current.status).toBe('error');
    });
  });
});
