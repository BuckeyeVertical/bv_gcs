import { type ButtonHTMLAttributes, forwardRef } from 'react';
import clsx from 'clsx';

type Variant = 'approve' | 'reject' | 'ghost';

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
}

const base =
  'inline-flex items-center justify-center gap-2 rounded-sm font-semibold ' +
  'uppercase tracking-wider text-xs px-4 py-3 transition-colors ' +
  'border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-blue ' +
  'disabled:opacity-50 disabled:cursor-not-allowed';

const variants: Record<Variant, string> = {
  approve:
    'bg-accent-green/15 text-accent-green border-accent-green/40 ' +
    'hover:bg-accent-green/25',
  reject:
    'bg-accent-red/15 text-accent-red border-accent-red/40 ' +
    'hover:bg-accent-red/25',
  ghost:
    'bg-transparent text-ink-muted border-bg-border hover:bg-bg-raised',
};

export const Button = forwardRef<HTMLButtonElement, Props>(
  ({ variant = 'ghost', className, ...rest }, ref) => (
    <button
      ref={ref}
      className={clsx(base, variants[variant], className)}
      {...rest}
    />
  ),
);
Button.displayName = 'Button';
