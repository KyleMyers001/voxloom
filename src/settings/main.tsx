import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AppProvider } from '../app/AppContext';
import { createDictionaryStore, createMemoryDictionaryIo } from '../services/dictionary';
import { createHistoryStore, createMemoryHistoryIo } from '../services/history';
import '../styles/index.css';
import { SettingsWindowApp } from './SettingsWindowApp';

const root = document.getElementById('root');
if (!root) throw new Error('Settings root element is missing');

// history.json and dictionary.json have one writer: the main window.
// The Settings window only reads/writes settings.json.
const historyPersistence = { enabled: false, store: createHistoryStore(createMemoryHistoryIo()) };
const dictionaryPersistence = { enabled: false, store: createDictionaryStore(createMemoryDictionaryIo()) };

createRoot(root).render(
  <StrictMode>
    <AppProvider dictionaryPersistence={dictionaryPersistence} historyPersistence={historyPersistence}>
      <SettingsWindowApp />
    </AppProvider>
  </StrictMode>,
);
