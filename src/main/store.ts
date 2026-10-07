import Store from 'electron-store';
import type { Rectangle } from 'electron';
import { toHostname } from './urls.js';

/** User-facing settings (editable from the settings window and tray). */
export interface Settings {
  closeToTray: boolean;
  startWithWindows: boolean;
  startMinimized: boolean;
  adblock: boolean;
  adblockExceptions: string[];
  hardwareAcceleration: boolean;
  defaultZoom: number;
}

interface Schema extends Settings {
  zoom: number;
  window: { bounds?: Rectangle; maximized: boolean };
}

export const settingDefaults: Settings = {
  closeToTray: true,
  startWithWindows: false,
  startMinimized: false,
  adblock: true,
  adblockExceptions: [],
  hardwareAcceleration: true,
  defaultZoom: 1,
};

export const store = new Store<Schema>({
  defaults: { ...settingDefaults, zoom: 1, window: { maximized: false } },
});

export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 2;
export const clampZoom = (z: number): number => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 100) / 100));

export function getSettings(): Settings {
  const out = {} as Record<string, unknown>;
  for (const k of Object.keys(settingDefaults)) out[k] = store.get(k as keyof Settings);
  return out as unknown as Settings;
}

/** Validates a value coming over IPC; returns the sanitised value or throws. */
export function sanitizeSetting<K extends keyof Settings>(key: K, value: unknown): Settings[K] {
  const def = settingDefaults[key];
  if (def === undefined) throw new Error(`Unknown setting: ${String(key)}`);
  if (key === 'adblockExceptions') {
    if (!Array.isArray(value)) throw new Error('Expected a list');
    const hosts = value.map((v) => (typeof v === 'string' ? toHostname(v) : null)).filter((h): h is string => !!h);
    return [...new Set(hosts)] as Settings[K];
  }
  if (typeof value !== typeof def) throw new Error(`Bad value for ${key}`);
  if (key === 'defaultZoom') return clampZoom(value as number) as Settings[K];
  return value as Settings[K];
}
