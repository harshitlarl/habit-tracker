import '@fontsource-variable/fraunces/full.css';
import '@fontsource-variable/fraunces/full-italic.css';
import '@fontsource-variable/hanken-grotesk';
import './styles/tokens.css';
import './styles/base.css';
import './pwa';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { initSync } from './lib/sync/bootstrap';

const container = document.getElementById('root');
if (!container) throw new Error('Momentum: #root element not found');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Optional cloud sync (SPEC §13): a no-op without VITE_FIREBASE_* config, otherwise it loads Firebase
// after the first paint and never blocks rendering.
initSync();
