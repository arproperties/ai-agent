import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import Crash from './components/Crash';
import { ParticleField } from './components/ParticleField';
import { watchForErrors } from './lib/report';
import './index.css';

// Before the first render, so a fault while the app is still starting is still heard.
watchForErrors();

createRoot(document.getElementById('root')).render(
  <StrictMode>
    {/* Outside <Crash>, and beside <App/> rather than inside it: the login screen
        returns early from App, and the background should be there for it too. */}
    <ParticleField />
    <Crash>
      <App />
    </Crash>
  </StrictMode>
);
