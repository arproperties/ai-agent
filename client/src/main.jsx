import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import Crash from './components/Crash';
import { watchForErrors } from './lib/report';
import './index.css';

// Before the first render, so a fault while the app is still starting is still heard.
watchForErrors();

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Crash>
      <App />
    </Crash>
  </StrictMode>
);
