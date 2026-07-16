import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { SettingsApp } from './SettingsApp.js';
import { getSettingsRendererApi } from './settings-api.js';
import '../shared/styles.css';
import './styles.css';

const rootElement = document.getElementById('root');

if (rootElement === null) {
  throw new Error('Missing settings renderer root element.');
}

createRoot(rootElement).render(
  <StrictMode>
    <SettingsApp api={getSettingsRendererApi()} />
  </StrictMode>
);
