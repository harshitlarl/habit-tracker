/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

import 'react';

declare module 'react' {
  // Allow CSS custom properties in style objects: style={{ '--i': index }}
  interface CSSProperties {
    [key: `--${string}`]: string | number | undefined;
  }
}

declare global {
  // Public Firebase web config (see .env). All optional: when any is missing, sync is hidden.
  interface ImportMetaEnv {
    readonly VITE_FIREBASE_API_KEY?: string;
    readonly VITE_FIREBASE_AUTH_DOMAIN?: string;
    readonly VITE_FIREBASE_PROJECT_ID?: string;
    readonly VITE_FIREBASE_APP_ID?: string;
  }
}
