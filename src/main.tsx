import './styles/fonts.css';
import './styles/tokens.css';
import './styles/base.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import App from './App';
import { initSync } from './lib/sync/bootstrap';
import { setupPWA } from './pwa';

// Service worker and its update policy (src/pwa.ts): registered before the first render.
setupPWA(registerSW);

const container = document.getElementById('root');
if (!container) throw new Error('Momentum: #root element not found');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Optional cloud sync (SPEC §13): a no-op without VITE_FIREBASE_* config; otherwise it restores a saved
// sign-in after the first paint (never blocking rendering), and on a device that has never signed in it
// leaves the SDK alone until the Sync card asks for it.
initSync();
