import type { Translator } from '@timelog/app-core';
import { createContext, useContext } from 'react';
import type { DesktopBackend } from './backend.js';

export const BackendContext = createContext<DesktopBackend | null>(null);
export const TranslatorContext = createContext<Translator | null>(null);

export function useBackend(): DesktopBackend {
  const backend = useContext(BackendContext);
  if (!backend) throw new Error('BackendContext fehlt');
  return backend;
}

export function useT(): Translator {
  const t = useContext(TranslatorContext);
  if (!t) throw new Error('TranslatorContext fehlt');
  return t;
}
