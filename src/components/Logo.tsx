interface LogoProps {
  size?: number;
  withBackground?: boolean;
  className?: string;
}

export function Logo({ size = 28, withBackground = true, className }: LogoProps) {
  const id = withBackground ? 'finch-logo-bg' : 'finch-logo-plain';
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      className={className}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={id} x1="8" y1="4" x2="58" y2="62" gradientUnits="userSpaceOnUse">
          <stop stopColor="#627CFF" />
          <stop offset="0.55" stopColor="#5367EE" />
          <stop offset="1" stopColor="#20C8B4" />
        </linearGradient>
        <linearGradient id={`${id}-wing`} x1="18" y1="18" x2="46" y2="48" gradientUnits="userSpaceOnUse">
          <stop stopColor="#FFFFFF" />
          <stop offset="1" stopColor="#E9F5FF" />
        </linearGradient>
      </defs>
      {withBackground && <rect width="64" height="64" rx="15" fill={`url(#${id})`} />}
      <path
        d="M15.8 39.5 39.6 15.2 34.9 30.6 49.2 26.5 24.6 48.8 29.1 34.5 15.8 39.5Z"
        fill={withBackground ? `url(#${id}-wing)` : `url(#${id})`}
      />
      <path d="M24.6 48.8 29.1 34.5 33.1 37.4 24.6 48.8Z" fill="#B9D4FF" fillOpacity="0.72" />
    </svg>
  );
}
