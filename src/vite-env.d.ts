/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

import 'react';

declare module 'react' {
  // Allow CSS custom properties in style objects: style={{ '--i': index }}
  interface CSSProperties {
    [key: `--${string}`]: string | number | undefined;
  }
}
