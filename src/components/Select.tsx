import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';
import { clsx } from 'clsx';

export interface SelectOption {
  value: string;
  label: string;
  hint?: string;
  disabled?: boolean;
}

interface SelectProps {
  value: string | number;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  size?: 'sm' | 'md';
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
  align?: 'left' | 'right';
  width?: number;
  menuWidth?: number;
}

interface MenuPosition {
  left: number;
  top: number;
  width: number;
}

/** Custom dropdown: native <select> popups cannot be styled on macOS. */
export function Select({
  value,
  onChange,
  options,
  placeholder = '请选择',
  size = 'md',
  disabled,
  className,
  ariaLabel,
  align = 'left',
  width,
  menuWidth,
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [position, setPosition] = useState<MenuPosition>({ left: 0, top: 0, width: 200 });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const current = options.find((option) => String(option.value) === String(value));

  const place = () => {
    const button = buttonRef.current;
    if (!button) return;
    const rect = button.getBoundingClientRect();
    const menuWidthValue = menuWidth || Math.max(rect.width, 168);
    let left = align === 'right' ? rect.right - menuWidthValue : rect.left;
    left = Math.max(8, Math.min(left, window.innerWidth - menuWidthValue - 8));
    const estimated = Math.min(options.length * 30 + 10, 296);
    const top =
      rect.bottom + 4 + estimated > window.innerHeight
        ? Math.max(8, rect.top - estimated - 4)
        : rect.bottom + 4;
    setPosition({ left, top, width: menuWidthValue });
  };

  useEffect(() => {
    if (!open) return;
    const index = Math.max(0, options.findIndex((option) => String(option.value) === String(value)));
    setActive(index);
    place();
    const close = (event: MouseEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      if (buttonRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    const reposition = () => place();
    window.addEventListener('mousedown', close, true);
    window.addEventListener('resize', reposition);
    window.addEventListener('wheel', reposition, { passive: true });
    return () => {
      window.removeEventListener('mousedown', close, true);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('wheel', reposition);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, options.length]);

  useLayoutEffect(() => {
    if (!open) return;
    const node = menuRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    node?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  const commit = (index: number) => {
    const option = options[index];
    if (!option || option.disabled) return;
    onChange(option.value);
    setOpen(false);
    buttonRef.current?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (disabled) return;
    if (!open) {
      if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown') {
        event.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((index) => Math.min(options.length - 1, index + 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((index) => Math.max(0, index - 1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      commit(active);
    } else if (event.key === 'Home') {
      event.preventDefault();
      setActive(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      setActive(options.length - 1);
    }
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={clsx('fselect', `fselect-${size}`, open && 'is-open', disabled && 'is-disabled', className)}
        style={width ? { width } : undefined}
        onClick={() => !disabled && setOpen((value) => !value)}
        onKeyDown={onKeyDown}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled}
      >
        <span className={clsx('fselect-label', !current && 'is-placeholder')}>{current?.label ?? placeholder}</span>
        <ChevronDown size={12} className="fselect-caret" />
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            className="fselect-menu"
            role="listbox"
            style={{ left: position.left, top: position.top, width: position.width }}
          >
            {options.map((option, index) => {
              const selected = String(option.value) === String(value);
              return (
                <button
                  key={option.value}
                  type="button"
                  data-index={index}
                  role="option"
                  aria-selected={selected}
                  className={clsx(
                    'fselect-option',
                    selected && 'is-selected',
                    index === active && 'is-active',
                    option.disabled && 'is-disabled',
                  )}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => commit(index)}
                >
                  <span className="fselect-check">{selected && <Check size={11} />}</span>
                  <span className="fselect-option-copy">
                    <span className="fselect-option-label">{option.label}</span>
                    {option.hint && <span className="fselect-option-hint">{option.hint}</span>}
                  </span>
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </>
  );
}
