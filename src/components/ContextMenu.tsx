import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { clsx } from 'clsx';
import type { LucideIcon } from 'lucide-react';

export interface ContextMenuItem {
  label?: string;
  icon?: LucideIcon;
  onClick?: () => void;
  danger?: boolean;
  divider?: boolean;
  hint?: string;
}

export interface ContextMenuState {
  x: number;
  y: number;
  items: ContextMenuItem[];
}

const MENU_WIDTH = 212;

export function ContextMenu({ menu, onClose }: { menu: ContextMenuState; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: menu.x, top: menu.y });

  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    const hide = () => onClose();
    window.addEventListener('mousedown', close, true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', hide);
    window.addEventListener('blur', hide);
    return () => {
      window.removeEventListener('mousedown', close, true);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', hide);
      window.removeEventListener('blur', hide);
    };
  }, [onClose]);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const margin = 8;
    const left = Math.max(margin, Math.min(menu.x, window.innerWidth - rect.width - margin));
    const top =
      menu.y + rect.height + margin > window.innerHeight
        ? Math.max(margin, menu.y - rect.height)
        : menu.y;
    setPosition({ left, top });
  }, [menu.x, menu.y, menu.items]);

  return createPortal(
    <div ref={ref} className="context-menu" style={{ left: position.left, top: position.top, minWidth: MENU_WIDTH }}>
      {menu.items.map((item, index) =>
        item.divider ? (
          <div key={`divider-${index}`} className="context-divider" />
        ) : (
          <button
            key={`${item.label}-${index}`}
            className={clsx('context-item', item.danger && 'is-danger')}
            onClick={() => {
              item.onClick?.();
              onClose();
            }}
          >
            {item.icon && <item.icon size={14} />}
            <span>{item.label}</span>
            {item.hint && <span className="context-hint">{item.hint}</span>}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}
