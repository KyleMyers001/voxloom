import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { OverlayApp } from './OverlayApp';
import '../styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Overlay root missing');

createRoot(root).render(
  <StrictMode>
    <OverlayApp />
  </StrictMode>,
);
