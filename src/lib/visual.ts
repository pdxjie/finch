import type { AppSettings } from '../types';

const UI_FALLBACK = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", "PingFang SC", sans-serif';
const MONO_FALLBACK = '"SFMono-Regular", "SF Mono", "JetBrains Mono", "Cascadia Code", Menlo, monospace';

function family(name: string): string {
  const value = name.trim();
  if (!value) return '';
  if (value.includes(',') || /^(serif|sans-serif|monospace|system-ui)$/i.test(value)) return value;
  return `"${value.replace(/"/g, '\\"')}"`;
}

function uiStack(name: string): string {
  const custom = family(name);
  return custom ? `${custom}, ${UI_FALLBACK}` : UI_FALLBACK;
}

function monoStack(name: string): string {
  const custom = family(name);
  return custom ? `${custom}, ${MONO_FALLBACK}` : MONO_FALLBACK;
}

function rgb(hex: string): [number, number, number] | null {
  const value = hex.trim().replace('#', '');
  const full = value.length === 3 ? value.split('').map((ch) => ch + ch).join('') : value;
  if (!/^[0-9a-f]{6}$/i.test(full)) return null;
  return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
}

function mix(hex: string, target: string, amount: number): string {
  const from = rgb(hex);
  const to = rgb(target);
  if (!from || !to) return hex;
  const channel = (index: number) => Math.round(from[index] + (to[index] - from[index]) * amount);
  return `rgb(${channel(0)}, ${channel(1)}, ${channel(2)})`;
}

function contrast(hex: string): string {
  const value = rgb(hex);
  if (!value) return '#ffffff';
  const [r, g, b] = value.map((part) => {
    const channel = part / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.45 ? '#14150f' : '#ffffff';
}

export function visualZoom(settings: AppSettings): number {
  const size = Math.min(17, Math.max(11, settings.uiFontSize || 13));
  return Math.max(0.5, Math.min(2.5, (size / 13) * (settings.zoomFactor || 1)));
}

/** Push typography, accent and motion preferences into CSS variables. */
export function applyVisualSettings(settings: AppSettings): void {
  const root = document.documentElement;
  root.style.setProperty('--font-ui', uiStack(settings.uiFont || ''));
  root.style.setProperty('--font-display', uiStack(settings.uiFont || ''));
  root.style.setProperty('--mono', monoStack(settings.monoFont || ''));

  const accent = /^#[0-9a-f]{6}$/i.test(settings.accentColor || '') ? settings.accentColor : '#5068f0';
  root.style.setProperty('--accent', accent);
  root.style.setProperty('--accent-strong', mix(accent, '#000000', 0.16));
  root.style.setProperty('--accent-soft', `rgba(${rgb(accent)?.join(', ') || '80, 104, 240'}, 0.1)`);
  root.style.setProperty('--accent-softer', `rgba(${rgb(accent)?.join(', ') || '80, 104, 240'}, 0.055)`);
  root.style.setProperty('--accent-contrast', contrast(accent));

  root.dataset.motion = ['full', 'reduced', 'off'].includes(settings.motion) ? settings.motion : 'full';
}
