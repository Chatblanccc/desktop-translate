import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { CardApp } from './CardApp.js';
import { getSelectionCardApi } from './card-api.js';
import '../shared/styles.css';
import './styles.css';

const rootElement = document.getElementById('root');
if (rootElement === null) throw new Error('Missing card renderer root element.');

createRoot(rootElement).render(
  <StrictMode>
    <CardApp api={getSelectionCardApi()} />
  </StrictMode>
);
