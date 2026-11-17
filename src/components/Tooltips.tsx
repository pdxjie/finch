import { useEffect, useRef, useState } from 'react';

const SHOW_DELAY = 110;
const HIDE_DELAY = 40;
const OFFSET_X = 12;
const OFFSET_Y = 20;

/** Replaces the slow native `title` tooltip with an instant, styled one. */
export function InstantTooltips() {
  const [tip, setTip] = useState<{ text: string; x: number; y: number } | null>(null);
  const timer = useRef<number | null>(null);
  const active = useRef<{ el: HTMLElement; attr: 'title' | 'data-tooltip'; text: string } | null>(null);
  const point = useRef({ x: 0, y: 0 });

  useEffect(() => {
    const clear = () => {
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
        timer.current = null;
      }
    };

    const restore = () => {
      const current = active.current;
      if (current) {
        if (current.el.isConnected && !current.el.hasAttribute(current.attr)) {
          current.el.setAttribute(current.attr, current.text);
        }
        current.el.removeAttribute('data-finch-tip');
      }
      active.current = null;
      setTip(null);
    };

    const schedule = (delay: number, action: () => void) => {
      clear();
      timer.current = window.setTimeout(action, delay);
    };

    const onOver = (event: MouseEvent) => {
      const target = (event.target as HTMLElement | null)?.closest<HTMLElement>('[title], [data-tooltip]');
      if (!target) return;
      if (active.current?.el === target) return;
      restore();
      const attr: 'title' | 'data-tooltip' = target.hasAttribute('title') ? 'title' : 'data-tooltip';
      const text = target.getAttribute(attr)?.trim();
      if (!text) return;
      point.current = { x: event.clientX, y: event.clientY };
      target.setAttribute('data-finch-tip', text);
      target.removeAttribute(attr);
      active.current = { el: target, attr, text };
      schedule(SHOW_DELAY, () => {
        setTip({ text, x: point.current.x, y: point.current.y });
      });
    };

    const onMove = (event: MouseEvent) => {
      point.current = { x: event.clientX, y: event.clientY };
      if (!active.current) return;
      if (tip) setTip({ text: tip.text, x: point.current.x, y: point.current.y });
    };

    const onOut = (event: MouseEvent) => {
      const target = active.current?.el;
      if (!target) return;
      const next = event.relatedTarget as Node | null;
      if (next && target.contains(next)) return;
      schedule(HIDE_DELAY, restore);
    };

    const hideNow = () => {
      clear();
      restore();
    };

    document.addEventListener('mouseover', onOver, true);
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('mouseout', onOut, true);
    document.addEventListener('mousedown', hideNow, true);
    document.addEventListener('keydown', hideNow, true);
    window.addEventListener('wheel', hideNow, { capture: true, passive: true });
    window.addEventListener('blur', hideNow);
    return () => {
      document.removeEventListener('mouseover', onOver, true);
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('mouseout', onOut, true);
      document.removeEventListener('mousedown', hideNow, true);
      document.removeEventListener('keydown', hideNow, true);
      window.removeEventListener('wheel', hideNow, true);
      window.removeEventListener('blur', hideNow);
      clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tip?.text]);

  if (!tip) return null;
  const width = Math.min(280, Math.max(80, tip.text.length * 7.2 + 22));
  const left = Math.max(8, Math.min(tip.x + OFFSET_X, window.innerWidth - width - 8));
  const top =
    tip.y + OFFSET_Y + 34 > window.innerHeight ? Math.max(8, tip.y - 34) : tip.y + OFFSET_Y;
  return (
    <div className="finch-tooltip" role="tooltip" style={{ left, top, maxWidth: width }}>
      {tip.text}
    </div>
  );
}
