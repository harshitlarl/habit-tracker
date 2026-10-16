import type { ReactNode } from 'react';
import './Icon.css';

export type IconName =
  | 'sun'
  | 'grid'
  | 'chart'
  | 'list'
  | 'plus'
  | 'chevronLeft'
  | 'chevronRight'
  | 'check'
  | 'flame'
  | 'trash'
  | 'archive'
  | 'restore'
  | 'edit'
  | 'close'
  | 'share'
  | 'up'
  | 'down'
  | 'download'
  | 'upload'
  | 'gear';

export interface IconProps {
  name: IconName;
  /** Rendered width/height in px (default 24). */
  size?: number;
  className?: string;
  /** Accessible name; omit for decorative icons (the default, aria-hidden). */
  title?: string;
}

const PATHS: Record<IconName, ReactNode> = {
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5V5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8" />
    </>
  ),
  grid: (
    <>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.75" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.75" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.75" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.75" />
    </>
  ),
  chart: (
    <>
      <path d="M4 20.5h16" />
      <path d="M7 16.5v-5M12 16.5V5.5M17 16.5v-8" strokeWidth="3" />
    </>
  ),
  list: (
    <>
      <path d="M9 6h11M9 12h11M9 18h11" />
      <circle cx="4.5" cy="6" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="4.5" cy="12" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="4.5" cy="18" r="1.1" fill="currentColor" stroke="none" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  chevronLeft: <path d="M15 5l-7 7 7 7" />,
  chevronRight: <path d="M9 5l7 7-7 7" />,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  flame: (
    <path d="M12 3c.5 3.3 3.4 4.7 4.7 7.3A6.2 6.2 0 0 1 12 21a6.2 6.2 0 0 1-5-9.9c.3 1.6 1 2.7 2.2 3.3C8.9 11.1 9.5 7.6 12 3zM12 21c1.9 0 3-1.4 3-3.1 0-1.6-1.2-2.4-2-4-.9 1-1.6 1.6-1.9 2.6" />
  ),
  trash: <path d="M4 7h16M9.5 7V4.5h5V7M6.5 7l.8 12.5h9.4L17.5 7M10 11v5.5M14 11v5.5" />,
  archive: (
    <>
      <rect x="3.5" y="4" width="17" height="4.5" rx="1.25" />
      <path d="M5 8.5V19a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8.5M10 13h4" />
    </>
  ),
  restore: <path d="M3.5 12a8.5 8.5 0 1 0 2.9-6.4M3.5 4.5V9H8" />,
  edit: <path d="M4 20h4.2L19 9.2a2.1 2.1 0 0 0-3-3L5.2 17 4 20zM14.5 7.7l2.8 2.8" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  share: <path d="M12 3v12M8 7l4-4 4 4M5.5 11v8.5a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V11" />,
  up: <path d="M12 19V5M6 11l6-6 6 6" />,
  down: <path d="M12 5v14M6 13l6 6 6-6" />,
  download: <path d="M12 4v11M7.5 10.5l4.5 4.5 4.5-4.5M4.5 20h15" />,
  upload: <path d="M12 15V4M7.5 8.5L12 4l4.5 4.5M4.5 20h15" />,
  gear: (
    <>
      <circle cx="12" cy="12" r="3.3" />
      <path d="M19.4 13.6a7.9 7.9 0 0 0 0-3.2l2-1.5-2-3.5-2.4.9a7.9 7.9 0 0 0-2.8-1.6L13.8 2h-3.6l-.4 2.7a7.9 7.9 0 0 0-2.8 1.6l-2.4-.9-2 3.5 2 1.5a7.9 7.9 0 0 0 0 3.2l-2 1.5 2 3.5 2.4-.9a7.9 7.9 0 0 0 2.8 1.6l.4 2.7h3.6l.4-2.7a7.9 7.9 0 0 0 2.8-1.6l2.4.9 2-3.5-2-1.5z" />
    </>
  ),
};

/** Inline line icon: currentColor, stroke 1.75, round caps and joins. */
export function Icon({ name, size = 24, className, title }: IconProps) {
  return (
    <svg
      className={className ? `icon ${className}` : 'icon'}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      focusable="false"
    >
      {title ? <title>{title}</title> : null}
      {PATHS[name]}
    </svg>
  );
}
