import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import Crash from './components/Crash';
import { watchForErrors } from './lib/report';
import { startTheme } from './lib/theme';
import './index.css';

// Before the first render, so a fault while the app is still starting is still heard.
watchForErrors();
startTheme();

createRoot(document.getElementById('root')).render(
  <StrictMode>
    {/* Outside <Crash>, and beside <App/> rather than inside it: the login screen
        returns early from App, and the background should be there for it too. */}
    <Crash>
      <App />
    </Crash>
  </StrictMode>
);
