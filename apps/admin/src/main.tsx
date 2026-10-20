import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { Session } from './session.js';
import './styles.css';

const baseUrl = (import.meta.env.VITE_API_URL as string | undefined) ?? window.location.origin;
const session = new Session(baseUrl, window.sessionStorage);

const download = (blob: Blob, filename: string) => {
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => {
    URL.revokeObjectURL(href);
  }, 1000);
};

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App
        session={session}
        initialUrl={window.location.href}
        redirectTo={(url) => {
          window.location.assign(url);
        }}
        replaceUrl={(path) => {
          window.history.replaceState(null, '', path);
        }}
        download={download}
      />
    </StrictMode>,
  );
}
