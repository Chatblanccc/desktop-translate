import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BallApp } from './BallApp.js';
import { getBallRendererApi } from './ball-api.js';
import '../shared/styles.css';
import './styles.css';

const rootElement = document.getElementById('root');

if (rootElement === null) {
  throw new Error('Missing ball renderer root element.');
}

createRoot(rootElement).render(
  <StrictMode>
    <BallApp api={getBallRendererApi()} />
  </StrictMode>
);
