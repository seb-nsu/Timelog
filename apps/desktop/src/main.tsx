import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { createTauriBackend } from './backend.js';
import { refreshProfile } from './profile.js';
import './styles.css';

const root = document.getElementById('root');
if (root) {
  void createTauriBackend().then((backend) => {
    // Profil beim Start aktualisieren; offline gilt das zwischengespeicherte.
    void refreshProfile(backend).catch(() => undefined);
    createRoot(root).render(
      <StrictMode>
        <App backend={backend} />
      </StrictMode>,
    );
  });
}
