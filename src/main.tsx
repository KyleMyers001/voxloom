import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { AppProvider } from './app/AppContext';
import './styles/index.css';

const root = document.getElementById('root');
if (!root) throw new Error('Voxloom root element is missing');

createRoot(root).render(
  <StrictMode>
    <AppProvider>
      <App />
    </AppProvider>
  </StrictMode>,
);
